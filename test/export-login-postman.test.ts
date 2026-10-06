import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { PostmanExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { LoginModels } from './helpers/login-models.js';

type Item = {
  name: string;
  event?: { listen: string; script: { type: string; exec: string[] } }[];
  request: { method: string; description: string; url: { raw: string }; body?: { urlencoded?: { key: string; value: string }[] } };
};
type Collection = { info: { description: string }; item: { name: string; item: Item[] }[]; variable: { key: string; value: string; description?: string }[] };

const ORIGIN = 'https://quotes.example.test';
const nodeRequire = createRequire(import.meta.url);

function collection(model: ApiModel): Collection {
  return JSON.parse(new PostmanExporter().export(model).content) as Collection;
}

function folder(doc: Collection, name: string): Item[] {
  const found = doc.item.find((each) => each.name === name);
  assert.ok(found, doc.item.map((each) => each.name).join(', '));
  return found.item;
}

function sandbox(exec: readonly string[], response: { text: string; headers?: Record<string, string>; cookies?: Record<string, string> }): Map<string, string> {
  const variables = new Map<string, string>();
  const pm = {
    response: {
      text: (): string => response.text,
      json: (): unknown => JSON.parse(response.text) as unknown,
      headers: { get: (name: string): string | undefined => Object.entries(response.headers ?? {}).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] },
    },
    cookies: { get: (name: string): string | undefined => response.cookies?.[name] },
    collectionVariables: { set: (name: string, value: string): void => void variables.set(name, value) },
  };
  new Function('pm', 'require', exec.join('\n'))(pm, nodeRequire);
  return variables;
}

describe('Postman carries the login flow (L3, QL-7, QL-8, QL-9)', () => {
  test('in its folder the login follows only the page that holds its CSRF token, and that page stores the token for it', () => {
    const doc = collection(LoginModels.form(ORIGIN));
    const items = folder(doc, 'login');
    assert.deepEqual(items.map((item) => `${item.request.method} ${item.request.url.raw}`), ['GET {{baseUrl}}/login', 'POST {{baseUrl}}/login']);
    const page = items[0];
    assert.equal(page?.event?.[0]?.listen, 'test');
    const login = items[1];
    assert.deepEqual(login?.request.body?.urlencoded?.map((entry) => [entry.key, entry.value]), [['csrf_token', '{{csrf_token}}'], ['username', '{{username}}'], ['password', '{{password}}']]);
    const stored = sandbox(page?.event?.[0]?.script.exec ?? [], { text: LoginModels.loginPage('page-token-123') });
    assert.deepEqual([...stored], [['csrf_token', 'page-token-123']]);
  });

  test('the login request describes what it sends and issues, and the variables for the user name and password have no value', () => {
    const doc = collection(LoginModels.form(ORIGIN));
    const login = folder(doc, 'login')[1];
    const description = login?.request.description ?? '';
    assert.match(description, /Login: sends the user name in `username` and the password in `password`, and issues the cookie `session`\./);
    assert.match(description, /Set the collection variables `username` and `password` before sending; they have no default\./);
    assert.match(description, /Postman's cookie jar keeps the cookies it sets/);
    assert.match(description, /Send "Get login page" \(GET \/login\) first: its test script stores the token in `\{\{csrf_token\}\}`\./);
    for (const key of ['username', 'password']) {
      const variable = doc.variable.find((each) => each.key === key);
      assert.equal(variable?.value, '');
      assert.match(variable?.description ?? '', /no default/);
    }
  });

  test('a protected request says the anonymous state and which request logs in', () => {
    const doc = collection(LoginModels.form(ORIGIN));
    const page = doc.item.flatMap((each) => each.item).find((item) => item.request.url.raw.includes('/page/'));
    assert.match(page?.request.description ?? '', /Anonymous access: not tested: no request without credentials was captured\./);
    assert.match(page?.request.description ?? '', /Log in first with "Post login" \(POST \/login\)\./);
  });

  test('the collection holds no captured credential value', () => {
    const text = new PostmanExporter().export(LoginModels.form(ORIGIN)).content;
    for (const secret of [LoginModels.USER, LoginModels.PASSWORD, LoginModels.AUTH_SESSION, LoginModels.ANON_SESSION, LoginModels.CSRF]) assert.ok(!text.includes(secret), secret);
  });

  test('a token in a meta element, in a JSON response and in a cookie is stored by the script of its source', () => {
    const model = LoginModels.bearer(ORIGIN);
    const login = LoginModels.endpoint(model, 'POST', '/api/auth/login');
    const notes = LoginModels.endpoint(model, 'GET', '/api/notes');
    login.auth.csrf = [{ location: 'header', name: 'X-CSRF-Token', source: 'meta', sourceName: 'csrf-token', sourceUrl: `${ORIGIN}/app` }];
    notes.auth.csrf = [{ location: 'header', name: 'X-Request-Token', source: 'response', sourceName: 'requestToken', sourceUrl: `${ORIGIN}/api/me` }];
    const me0 = LoginModels.endpoint(model, 'GET', '/api/me');
    me0.auth.csrf = [{ location: 'header', name: 'X-XSRF-TOKEN', source: 'cookie', sourceName: 'XSRF-TOKEN' }];
    const app0 = LoginModels.endpoint(model, 'GET', '/app');
    model.cookies.push({ name: 'XSRF-TOKEN', domain: 'quotes.example.test', path: '/', httpOnly: false, secure: true, sameSite: 'Lax', session: true, expires: null, role: 'csrf', setBy: [app0.id], usedBy: [me0.id], valueExample: 'x' });
    const doc = collection(model);
    const items = doc.item.flatMap((each) => each.item);
    const app = items.find((item) => item.request.url.raw === '{{baseUrl}}/app');
    const meta = sandbox(app?.event?.[0]?.script.exec ?? [], { text: '<html><head><meta name="CSRF-Token" content="m-1"></head></html>', cookies: { 'XSRF-TOKEN': 'c%3D4' } });
    assert.deepEqual([...meta].sort(), [['x_csrf_token', 'm-1'], ['xsrf_token', 'c=4']]);
    const me = items.find((item) => item.request.url.raw === '{{baseUrl}}/api/me');
    const json = sandbox(me?.event?.[0]?.script.exec ?? [], { text: JSON.stringify({ data: { requestToken: 'j-2' } }) });
    assert.deepEqual([...json], [['x_request_token', 'j-2']]);
    const header = sandbox(me?.event?.[0]?.script.exec ?? [], { text: '{}', headers: { 'X-Request-Token': 'unused', requestToken: 'h-3' } });
    assert.deepEqual([...header], [['x_request_token', 'h-3']]);
  });

  test('a Collection Runner run logs in first, sends the requests that need the login next, and logs out last (P4)', () => {
    const doc = collection(LoginModels.form(ORIGIN));
    assert.deepEqual(doc.item.map((each) => each.name), ['login', 'root', 'account', 'page', 'logout']);
    const run = doc.item.flatMap((each) => each.item.map((item) => `${item.request.method} ${item.request.url.raw}`));
    assert.deepEqual(run, ['GET {{baseUrl}}/login', 'POST {{baseUrl}}/login', 'GET {{baseUrl}}/', 'GET {{baseUrl}}/account', 'GET {{baseUrl}}/page/:page/', 'GET {{baseUrl}}/logout']);
  });

  test('a logout in the folder of the login moves to the last folder, after every request that needs the login', () => {
    const model = LoginModels.bearer(ORIGIN);
    const me = LoginModels.endpoint(model, 'GET', '/api/me');
    model.endpoints.splice(1, 0, { ...structuredClone(me), id: 'post-api-auth-logout', name: 'postAuthLogout', key: 'POST /api/auth/logout', method: 'POST', path: '/api/auth/logout', role: 'logout', auth: { ...structuredClone(me.auth), anonymous: 'untested' } });
    const doc = collection(model);
    assert.deepEqual(doc.item.map((each) => [each.name, each.item.map((item) => item.request.url.raw)]), [
      ['auth', ['{{baseUrl}}/api/auth/login']],
      ['me', ['{{baseUrl}}/api/me']],
      ['notes', ['{{baseUrl}}/api/notes']],
      ['app', ['{{baseUrl}}/app']],
      ['logout', ['{{baseUrl}}/api/auth/logout']],
    ]);
    assert.match(doc.info.description, /the logout requests come last, in the folder "logout", so the requests between them are logged in\./);
  });

  test('the folder of the page that holds the CSRF token of the login runs before the folder of the login', () => {
    const model = LoginModels.form(ORIGIN);
    const login = LoginModels.endpoint(model, 'POST', '/login');
    Object.assign(login, { path: '/session', key: 'POST /session', name: 'postSession' });
    login.auth.csrf = login.auth.csrf.map((token) => ({ ...token, sourceUrl: `${ORIGIN}/login` }));
    const doc = collection(model);
    assert.deepEqual(doc.item.slice(0, 2).map((each) => [each.name, each.item.map((item) => `${item.request.method} ${item.request.url.raw}`)]), [
      ['login', ['GET {{baseUrl}}/login']],
      ['session', ['POST {{baseUrl}}/session']],
    ]);
  });

  test('the login finds its CSRF source page even when another request that sends the same token comes first', () => {
    const model = LoginModels.form(ORIGIN);
    const login = LoginModels.endpoint(model, 'POST', '/login');
    const account = LoginModels.endpoint(model, 'GET', '/account');
    model.endpoints.unshift({ ...structuredClone(login), id: 'post-account', name: 'postAccount', key: 'POST /account', path: '/account', role: undefined, login: undefined, auth: { ...structuredClone(account.auth), csrf: structuredClone(login.auth.csrf) } } as typeof login);
    const doc = collection(model);
    const posted = folder(doc, 'login')[1];
    assert.match(posted?.request.description ?? '', /Send "Get login page" \(GET \/login\) first: its test script stores the token in `\{\{csrf_token\}\}`\./);
    assert.match(doc.info.description, /the login and the page that holds its CSRF token come first/);
  });

  test('the collection description names the login request, the variables without a default and the test scripts', () => {
    const doc = collection(LoginModels.form(ORIGIN));
    const text = doc.info.description;
    assert.match(text, /Log in with "Post login" \(POST \/login\) in the folder "login"\. Set the collection variables \{\{username\}\} and \{\{password\}\} first; they have no default\./);
    assert.match(text, /Test scripts fill variables from the responses: "Get login page" \(GET \/login\) stores the CSRF token csrf_token in \{\{csrf_token\}\}\./);
    assert.match(text, /In a Collection Runner run the login and the page that holds its CSRF token come first and the logout requests come last, in the folder "logout", so the requests between them are logged in\./);
    assert.ok(!text.includes('must be filled in before sending'), text);
    const model = LoginModels.form(ORIGIN);
    LoginModels.endpoint(model, 'GET', '/account').headerParams.push({ name: 'x-api-key', in: 'header', required: true, schema: { type: 'string' }, examples: ['<redacted>'] });
    assert.match(collection(model).info.description, /Variables without a default, to fill in before sending: \{\{x_api_key\}\}\./);
  });

  test('a login that returns a bearer token stores it in {{access_token}} with a test script, and the description says so', () => {
    const doc = collection(LoginModels.bearer(ORIGIN));
    const login = folder(doc, 'auth')[0];
    const exec = login?.event?.[0]?.script.exec ?? [];
    assert.deepEqual([...sandbox(exec, { text: JSON.stringify({ token: 'bearer-1', user: { name: 'x' } }) })], [['access_token', 'bearer-1']]);
    assert.deepEqual([...sandbox(exec, { text: JSON.stringify({ error: 'bad credentials' }) })], []);
    assert.deepEqual([...sandbox(exec, { text: 'not json' })], []);
    assert.match(login?.request.description ?? '', /Its test script stores the bearer token from the response field `token` in `\{\{access_token\}\}`/);
    assert.match(doc.info.description, /"Post auth login" \(POST \/api\/auth\/login\) stores the bearer token from the response field token in \{\{access_token\}\}/);
    assert.ok(!/Variables without a default[^\n]*access_token/.test(doc.info.description), doc.info.description);
  });
});
