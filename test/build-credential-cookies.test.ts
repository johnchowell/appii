import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import { CredentialAnalyzer, FormLinker, ModelBuilder, ModelValidator } from '../src/build/index.js';
import { CaptureMerger, CaptureSession } from '../src/capture/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import type { ApiModel, Capture, Endpoint } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

interface Site {
  server: Server;
  origin: string;
  issued: Set<string>;
}

interface OpenApi {
  paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>>;
  components?: { securitySchemes?: Record<string, { type?: string; in?: string; name?: string }> };
}

const EMAIL = 'ann.ledger@example.test';
const PASSWORD = 'Ledger-Pass-2026';

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const pair of (req.headers.cookie ?? '').split(/; */)) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
}

interface Ledger {
  readonly handle: (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void;
  readonly issued: Set<string>;
}

function ledger(name: string): Ledger {
  const sessions = new Map<string, { csrf: string; user?: string }>();
  const issued = new Set<string>();
  const open = (user?: string): string => {
    const id = randomBytes(18).toString('base64url');
    sessions.set(id, user === undefined ? { csrf: randomBytes(16).toString('hex') } : { csrf: randomBytes(16).toString('hex'), user });
    issued.add(id);
    return id;
  };
  const set = (id: string): string => `${name}=${id}; Path=/; HttpOnly; SameSite=Lax`;
  const html = (res: ServerResponse, body: string, headers: Record<string, string> = {}, status = 200): void => {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
    res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Ledger</title></head><body>${body}</body></html>`);
  };
  const redirect = (res: ServerResponse, location: string, headers: Record<string, string> = {}): void => {
    res.writeHead(302, { location, ...headers });
    res.end();
  };
  const handle = (req: IncomingMessage, res: ServerResponse, url: URL, body: string): void => {
    const id = readCookie(req, name);
    const current = id === undefined ? undefined : sessions.get(id);
    const fresh = current === undefined ? open() : undefined;
    const state = current ?? sessions.get(fresh!)!;
    const header: Record<string, string> = fresh === undefined ? {} : { 'set-cookie': set(fresh) };
    if (req.method === 'GET' && url.pathname === '/') html(res, '<h1>Ledger</h1><a href="/signin">Sign in</a>', header);
    else if (req.method === 'GET' && url.pathname === '/prices') html(res, '<h1>Prices</h1>', header);
    else if (req.method === 'GET' && url.pathname === '/signin') {
      html(
        res,
        `<form action="/signin" method="post"><input type="hidden" name="authenticity_token" value="${state.csrf}"><input type="email" name="user[email]" autocomplete="username"><input type="password" name="user[password]" autocomplete="current-password"><input type="submit" name="commit" value="Sign in"></form>`,
        header,
      );
    } else if (req.method === 'POST' && url.pathname === '/signin') {
      const form = new URLSearchParams(body);
      if (current === undefined || form.get('authenticity_token') !== current.csrf) html(res, '<p>Invalid authenticity token</p>', {}, 422);
      else {
        sessions.delete(id!);
        redirect(res, '/dashboard', { 'set-cookie': set(open(form.get('user[email]') ?? '')) });
      }
    } else if (req.method === 'GET' && url.pathname === '/dashboard') {
      if (current?.user === undefined) redirect(res, '/signin?return_to=%2Fdashboard', header);
      else html(res, `<h1>Dashboard</h1><p id="balance"></p><script>fetch('/api/balance.json').then((r) => r.json()).then((b) => { document.getElementById('balance').textContent = String(b.balance); });</script>`);
    } else if (req.method === 'GET' && url.pathname === '/api/balance.json') {
      res.writeHead(current?.user === undefined ? 401 : 200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(current?.user === undefined ? { error: 'not signed in' } : { balance: 1234.56, currency: 'EUR' }));
    } else if (req.method === 'GET' && url.pathname === '/signout') {
      if (id !== undefined) sessions.delete(id);
      redirect(res, '/', { 'set-cookie': set(open()) });
    } else html(res, '<h1>Not found</h1>', {}, 404);
  };
  return { handle, issued };
}

function start(name: string): Promise<Site> {
  const { handle, issued } = ledger(name);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handle(req, res, new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`), Buffer.concat(chunks).toString('utf8')));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, issued })));
}

function stop(site: Site | undefined): void {
  if (!site) return;
  site.server.closeAllConnections();
  site.server.close();
}

function capture(site: Site, script: (page: Page, origin: string) => Promise<void>): Promise<Capture> {
  return CaptureSession.create({ url: `${site.origin}/`, headless: true, idleMs: 300, script: (page) => script(page, site.origin) }).run();
}

function build(value: Capture): ApiModel {
  const model = ModelBuilder.create({ now: new Date(0) }).build(value);
  assert.deepEqual(new ModelValidator().validate(model), []);
  return model;
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

for (const name of ['ledger_sid', 'wordpress_logged_in_5c0f2e1a']) {
  describe(`a session cookie whose name says nothing (${name}) is a credential by what the login and the server do with it (LV2-1)`, () => {
    let site: Site | undefined;
    let model: ApiModel;

    before(async () => {
      site = await start(name);
      const anonymous = await capture(site, async (page, origin) => {
        await page.goto(`${origin}/signin`, { waitUntil: 'load' });
        await page.goto(`${origin}/prices`, { waitUntil: 'load' });
        await page.goto(`${origin}/dashboard`, { waitUntil: 'load' });
      });
      const authenticated = await capture(site, async (page, origin) => {
        await page.goto(`${origin}/signin`, { waitUntil: 'load' });
        await page.fill('input[name="user[email]"]', EMAIL);
        await page.fill('input[name="user[password]"]', PASSWORD);
        await Promise.all([page.waitForURL(`${origin}/dashboard`), page.click('input[type=submit]')]);
        await page.waitForFunction(`document.getElementById('balance').textContent !== ''`);
        await page.goto(`${origin}/prices`, { waitUntil: 'load' });
        await page.goto(`${origin}/signout`, { waitUntil: 'load' });
      });
      model = build(CaptureMerger.create().merge([{ capture: anonymous }, { capture: authenticated }]).capture);
    });

    after(() => stop(site));

    test('the login issues it, the logout revokes it and its value never reaches the model', () => {
      const login = endpoint(model, 'POST', '/signin');
      const logout = endpoint(model, 'GET', '/signout');
      assert.equal(login.role, 'login');
      assert.equal(login.login?.evidence, 'observed');
      assert.deepEqual(login.login?.issues, { cookies: [name], tokens: [] });
      assert.equal(logout.role, 'logout');
      const info = model.cookies.find((cookie) => cookie.name === name);
      assert.equal(info?.role, 'session');
      assert.deepEqual(info?.issuedBy, [login.id]);
      assert.deepEqual(info?.revokedBy, [logout.id]);
      assert.match(info?.valueExample ?? '', /^<redacted> \(\d+ characters\)$/);
      const text = JSON.stringify(model);
      assert.ok(site!.issued.size >= 4);
      for (const value of site!.issued) assert.ok(!text.includes(value.slice(0, 6)), `a prefix of ${name} reached the model`);
    });

    test('the API only fetched after login was seen authenticated, with anonymous access not tested', () => {
      const balance = endpoint(model, 'GET', '/api/balance.json');
      assert.deepEqual(balance.auth.seen, ['authenticated']);
      assert.equal(balance.auth.anonymous, 'untested');
      assert.deepEqual(balance.auth.sets, [[`cookie:${name}`]]);
      const dashboard = endpoint(model, 'GET', '/dashboard');
      assert.equal(dashboard.auth.anonymous, 'refused');
      assert.deepEqual(dashboard.auth.sets, [[`cookie:${name}`]]);
      const document = JSON.parse(ExporterRegistry.default().export(model, 'openapi').content) as OpenApi;
      const scheme = Object.entries(document.components?.securitySchemes ?? {}).find(([, value]) => value.in === 'cookie' && value.name === name)?.[0];
      assert.ok(scheme, JSON.stringify(document.components?.securitySchemes));
      assert.deepEqual(document.paths['/api/balance.json']?.get?.security, [{ [scheme]: [] }, {}]);
      assert.deepEqual(document.paths['/dashboard']?.get?.security, [{ [scheme]: [] }]);
    });

    test('the pages seen before and after login keep both states', () => {
      assert.deepEqual(endpoint(model, 'GET', '/prices').auth.seen, ['anonymous', 'authenticated']);
      assert.equal(endpoint(model, 'GET', '/prices').auth.anonymous, 'allowed');
    });
  });
}

function login(f: CaptureFactory, cookie: string, set: string[]): void {
  f.exchange({
    method: 'POST',
    url: '/session',
    resourceType: 'document',
    requestHeaders: { 'content-type': 'application/x-www-form-urlencoded', cookie },
    requestBody: 'name=ann&pass=Secret-Pass-1',
    status: 303,
    responseHeaders: [{ name: 'location', value: '/home' }, ...set.map((value) => ({ name: 'set-cookie', value }))],
  });
}

function roles(capture: Capture): Map<string, string> {
  const evidence = CredentialAnalyzer.create().analyze(capture, { passwordFields: new Set(['pass']), loginPages: FormLinker.create().loginPages(capture) });
  const names = new Set(capture.exchanges.flatMap((exchange) => [...CredentialAnalyzer.sent(exchange), ...CredentialAnalyzer.setCookies(exchange)].map((cookie) => cookie.name)));
  return new Map([...names].map((cookie) => [cookie, evidence.role(cookie)]));
}

describe('the evidence that makes a cookie a session credential, and what does not (LV2-1)', () => {
  test('framework session cookies with hashed or dotted names that a login issues and later requests keep sending', () => {
    for (const name of ['SSESS4f1d2c3b', '.AspNetCore.Identity.Application', 'wordpress_sec_5c0f2e1a']) {
      const f = new CaptureFactory();
      f.document('/login', '<form method="post" action="/session"><input name="name"><input type="password" name="pass"></form>');
      login(f, '', [`${name}=Zx81-session-value-0001; path=/; httponly`]);
      f.document('/home', '<h1>Home</h1>', { requestHeaders: { cookie: `${name}=Zx81-session-value-0001` } });
      f.json('GET', '/api/me', 200, { name: 'ann' }, { requestHeaders: { cookie: `${name}=Zx81-session-value-0001` } });
      assert.equal(roles(f.capture()).get(name), 'session', name);
    }
  });

  test('a cookie the server sends again with a new value on every response (a load balancer cookie) is not a credential', () => {
    const f = new CaptureFactory();
    f.document('/login', '<form></form>', { responseHeaders: { 'set-cookie': ['AWSALB=lb-0001; path=/', 'acct_sid=anon-00000001; path=/; httponly'] } });
    login(f, 'AWSALB=lb-0001; acct_sid=anon-00000001', ['AWSALB=lb-0002; path=/', 'acct_sid=user-00000001; path=/; httponly']);
    f.document('/home', '<h1>Home</h1>', { requestHeaders: { cookie: 'AWSALB=lb-0002; acct_sid=user-00000001' }, responseHeaders: { 'set-cookie': 'AWSALB=lb-0003; path=/' } });
    f.json('GET', '/api/me', 200, {}, { requestHeaders: { cookie: 'AWSALB=lb-0003; acct_sid=user-00000001' }, responseHeaders: { 'set-cookie': 'AWSALB=lb-0004; path=/' } });
    const found = roles(f.capture());
    assert.equal(found.get('acct_sid'), 'session');
    assert.equal(found.get('AWSALB'), 'unknown');
  });

  test('a cookie set on a request that keeps sending its bearer token is not issued by a login', () => {
    const f = new CaptureFactory();
    const bearer = { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.c2lnbmF0dXJl' };
    f.json('GET', '/api/feed', 200, [], { requestHeaders: bearer, responseHeaders: { 'set-cookie': 'route=node-7; path=/' } });
    f.json('GET', '/api/feed', 200, [], { requestHeaders: { ...bearer, cookie: 'route=node-7' } });
    f.json('GET', '/api/me', 200, {}, { requestHeaders: { ...bearer, cookie: 'route=node-7' } });
    assert.equal(roles(f.capture()).get('route'), 'unknown');
  });

  test('a cookie a login answer sets is never a credential when its name says csrf, tracking or preference, or when the login failed', () => {
    const f = new CaptureFactory();
    login(f, '', ['XSRF-TOKEN=x-0001; path=/', '_ga=GA1.1.1; path=/', 'theme=dark; path=/']);
    f.document('/home', '<h1>Home</h1>', { requestHeaders: { cookie: 'XSRF-TOKEN=x-0001; _ga=GA1.1.1; theme=dark' } });
    f.exchange({
      method: 'POST',
      url: '/session',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: 'name=ann&pass=wrong-pass-2',
      status: 401,
      responseHeaders: { 'set-cookie': 'attempt_ref=r-0001; path=/' },
    });
    f.document('/login', '<h1>Login</h1>', { requestHeaders: { cookie: 'attempt_ref=r-0001' } });
    const found = roles(f.capture());
    assert.equal(found.get('XSRF-TOKEN'), 'csrf');
    assert.equal(found.get('_ga'), 'tracking');
    assert.equal(found.get('theme'), 'preference');
    assert.equal(found.get('attempt_ref'), 'unknown');
  });

  test('without a recorded login, a request refused with one value and accepted with another makes the cookie a session credential', () => {
    const f = new CaptureFactory();
    f.document('/admin', '', { status: 302, requestHeaders: { cookie: 'site_lang=en; acct_sid=anon-00000001' }, responseHeaders: { location: '/login?next=/admin' } });
    f.document('/admin', '<h1>Admin</h1>', { requestHeaders: { cookie: 'site_lang=en; acct_sid=user-00000001' } });
    const found = roles(f.capture());
    assert.equal(found.get('acct_sid'), 'session');
    assert.equal(found.get('site_lang'), 'unknown');
  });

  test('a cookie that page scripts made and the server never echoed stays unknown, even when only its value differs', () => {
    const f = new CaptureFactory();
    f.document('/', '<h1>Home</h1>');
    f.document('/admin', '', { status: 302, requestHeaders: { cookie: 'last_view=1700000000001' }, responseHeaders: { location: '/login?next=/admin' } });
    f.document('/admin', '<h1>Admin</h1>', { requestHeaders: { cookie: 'last_view=1700000000999' } });
    assert.equal(roles(f.capture()).get('last_view'), 'unknown');
  });

  test('when more than one cookie differs between the refused and the accepted request, none is named a credential by that pair', () => {
    const f = new CaptureFactory();
    f.document('/admin', '', { status: 302, responseHeaders: { location: '/login?next=/admin' } });
    f.document('/admin', '<h1>Admin</h1>', { requestHeaders: { cookie: 'site_lang=en; acct_sid=user-00000001' } });
    const found = roles(f.capture());
    assert.equal(found.get('acct_sid'), 'unknown');
    assert.equal(found.get('site_lang'), 'unknown');
  });
});

describe('the cookies an endpoint needs leave out a cookie the server replaces in every answer (LV2-1)', () => {
  test('a load balancer cookie that differs between the refused and the accepted request is not part of the credential set', () => {
    const f = new CaptureFactory();
    f.document('/login', '<form method="post" action="/session"><input name="name"><input type="password" name="pass"></form>', { responseHeaders: { 'set-cookie': 'AWSALB=lb-0001; path=/' } });
    f.document('/admin', '', { status: 302, requestHeaders: { cookie: 'AWSALB=lb-0001' }, responseHeaders: { location: '/login?next=/admin', 'set-cookie': 'AWSALB=lb-0002; path=/' } });
    login(f, 'AWSALB=lb-0002', ['AWSALB=lb-0003; path=/', 'sid=s-user-00000001; path=/; httponly']);
    f.document('/admin', '<h1>Admin</h1>', { requestHeaders: { cookie: 'AWSALB=lb-0003; sid=s-user-00000001' }, responseHeaders: { 'set-cookie': 'AWSALB=lb-0004; path=/' } });
    f.document('/admin', '<h1>Admin</h1>', { requestHeaders: { cookie: 'AWSALB=lb-0004; sid=s-user-00000001' }, responseHeaders: { 'set-cookie': 'AWSALB=lb-0005; path=/' } });
    const model = build(f.capture());
    const admin = endpoint(model, 'GET', '/admin');
    assert.deepEqual(admin.auth.sets, [['cookie:sid']]);
    assert.equal(admin.auth.anonymous, 'refused');
    assert.equal(model.cookies.find((cookie) => cookie.name === 'AWSALB')?.role, 'unknown');
  });
});
