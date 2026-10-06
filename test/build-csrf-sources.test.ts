import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder, ModelValidator } from '../src/build/index.js';
import type { ApiModel, CsrfToken, Endpoint } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const ORIGIN = 'https://spa.example.test';
const TOKEN = 'Zq7Kp2Lm9Xw4Rt6Yb1Nc8Vd3';
const ANON = 'anon0c8e1d2f3a4b5c6d7e8f90';
const AUTH = 'auth9f8e7d6c5b4a3f2e1d0c9b';
const SHELL = CaptureFactory.page('Tasks', '<div id="app">Loading...</div><script src="/app.js"></script>');

function loginForm(token: string, field = '_csrf'): string {
  return CaptureFactory.page(
    'Tasks',
    `<div id="app"><h1>Sign in</h1><form method="post" action="/session"><input type="hidden" name="${field}" value="${token}"><input type="email" name="email" autocomplete="email"><input type="password" name="pass" autocomplete="current-password"><button type="submit">Sign in</button></form></div>`,
  );
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

function scriptRenderedLogin(f: CaptureFactory, field = '_csrf'): void {
  f.document('/login', SHELL, { responseHeaders: { 'set-cookie': `_spa_session=${ANON}; Path=/; HttpOnly` } });
  f.json('GET', '/api/csrf', 200, { csrfToken: TOKEN }, { pageUrl: `${ORIGIN}/login`, requestHeaders: { cookie: `_spa_session=${ANON}` } });
  f.snapshot('/login', 'Tasks', loginForm(TOKEN, field));
}

function submit(f: CaptureFactory, field = '_csrf'): void {
  f.exchange({
    method: 'POST',
    url: '/session',
    resourceType: 'document',
    pageUrl: `${ORIGIN}/login`,
    requestHeaders: { cookie: `_spa_session=${ANON}`, 'content-type': 'application/x-www-form-urlencoded' },
    requestBody: `${field}=${TOKEN}&email=ann%40example.test&pass=Sesame-2026`,
    status: 303,
    responseHeaders: { location: '/dashboard', 'set-cookie': `_spa_session=${AUTH}; Path=/; HttpOnly` },
  });
  f.document('/dashboard', SHELL, { requestHeaders: { cookie: `_spa_session=${AUTH}` } });
  f.json('GET', '/api/me', 200, { plan: 'free' }, { pageUrl: `${ORIGIN}/dashboard`, requestHeaders: { cookie: `_spa_session=${AUTH}` } });
}

const FROM_JSON: CsrfToken = { location: 'body', name: '_csrf', source: 'response', sourceName: 'csrfToken', sourceUrl: `${ORIGIN}/api/csrf`, sourceMethod: 'GET', sessionCookies: ['_spa_session'] };

describe('the CSRF token source is what the server sent, not a field that only the live page had (LL-3)', () => {
  test('a script-rendered hidden field whose value came from a JSON response: the observed login names the JSON response as the source', () => {
    const f = new CaptureFactory(ORIGIN);
    scriptRenderedLogin(f);
    submit(f);
    const login = endpoint(build(f), 'POST', '/session');
    assert.equal(login.count, 1);
    assert.deepEqual(login.auth.csrf, [FROM_JSON]);
  });

  test('the anonymous capture of the same page already names the JSON response for the login known from the form', () => {
    const f = new CaptureFactory(ORIGIN);
    scriptRenderedLogin(f);
    const login = endpoint(build(f), 'POST', '/session');
    assert.equal(login.count, 0);
    assert.equal(login.role, 'login');
    assert.deepEqual(login.auth.csrf, [FROM_JSON]);
  });

  test('a hidden field that the server rendered stays the source even when a JSON response carries the same value', () => {
    for (const observed of [false, true]) {
      const f = new CaptureFactory(ORIGIN);
      const html = loginForm(TOKEN);
      f.document('/login', html, { responseHeaders: { 'set-cookie': `_spa_session=${ANON}; Path=/; HttpOnly` } });
      f.json('GET', '/api/csrf', 200, { csrfToken: TOKEN }, { pageUrl: `${ORIGIN}/login`, requestHeaders: { cookie: `_spa_session=${ANON}` } });
      f.snapshot('/login', 'Tasks', html);
      if (observed) submit(f);
      assert.deepEqual(endpoint(build(f), 'POST', '/session').auth.csrf, [
        { location: 'body', name: '_csrf', source: 'hidden-field', sourceName: '_csrf', sourceUrl: `${ORIGIN}/login`, sessionCookies: ['_spa_session'] },
      ], observed ? 'observed' : 'form only');
    }
  });

  test('a meta tag that the server rendered and that a script copied into the form is the source', () => {
    const f = new CaptureFactory(ORIGIN);
    f.document('/login', CaptureFactory.page('Tasks', `<meta name="csrf-token" content="${TOKEN}"><div id="app"></div>`), { responseHeaders: { 'set-cookie': `_spa_session=${ANON}; Path=/; HttpOnly` } });
    f.snapshot('/login', 'Tasks', loginForm(TOKEN));
    assert.deepEqual(endpoint(build(f), 'POST', '/session').auth.csrf, [
      { location: 'body', name: '_csrf', source: 'meta', sourceName: 'csrf-token', sourceUrl: `${ORIGIN}/login`, sessionCookies: ['_spa_session'] },
    ]);
  });

  test('a double-submit cookie that a script copied into the form is the source', () => {
    const f = new CaptureFactory(ORIGIN);
    f.document('/login', SHELL, { responseHeaders: { 'set-cookie': [`_spa_session=${ANON}; Path=/; HttpOnly`, `XSRF-TOKEN=${TOKEN}; Path=/`] } });
    f.json('GET', '/api/status', 200, { ok: true }, { pageUrl: `${ORIGIN}/login`, requestHeaders: { cookie: `_spa_session=${ANON}; XSRF-TOKEN=${TOKEN}` } });
    f.snapshot('/login', 'Tasks', loginForm(TOKEN));
    assert.deepEqual(endpoint(build(f), 'POST', '/session').auth.csrf, [{ location: 'body', name: '_csrf', source: 'cookie', sourceName: 'XSRF-TOKEN' }]);
  });

  test('without any server source, the live hidden field stays the source; a JSON response that came later is not one', () => {
    const f = new CaptureFactory(ORIGIN);
    f.document('/login', SHELL, { responseHeaders: { 'set-cookie': `_spa_session=${ANON}; Path=/; HttpOnly` } });
    f.snapshot('/login', 'Tasks', loginForm(TOKEN));
    submit(f);
    f.json('GET', '/api/csrf', 200, { csrfToken: TOKEN }, { pageUrl: `${ORIGIN}/dashboard`, requestHeaders: { cookie: `_spa_session=${AUTH}` } });
    assert.deepEqual(endpoint(build(f), 'POST', '/session').auth.csrf, [
      { location: 'body', name: '_csrf', source: 'hidden-field', sourceName: '_csrf', sourceUrl: `${ORIGIN}/login`, sessionCookies: ['_spa_session'] },
    ]);
  });

  test('a field named like a form token (not like CSRF) still counts when its value came from a JSON response into a hidden field', () => {
    const f = new CaptureFactory(ORIGIN);
    scriptRenderedLogin(f, 'token');
    submit(f, 'token');
    assert.deepEqual(endpoint(build(f), 'POST', '/session').auth.csrf, [{ ...FROM_JSON, name: 'token' }]);
  });
});
