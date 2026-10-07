import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder, ModelValidator } from '../src/build/index.js';
import type { ApiModel, Endpoint, Exchange } from '../src/model/index.js';
import { EndpointDetailPresenter, EndpointListPresenter } from '../src/present/index.js';
import { Ansi, EndpointIndex, FormSource } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import type { ExchangeSpec } from './helpers/capture-factory.js';

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

function summary(model: ApiModel, width = 300): string[] {
  return Ansi.strip(new EndpointListPresenter({ width }).render(model)).split('\n');
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
    assert.ok(
      lines.some((line) => line.replace(/^Login form: +/, '') === `on /login (username, password) has no action, so a script probably sends it; record its request without an account with appii capture ${ORIGIN}/login --headless --probe-login, or log in with --login`),
      lines.join('\n'),
    );
    assert.ok(!lines.some((line) => line.startsWith('Login: ')), lines.join('\n'));
    const narrow = summary(model, 80);
    assert.ok(narrow.every((line) => line.length <= 80 && /^[\x20-\x7e]*$/.test(line)), narrow.join('\n'));
    const start = narrow.findIndex((line) => line.startsWith('Login form:'));
    const wrapped = narrow.slice(start, start + 4).map((line) => line.trim()).join(' ');
    assert.ok(wrapped.includes(`appii capture ${ORIGIN}/login --headless --probe-login, or log in with --login`), wrapped);
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
    assert.ok(
      summary(model).some(
        (line) => line.replace(/^Login form: +/, '') === `on /login (username, password) submits to GET /login, but no request with its password was recorded; record its request without an account with appii capture ${ORIGIN}/login --headless --probe-login, or log in with --login`,
      ),
    );
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

const PROBE = { username: 'probe-user-7d1c', password: 'probe-pass-7d1c', client: 'probe-client-7d1c' };

function probe(f: CaptureFactory, spec: Partial<ExchangeSpec> = {}): Exchange {
  const exchange = f.exchange({
    method: 'POST',
    url: '/api/auth/login',
    resourceType: 'fetch',
    pageUrl: `${ORIGIN}/login`,
    requestHeaders: { 'content-type': 'application/json' },
    requestBody: { json: PROBE },
    error: 'net::ERR_BLOCKED_BY_CLIENT',
    ...spec,
  });
  exchange.source = 'probe';
  return exchange;
}

function detail(model: ApiModel, found: Endpoint): string {
  return Ansi.strip(new EndpointDetailPresenter({ width: 160 }).render({ model, ref: found.id }));
}

describe('a login request that a script of the form sends is not described as the form submitting it (LV2-5)', () => {
  test('the endpoint records that a script sent it and keeps the observed JSON type; the detail view leaves out the form enctype and submitters', () => {
    const f = new CaptureFactory(ORIGIN);
    anonymous(f);
    signIn(f);
    const model = build(f);
    const login = endpoint(model, 'POST', '/api/auth/login');
    assert.equal(login.form?.submittedBy, 'script');
    assert.equal(login.requestBody?.mimeType, 'application/json');
    assert.equal(FormSource.contentType(login), 'application/json');
    assert.equal(FormSource.describe(login, (text) => `\`${text}\``), `Sent by a script of the form \`${login.form?.selector}\` on ${ORIGIN}/login as application/json.`);
    const out = detail(model, login);
    assert.match(out, /Sent by: +a script of the form, not the form itself/);
    assert.match(out, /Sent as: +application\/json/);
    assert.doesNotMatch(out, /Enctype:|Submitter|implicit submission/);
  });

  test('a form the browser submits itself has no submittedBy and is described with its enctype', () => {
    const f = new CaptureFactory(ORIGIN);
    const html = CaptureFactory.page('Login', '<form method="post" action="/session"><input name="username"><input type="password" name="password"><button>Go</button></form>');
    f.document('/login', html);
    f.snapshot('/login', 'Login', html);
    const model = build(f);
    const login = endpoint(model, 'POST', '/session');
    assert.equal(login.role, 'login');
    assert.equal(login.form?.submittedBy, undefined);
    assert.equal(FormSource.describe(login), `Submitted by the form ${login.form?.selector} on ${ORIGIN}/login (application/x-www-form-urlencoded).`);
    assert.match(detail(model, login), /Enctype: +application\/x-www-form-urlencoded/);
  });

  test('the model validator accepts form and script as submittedBy and rejects other values', () => {
    const f = new CaptureFactory(ORIGIN);
    anonymous(f);
    signIn(f);
    const model = build(f);
    const login = endpoint(model, 'POST', '/api/auth/login');
    const at = `endpoints[${model.endpoints.indexOf(login)}].form`;
    login.form!.submittedBy = 'form';
    assert.deepEqual(new ModelValidator().validate(model), []);
    (login.form as unknown as { submittedBy: string }).submittedBy = 'page';
    assert.deepEqual(new ModelValidator().validate(model), [`${at}.submittedBy: expected one of form, script`]);
  });
});

describe('a request that appii stopped while it probed the login form gives the login endpoint its shape, never evidence (LV2-4)', () => {
  test('anonymously, the script login is known from the form with the probed body shape and content type, 0 hits and anonymous access not tested', () => {
    const f = new CaptureFactory(ORIGIN);
    anonymous(f);
    probe(f);
    const model = build(f);
    const login = endpoint(model, 'POST', '/api/auth/login');
    assert.equal(login.role, 'login');
    assert.deepEqual(login.login, { evidence: 'form', identifier: 'username', password: 'password', issues: { cookies: [], tokens: [] } });
    assert.equal(login.form?.submittedBy, 'script');
    assert.equal(login.requestBody?.mimeType, 'application/json');
    assert.deepEqual(Object.keys(login.requestBody?.schema?.properties ?? {}).sort(), ['client', 'password', 'username']);
    assert.deepEqual(login.requestBody?.examples, []);
    assert.deepEqual(login.resourceTypes, ['fetch']);
    assert.equal(login.count, 0);
    assert.deepEqual(login.samples, []);
    assert.deepEqual(login.responses, []);
    assert.equal(login.auth.anonymous, 'untested');
    assert.equal(login.auth.seen, undefined);
    assert.equal(model.source.exchanges, f.exchanges.length - 1);
    assert.deepEqual(model.forms.map((form) => form.endpoints), [[login.id]]);
    const text = JSON.stringify(model);
    for (const value of Object.values(PROBE)) assert.ok(!text.includes(value), `${value} reached the model`);
    const lines = summary(model);
    assert.ok(lines.some((line) => new RegExp(`^Login: +#${EndpointIndex.of(model).numberOf(login)} POST /api/auth/login with username and password, known from a form; not submitted yet$`).test(line)), lines.join('\n'));
  });

  test('after logging in, the recorded request is the evidence and the probe adds no hit, sample or example', () => {
    const f = new CaptureFactory(ORIGIN);
    anonymous(f);
    probe(f);
    signIn(f);
    const model = build(f);
    const login = endpoint(model, 'POST', '/api/auth/login');
    assert.equal(login.login?.evidence, 'observed');
    assert.equal(login.count, 1);
    assert.deepEqual(login.samples.map((sample) => sample.status), [200]);
    assert.equal(login.auth.anonymous, 'allowed');
    assert.deepEqual(login.auth.seen, ['anonymous']);
    assert.deepEqual(Object.keys(login.requestBody?.schema?.properties ?? {}).sort(), ['password', 'username']);
    const text = JSON.stringify(model);
    for (const value of Object.values(PROBE)) assert.ok(!text.includes(value), `${value} reached the model`);
  });

  test('a probed native form submission links the form to its action without counting as a loaded page or a hit', () => {
    const f = new CaptureFactory(ORIGIN);
    const html = CaptureFactory.page('Login', '<form method="post" action="/session"><input name="username"><input type="password" name="password"><button>Go</button></form>');
    f.document('/login', html);
    f.snapshot('/login', 'Login', html);
    probe(f, {
      url: '/session',
      resourceType: 'document',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: `username=${PROBE.username}&password=${PROBE.password}`,
    });
    const model = build(f);
    const login = endpoint(model, 'POST', '/session');
    assert.equal(login.role, 'login');
    assert.equal(login.login?.evidence, 'form');
    assert.equal(login.form?.submittedBy, undefined);
    assert.equal(login.count, 0);
    assert.equal(login.auth.anonymous, 'untested');
    assert.deepEqual(login.requestBody?.examples, []);
    const text = JSON.stringify(model);
    for (const value of [PROBE.username, PROBE.password]) assert.ok(!text.includes(value), `${value} reached the model`);
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

describe('a script login that sends the CSRF token of its form in a header is linked to the form', () => {
  const CSRF = 'csrf-6b1d9e4f2a7c3085d1e6f4a9b2c7d0e3';
  const SPA_FORM = CaptureFactory.page(
    'Tasks',
    `<div id="app"><form id="login"><input type="hidden" name="_csrf" value="${CSRF}"><input type="email" name="email" autocomplete="username"><input type="password" name="pass" autocomplete="current-password"><button type="submit">Sign in</button></form></div>`,
  );

  function capture(f: CaptureFactory, headers: Record<string, string>): void {
    f.document('/login', SHELL);
    f.snapshot('/login', 'Tasks', SPA_FORM);
    f.json('POST', '/api/login', 200, { ok: true }, {
      pageUrl: `${ORIGIN}/login`,
      requestHeaders: { 'content-type': 'application/json', ...headers },
      requestBody: { json: { email: 'someone@example.test', pass: 'Sesame-2026' } },
      responseHeaders: { 'set-cookie': `sid=${TOKEN}; Path=/; HttpOnly` },
    });
  }

  test('the token value in a request header stands for the hidden token field, so the request is the form login', () => {
    const f = new CaptureFactory(ORIGIN);
    capture(f, { 'x-csrf-token': CSRF });
    const model = build(f);
    const login = endpoint(model, 'POST', '/api/login');
    assert.equal(login.role, 'login');
    assert.equal(login.form?.submittedBy, 'script');
    assert.deepEqual(model.forms.map((form) => form.endpoints), [[login.id]]);
  });

  test('a request without the token value is not linked to the form by its other fields alone', () => {
    const f = new CaptureFactory(ORIGIN);
    capture(f, { 'x-csrf-token': 'some-other-value' });
    const model = build(f);
    assert.equal(endpoint(model, 'POST', '/api/login').form, undefined);
  });
});
