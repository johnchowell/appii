import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CurlExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { LoginModels } from './helpers/login-models.js';
import { LoginShell } from './helpers/login-shell.js';
import { LoginSite } from './helpers/login-site.js';

class BearerScript {
  static model(origin: string): ApiModel {
    const model = LoginModels.bearer(origin);
    const me = LoginModels.endpoint(model, 'GET', '/api/me');
    model.endpoints.push({ ...structuredClone(me), id: 'post-api-logout', name: 'postLogout', key: 'POST /api/logout', method: 'POST', path: '/api/logout', role: 'logout', auth: { ...structuredClone(me.auth), anonymous: 'untested' } });
    return model;
  }

  static name(model: ApiModel, method: string, path: string): string {
    return LoginModels.endpoint(model, method, path).name;
  }

  static tokenFile(model: ApiModel): string {
    return `${model.name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()}-token.txt`;
  }

  static authorizations(site: LoginSite, path: string): string[] {
    return site.requests.filter((request) => request.path === path).map((request) => request.authorization);
  }
}

describe('the curl script carries the bearer token from the login function to the functions that send one (LL-5)', () => {
  const site = new LoginSite();
  let dir = '';
  let model: ApiModel;
  let file = '';
  let login = '';
  let me = '';
  let notes = '';
  let logout = '';

  before(async () => {
    await site.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-login-bearer-'));
    model = BearerScript.model(site.origin);
    file = join(dir, 'endpoints.sh');
    await writeFile(file, new CurlExporter().export(model).content);
    login = BearerScript.name(model, 'POST', '/api/auth/login');
    me = BearerScript.name(model, 'GET', '/api/me');
    notes = BearerScript.name(model, 'GET', '/api/notes');
    logout = BearerScript.name(model, 'POST', '/api/logout');
  });

  after(async () => {
    await site.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test('without a token, a function whose endpoint refused anonymous requests stops with a message and sends nothing', async () => {
    site.reset();
    const run = await LoginShell.run([file, me], dir, { APPII_COOKIE_JAR: join(dir, 'none', 'jar.txt') });
    assert.equal(run.code, 2);
    assert.equal(run.stderr.trim(), `${me}: no bearer token: run ${login} first or set APPII_ACCESS_TOKEN.`);
    assert.deepEqual(site.requests, []);
  });

  test('without a token, a function whose anonymous access was not tested warns and sends no authorization header at all', async () => {
    site.reset();
    const run = await LoginShell.run([file, notes], dir, { APPII_COOKIE_JAR: join(dir, 'untested-jar.txt'), APPII_TOKEN_FILE: join(dir, 'absent-token.txt') });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, new RegExp(`^${notes}: warning: no bearer token, so the request goes without one \\(anonymous access was not tested\\): run ${login} first or set APPII_ACCESS_TOKEN\\.`));
    assert.deepEqual(BearerScript.authorizations(site, '/api/notes'), ['']);
  });

  test('the login function saves the token next to the cookie jar, readable only by the user, and the functions called after it send it', async () => {
    site.reset();
    const jar = join(dir, 'run-jar.txt');
    const first = await LoginShell.run([file, login, 'username=bearer-user', 'password=pw'], dir, { APPII_COOKIE_JAR: jar });
    assert.equal(first.code, 0, first.stderr);
    assert.equal(first.stderr, '');
    const token = (JSON.parse(first.stdout) as { token: string }).token;
    const saved = join(dir, BearerScript.tokenFile(model));
    assert.equal(await readFile(saved, 'utf8'), `${token}\n`);
    assert.equal(((await stat(saved)).mode & 0o777).toString(8), '600');
    const profile = await LoginShell.run([file, me], dir, { APPII_COOKIE_JAR: jar });
    assert.equal(profile.code, 0, profile.stderr);
    assert.deepEqual(JSON.parse(profile.stdout), { name: 'bearer-user' });
    const list = await LoginShell.run([file, notes], dir, { APPII_COOKIE_JAR: jar });
    assert.equal(list.stderr, '');
    assert.deepEqual(JSON.parse(list.stdout), [{ id: 1, text: 'note of bearer-user' }]);
    assert.deepEqual(BearerScript.authorizations(site, '/api/me'), [`Bearer ${token}`]);
    assert.deepEqual(BearerScript.authorizations(site, '/api/notes'), [`Bearer ${token}`]);
  });

  test('sourced in one shell: login with -i, protected calls, logout deletes the token file, and the protected call stops again', async () => {
    site.reset();
    const tokenFile = join(dir, 'shell-token.txt');
    const run = await LoginShell.run(
      LoginShell.script([
        `source ${JSON.stringify(file)}`,
        `${login} username=shell-user password=pw -i > /dev/null`,
        `${me}; echo`,
        `${logout} -o /dev/null`,
        '[[ -e "$APPII_TOKEN_FILE" ]] && echo still-there || echo deleted',
        `${me} || echo "stopped $?"`,
      ]),
      dir,
      { APPII_COOKIE_JAR: join(dir, 'shell-jar.txt'), APPII_TOKEN_FILE: tokenFile },
    );
    assert.equal(run.code, 0, run.stderr);
    assert.deepEqual(run.stdout.trim().split('\n'), ['{"name":"shell-user"}', 'deleted', 'stopped 2']);
    assert.match(run.stderr, new RegExp(`${me}: no bearer token: run ${login} first`));
    assert.deepEqual(site.requests.map((request) => `${request.method} ${request.path}`), ['POST /api/auth/login', 'GET /api/me', 'POST /api/logout']);
    assert.match(site.requests[2]?.authorization ?? '', /^Bearer \S+$/);
  });

  test('APPII_ACCESS_TOKEN wins over the token file, and an authorization header given as a curl argument is sent alone', async () => {
    site.reset();
    const tokenFile = join(dir, 'own-token.txt');
    await writeFile(tokenFile, 'from-the-file\n');
    const env = { APPII_COOKIE_JAR: join(dir, 'own-jar.txt'), APPII_TOKEN_FILE: tokenFile };
    await LoginShell.run([file, me], dir, { ...env, APPII_ACCESS_TOKEN: 'from-the-variable' });
    await LoginShell.run([file, me], dir, env);
    const given = await LoginShell.run([file, me, '-H', 'Authorization: Bearer from-the-argument'], dir, { ...env, APPII_TOKEN_FILE: join(dir, 'absent.txt') });
    assert.equal(given.code, 0, given.stderr);
    assert.deepEqual(BearerScript.authorizations(site, '/api/me'), ['Bearer from-the-variable', 'Bearer from-the-file', 'Bearer from-the-argument']);
  });

  test('a refused login leaves the token file as it was and says why', async () => {
    site.reset();
    const tokenFile = join(dir, 'kept-token.txt');
    await writeFile(tokenFile, 'earlier-token\n');
    const run = await LoginShell.run([file, login, 'username=x', 'password=pw', '--data-raw', 'not-json'], dir, { APPII_COOKIE_JAR: join(dir, 'kept-jar.txt'), APPII_TOKEN_FILE: tokenFile });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, '{"error":"bad json"}');
    assert.equal(run.stderr.trim(), `${login}: warning: the response has no bearer token in token, so APPII_TOKEN_FILE was not changed.\n${login}: the curl arguments --data-raw change the request or the response.`);
    assert.equal(await readFile(tokenFile, 'utf8'), 'earlier-token\n');
  });

  test('the login function saves the token whatever curl output arguments are given, and writes the response where they say (LV4-4)', async () => {
    const env = (name: string) => ({ APPII_COOKIE_JAR: join(dir, `${name}-jar.txt`), APPII_TOKEN_FILE: join(dir, `${name}-token.txt`), APPII_USERNAME: `${name}-user`, APPII_PASSWORD: 'pw' });
    const saved = async (name: string): Promise<string> => (await readFile(join(dir, `${name}-token.txt`), 'utf8')).trim();
    for (const [name, args] of [
      ['short', ['-o', join(dir, 'short.json')]],
      ['long', ['--output', join(dir, 'long.json')]],
      ['joined', [`-o${join(dir, 'joined.json')}`]],
      ['cluster', ['-so', join(dir, 'cluster.json')]],
      ['silent', ['-s', '-S', '-o', join(dir, 'silent.json'), '--compressed']],
    ] as const) {
      site.reset();
      const run = await LoginShell.run([file, login, ...args], dir, env(name));
      assert.equal(run.code, 0, `${name}: ${run.stderr}`);
      assert.equal(run.stdout, '', name);
      assert.equal(run.stderr, '', name);
      const written = JSON.parse(await readFile(join(dir, `${name}.json`), 'utf8')) as { token: string };
      assert.equal(await saved(name), written.token, name);
      const profile = await LoginShell.run([file, me], dir, env(name));
      assert.deepEqual(JSON.parse(profile.stdout), { name: `${name}-user` }, name);
    }
    site.reset();
    const dash = await LoginShell.run([file, login, '-o', '-'], dir, env('dash'));
    assert.equal(dash.code, 0, dash.stderr);
    assert.equal(await saved('dash'), (JSON.parse(dash.stdout) as { token: string }).token);
    site.reset();
    const headers = await LoginShell.run([file, login, '-i', '-o', join(dir, 'headers.txt')], dir, env('headers'));
    assert.equal(headers.code, 0, headers.stderr);
    assert.match(await readFile(join(dir, 'headers.txt'), 'utf8'), /^HTTP\/1\.1 200 OK\r\n[\s\S]*\r\n\r\n\{"token":"/);
    assert.ok((await saved('headers')).length > 0);
    site.reset();
    const unwritable = await LoginShell.run([file, login, '-o', join(dir, 'missing-dir', 'out.json')], dir, env('unwritable'));
    assert.equal(unwritable.code, 23);
    assert.equal(unwritable.stderr, `${login}: cannot write the response to ${join(dir, 'missing-dir', 'out.json')}.\n`);
    assert.ok((await saved('unwritable')).length > 0, 'the login happened, so its token is kept');
    for (const option of [['-O'], ['--remote-name'], ['-J'], ['--output-dir', dir], ['-sO']]) {
      site.reset();
      const refused = await LoginShell.run([file, login, ...option], dir, env('refused'));
      assert.equal(refused.code, 2, option.join(' '));
      assert.match(refused.stderr, new RegExp(`^${login}: the curl option -?-?[A-Za-z-]+ is not supported here: the function reads the response to save the bearer token\\. Use -o FILE to keep the response\\.\\n$`), option.join(' '));
      assert.deepEqual(site.requests, [], option.join(' '));
    }
  });

  test('the script documents the token file and its default, and never names a captured token or password', async () => {
    const usage = await LoginShell.run([file, 'help'], dir);
    assert.match(usage.stdout, /APPII_TOKEN_FILE file where the login function keeps the bearer token/);
    assert.ok(usage.stdout.includes(BearerScript.tokenFile(model)), usage.stdout);
    const script = await readFile(file, 'utf8');
    for (const secret of [LoginModels.TOKEN, LoginModels.PASSWORD, LoginModels.USER]) assert.ok(!script.includes(secret), secret);
    assert.ok(!/Bearer \$\{APPII_ACCESS_TOKEN\}"\s*\\\n/.test(script.split('\n').filter((line) => line.trim().startsWith('-H')).join('\n')), 'no curl command line sends the bearer header unconditionally');
  });
});

describe('the JSON reader of the curl script follows the whole field path of login.issues.tokens', () => {
  let dir = '';
  let file = '';

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-bearer-json-'));
    file = join(dir, 'endpoints.sh');
    await writeFile(file, new CurlExporter().export(BearerScript.model('http://127.0.0.1:9')).content);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const read = async (body: string, path: string): Promise<string> => {
    const input = join(dir, 'body.txt');
    await writeFile(input, body);
    const run = await LoginShell.run(LoginShell.script([`source ${JSON.stringify(file)}`, `appii_html json ${JSON.stringify(path)} < ${JSON.stringify(input)}`]), dir);
    assert.equal(run.code, 0, run.stderr);
    return run.stdout;
  };

  test('a nested path, not a key with the same name elsewhere', async () => {
    const body = JSON.stringify({ token: 'top', meta: { token: 'decoy' }, data: { session: { token: 'wanted' } }, list: [{ token: 'in-array' }] });
    assert.equal(await read(body, 'data.session.token'), 'wanted');
    assert.equal(await read(body, 'token'), 'top');
    assert.equal(await read(body, 'missing.token'), '');
  });

  test('escapes, spaces and HTTP headers before the body (curl -i)', async () => {
    assert.equal(await read('{ "a" : [1, {"x":"y"}], "auth" : { "access_token" : "a\\/b\\u0041c\\"d" } }', 'auth.access_token'), 'a/bAc"d');
    assert.equal(await read('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"accessToken":"abc"}', 'accessToken'), 'abc');
    assert.equal(await read('{"items":[{"accessToken":"no"}],"accessToken":"yes"}', 'accessToken'), 'yes');
  });
});
