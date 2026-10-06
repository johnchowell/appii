import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright';
import { ModelBuilder } from '../src/build/index.js';
import { CaptureSession } from '../src/capture/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import type { ApiModel, Capture, Endpoint } from '../src/model/index.js';
import { EndpointDetailPresenter, EndpointFormatter, EndpointListPresenter } from '../src/present/index.js';
import { Credentials, Curl } from '../src/shared/index.js';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void;

interface Site {
  server: Server;
  origin: string;
}

interface Built {
  site: Site;
  capture: Capture;
  model: ApiModel;
}

interface OpenApi {
  paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>>;
  components?: { securitySchemes?: Record<string, Record<string, unknown>> };
}

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

function html(res: ServerResponse, body: string, headers: Record<string, string | string[]> = {}): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
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

async function build(handler: Handler, script: (page: Page, origin: string) => Promise<void>): Promise<Built> {
  const site = await start(handler);
  try {
    const capture = await CaptureSession.create({ url: `${site.origin}/`, headless: true, idleMs: 300, script: (page) => script(page, site.origin) }).run();
    return { site, capture, model: ModelBuilder.create({ now: new Date(0) }).build(capture) };
  } catch (err) {
    stop(site);
    throw err;
  }
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

function openapi(model: ApiModel): OpenApi {
  return JSON.parse(ExporterRegistry.default().export(model, 'openapi').content) as OpenApi;
}

function example(model: ApiModel, found: Endpoint): string {
  return Curl.curlCommand(EndpointDetailPresenter.exampleRequest(found), { variables: 'shell' });
}

function flaskLikeQuotes(): Handler {
  let anonymous = 0;
  let users = 0;
  return (req, res, url, body) => {
    const session = cookie(req, 'session');
    const loggedIn = session?.startsWith('user-') === true;
    const anonymousCookie = (): string => `session=anon-${String(++anonymous).padStart(8, '0')}; HttpOnly; Path=/`;
    if (url.pathname === '/') return html(res, `<h1>Quotes</h1><a href="/login">Login</a>${loggedIn ? '<a href="/logout">Logout</a>' : ''}`);
    if (url.pathname === '/login' && req.method === 'GET') {
      return html(res, '<form action="/login" method="post"><input type="hidden" name="csrf_token" value="tok-1234567890"><input name="username"><input type="password" name="password"><input type="submit" value="Login"></form>', { 'set-cookie': anonymousCookie() });
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      if (form.get('password')) return redirect(res, '/', { 'set-cookie': `session=user-${String(++users).padStart(8, '0')}; HttpOnly; Path=/` });
      return html(res, '<p>Error</p>');
    }
    if (url.pathname === '/logout') return redirect(res, '/', { 'set-cookie': anonymousCookie() });
    if (url.pathname === '/account') return loggedIn ? html(res, '<h1>Your account</h1>') : redirect(res, '/login');
    if (url.pathname === '/api/quotes') return json(res, { page: Number(url.searchParams.get('page') ?? '1'), quotes: [{ text: 'A quote', author: 'Jane Austen' }] });
    return json(res, { error: 'not found' }, 404);
  };
}

describe('a cookie is an auth requirement only with evidence (QTS-5, WIKI-5)', () => {
  let built: Built | undefined;

  before(async () => {
    built = await build(flaskLikeQuotes(), async (page, origin) => {
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      await page.goto(`${origin}/account`, { waitUntil: 'load' });
      await page.fill('input[name=username]', 'reader');
      await page.fill('input[name=password]', 'correct-horse-9');
      await Promise.all([page.waitForURL(`${origin}/`), page.click('input[type=submit]')]);
      await page.goto(`${origin}/account`, { waitUntil: 'load' });
      await page.goto(`${origin}/logout`, { waitUntil: 'load' });
      for (const n of [1, 2]) await page.evaluate(`fetch('/api/quotes?page=${n}').then((r) => r.text())`);
    });
  });

  after(() => stop(built?.site));

  test('an API called with the anonymous session that the logout issued is public everywhere', () => {
    const { model } = built!;
    const quotes = endpoint(model, 'GET', '/api/quotes');
    assert.deepEqual(quotes.auth.cookies, ['session']);
    assert.equal(quotes.auth.anonymous, true);
    assert.deepEqual(quotes.auth.sets, []);
    assert.deepEqual(openapi(model).paths['/api/quotes']?.get?.security ?? [], []);
    assert.deepEqual(EndpointFormatter.authLabels(quotes, Credentials.roles(model)), []);
    assert.ok(!example(model, quotes).includes(' -b '), example(model, quotes));
  });

  test('a page that redirected to the login form without the cookie needs it', () => {
    const { model } = built!;
    const account = endpoint(model, 'GET', '/account');
    assert.deepEqual(account.auth.sets, [['cookie:session']]);
    assert.notEqual(account.auth.anonymous, true);
    assert.deepEqual(openapi(model).paths['/account']?.get?.security, [{ sessionCookie: [] }]);
    assert.deepEqual(EndpointFormatter.authLabels(account, Credentials.roles(model)), ['cookie']);
    assert.ok(example(model, account).includes('-b "session=${APPII_SESSION}"'), example(model, account));
  });

  test('a page seen with and without the login is marked optional in every output', () => {
    const { model } = built!;
    const home = endpoint(model, 'GET', '/');
    assert.deepEqual(home.auth.sets, [['cookie:session']]);
    assert.equal(home.auth.anonymous, true);
    assert.deepEqual(openapi(model).paths['/']?.get?.security, [{ sessionCookie: [] }, {}]);
    assert.deepEqual(EndpointFormatter.authLabels(home, Credentials.roles(model)), ['cookie?']);
    const list = new EndpointListPresenter({ width: 200 }).render(model);
    const row = list.split('\n').find((line) => /^\| 1 \| GET +\| \/ /.test(line));
    assert.match(row ?? '', /\| cookie\? +\|/, list);
    const markdown = ExporterRegistry.default().export(model, 'markdown').content;
    assert.ok(markdown.includes('cookie session (optional)'), 'Markdown auth column');
  });

  test('the login form post is not authenticated, but its example keeps the session its CSRF token is bound to', () => {
    const { model } = built!;
    const login = endpoint(model, 'POST', '/login');
    assert.deepEqual(login.auth.sets, []);
    const token = login.auth.csrf.find((candidate) => candidate.name === 'csrf_token');
    assert.deepEqual(token?.sessionCookies, ['session']);
    assert.ok(example(model, login).includes('-b "session=${APPII_SESSION}"'), example(model, login));
    assert.deepEqual(endpoint(model, 'GET', '/logout').auth.sets, [['cookie:session']]);
  });

  test('the detail view separates credential cookies from cookies the browser merely sent', () => {
    const { model } = built!;
    const out = new EndpointDetailPresenter({ width: 160 }).render({ model, ref: endpoint(model, 'GET', '/api/quotes').id });
    assert.match(out, /Credentials: +none/);
    assert.match(out, /Anonymous: +yes/);
    assert.match(out, /Credential cookies: +none/);
    assert.match(out, /Other cookies: +session \(sent by the browser; not credentials\)/);
  });
});

function wikiLike(): Handler {
  return (_req, res, url) => {
    if (url.pathname === '/') {
      return html(
        res,
        `<h1>Wiki</h1><script>
          var id = '';
          for (var i = 0; i < 20; i++) id += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
          document.cookie = 'sitewikimwuser-sessionId=' + id + '; path=/';
          window.done = fetch('/api/rest_v1/page/summary/Alpha').then(function (r) { return r.text(); });
        </script>`,
        { 'set-cookie': ['GeoIP=US:::37.75:-97.82:v4; Path=/', 'WMF-Last-Access=06-Oct-2026; HttpOnly; Path=/'] },
      );
    }
    if (url.pathname.startsWith('/api/rest_v1/page/summary/')) return json(res, { title: url.pathname.split('/').pop(), extract: 'A letter.' });
    return json(res, { error: 'not found' }, 404);
  };
}

describe('analytics ids that page scripts create are never credentials (WIKI-2, WIKI-5)', () => {
  let built: Built | undefined;

  before(async () => {
    built = await build(wikiLike(), async (page, origin) => {
      await page.goto(`${origin}/`, { waitUntil: 'load' });
      await page.evaluate('window.done');
      await page.evaluate(`fetch('/api/rest_v1/page/summary/Beta').then((r) => r.text())`);
    });
  });

  after(() => stop(built?.site));

  test('the client-generated session id is a tracking cookie and the public API is anonymous', () => {
    const { model } = built!;
    assert.equal(model.cookies.find((info) => info.name === 'sitewikimwuser-sessionId')?.role, 'tracking');
    const summary = endpoint(model, 'GET', '/api/rest_v1/page/summary/{title}');
    assert.ok(summary.auth.cookies.includes('sitewikimwuser-sessionId'), summary.auth.cookies.join(', '));
    assert.equal(summary.auth.anonymous, true);
    assert.deepEqual(summary.auth.sets, []);
    const spec = openapi(model);
    assert.equal(spec.components?.securitySchemes, undefined);
    assert.deepEqual(EndpointFormatter.authLabels(summary, Credentials.roles(model)), []);
    assert.ok(!example(model, summary).includes(' -b '), example(model, summary));
    assert.ok(!ExporterRegistry.default().export(model, 'markdown').content.includes('cookie sitewikimwuser'));
  });
});

function httpbinLike(): Handler {
  return (req, res, url, body) => {
    const authorization = req.headers.authorization ?? '';
    if (url.pathname === '/') return html(res, '<h1>httpbin</h1>', { 'set-cookie': `visitor=${'v'.repeat(20)}0123456789abcdefghij; Path=/` });
    if (url.pathname === '/cookies/set') return redirect(res, '/cookies', { 'set-cookie': `session=${url.searchParams.get('session') ?? ''}; Path=/` });
    if (url.pathname === '/cookies') return json(res, { ok: true });
    if (url.pathname === '/bearer') return /^Bearer \S/.test(authorization) ? json(res, { authenticated: true }) : json(res, { authenticated: false }, 401);
    if (url.pathname === '/basic-auth/user/pass') {
      return authorization === `Basic ${Buffer.from('user:pass-w0rd').toString('base64')}` ? json(res, { authenticated: true, user: 'user' }) : json(res, {}, 401, { 'www-authenticate': 'Basic realm="Fake Realm"' });
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const credentials = JSON.parse(body) as { user?: { password?: string } };
      return credentials.user?.password ? json(res, { ok: true }, 200, { 'set-cookie': 'sid=s1d-authenticated-77; HttpOnly; Path=/' }) : json(res, {}, 401);
    }
    if (url.pathname === '/api/me') return authorization.startsWith('Bearer ') && cookie(req, 'sid') !== undefined ? json(res, { me: 'user' }) : json(res, {}, 401);
    return json(res, { error: 'not found' }, 404);
  };
}

describe('credentials sent together are one requirement, and HTTP schemes keep their meaning (HTTPBIN-3, HTTPBIN-9, HTTPBIN-11)', () => {
  let built: Built | undefined;

  before(async () => {
    built = await build(httpbinLike(), async (page) => {
      const calls: [string, RequestInit][] = [
        ['/cookies/set?session=abc123def', {}],
        ['/bearer', { headers: { authorization: 'Bearer test-token-123' } }],
        ['/basic-auth/user/pass', { headers: { authorization: `Basic ${Buffer.from('user:pass-w0rd').toString('base64')}` } }],
        ['/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: { email: 'a@example.com', password: 'secret-pass-1' } }) }],
        ['/api/me', { headers: { authorization: 'Bearer test-token-123' } }],
      ];
      for (const [input, init] of calls) await page.evaluate(`fetch(${JSON.stringify(input)}, ${JSON.stringify(init)}).then((r) => r.text())`);
    });
  });

  after(() => stop(built?.site));

  test('a cookie that a plain GET set is not an alternative to the bearer token', () => {
    const { model } = built!;
    const bearer = endpoint(model, 'GET', '/bearer');
    assert.deepEqual(bearer.auth.cookies, ['session', 'visitor']);
    assert.deepEqual(bearer.auth.sets, [['http:bearer']]);
    assert.deepEqual(openapi(model).paths['/bearer']?.get?.security, [{ bearerAuth: [] }]);
  });

  test('a bearer token and a login session sent together are one requirement', () => {
    const { model } = built!;
    const me = endpoint(model, 'GET', '/api/me');
    assert.deepEqual(me.auth.sets, [['cookie:sid', 'http:bearer']]);
    assert.deepEqual(openapi(model).paths['/api/me']?.get?.security, [{ sidCookie: [], bearerAuth: [] }]);
  });

  test('Basic credentials map to the http basic scheme, curl -u and Postman basic auth', () => {
    const { model } = built!;
    const basic = endpoint(model, 'GET', '/basic-auth/user/pass');
    assert.deepEqual(basic.auth.schemes, ['basic']);
    assert.deepEqual(basic.auth.sets, [['http:basic']]);
    const spec = openapi(model);
    assert.deepEqual(spec.components?.securitySchemes?.basicAuth, { type: 'http', scheme: 'basic', description: 'HTTP Basic authentication: a user name and password in the Authorization header.' });
    assert.deepEqual(spec.paths['/basic-auth/user/pass']?.get?.security, [{ basicAuth: [] }]);
    const command = example(model, basic);
    assert.ok(command.includes('-u "${APPII_USERNAME}:${APPII_PASSWORD}"'), command);
    assert.ok(!/authorization:/i.test(command), command);
    const postman = JSON.parse(ExporterRegistry.default().export(model, 'postman').content) as { item: { item?: { name: string; request: { auth?: { type: string } } }[]; name: string; request?: { auth?: { type: string } } }[] };
    const items = postman.item.flatMap((entry) => entry.item ?? [entry]);
    const auth = items.find((item) => item.name.toLowerCase().includes('basic'))?.request?.auth;
    assert.equal(auth?.type, 'basic');
    assert.match(new EndpointListPresenter({ width: 200 }).render(model).split('\n').find((line) => line.includes('| /basic-auth/user/pass')) ?? '', /\| basic +\|/);
  });

  test('cookie value examples reveal no part of a secret and at most a prefix of a long non-secret value', () => {
    const { model } = built!;
    const session = model.cookies.find((info) => info.name === 'session');
    assert.equal(session?.role, 'session');
    assert.equal(session?.valueExample, '<redacted> (9 characters)');
    const visitor = model.cookies.find((info) => info.name === 'visitor');
    assert.equal(visitor?.valueExample, 'vvvv... (40 characters)');
    const sid = model.cookies.find((info) => info.name === 'sid');
    assert.equal(sid?.valueExample, '<redacted> (20 characters)');
  });
});
