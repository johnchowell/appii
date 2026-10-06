import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Build, Capture, Shared } from '../src/index.js';
import type { Model } from '../src/index.js';
import { LOGIN_USER, startFormLoginSite, startSpaLoginSite, startTokenLoginSite } from './fixtures/login-sites.js';
import type { LoginSite } from './fixtures/login-sites.js';
import { CliHarness } from './helpers/cli-harness.js';

const ENV = { APPII_LOGIN_USERNAME: LOGIN_USER.username, APPII_LOGIN_PASSWORD: LOGIN_USER.password, NO_COLOR: '1' };

function find(model: Model.ApiModel, method: string, path: string): Model.Endpoint | undefined {
  return model.endpoints.find((endpoint) => endpoint.method === method && endpoint.path === path);
}

function listing(model: Model.ApiModel): string {
  return model.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path} (${endpoint.count})`).join(', ');
}

function setCookieValues(capture: Model.Capture, name: string): string[] {
  return capture.exchanges.flatMap((exchange) =>
    Shared.Http.getHeaderAll(exchange.response?.headers ?? [], 'set-cookie').flatMap((line) => (line.startsWith(`${name}=`) ? [line.slice(name.length + 1).split(';')[0] ?? ''] : [])),
  );
}

describe('end to end: an anonymous capture, then a logged-in capture, built into one updated model', () => {
  let site: LoginSite;
  let dir: string;
  let cli: CliHarness;

  before(async () => {
    site = await startFormLoginSite();
    dir = await mkdtemp(join(tmpdir(), 'appii-e2e-login-'));
    cli = new CliHarness(dir);
  });

  after(async () => {
    await site?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the anonymous capture already gives the login endpoint, and the update keeps it and adds what logging in found', async () => {
    const anon = await cli.run(['capture', `${site.origin}/login`, `${site.origin}/`, `${site.origin}/account`, '--headless', '--idle', '0.3', '-o', 'anon.json']);
    assert.equal(anon.code, 0, anon.stderr);
    const anonBuild = await cli.run(['build', 'anon.json', '-o', 'anon-api.json']);
    assert.equal(anonBuild.code, 0, anonBuild.stderr);
    const anonModel = await Build.ModelStore.create().load(join(dir, 'anon-api.json'));
    const formLogin = find(anonModel, 'POST', '/login');
    assert.ok(formLogin, listing(anonModel));
    assert.equal(formLogin.count, 0);
    assert.deepEqual(formLogin.form?.fields.map((field) => field.name), ['csrf_token', 'username', 'password']);
    assert.equal(formLogin.role, 'login');
    assert.deepEqual(formLogin.login, { evidence: 'form', identifier: 'username', password: 'password', issues: { cookies: [], tokens: [] } });
    assert.equal(find(anonModel, 'GET', '/account')?.auth.anonymous, 'refused', 'the protected page redirected to the login page');

    const authed = await cli.run(['capture', `${site.origin}/login`, `${site.origin}/account`, `${site.origin}/logout`, '--headless', '--idle', '0.3', '--login', 'username', '--login', 'password', '-o', 'authed.json'], { env: ENV });
    assert.equal(authed.code, 0, authed.stderr);
    const update = await cli.run(['build', 'anon.json', 'authed.json', '-o', 'api.json']);
    assert.equal(update.code, 0, update.stderr);
    const model = await Build.ModelStore.create().load(join(dir, 'api.json'));
    assert.equal(find(model, 'POST', '/login')?.count, 1, listing(model));
    assert.ok(find(model, 'POST', '/login')?.form, 'the form evidence of the anonymous capture stays');
    assert.equal(find(model, 'GET', '/account')?.count, 2, listing(model));
    assert.ok(find(model, 'GET', '/logout'), listing(model));
    assert.ok((find(model, 'GET', '/login')?.count ?? 0) >= 2, listing(model));
    assert.ok(find(model, 'GET', '/'), listing(model));
    assert.deepEqual(
      model.source.captures?.map((entry) => entry.file),
      ['anon.json', 'authed.json'],
    );
    const login = find(model, 'POST', '/login');
    assert.equal(login?.role, 'login');
    assert.equal(login?.login?.evidence, 'observed');
    assert.deepEqual(login?.login?.issues.cookies, ['session']);
    assert.equal(find(model, 'GET', '/logout')?.role, 'logout');
    assert.deepEqual(find(model, 'GET', '/logout')?.auth.seen, ['authenticated']);
    assert.deepEqual(find(model, 'GET', '/login')?.auth.seen, ['anonymous']);
    const session = model.cookies.find((cookie) => cookie.name === 'session');
    assert.deepEqual(session?.issuedBy, [login?.id]);
    assert.deepEqual(session?.revokedBy, [find(model, 'GET', '/logout')?.id]);

    const list = await cli.run(['list', 'api.json', '--width', '160']);
    assert.equal(list.code, 0, list.stderr);
    const exported = await cli.run(['export', 'api.json', '--format', 'openapi', '-o', 'openapi.json']);
    assert.equal(exported.code, 0, exported.stderr);

    const authedCapture = await Capture.CaptureStore.create().load(join(dir, 'authed.json'));
    const sessions = setCookieValues(authedCapture, 'session');
    assert.ok(sessions.length >= 2, 'the session cookie rotated at login and at logout');
    for (const file of ['api.json', 'openapi.json']) {
      const text = await readFile(join(dir, file), 'utf8');
      assert.ok(!text.includes(LOGIN_USER.password), `${file} holds the password`);
      assert.ok(!text.includes(LOGIN_USER.username), `${file} holds the login identifier`);
      for (const value of sessions) assert.ok(!text.includes(value), `${file} holds a session cookie value`);
    }
  });
});

describe('end to end: script logins are captured with --login and merged with the anonymous capture', () => {
  let dir: string;
  let cli: CliHarness;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-e2e-login-js-'));
    cli = new CliHarness(dir);
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('a single-page app: the anonymous capture sees the API refuse, the logged-in capture adds the JSON login and the API answers', async () => {
    const site = await startSpaLoginSite();
    try {
      const anon = await cli.run(['capture', `${site.origin}/`, '--headless', '-o', 'spa-anon.json']);
      assert.equal(anon.code, 0, anon.stderr);
      const authed = await cli.run(['capture', `${site.origin}/`, '--headless', '--idle', '0.5', '--login', 'username', '--login', 'password', '-o', 'spa-authed.json', '--width', '400'], { env: ENV });
      assert.equal(authed.code, 0, authed.stderr);
      assert.match(authed.stdout, /POST http:\/\/127\.0\.0\.1:\d+\/api\/login answered 200; now on http:\/\/127\.0\.0\.1:\d+\/dashboard/);
      const build = await cli.run(['build', 'spa-anon.json', 'spa-authed.json', '-o', 'spa-api.json']);
      assert.equal(build.code, 0, build.stderr);
      const model = await Build.ModelStore.create().load(join(dir, 'spa-api.json'));
      for (const [method, path] of [
        ['GET', '/api/csrf'],
        ['POST', '/api/login'],
        ['GET', '/api/me'],
        ['GET', '/api/items'],
      ] as const) {
        assert.ok(find(model, method, path), `${method} ${path} in ${listing(model)}`);
      }
      assert.deepEqual(find(model, 'GET', '/api/me')?.responses.map((response) => response.status).sort(), [200, 401]);
    } finally {
      await site.close();
    }
  });

  test('a token login: the bearer token returned in JSON is sent by the next request and stays out of the model', async () => {
    const site = await startTokenLoginSite({ bearer: true });
    try {
      const authed = await cli.run(['capture', `${site.origin}/signin`, '--headless', '--idle', '0.3', '--login', 'username', '--login', 'password', '-o', 'token.json'], { env: ENV });
      assert.equal(authed.code, 0, authed.stderr);
      const build = await cli.run(['build', 'token.json', '-o', 'token-api.json']);
      assert.equal(build.code, 0, build.stderr);
      const capture = await Capture.CaptureStore.create().load(join(dir, 'token.json'));
      const login = capture.exchanges.find((exchange) => exchange.request.method === 'POST' && exchange.request.url.endsWith('/api/auth/login'));
      const token = (Shared.Http.bodyJson(login?.response?.body) as { token?: string }).token;
      assert.ok(token);
      const model = await Build.ModelStore.create().load(join(dir, 'token-api.json'));
      assert.ok(find(model, 'POST', '/api/auth/login'), listing(model));
      assert.equal(find(model, 'GET', '/api/profile')?.auth.bearer, true);
      const text = await readFile(join(dir, 'token-api.json'), 'utf8');
      assert.ok(!text.includes(token), 'the bearer token reached api.json');
      assert.ok(!text.includes(LOGIN_USER.password), 'the password reached api.json');
    } finally {
      await site.close();
    }
  });
});
