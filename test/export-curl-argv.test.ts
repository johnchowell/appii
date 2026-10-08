import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelBuilder } from '../src/build/index.js';
import { CurlExporter, MarkdownExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { Curl, Samples } from '../src/shared/index.js';
import { ShellScript } from '../src/shared/index.js';
import { ExportModel } from './helpers/export-model.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { ArgvRecorder } from './helpers/login-argv.js';
import { LoginModels } from './helpers/login-models.js';
import { LoginSite } from './helpers/login-site.js';

class ArgvCase {
  static readonly USER = 'argv-user-7Qe';
  static readonly PASSWORD = 'argv-pass-K9w2-Zt';
  static readonly BOUNDARY = '----argvBoundary0123';
  static readonly COOKIE = 'argv-cookie-Hq3v';
  static readonly ODD_PASSWORD = 'argv "odd" \\ pass';

  static basic(origin: string): ApiModel {
    return ExportModel.model([
      ExportModel.endpoint({ method: 'GET', path: '/api/basic', origin, auth: { cookies: ['session'], headers: ['authorization'], anonymous: 'refused', bearer: false, csrf: [], schemes: ['basic'], sets: [['http:basic', 'cookie:session']] } }),
    ]);
  }

  static multipart(origin: string): ApiModel {
    const f = new CaptureFactory(origin);
    const html = CaptureFactory.page(
      'Sign in',
      '<form action="/api/session" method="post" enctype="multipart/form-data"><input type="text" name="login" autocomplete="username"><input type="password" name="secret"><input type="hidden" name="workspace" value="main"><button>Sign in</button></form>',
    );
    f.document('/signin', html);
    f.snapshot('/signin', 'Sign in', html);
    const part = (name: string, value: string): string => `--${ArgvCase.BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    f.json('POST', '/api/session', 200, { ok: true }, {
      pageUrl: f.url('/signin'),
      requestHeaders: { 'content-type': `multipart/form-data; boundary=${ArgvCase.BOUNDARY}` },
      requestBody: `${part('login', 'mara.k')}${part('secret', 'captured-secret-1')}${part('workspace', 'main')}--${ArgvCase.BOUNDARY}--\r\n`,
    });
    const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
    return LoginModels.mark(model, [
      { method: 'POST', path: '/api/session', role: 'login', login: { evidence: 'observed', identifier: 'login', password: 'secret', issues: { cookies: [], tokens: [] } }, anonymous: 'allowed', seen: ['anonymous'] },
    ]);
  }

  static block(markdown: string, path: string): string {
    const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
    const block = new RegExp('```bash\\n((?:: [^\\n]*&& )?curl -sS -X POST [^\\n]*' + escaped + "'?\"?[\\s\\S]*?)\\n```").exec(markdown)?.[1];
    assert.ok(block, markdown);
    return block;
  }

  static steps(markdown: string): string[] {
    const block = /\*\*Session steps\*\*[\s\S]*?```bash\n([\s\S]*?)\n```/.exec(markdown)?.[1];
    assert.ok(block, markdown);
    return block.split('\n');
  }

  static function(model: ApiModel, method: string, path: string): string {
    return ShellScript.functionName(LoginModels.endpoint(model, method, path).name);
  }
}

describe('no credential value reaches the argv of any process that the curl script or the documented commands start (QL4-1)', () => {
  const site = new LoginSite();
  let dir = '';
  let recorder: ArgvRecorder;

  before(async () => {
    await site.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-argv-'));
    recorder = new ArgvRecorder(dir);
    await recorder.install();
  });

  after(async () => {
    await site.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test('the form login function sends the user name and the password from the environment through a file descriptor, never as an argument', async () => {
    const model = LoginModels.form(site.origin);
    const file = join(dir, 'form.sh');
    await writeFile(file, new CurlExporter().export(model).content);
    site.reset();
    await recorder.clear();
    const jar = join(dir, 'form-jar.txt');
    const login = await recorder.run([file, 'postLogin'], dir, { APPII_COOKIE_JAR: jar, APPII_USERNAME: ArgvCase.USER, APPII_PASSWORD: ArgvCase.PASSWORD });
    assert.equal(login.code, 0, login.stderr);
    assert.doesNotMatch(login.stderr, /command not found/);
    const posted = new URLSearchParams(site.requests.find((request) => request.method === 'POST')?.body ?? '');
    assert.equal(posted.get('username'), ArgvCase.USER);
    assert.equal(posted.get('password'), ArgvCase.PASSWORD);
    assert.ok((await recorder.commands()).includes('curl'), 'the recorder saw curl');
    assert.deepEqual(await recorder.carrying([ArgvCase.PASSWORD, ArgvCase.USER]), []);
    const account = await recorder.run([file, 'getAccountPage'], dir, { APPII_COOKIE_JAR: jar });
    assert.match(account.stdout, new RegExp(`Account of ${ArgvCase.USER}`));
  });

  test('the documented session steps read the password into its variable, so no process sees it as an argument', async () => {
    const model = LoginModels.form(site.origin);
    const markdown = new MarkdownExporter().export(model).content;
    await writeFile(join(dir, 'endpoints.sh'), new CurlExporter().export(model).content);
    const steps = ArgvCase.steps(markdown).filter((line) => !line.startsWith('appii '));
    assert.ok(steps.some((line) => /\bread -rs APPII_PASSWORD\b/.test(line)), steps.join('\n'));
    assert.ok(steps.every((line) => !/password=/.test(line)), steps.join('\n'));
    site.reset();
    await recorder.clear();
    const script = steps.map((line) => line.replace(/=VALUE\b/g, `=${ArgvCase.USER}`)).join('\n');
    const run = await recorder.run(['-c', script], dir, { APPII_COOKIE_JAR: join(dir, 'steps-jar.txt') }, `${ArgvCase.PASSWORD}\n`);
    assert.equal(run.code, 0, run.stderr);
    const posted = new URLSearchParams(site.requests.find((request) => request.method === 'POST')?.body ?? '');
    assert.equal(posted.get('password'), ArgvCase.PASSWORD);
    assert.deepEqual(await recorder.carrying([ArgvCase.PASSWORD]), []);
  });

  test('the one-command example of the login sends the credentials through a file descriptor', async () => {
    const model = LoginModels.form(site.origin);
    const block = ArgvCase.block(new MarkdownExporter().export(model).content, '/login');
    site.reset();
    await recorder.clear();
    const run = await recorder.run(['-c', block], dir, { APPII_CSRF_TOKEN: 'any-token', APPII_SESSION: 'any-session', APPII_USERNAME: ArgvCase.USER, APPII_PASSWORD: ArgvCase.PASSWORD });
    assert.doesNotMatch(run.stderr, /command not found/);
    const posted = new URLSearchParams(site.requests.find((request) => request.method === 'POST')?.body ?? '');
    assert.equal(posted.get('password'), ArgvCase.PASSWORD);
    assert.equal(posted.get('username'), ArgvCase.USER);
    assert.equal(posted.get('csrf_token'), 'any-token');
    assert.deepEqual(await recorder.carrying([ArgvCase.PASSWORD, ArgvCase.USER]), []);
  });

  test('the bearer login and the functions that send the token keep the password and the token off every argv', async () => {
    const model = LoginModels.bearer(site.origin);
    const file = join(dir, 'bearer.sh');
    await writeFile(file, new CurlExporter().export(model).content);
    const env = { APPII_COOKIE_JAR: join(dir, 'bearer-jar.txt'), APPII_TOKEN_FILE: join(dir, 'bearer-token.txt') };
    site.reset();
    await recorder.clear();
    const login = await recorder.run([file, ArgvCase.function(model, 'POST', '/api/auth/login')], dir, { ...env, APPII_USERNAME: ArgvCase.USER, APPII_PASSWORD: ArgvCase.PASSWORD });
    assert.equal(login.code, 0, login.stderr);
    const me = await recorder.run([file, ArgvCase.function(model, 'GET', '/api/me')], dir, env);
    assert.equal(me.code, 0, me.stderr);
    assert.deepEqual(JSON.parse(me.stdout), { name: ArgvCase.USER });
    const tokens = [...site.tokens.keys()];
    assert.equal(tokens.length > 0, true);
    assert.deepEqual(await recorder.carrying([ArgvCase.PASSWORD, ...tokens]), []);
  });

  test('HTTP Basic credentials and cookie values reach curl through a config on a file descriptor, never as an argument', async () => {
    const model = ArgvCase.basic(site.origin);
    const file = join(dir, 'basic.sh');
    await writeFile(file, new CurlExporter().export(model).content);
    const name = ArgvCase.function(model, 'GET', '/api/basic');
    const secrets = [ArgvCase.USER, ArgvCase.ODD_PASSWORD, ArgvCase.COOKIE];
    const expected = `Basic ${Buffer.from(`${ArgvCase.USER}:${ArgvCase.ODD_PASSWORD}`).toString('base64')}`;
    site.reset();
    await recorder.clear();
    const run = await recorder.run([file, name, '-o', '/dev/null'], dir, {
      APPII_COOKIE_JAR: join(dir, 'basic-jar.txt'),
      APPII_COOKIE: `session=${ArgvCase.COOKIE}`,
      APPII_USERNAME: ArgvCase.USER,
      APPII_PASSWORD: ArgvCase.ODD_PASSWORD,
    });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(site.requests.at(-1)?.authorization, expected);
    assert.equal(site.requests.at(-1)?.cookie, `session=${ArgvCase.COOKIE}`);
    assert.ok((await recorder.commands()).includes('curl'), 'the recorder saw curl');
    assert.deepEqual(await recorder.carrying(secrets), []);
    const example = Curl.curlCommand(Samples.requestSample(LoginModels.endpoint(model, 'GET', '/api/basic'), { baseUrl: site.origin }), { variables: 'shell' });
    site.reset();
    await recorder.clear();
    const shell = await recorder.run(['-c', `${example} -o /dev/null`], dir, { APPII_SESSION: ArgvCase.COOKIE, APPII_USERNAME: ArgvCase.USER, APPII_PASSWORD: ArgvCase.ODD_PASSWORD });
    assert.equal(shell.code, 0, `${example}\n${shell.stderr}`);
    assert.equal(site.requests.at(-1)?.authorization, expected);
    assert.equal(site.requests.at(-1)?.cookie, `session=${ArgvCase.COOKIE}`);
    assert.deepEqual(await recorder.carrying(secrets), []);
  });

  test('a multipart login whose password field has another name sends its parts through a file descriptor, with a Content-Length like a browser', async () => {
    const model = ArgvCase.multipart(site.origin);
    const file = join(dir, 'multipart.sh');
    await writeFile(file, new CurlExporter().export(model).content);
    const name = ArgvCase.function(model, 'POST', '/api/session');
    site.reset();
    await recorder.clear();
    const run = await recorder.run([file, name, '-o', '/dev/null'], dir, { APPII_COOKIE_JAR: join(dir, 'multipart-jar.txt'), APPII_LOGIN: ArgvCase.USER, APPII_SECRET: ArgvCase.PASSWORD });
    assert.equal(run.code, 0, run.stderr);
    const posted = site.requests.find((request) => request.method === 'POST');
    const body = posted?.body ?? '';
    assert.equal(posted?.headers['transfer-encoding'], undefined);
    assert.equal(posted?.headers['content-length'], String(Buffer.byteLength(body)));
    assert.match(posted?.headers['content-type'] ?? '', /^multipart\/form-data; boundary=/);
    assert.match(body, new RegExp(`name="secret"\\r\\n\\r\\n${ArgvCase.PASSWORD}\\r\\n`));
    assert.match(body, new RegExp(`name="login"\\r\\n\\r\\n${ArgvCase.USER}\\r\\n`));
    assert.match(body, /name="workspace"\r\n\r\nmain\r\n/);
    assert.deepEqual(await recorder.carrying([ArgvCase.PASSWORD, ArgvCase.USER]), []);
    await recorder.clear();
    site.reset();
    const block = ArgvCase.block(new MarkdownExporter().export(model).content, '/api/session');
    const example = await recorder.run(['-c', `${block} -o /dev/null`], dir, { APPII_LOGIN: ArgvCase.USER, APPII_SECRET: ArgvCase.PASSWORD });
    assert.equal(example.code, 0, example.stderr);
    assert.match(site.requests.find((request) => request.method === 'POST')?.body ?? '', new RegExp(`name="secret"\\r\\n\\r\\n${ArgvCase.PASSWORD}\\r\\n`));
    assert.deepEqual(await recorder.carrying([ArgvCase.PASSWORD, ArgvCase.USER]), []);
  });
});
