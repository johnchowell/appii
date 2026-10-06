import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import { ModelBuilder, ModelValidator } from '../src/build/index.js';
import { CaptureMerger, CaptureSession } from '../src/capture/index.js';
import type { ApiModel, Capture, Endpoint } from '../src/model/index.js';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void;

interface Site {
  server: Server;
  origin: string;
}

const USER = 'reader-one';
const PASSWORD = 'Sesame-Pass-2026';
const EMAIL = 'ann.reader@example.test';

function start(handler: Handler): Promise<Site> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handler(req, res, new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), Buffer.concat(chunks).toString('utf8')));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

function stop(site: Site | undefined): void {
  if (!site) return;
  site.server.closeAllConnections();
  site.server.close();
}

function html(res: ServerResponse, body: string, headers: Record<string, string | string[]> = {}, status = 200): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Site</title></head><body>${body}</body></html>`);
}

function json(res: ServerResponse, value: unknown, status = 200, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

function redirect(res: ServerResponse, location: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(302, { location, ...headers });
  res.end();
}

function cookie(req: IncomingMessage, name: string): string | undefined {
  for (const pair of (req.headers.cookie ?? '').split(/; */)) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
}

async function capture(site: Site, script: (page: Page, origin: string) => Promise<void>): Promise<Capture> {
  return CaptureSession.create({ url: `${site.origin}/`, headless: true, idleMs: 300, script: (page) => script(page, site.origin) }).run();
}

function build(value: Capture, redact = true): ApiModel {
  const model = ModelBuilder.create({ now: new Date(0), redact }).build(value);
  assert.deepEqual(new ModelValidator().validate(model), []);
  return model;
}

function merged(...captures: Capture[]): Capture {
  return CaptureMerger.create().merge(captures.map((value) => ({ capture: value }))).capture;
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

function classicSite(): Handler {
  const sessions = new Map<string, { csrf: string; user?: string }>();
  const open = (user?: string, csrf = randomBytes(12).toString('hex')): string => {
    const id = `${user === undefined ? 'anon' : 'user'}.${randomBytes(16).toString('hex')}`;
    sessions.set(id, user === undefined ? { csrf } : { csrf, user });
    return id;
  };
  const session = (id: string): string => `session=${id}; HttpOnly; Path=/`;
  return (req, res, url, body) => {
    const id = cookie(req, 'session');
    const state = id === undefined ? undefined : sessions.get(id);
    if (url.pathname === '/') return html(res, `<h1>Quotes</h1>${state?.user === undefined ? '<a href="/login">Login</a>' : '<a href="/logout">Logout</a>'}`);
    if (url.pathname === '/about') return html(res, '<h1>About</h1>');
    if (url.pathname === '/login' && req.method === 'GET') {
      const current = state ? id! : open();
      const csrf = sessions.get(current)!.csrf;
      return html(res, `<form action="/login" method="post"><input type="hidden" name="csrf_token" value="${csrf}"><input type="text" name="username"><input type="password" name="password"><input type="submit" value="Login"></form>`, state ? {} : { 'set-cookie': session(current) });
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      if (!state || form.get('csrf_token') !== state.csrf) return html(res, '<p>CSRF token missing or wrong</p>', {}, 400);
      if (!form.get('password')) return html(res, '<p>Error</p>');
      return redirect(res, '/', { 'set-cookie': session(open(form.get('username') ?? '', state.csrf)) });
    }
    if (url.pathname === '/account') return state?.user === undefined ? redirect(res, '/login') : html(res, '<h1>Your account</h1>');
    if (url.pathname === '/api/whoami') return json(res, { user: state?.user ?? null, plan: 'free' });
    if (url.pathname === '/quotes') return html(res, '<h1>Members quotes</h1>');
    if (url.pathname === '/logout') return redirect(res, '/', { 'set-cookie': session(open()) });
    return json(res, { error: 'not found' }, 404);
  };
}

describe('pattern (a): a server-rendered login form with a CSRF field bound to a session cookie that rotates at login (QL-1..QL-6, QL-9)', () => {
  let site: Site | undefined;
  let anonymous: Capture;
  let authenticated: Capture;

  before(async () => {
    site = await start(classicSite());
    anonymous = await capture(site, async (page, origin) => {
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      await page.goto(`${origin}/about`, { waitUntil: 'load' });
      await page.evaluate(`fetch('/api/whoami').then((r) => r.text())`);
      await page.goto(`${origin}/account`, { waitUntil: 'load' });
    });
    authenticated = await capture(site, async (page, origin) => {
      await page.goto(`${origin}/login`, { waitUntil: 'load' });
      await page.fill('input[name=username]', USER);
      await page.fill('input[name=password]', PASSWORD);
      await Promise.all([page.waitForURL(`${origin}/`), page.click('input[type=submit]')]);
      await page.goto(`${origin}/account`, { waitUntil: 'load' });
      await page.goto(`${origin}/quotes`, { waitUntil: 'load' });
      await page.evaluate(`fetch('/api/whoami').then((r) => r.text())`);
      await page.goto(`${origin}/logout`, { waitUntil: 'load' });
    });
  });

  after(() => stop(site));

  test('an anonymous capture already gives the login endpoint from the form, not submitted yet', () => {
    const model = build(anonymous);
    const login = endpoint(model, 'POST', '/login');
    assert.equal(login.count, 0);
    assert.equal(login.role, 'login');
    assert.deepEqual(login.login, { evidence: 'form', identifier: 'username', password: 'password', issues: { cookies: [], tokens: [] } });
    assert.equal(login.auth.anonymous, 'untested');
    assert.equal(login.auth.seen, undefined);
    const account = endpoint(model, 'GET', '/account');
    assert.equal(account.auth.anonymous, 'refused');
    assert.deepEqual(account.auth.seen, ['anonymous']);
    assert.equal(endpoint(model, 'GET', '/about').auth.anonymous, 'allowed');
    assert.equal(model.endpoints.some((candidate) => candidate.role === 'logout'), false);
  });

  test('after logging in, the update shows the observed login, the credential it issues, the logout and what needs the credential', () => {
    const model = build(merged(anonymous, authenticated));
    const login = endpoint(model, 'POST', '/login');
    assert.equal(login.role, 'login');
    assert.deepEqual(login.login, { evidence: 'observed', identifier: 'username', password: 'password', issues: { cookies: ['session'], tokens: [] } });
    assert.equal(login.auth.anonymous, 'allowed');
    assert.deepEqual(login.auth.seen, ['anonymous']);
    const account = endpoint(model, 'GET', '/account');
    assert.equal(account.auth.anonymous, 'refused');
    assert.deepEqual(account.auth.seen, ['anonymous', 'authenticated']);
    assert.deepEqual(account.auth.sets, [['cookie:session']]);
    const quotes = endpoint(model, 'GET', '/quotes');
    assert.equal(quotes.auth.anonymous, 'untested');
    assert.deepEqual(quotes.auth.seen, ['authenticated']);
    const logout = endpoint(model, 'GET', '/logout');
    assert.equal(logout.role, 'logout');
    assert.equal(logout.name, 'getLogout');
    assert.equal(logout.login, undefined);
    const home = endpoint(model, 'GET', '/');
    assert.equal(home.auth.anonymous, 'allowed');
    assert.deepEqual(home.auth.seen, ['anonymous', 'authenticated']);
    const about = endpoint(model, 'GET', '/about');
    assert.deepEqual(about.auth.seen, ['anonymous']);
    const session = model.cookies.find((info) => info.name === 'session');
    assert.deepEqual(session?.issuedBy, [login.id]);
    assert.deepEqual(session?.revokedBy, [logout.id]);
    assert.equal(model.endpoints.filter((candidate) => candidate.role === 'login').length, 1);
  });

  test('the logged-in capture alone also finds the login and the logout', () => {
    const model = build(authenticated);
    assert.equal(endpoint(model, 'POST', '/login').login?.evidence, 'observed');
    assert.equal(endpoint(model, 'GET', '/logout').role, 'logout');
    assert.equal(endpoint(model, 'GET', '/account').auth.anonymous, 'untested');
  });

  test('the user name typed into the login form is personal data: redacted by name and by value unless redaction is off (QL-9)', () => {
    const value = merged(anonymous, authenticated);
    const text = JSON.stringify(build(value));
    assert.ok(!text.includes(USER), 'user name in the model');
    assert.ok(!text.includes(PASSWORD), 'password in the model');
    const login = endpoint(build(value), 'POST', '/login');
    assert.deepEqual(login.requestBody?.examples.map((example) => (example as Record<string, unknown>).username), ['<redacted>']);
    const raw = JSON.stringify(build(value, false));
    assert.ok(raw.includes(USER), 'user name kept with redaction off');
  });
});

function spaSite(): Handler {
  const sessions = new Map<string, { csrf: string; email?: string }>();
  const open = (csrf: string, email?: string): string => {
    const id = randomBytes(16).toString('hex');
    sessions.set(id, email === undefined ? { csrf } : { csrf, email });
    return id;
  };
  const app = (csrf: string) => `<div id="app">Loading</div><script>
    window.csrf = ${JSON.stringify(csrf)};
    fetch('/api/me').then(function (r) { return r.text(); });
    setTimeout(function () {
      document.getElementById('app').innerHTML = '<form id="login" method="post" action="/api/session">' +
        '<input type="hidden" name="csrf" value="' + window.csrf + '">' +
        '<input type="email" name="email" autocomplete="username">' +
        '<input type="password" name="password" autocomplete="current-password">' +
        '<button type="submit">Sign in</button></form>';
      document.getElementById('login').addEventListener('submit', function (event) {
        event.preventDefault();
        var form = event.target;
        fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: form.email.value, password: form.password.value, csrf: form.csrf.value }) })
          .then(function (r) { return r.text(); })
          .then(function () { return fetch('/api/me'); })
          .then(function (r) { return r.text(); })
          .then(function () { return fetch('/api/orders'); })
          .then(function (r) { return r.text(); })
          .then(function () { document.getElementById('app').textContent = 'Signed in'; });
      });
    }, 150);
  </script>`;
  return (req, res, url, body) => {
    const id = cookie(req, 'sid');
    const state = id === undefined ? undefined : sessions.get(id);
    if (url.pathname === '/') {
      const current = state ? id! : open(randomBytes(12).toString('hex'));
      return html(res, app(sessions.get(current)!.csrf), state ? {} : { 'set-cookie': `sid=${current}; HttpOnly; Path=/; SameSite=Lax` });
    }
    if (url.pathname === '/api/session' && req.method === 'POST') {
      const sent = JSON.parse(body) as { email?: string; password?: string; csrf?: string };
      if (!state || sent.csrf !== state.csrf) return json(res, { error: 'csrf' }, 403);
      if (!sent.password) return json(res, { error: 'credentials' }, 401);
      return json(res, { ok: true }, 200, { 'set-cookie': `sid=${open(state.csrf, sent.email ?? '')}; HttpOnly; Path=/; SameSite=Lax` });
    }
    if (url.pathname === '/api/me') return state?.email === undefined ? json(res, { error: 'unauthenticated' }, 401) : json(res, { email: state.email });
    if (url.pathname === '/api/orders') return state?.email === undefined ? json(res, { error: 'unauthenticated' }, 401) : json(res, [{ id: 1, total: 9.5 }]);
    return json(res, { error: 'not found' }, 404);
  };
}

describe('pattern (b): a single-page app renders its login form after load and its JSON API refuses requests without the session cookie', () => {
  let site: Site | undefined;
  let anonymous: Capture;
  let authenticated: Capture;

  before(async () => {
    site = await start(spaSite());
    anonymous = await capture(site, async (page) => {
      await page.waitForSelector('#login input[name=email]');
      await page.waitForTimeout(400);
    });
    authenticated = await capture(site, async (page) => {
      await page.waitForSelector('#login input[name=email]');
      await page.fill('#login input[name=email]', EMAIL);
      await page.fill('#login input[name=password]', PASSWORD);
      await page.click('#login button');
      await page.waitForFunction(`document.getElementById('app').textContent === 'Signed in'`, undefined, { polling: 50 });
    });
  });

  after(() => stop(site));

  test('the anonymous capture gives the login endpoint from the late form and marks the API as refused', () => {
    const model = build(anonymous);
    const login = endpoint(model, 'POST', '/api/session');
    assert.equal(login.count, 0);
    assert.deepEqual(login.login, { evidence: 'form', identifier: 'email', password: 'password', issues: { cookies: [], tokens: [] } });
    assert.equal(login.auth.csrf.some((token) => token.name === 'csrf' && token.source === 'hidden-field'), true);
    const me = endpoint(model, 'GET', '/api/me');
    assert.equal(me.auth.anonymous, 'refused');
    assert.deepEqual(me.auth.sets, []);
  });

  test('after logging in, the JSON login issues the rotated session and the API needs it', () => {
    const model = build(merged(anonymous, authenticated));
    const login = endpoint(model, 'POST', '/api/session');
    assert.equal(login.kind, 'json');
    assert.deepEqual(login.login, { evidence: 'observed', identifier: 'email', password: 'password', issues: { cookies: ['sid'], tokens: [] } });
    assert.equal(login.auth.anonymous, 'allowed');
    const me = endpoint(model, 'GET', '/api/me');
    assert.equal(me.auth.anonymous, 'refused');
    assert.deepEqual(me.auth.sets, [['cookie:sid']]);
    assert.deepEqual(me.auth.seen, ['anonymous', 'authenticated']);
    const orders = endpoint(model, 'GET', '/api/orders');
    assert.equal(orders.auth.anonymous, 'untested');
    assert.deepEqual(orders.auth.seen, ['authenticated']);
    assert.deepEqual(model.cookies.find((info) => info.name === 'sid')?.issuedBy, [login.id]);
    assert.ok(!JSON.stringify(model).includes(EMAIL), 'the e-mail address the user signed in with');
    assert.ok(!JSON.stringify(model).includes(PASSWORD));
  });
});

function tokenSite(bearer: boolean): Handler {
  const tokens = new Set<string>();
  return (req, res, url, body) => {
    const token = bearer ? /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1] : cookie(req, 'token');
    const signedIn = token !== undefined && tokens.has(token);
    if (url.pathname === '/') return html(res, '<h1>App</h1>');
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const sent = JSON.parse(body) as { username?: string; password?: string };
      if (sent.password !== PASSWORD) return json(res, { error: 'bad credentials' }, 401, { 'set-cookie': `sid=${randomBytes(16).toString('hex')}; Path=/` });
      const issued = randomBytes(24).toString('hex');
      tokens.add(issued);
      if (bearer) return json(res, { data: { accessToken: issued, tokenType: 'Bearer' }, user: { name: sent.username } });
      return json(res, { ok: true }, 200, { 'set-cookie': `token=${issued}; HttpOnly; Path=/` });
    }
    if (url.pathname === '/api/auth/logout' && req.method === 'POST') {
      if (token !== undefined) tokens.delete(token);
      res.writeHead(204, bearer ? {} : { 'set-cookie': 'token=; Max-Age=0; Path=/' });
      return res.end();
    }
    if (url.pathname === '/api/profile') return signedIn ? json(res, { plan: 'pro' }) : json(res, { error: 'unauthenticated' }, 401);
    if (url.pathname === '/api/public') return json(res, { items: [1, 2] });
    return json(res, { error: 'not found' }, 404);
  };
}

function call(page: Page, path: string, init: Record<string, unknown> = {}): Promise<unknown> {
  return page.evaluate(`fetch(${JSON.stringify(path)}, ${JSON.stringify(init)}).then((r) => r.text())`);
}

function login(password: string): Record<string, unknown> {
  return { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: USER, password }) };
}

describe('pattern (c): a JavaScript login posts JSON and gets a session cookie', () => {
  let site: Site | undefined;
  let value: Capture;

  before(async () => {
    site = await start(tokenSite(false));
    value = await capture(site, async (page) => {
      await call(page, '/api/profile');
      await call(page, '/api/auth/login', login('Wrong-Pass-2026'));
      await call(page, '/api/public');
      await call(page, '/api/auth/login', login(PASSWORD));
      await call(page, '/api/profile');
      await call(page, '/api/auth/logout', { method: 'POST' });
    });
  });

  after(() => stop(site));

  test('the login issues the token cookie; a failed attempt issues nothing that counts as a credential', () => {
    const model = build(value);
    const signIn = endpoint(model, 'POST', '/api/auth/login');
    assert.deepEqual(signIn.login, { evidence: 'observed', identifier: 'username', password: 'password', issues: { cookies: ['token'], tokens: [] } });
    assert.equal(signIn.auth.anonymous, 'allowed');
    const open = endpoint(model, 'GET', '/api/public');
    assert.deepEqual(open.auth.sets, []);
    assert.equal(open.auth.anonymous, 'allowed');
    const profile = endpoint(model, 'GET', '/api/profile');
    assert.equal(profile.auth.anonymous, 'refused');
    assert.deepEqual(profile.auth.sets, [['cookie:token']]);
    const signOut = endpoint(model, 'POST', '/api/auth/logout');
    assert.equal(signOut.role, 'logout');
    const token = model.cookies.find((info) => info.name === 'token');
    assert.deepEqual(token?.issuedBy, [signIn.id]);
    assert.deepEqual(token?.revokedBy, [signOut.id]);
    assert.equal(model.cookies.find((info) => info.name === 'sid')?.issuedBy, undefined);
    assert.ok(!JSON.stringify(model).includes(USER));
  });
});

describe('pattern (c) variant: the JSON login returns a token that later requests send as a bearer', () => {
  let site: Site | undefined;
  let value: Capture;

  before(async () => {
    site = await start(tokenSite(true));
    value = await capture(site, async (page) => {
      await call(page, '/api/profile');
      await page.evaluate(`fetch('/api/auth/login', ${JSON.stringify(login(PASSWORD))}).then((r) => r.json()).then((body) => {
        window.accessToken = body.data.accessToken;
        return fetch('/api/profile', { headers: { authorization: 'Bearer ' + window.accessToken } });
      }).then((r) => r.text())`);
    });
  });

  after(() => stop(site));

  test('the login issues the JSON field that becomes the bearer token', () => {
    const model = build(value);
    const signIn = endpoint(model, 'POST', '/api/auth/login');
    assert.deepEqual(signIn.login, { evidence: 'observed', identifier: 'username', password: 'password', issues: { cookies: [], tokens: ['data.accessToken'] } });
    const profile = endpoint(model, 'GET', '/api/profile');
    assert.deepEqual(profile.auth.sets, [['http:bearer']]);
    assert.equal(profile.auth.anonymous, 'refused');
    assert.ok(!JSON.stringify(model).includes(USER));
  });
});
