import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { TypeScriptExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { TsClientHarness } from './fixtures/export-ts-harness.js';
import type { Module } from './fixtures/export-ts-harness.js';
import { LoginModels } from './helpers/login-models.js';
import { LoginSite } from './helpers/login-site.js';

function name(model: ApiModel, method: string, path: string): string {
  return LoginModels.endpoint(model, method, path).name;
}

describe('the TypeScript client logs in and later calls are authenticated (L3, QL-2, QL-4, QL-8)', () => {
  const site = new LoginSite();
  let harness: TsClientHarness;
  let form: ApiModel;
  let bearer: ApiModel;
  let formModule: Module;
  let bearerModule: Module;
  let formSource = '';
  let bearerSource = '';

  before(async () => {
    await site.start();
    harness = await TsClientHarness.open('appii-login-client-');
    form = LoginModels.form(site.origin);
    bearer = LoginModels.bearer(site.origin);
    const loadedForm = await harness.load(form, 'form-client.ts');
    const loadedBearer = await harness.load(bearer, 'bearer-client.ts');
    formModule = loadedForm.mod;
    bearerModule = loadedBearer.mod;
    formSource = loadedForm.source;
    bearerSource = loadedBearer.source;
  });

  after(async () => {
    await site.stop();
    await harness?.close();
  });

  test('a form login: the cookie jar and the CSRF token from the login page authenticate the next call', async () => {
    site.reset();
    const client = TsClientHarness.client(formModule, form);
    const login = await TsClientHarness.call(client, name(form, 'POST', '/login'), { body: { username: 'ts-reader', password: 'pw' } });
    assert.equal(login.status, 200);
    assert.deepEqual(site.requests.slice(0, 2).map((request) => `${request.method} ${request.path}`), ['GET /login', 'POST /login']);
    const account = await TsClientHarness.call(client, name(form, 'GET', '/account'));
    assert.equal(account.status, 200);
    assert.match(String(account.data), /Account of ts-reader/);
  });

  test('the login method throws MissingLoginError and sends nothing when the user name or the password is missing', async () => {
    site.reset();
    const client = TsClientHarness.client(formModule, form);
    await assert.rejects(TsClientHarness.call(client, name(form, 'POST', '/login'), { body: { username: 'only-user' } }), (err: Error) => {
      assert.equal(err.name, 'MissingLoginError');
      assert.match(err.message, /needs the password in the field password/);
      return true;
    });
    await assert.rejects(TsClientHarness.call(client, name(form, 'POST', '/login'), {}), /needs the user name in the field username/);
    assert.deepEqual(site.requests, []);
  });

  test('a login that returns a token: the client keeps it as the bearer token for the endpoints that need one', async () => {
    site.reset();
    const client = TsClientHarness.client(bearerModule, bearer);
    await assert.rejects(TsClientHarness.call(client, name(bearer, 'GET', '/api/me')), (err: Error) => err.name === 'MissingCredentialError');
    const early = await TsClientHarness.call(client, name(bearer, 'GET', '/api/notes'));
    assert.equal(early.status, 401, 'an endpoint whose anonymous access was not tested is sent without a token');
    const login = await TsClientHarness.call(client, name(bearer, 'POST', '/api/auth/login'), { body: { username: 'token-user', password: 'pw' } });
    assert.equal(login.status, 200);
    const me = await TsClientHarness.call(client, name(bearer, 'GET', '/api/me'));
    assert.equal(me.status, 200);
    assert.deepEqual(me.data, { name: 'token-user' });
    const notes = await TsClientHarness.call(client, name(bearer, 'GET', '/api/notes'));
    assert.equal(notes.status, 200);
    const sent = site.requests.filter((request) => request.path === '/api/me' || request.path === '/api/notes').map((request) => request.authorization);
    assert.equal(sent.length, 3);
    assert.equal(sent[0], '');
    assert.match(sent[1] ?? '', /^Bearer \S+$/);
    assert.equal(sent[1], sent[2]);
  });

  test('a logout makes the client forget the bearer token', async () => {
    const model = LoginModels.bearer(site.origin);
    const me = LoginModels.endpoint(model, 'GET', '/api/me');
    model.endpoints.push({ ...structuredClone(me), id: 'post-api-logout', name: 'postLogout', key: 'POST /api/logout', method: 'POST', path: '/api/logout', role: 'logout', auth: { ...structuredClone(me.auth), anonymous: 'untested' } });
    const mod = (await harness.load(model, 'logout-client.ts')).mod;
    const client = TsClientHarness.client(mod, model);
    await TsClientHarness.call(client, name(model, 'POST', '/api/auth/login'), { body: { username: 'bye', password: 'pw' } });
    assert.equal((await TsClientHarness.call(client, 'getMe')).status, 200);
    await TsClientHarness.call(client, 'postLogout');
    await assert.rejects(TsClientHarness.call(client, 'getMe'), (err: Error) => err.name === 'MissingCredentialError');
  });

  test('the docs name the login, the logout and the anonymous state; no credential value is in the source', () => {
    const login = name(form, 'POST', '/login');
    assert.match(formSource, /Login: sends the user name in username and the password in password, and issues the cookie session\./);
    assert.match(formSource, /Pass username and password in the request; there is no default/);
    assert.match(formSource, /Logout: revokes the cookie session\./);
    assert.match(formSource, /Sends the credential cookie session when the client has it\. Anonymous access was not tested: every captured request sent it\./);
    assert.match(formSource, new RegExp(`Log in first with client\\.${login}\\(\\)\\.`));
    assert.match(bearerSource, /The client keeps the bearer token it returns and sends it to the endpoints that take a bearer token\./);
    for (const secret of [LoginModels.USER, LoginModels.PASSWORD, LoginModels.TOKEN, LoginModels.AUTH_SESSION, LoginModels.CSRF]) {
      assert.ok(!formSource.includes(secret) && !bearerSource.includes(secret), secret);
    }
  });

  test('the generated client compiles in strict mode, and a login call without the password does not', async () => {
    const client = TypeScriptExporter.clientName(form);
    const login = name(form, 'POST', '/login');
    await writeFile(join(harness.dir, 'use-ok.ts'), `import { ${client} } from './form-client.js';\nexport async function run(): Promise<number> {\n  const c = new ${client}();\n  return (await c.${login}({ body: { username: 'u', password: 'p' } })).status;\n}\n`);
    const ok = await harness.compile(['form-client.ts', 'use-ok.ts'], true);
    assert.equal(ok.code, 0, ok.output);
    await writeFile(join(harness.dir, 'use-bad.ts'), `import { ${client} } from './form-client.js';\nexport async function run(): Promise<number> {\n  const c = new ${client}();\n  return (await c.${login}({ body: { username: 'u' } })).status;\n}\n`);
    const bad = await harness.compile(['form-client.ts', 'use-bad.ts'], true);
    assert.notEqual(bad.code, 0);
    assert.match(bad.output, /password/);
  });
});
