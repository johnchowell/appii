import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder, ModelValidator } from '../src/build/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { EndpointListPresenter } from '../src/present/index.js';
import { Ansi, EndpointIndex } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const ORIGIN = 'https://notes.example.test';
const TOKEN = 'tok7f3a9c2e8b1d4f6a0c5e9b2d7f1a3c8e';
const SHELL = CaptureFactory.page('Notes', '<div id="app"></div><script src="/main.js"></script>');
const FORM = CaptureFactory.page(
  'Notes',
  '<div id="app"><h1>Sign in</h1><form id="login-form"><label>User <input name="username" autocomplete="username"></label><label>Password <input type="password" name="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form></div>',
);

function anonymous(f: CaptureFactory): void {
  f.document('/login', SHELL);
  f.json('GET', '/api/public/tips', 200, { tip: 'Write it down' }, { pageUrl: `${ORIGIN}/login` });
  f.snapshot('/login', 'Notes', FORM);
}

function signIn(f: CaptureFactory): void {
  f.json('POST', '/api/auth/login', 200, { ok: true }, {
    pageUrl: `${ORIGIN}/login`,
    requestHeaders: { 'content-type': 'application/json' },
    requestBody: { json: { username: 'note-taker', password: 'Sesame-2026' } },
    responseHeaders: { 'set-cookie': `auth_token=${TOKEN}; Path=/; HttpOnly` },
  });
  f.document('/home', SHELL, { requestHeaders: { cookie: `auth_token=${TOKEN}` } });
  f.json('GET', '/api/profile', 200, { plan: 'free' }, { pageUrl: `${ORIGIN}/home`, requestHeaders: { cookie: `auth_token=${TOKEN}` } });
}

function build(f: CaptureFactory): ApiModel {
  const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture({ startUrl: `${ORIGIN}/login` }));
  assert.deepEqual(new ModelValidator().validate(model), []);
  return model;
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((each) => `${each.method} ${each.path}`).join(', ')}`);
  return found;
}

function summary(model: ApiModel): string[] {
  return Ansi.strip(new EndpointListPresenter({ width: 200 }).render(model)).split('\n');
}

describe('the page load of a login form that a script submits is not the login endpoint (LL-4)', () => {
  test('anonymously, no endpoint is the login; the list names the login form and how to record its request', () => {
    const f = new CaptureFactory(ORIGIN);
    anonymous(f);
    const model = build(f);
    const page = endpoint(model, 'GET', '/login');
    assert.equal(page.role, undefined);
    assert.equal(page.login, undefined);
    assert.equal(page.name, 'getLoginPage');
    assert.deepEqual(page.queryParams, []);
    assert.equal(model.endpoints.some((candidate) => candidate.role === 'login'), false);
    const lines = summary(model);
    assert.ok(lines.some((line) => /^Login form: +on \/login \(username, password\) has no action, so a script probably sends it; log in with --login to record its request$/.test(line)), lines.join('\n'));
    assert.ok(!lines.some((line) => line.startsWith('Login: ')), lines.join('\n'));
  });

  test('after logging in, only the request the script sent is the login, and the form names it as its endpoint', () => {
    const f = new CaptureFactory(ORIGIN);
    anonymous(f);
    signIn(f);
    const model = build(f);
    const login = endpoint(model, 'POST', '/api/auth/login');
    assert.equal(login.role, 'login');
    assert.deepEqual(login.login, { evidence: 'observed', identifier: 'username', password: 'password', issues: { cookies: ['auth_token'], tokens: [] } });
    assert.deepEqual(model.endpoints.filter((candidate) => candidate.role === 'login').map((candidate) => candidate.id), [login.id]);
    assert.equal(endpoint(model, 'GET', '/login').role, undefined);
    assert.deepEqual(model.forms.map((form) => form.endpoints), [[login.id]]);
    const lines = summary(model);
    assert.ok(lines.some((line) => new RegExp(`^Login: +#${EndpointIndex.of(model).numberOf(login)} POST /api/auth/login with username and password, issues cookie auth_token$`).test(line)), lines.join('\n'));
    assert.ok(!lines.some((line) => line.startsWith('Login form:')), lines.join('\n'));
  });

  test('a GET login form with an explicit action is linked to the page it loads, which is not the login while no request carried the password', () => {
    const f = new CaptureFactory(ORIGIN);
    const html = CaptureFactory.page('Login', '<form method="get" action="/login"><input name="username"><input type="password" name="password"><button>Go</button></form>');
    f.document('/login', html);
    f.snapshot('/login', 'Login', html);
    const model = build(f);
    const page = endpoint(model, 'GET', '/login');
    assert.equal(page.role, undefined);
    assert.deepEqual(model.forms.map((form) => form.endpoints), [[page.id]]);
    assert.ok(summary(model).some((line) => /^Login form: +on \/login \(username, password\) submits to GET \/login, but no request with its password was recorded; log in with --login to record its request$/.test(line)));
  });

  test('a script login form whose request is nested JSON still gives the login role to that request', () => {
    const f = new CaptureFactory(ORIGIN);
    anonymous(f);
    f.json('POST', '/api/users/login', 200, { user: { name: 'n' } }, {
      pageUrl: `${ORIGIN}/login`,
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: { json: { user: { username: 'note-taker', password: 'Sesame-2026' } } },
    });
    const model = build(f);
    const login = endpoint(model, 'POST', '/api/users/login');
    assert.equal(login.role, 'login');
    assert.equal(login.login?.password, 'user.password');
    assert.equal(endpoint(model, 'GET', '/login').role, undefined);
  });
});

describe('a logout page that only runs the logout script is not the logout next to the request that revokes the credential (LL-7)', () => {
  function session(f: CaptureFactory): void {
    anonymous(f);
    signIn(f);
  }

  test('the script request that deletes the cookie is the logout; the HTML page that started it is a page', () => {
    const f = new CaptureFactory(ORIGIN);
    session(f);
    f.document('/logout', SHELL, { requestHeaders: { cookie: `auth_token=${TOKEN}` } });
    f.json('POST', '/api/auth/logout', 200, { ok: true }, {
      pageUrl: `${ORIGIN}/logout`,
      requestHeaders: { cookie: `auth_token=${TOKEN}` },
      responseHeaders: { 'set-cookie': 'auth_token=; Path=/; HttpOnly; Max-Age=0' },
    });
    f.document('/login', SHELL, { pageUrl: `${ORIGIN}/logout` });
    const model = build(f);
    const logout = endpoint(model, 'POST', '/api/auth/logout');
    assert.equal(logout.role, 'logout');
    const page = endpoint(model, 'GET', '/logout');
    assert.equal(page.role, undefined);
    assert.equal(page.name, 'getLogoutPage');
    assert.deepEqual(model.endpoints.filter((candidate) => candidate.role === 'logout').map((candidate) => candidate.id), [logout.id]);
    assert.deepEqual(model.cookies.find((cookie) => cookie.name === 'auth_token')?.revokedBy, [logout.id]);
  });

  test('a bearer logout request started by the page is the logout; the page is not', () => {
    const f = new CaptureFactory(ORIGIN);
    session(f);
    f.document('/logout', SHELL, { requestHeaders: { cookie: `auth_token=${TOKEN}` } });
    f.json('POST', '/api/auth/logout', 200, { ok: true }, { pageUrl: `${ORIGIN}/logout`, requestHeaders: { authorization: 'Bearer abcdef0123456789abcdef' } });
    const model = build(f);
    assert.equal(endpoint(model, 'POST', '/api/auth/logout').role, 'logout');
    assert.equal(endpoint(model, 'GET', '/logout').role, undefined);
  });

  test('a logout page requested with the credential that started no sign-out request stays the logout', () => {
    const f = new CaptureFactory(ORIGIN);
    session(f);
    f.document('/logout', '', { status: 302, requestHeaders: { cookie: `auth_token=${TOKEN}` }, responseHeaders: { location: '/login' } });
    const model = build(f);
    const logout = endpoint(model, 'GET', '/logout');
    assert.equal(logout.role, 'logout');
    assert.equal(logout.name, 'getLogout');
  });
});
