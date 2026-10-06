import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelBuilder } from '../src/build/index.js';
import { CurlExporter, MarkdownExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { LoginModels } from './helpers/login-models.js';
import { LoginSite } from './helpers/login-site.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function bash(args: string[], cwd: string, env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const clean: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C', ...env };
    execFile('bash', args, { cwd, env: clean, timeout: 30_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

describe('the curl script logs in and keeps the session in a cookie jar (L3, QL-7, QL-8, QL-9)', () => {
  const site = new LoginSite();
  let dir = '';
  let model: ApiModel;
  let file = '';

  before(async () => {
    await site.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-login-curl-'));
    model = LoginModels.form(site.origin);
    file = join(dir, 'endpoints.sh');
    await writeFile(file, new CurlExporter().export(model).content);
  });

  after(async () => {
    await site.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test('the login function stops with a message naming the variable when the user name or the password is missing, and sends nothing', async () => {
    site.reset();
    const none = await bash([file, 'postLogin'], dir, { APPII_COOKIE_JAR: join(dir, 'none.txt') });
    assert.equal(none.code, 2);
    assert.match(none.stderr, /postLogin: no value for the user name \(username\)\. Give username=VALUE or set APPII_USERNAME\./);
    const password = await bash([file, 'postLogin', 'username=reader'], dir, { APPII_COOKIE_JAR: join(dir, 'none.txt') });
    assert.equal(password.code, 2);
    assert.match(password.stderr, /no value for the password \(password\)\. Give password=VALUE or set APPII_PASSWORD\./);
    assert.deepEqual(site.requests, []);
  });

  test('postLogin fetches the CSRF token from the login page with the jar, logs in, and a protected function called after it is logged in', async () => {
    site.reset();
    const jar = join(dir, 'run.txt');
    const login = await bash([file, 'postLogin'], dir, { APPII_COOKIE_JAR: jar, APPII_USERNAME: 'reader-one', APPII_PASSWORD: 'any-pass' });
    assert.equal(login.code, 0, login.stderr);
    assert.deepEqual(site.requests.map((request) => `${request.method} ${request.path}`), ['GET /login', 'POST /login']);
    const posted = new URLSearchParams(site.requests[1]?.body ?? '');
    assert.equal(posted.get('username'), 'reader-one');
    assert.match(posted.get('csrf_token') ?? '', /^[0-9a-f]{32}$/);
    assert.equal(site.requests[0]?.cookie, '');
    assert.ok(LoginSite.cookie(site.requests[1]?.cookie ?? '', 'session'), 'the login carries the session cookie that the login page set');
    assert.equal(((await stat(jar)).mode & 0o777).toString(8), '600');
    const account = await bash([file, 'getAccountPage'], dir, { APPII_COOKIE_JAR: jar });
    assert.equal(account.code, 0, account.stderr);
    assert.match(account.stdout, /Account of reader-one/);
  });

  test('sourced in one shell: login, a protected call, logout, and the protected call is refused again', async () => {
    site.reset();
    const steps = [
      `source ${JSON.stringify(file)}`,
      'postLogin username=shell-user password=pw > /dev/null',
      'getAccountPage',
      'getLogout > /dev/null',
      "printf '\\n--after logout--\\n'",
      'getAccountPage -o /dev/null -w "%{http_code}"',
    ].join('\n');
    const run = await bash(['-c', steps], dir);
    assert.equal(run.code, 0, run.stderr);
    const [before, afterLogout] = run.stdout.split('--after logout--');
    assert.match(before ?? '', /Account of shell-user/);
    assert.equal((afterLogout ?? '').trim(), '302');
    assert.equal(((await stat(join(dir, CurlExporterTest.jarName(model)))).mode & 0o777).toString(8), '600');
  });

  test('a capture made without an account already gives a working login function', async () => {
    site.reset();
    const anonymous = join(dir, 'anonymous.sh');
    await writeFile(anonymous, new CurlExporter().export(LoginModels.anonymous(site.origin)).content);
    const jar = join(dir, 'anonymous-jar.txt');
    const run = await bash([anonymous, 'postLogin', 'username=first-time', 'password=pw', '-o', '/dev/null'], dir, { APPII_COOKIE_JAR: jar });
    assert.equal(run.code, 0, run.stderr);
    const sids = await bash(['-c', `awk -F'\\t' '$6 == "session" { print $7 }' ${JSON.stringify(jar)}`], dir);
    assert.equal(site.user(sids.stdout.trim()), 'first-time');
  });

  test('the script and the documentation carry no captured credential value and no default for the user name or password', () => {
    const script = new CurlExporter().export(model).content;
    const markdown = new MarkdownExporter().export(model).content;
    for (const text of [script, markdown]) {
      for (const secret of [LoginModels.USER, LoginModels.PASSWORD, LoginModels.AUTH_SESSION, LoginModels.ANON_SESSION, LoginModels.CSRF]) assert.ok(!text.includes(secret), secret);
    }
    assert.match(script, /local APPII_USERNAME="\$\{APPII_USERNAME:-\}"/);
    assert.match(script, /local APPII_PASSWORD="\$\{APPII_PASSWORD:-\}"/);
    assert.match(markdown, /--data-urlencode "password=\$\{APPII_PASSWORD:\?\}"/);
    assert.match(markdown, /--data-urlencode "username=\$\{APPII_USERNAME:\?\}"/);
  });

  test('the documented example of the login stops with a message naming the variable', async () => {
    const markdown = new MarkdownExporter().export(model).content;
    const block = /```bash\n(curl -sS -X POST [^\n]*\/login'?"?[\s\S]*?)\n```/.exec(markdown)?.[1];
    assert.ok(block, markdown);
    const run = await bash(['-c', `curl() { printf '%s\\n' "$@"; }\n${block}`], dir, { APPII_CSRF_TOKEN: 't', APPII_SESSION: 's', APPII_USERNAME: 'u' });
    assert.notEqual(run.code, 0);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /APPII_PASSWORD: parameter null or not set/);
  });

  test('the documented example stops when the CSRF token or the session cookie it is bound to is not set, and names the page and the curl function (P3b)', async () => {
    const markdown = new MarkdownExporter().export(model).content;
    const block = /```bash\n(curl -sS -X POST [^\n]*\/login'?"?[\s\S]*?)\n```/.exec(markdown)?.[1];
    assert.ok(block, markdown);
    const script = ['-c', `curl() { printf '%s\\n' "$@"; }\n${block}`];
    const credentials = { APPII_USERNAME: 'u', APPII_PASSWORD: 'p' };
    const noSession = await bash(script, dir, { ...credentials, APPII_CSRF_TOKEN: 't' });
    assert.notEqual(noSession.code, 0);
    assert.equal(noSession.stdout, '');
    assert.match(noSession.stderr, new RegExp(`APPII_SESSION: the session cookie of GET ${site.origin.replace(/[.]/g, '\\.')}/login that csrf_token is bound to; bash endpoints\\.sh postLogin keeps it`));
    const noToken = await bash(script, dir, { ...credentials, APPII_SESSION: 's' });
    assert.notEqual(noToken.code, 0);
    assert.equal(noToken.stdout, '');
    assert.match(noToken.stderr, new RegExp(`APPII_CSRF_TOKEN: the hidden field csrf_token of GET ${site.origin.replace(/[.]/g, '\\.')}/login; bash endpoints\\.sh postLogin fetches it`));
    const all = await bash(script, dir, { ...credentials, APPII_SESSION: 's1', APPII_CSRF_TOKEN: 't1' });
    assert.equal(all.code, 0, all.stderr);
    assert.ok(all.stdout.split('\n').includes('session=s1'), all.stdout);
    assert.ok(all.stdout.split('\n').includes('csrf_token=t1'), all.stdout);
  });

  test('a CSRF header taken from a cookie: the function loads the page that sets it into the jar and sends the decoded value', async () => {
    const f = new CaptureFactory(site.origin);
    f.document('/app', CaptureFactory.page('App', '<div id="root"></div>'), { responseHeaders: { 'set-cookie': 'XSRF-TOKEN=c2VlZA%3D%3D; Path=/' } });
    f.json('POST', '/api/items', 201, { id: 1 }, { pageUrl: f.url('/app'), requestHeaders: { 'content-type': 'application/json', cookie: 'XSRF-TOKEN=c2VlZA%3D%3D', 'x-xsrf-token': 'c2VlZA==' }, requestBody: { json: { name: 'x' } } });
    const built = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
    const items = LoginModels.endpoint(built, 'POST', '/api/items');
    items.auth.csrf = [{ location: 'header', name: 'X-XSRF-TOKEN', source: 'cookie', sourceName: 'XSRF-TOKEN' }];
    const own = join(dir, 'xsrf.sh');
    await writeFile(own, new CurlExporter().export(built).content);
    site.reset();
    const run = await bash([own, items.name], dir, { APPII_COOKIE_JAR: join(dir, 'xsrf-jar.txt') });
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), { id: 1 });
    assert.deepEqual(site.requests.map((request) => `${request.method} ${request.path}`), ['GET /app', 'POST /api/items']);
  });

  test('the usage text documents the cookie jar and its default', async () => {
    const usage = await bash([file, 'help'], dir);
    assert.match(usage.stdout, /APPII_COOKIE_JAR/);
    assert.match(usage.stdout, new RegExp(CurlExporterTest.jarName(model).replace(/[.]/g, '\\.')));
  });
});

class CurlExporterTest {
  static jarName(model: ApiModel): string {
    return `${model.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}-cookies.txt`;
  }
}
