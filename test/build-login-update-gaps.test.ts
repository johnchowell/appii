import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import type { Page } from 'playwright';
import { ModelBuilder, ModelValidator } from '../src/build/index.js';
import type { BuildOptions } from '../src/build/index.js';
import { CaptureMerger, CaptureSession } from '../src/capture/index.js';
import { HtmlExporter, MarkdownExporter, OpenApiExporter } from '../src/export/index.js';
import type { ApiModel, Capture, Endpoint, JsonSchema } from '../src/model/index.js';
import { EndpointDetailPresenter, EndpointListPresenter } from '../src/present/index.js';
import { Ansi, EndpointIndex, Schema } from '../src/shared/index.js';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void;

interface Site {
  server: Server;
  origin: string;
}

const USER = 'reader-two';
const PASSWORD = 'Saffron-Pass-2026';

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

function capture(site: Site, script: (page: Page, origin: string) => Promise<void>): Promise<Capture> {
  return CaptureSession.create({ url: `${site.origin}/`, headless: true, idleMs: 300, script: (page) => script(page, site.origin) }).run();
}

function merged(...captures: Capture[]): Capture {
  return CaptureMerger.create().merge(captures.map((value) => ({ capture: value }))).capture;
}

function build(value: Capture, options: BuildOptions = {}): ApiModel {
  const model = ModelBuilder.create({ now: new Date(0), ...options }).build(value);
  assert.deepEqual(new ModelValidator().validate(model), []);
  return model;
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((each) => `${each.method} ${each.path}`).join(', ')}`);
  return found;
}

function lines(text: string): string[] {
  return Ansi.strip(text).split('\n');
}

function recipesSite(): Handler {
  const sessions = new Map<string, { csrf: string; user?: string }>();
  const tokens = new Set<string>();
  const open = (user?: string, csrf = randomBytes(12).toString('hex')): string => {
    const id = randomBytes(16).toString('hex');
    sessions.set(id, user === undefined ? { csrf } : { csrf, user });
    return id;
  };
  const session = (id: string): string => `_rc_session=${id}; HttpOnly; Path=/; SameSite=Lax`;
  return (req, res, url, body) => {
    const id = cookie(req, '_rc_session');
    const state = id === undefined ? undefined : sessions.get(id);
    const signedIn = state?.user !== undefined && cookie(req, 'remember_user_token') !== undefined;
    if (url.pathname === '/') return html(res, `<h1>Recipes</h1>${signedIn ? '<a href="/logout">Sign out</a>' : '<a href="/login">Sign in</a>'}`);
    if (url.pathname === '/login' && req.method === 'GET') {
      const current = state ? id! : open();
      const csrf = sessions.get(current)!.csrf;
      return html(
        res,
        `<form action="/login" method="post"><input type="hidden" name="authenticity_token" value="${csrf}"><input type="text" name="username"><input type="password" name="password"><button>Sign in</button></form>`,
        state ? {} : { 'set-cookie': session(current) },
      );
    }
    if (url.pathname === '/login' && req.method === 'POST') {
      const form = new URLSearchParams(body);
      if (!state || form.get('authenticity_token') !== state.csrf) return html(res, '<p>Invalid token</p>', {}, 422);
      if (form.get('password') !== PASSWORD) return html(res, '<p>Wrong password</p>', {}, 401);
      return redirect(res, '/account', { 'set-cookie': [session(open(form.get('username') ?? '')), `remember_user_token=${randomBytes(20).toString('hex')}; HttpOnly; Path=/; SameSite=Lax`] });
    }
    if (url.pathname === '/api/login' && req.method === 'POST') {
      const sent = JSON.parse(body) as { username?: string; password?: string };
      if (sent.password !== PASSWORD) return json(res, { error: 'credentials' }, 401);
      const token = randomBytes(24).toString('hex');
      tokens.add(token);
      return json(res, { ok: true }, 200, { 'set-cookie': `api_token=${token}; HttpOnly; Path=/; SameSite=Lax` });
    }
    if (url.pathname === '/account' || url.pathname === '/account/favorites') return signedIn ? html(res, '<h1>Your account</h1>') : redirect(res, '/login');
    if (url.pathname === '/logout') return redirect(res, '/', { 'set-cookie': [session(open()), 'remember_user_token=; Max-Age=0; Path=/'] });
    return json(res, { error: 'not found' }, 404);
  };
}

describe('pattern (a) update: the sign-out, and a page refused anonymously that the logged-in capture never visited (QL4-2, LV4-2)', () => {
  let site: Site | undefined;
  let anonymous: Capture;
  let authenticated: Capture;
  let apiLogin: Capture;

  before(async () => {
    site = await start(recipesSite());
    anonymous = await capture(site, async (page, origin) => {
      await page.goto(`${origin}/login`, { waitUntil: 'load' });
      await page.goto(`${origin}/account`, { waitUntil: 'load' });
      await page.goto(`${origin}/account/favorites`, { waitUntil: 'load' });
    });
    authenticated = await capture(site, async (page, origin) => {
      await page.goto(`${origin}/login`, { waitUntil: 'load' });
      await page.fill('input[name=username]', USER);
      await page.fill('input[name=password]', PASSWORD);
      await Promise.all([page.waitForURL(`${origin}/account`), page.click('button')]);
      await page.goto(`${origin}/logout`, { waitUntil: 'load' });
    });
    apiLogin = await capture(site, async (page) => {
      await page.evaluate(`fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASSWORD)} }) }).then((r) => r.text())`);
    });
  });

  after(() => stop(site));

  test('--no-documents keeps the sign-out navigation as the logout action, with its role, its name and the cookies it revokes (QL4-2)', () => {
    const value = merged(anonymous, authenticated);
    const full = build(value);
    const model = build(value, { includeDocuments: false });
    const login = endpoint(model, 'POST', '/login');
    const logout = endpoint(model, 'GET', '/logout');
    assert.equal(logout.role, 'logout');
    assert.equal(logout.name, 'getLogout');
    assert.equal(logout.count, 1);
    assert.equal(logout.id, endpoint(full, 'GET', '/logout').id);
    for (const name of ['_rc_session', 'remember_user_token']) {
      const info = model.cookies.find((candidate) => candidate.name === name);
      assert.deepEqual(info?.issuedBy, [login.id], name);
      assert.deepEqual(info?.revokedBy, [logout.id], name);
    }
    const documents = model.source.skipped?.find((entry) => entry.reason === 'document');
    assert.ok(documents && documents.count > 0);
    assert.ok(!documents.examples.includes('GET /logout'), documents.examples.join(', '));
    assert.ok(!model.endpoints.some((candidate) => candidate.method === 'GET' && ['/', '/login', '/account', '/account/favorites'].includes(candidate.path)), model.endpoints.map((each) => `${each.method} ${each.path}`).join(', '));
    const out = lines(new EndpointListPresenter({ width: 200 }).render(model));
    const number = EndpointIndex.of(model).numberOf(logout);
    assert.ok(out.some((line) => new RegExp(`^Logout: +#${number} GET /logout, revokes cookie _rc_session and cookie remember_user_token$`).test(line)), out.join('\n'));
  });

  test('the update predicts the credential its login issues for a page that refused every anonymous request, and says it is predicted (LV4-2)', () => {
    const model = build(merged(anonymous, authenticated));
    const login = endpoint(model, 'POST', '/login');
    assert.deepEqual(login.login?.issues, { cookies: ['_rc_session', 'remember_user_token'], tokens: [] });
    const account = endpoint(model, 'GET', '/account');
    assert.deepEqual(account.auth.sets, [['cookie:_rc_session', 'cookie:remember_user_token']]);
    assert.equal(account.auth.predicted, undefined);
    const favorites = endpoint(model, 'GET', '/account/favorites');
    assert.equal(favorites.count, 1);
    assert.equal(favorites.auth.anonymous, 'refused');
    assert.deepEqual(favorites.auth.seen, ['anonymous']);
    assert.deepEqual(favorites.auth.sets, [['cookie:_rc_session', 'cookie:remember_user_token']]);
    assert.equal(favorites.auth.predicted, true);
    assert.equal(favorites.auth.bearer, false);
    const index = EndpointIndex.of(model);
    const list = lines(new EndpointListPresenter({ width: 200 }).render(model));
    const row = list.find((line) => line.includes(' /account/favorites '));
    assert.match(row ?? '', /\| cookie\* +\|/, list.join('\n'));
    assert.match(list.join(' ').replace(/\s+/g, ' '), /a label ending in \* means the endpoint refused every request without credentials and was never requested logged in, so the credential is predicted from what its login issues/);
    const show = lines(new EndpointDetailPresenter({ width: 200 }).render({ model, ref: String(index.numberOf(favorites)) }));
    const credentials = show.find((line) => line.startsWith('Credentials:'));
    assert.equal(
      credentials?.replace(/^Credentials: +/, ''),
      `probably cookie _rc_session + cookie remember_user_token (issued by #${index.numberOf(login)} POST /login; not observed on this endpoint)`,
      show.join('\n'),
    );
    assert.ok(show.some((line) => /^Anonymous: +refused, every request without credentials was refused$/.test(line)), show.join('\n'));
  });

  test('OpenAPI, HTML and Markdown mark the predicted credential as predicted; observed credentials stay unmarked (LV4-2)', () => {
    const model = build(merged(anonymous, authenticated));
    type Operation = { description?: string; security?: Record<string, string[]>[]; 'x-appii-predicted'?: boolean; 'x-appii-anonymous'?: string };
    const doc = JSON.parse(new OpenApiExporter().export(model).content) as { paths: Record<string, Record<string, Operation>> };
    const favorites = doc.paths['/account/favorites']?.get;
    const account = doc.paths['/account']?.get;
    assert.ok(favorites && account, Object.keys(doc.paths).join(', '));
    assert.equal(favorites['x-appii-predicted'], true);
    assert.equal(favorites['x-appii-anonymous'], 'refused');
    assert.equal(favorites.security?.length, 1);
    assert.deepEqual(Object.keys(favorites.security?.[0] ?? {}).length, 2);
    assert.match(
      favorites.description ?? '',
      /Credential: probably cookie _rc_session \+ cookie remember_user_token \(issued by [^;]*POST \/login[^;]*; not observed on this endpoint\)\. It was never requested logged in, so the security requirement is predicted from what the login issues\./,
    );
    assert.equal(account['x-appii-predicted'], undefined);
    assert.doesNotMatch(account.description ?? '', /probably/);
    const html = new HtmlExporter().export(model).content;
    assert.equal(html.split('>auth*</span>').length - 1, 1, 'one predicted badge');
    assert.match(html, /title="predicted: never requested logged in; the login issues this credential">auth\*<\/span>/);
    const markdown = new MarkdownExporter().export(model).content;
    assert.match(markdown, /\| probably cookie \\_rc\\_session \+ cookie remember\\_user\\_token \(issued by the login; not observed on this endpoint\) \|/);
  });

  test('without a login that issued a credential, the refused page stays as before: credential not captured', () => {
    const model = build(anonymous);
    const favorites = endpoint(model, 'GET', '/account/favorites');
    assert.equal(favorites.auth.anonymous, 'refused');
    assert.deepEqual(favorites.auth.sets, []);
    assert.equal(favorites.auth.predicted, undefined);
  });

  test('two logins that issue different credentials make the prediction ambiguous, so the refused page is left unpredicted', () => {
    const model = build(merged(anonymous, authenticated, apiLogin));
    assert.deepEqual(endpoint(model, 'POST', '/api/login').login?.issues, { cookies: ['api_token'], tokens: [] });
    const favorites = endpoint(model, 'GET', '/account/favorites');
    assert.equal(favorites.auth.anonymous, 'refused');
    assert.deepEqual(favorites.auth.sets, []);
    assert.equal(favorites.auth.predicted, undefined);
  });
});

function tokenSite(): Handler {
  const tokens = new Set<string>();
  return (req, res, url, body) => {
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const signedIn = token !== undefined && tokens.has(token);
    if (url.pathname === '/') return html(res, '<h1>App</h1>');
    if (url.pathname === '/members') return html(res, '<h1>Members only</h1>', {}, 401);
    if (url.pathname === '/api/auth/login' && req.method === 'POST') {
      const sent = JSON.parse(body) as { username?: string; password?: string };
      if (sent.password !== PASSWORD) return json(res, { error: 'bad credentials' }, 401);
      const issued = randomBytes(24).toString('hex');
      tokens.add(issued);
      return json(res, { data: { accessToken: issued } });
    }
    if (url.pathname === '/api/profile' || url.pathname === '/api/orders') return signedIn ? json(res, { plan: 'pro' }) : json(res, { error: 'unauthenticated' }, 401);
    return json(res, { error: 'not found' }, 404);
  };
}

describe('pattern (c) bearer: an API refused anonymously and never called with the token (LV4-2)', () => {
  let site: Site | undefined;
  let value: Capture;

  before(async () => {
    site = await start(tokenSite());
    value = await capture(site, async (page, origin) => {
      await page.evaluate(`fetch('/api/orders').then((r) => r.text())`);
      await page.goto(`${origin}/members`, { waitUntil: 'load' });
      await page.evaluate(`fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: ${JSON.stringify(USER)}, password: ${JSON.stringify(PASSWORD)} }) })
        .then((r) => r.json())
        .then((body) => fetch('/api/profile', { headers: { authorization: 'Bearer ' + body.data.accessToken } }))
        .then((r) => r.text())`);
    });
  });

  after(() => stop(site));

  test('the API gets the bearer the login issues, marked predicted; a page load, which never carries a script bearer, gets nothing', () => {
    const model = build(value);
    assert.deepEqual(endpoint(model, 'POST', '/api/auth/login').login?.issues, { cookies: [], tokens: ['data.accessToken'] });
    assert.deepEqual(endpoint(model, 'GET', '/api/profile').auth.sets, [['http:bearer']]);
    const orders = endpoint(model, 'GET', '/api/orders');
    assert.equal(orders.auth.anonymous, 'refused');
    assert.deepEqual(orders.auth.seen, ['anonymous']);
    assert.deepEqual(orders.auth.sets, [['http:bearer']]);
    assert.equal(orders.auth.predicted, true);
    assert.equal(orders.auth.bearer, true);
    const members = endpoint(model, 'GET', '/members');
    assert.equal(members.auth.anonymous, 'refused');
    assert.deepEqual(members.auth.sets, []);
    assert.equal(members.auth.predicted, undefined);
  });
});

function ledgerSite(): Handler {
  const sessions = new Map<string, { csrf: string; user?: string }>();
  const open = (user?: string): string => {
    const id = randomBytes(16).toString('hex');
    sessions.set(id, user === undefined ? { csrf: randomBytes(12).toString('hex') } : { csrf: randomBytes(12).toString('hex'), user });
    return id;
  };
  const sid = (id: string): string => `ledger_sid=${id}; HttpOnly; Path=/; SameSite=Lax`;
  const app = (csrf: string): string => `<main id="root">Loading</main><script>
    setTimeout(function () {
      document.getElementById('root').innerHTML = '<form id="signin" action="/api/session" method="post">' +
        '<input type="hidden" name="csrf_token" value="${csrf}">' +
        '<input type="text" name="login" required>' +
        '<input type="password" name="secret" required>' +
        '<select name="workspace"><option value="personal">Personal</option><option value="acme">Acme Corp</option></select>' +
        '<label><input type="checkbox" name="remember" value="yes"> Remember me</label>' +
        '<button>Continue</button></form>';
      document.getElementById('signin').addEventListener('submit', function (event) {
        event.preventDefault();
        var form = event.target;
        fetch(form.action, { method: 'POST', credentials: 'same-origin', body: new FormData(form) })
          .then(function (r) { return r.text(); })
          .then(function () { document.getElementById('root').textContent = 'Signed in'; });
      });
    }, 150);
  </script>`;
  const profile = `<form id="prefs" action="/api/profile" method="post">
    <input type="text" name="display_name" maxlength="20">
    <select name="theme"><option value="light">Light</option><option value="dark">Dark</option></select>
    <button>Save</button></form>
    <p id="state"></p>
    <script>
      document.getElementById('prefs').addEventListener('submit', function (event) {
        event.preventDefault();
        var xhr = new XMLHttpRequest();
        xhr.open('POST', event.target.action);
        xhr.onload = function () { document.getElementById('state').textContent = 'Saved'; };
        xhr.send(new URLSearchParams(new FormData(event.target)));
      });
    </script>`;
  return (req, res, url) => {
    const id = cookie(req, 'ledger_sid');
    const state = id === undefined ? undefined : sessions.get(id);
    if (url.pathname === '/') {
      const current = state ? id! : open();
      return html(res, app(sessions.get(current)!.csrf), state ? {} : { 'set-cookie': sid(current) });
    }
    if (url.pathname === '/profile') return html(res, profile);
    if (url.pathname === '/api/session' && req.method === 'POST') {
      if (!state || !(req.headers['content-type'] ?? '').startsWith('multipart/form-data')) return json(res, { error: 'bad request' }, 400);
      return json(res, { ok: true }, 200, { 'set-cookie': sid(open(USER)) });
    }
    if (url.pathname === '/api/profile' && req.method === 'POST') return json(res, { saved: true });
    return json(res, { error: 'not found' }, 404);
  };
}

function property(schema: JsonSchema | undefined, name: string): JsonSchema {
  const found = Schema.properties(schema)[name];
  assert.ok(found, `${name} in ${JSON.stringify(schema)}`);
  return found;
}

describe('pattern (b): a form with an explicit action that its page sends with fetch(new FormData(form)) or XHR (LV4-3)', () => {
  let site: Site | undefined;
  let anonymous: Capture;
  let authenticated: Capture;

  before(async () => {
    site = await start(ledgerSite());
    anonymous = await capture(site, async (page) => {
      await page.waitForSelector('#signin input[name=login]');
      await page.waitForTimeout(300);
    });
    authenticated = await capture(site, async (page, origin) => {
      await page.waitForSelector('#signin input[name=login]');
      await page.fill('#signin input[name=login]', USER);
      await page.fill('#signin input[name=secret]', PASSWORD);
      await page.selectOption('#signin select[name=workspace]', 'acme');
      await page.click('#signin button');
      await page.waitForFunction(`document.getElementById('root').textContent === 'Signed in'`, undefined, { polling: 50 });
      await page.goto(`${origin}/profile`, { waitUntil: 'load' });
      await page.fill('#prefs input[name=display_name]', 'Mara');
      await page.selectOption('#prefs select[name=theme]', 'dark');
      await page.click('#prefs button');
      await page.waitForFunction(`document.getElementById('state').textContent === 'Saved'`, undefined, { polling: 50 });
    });
  });

  after(() => stop(site));

  test('the anonymous capture knows the form from its markup: urlencoded, with the select enum', () => {
    const model = build(anonymous);
    const login = endpoint(model, 'POST', '/api/session');
    assert.equal(login.count, 0);
    assert.equal(login.form?.submittedBy, undefined);
    assert.equal(login.requestBody?.mimeType, 'application/x-www-form-urlencoded');
    assert.deepEqual(property(login.requestBody?.schema, 'workspace').enum, ['personal', 'acme']);
  });

  test('the fetch with new FormData(form) is the form sent by a script: multipart as observed, with the field rules of the form', () => {
    const model = build(merged(anonymous, authenticated));
    const login = endpoint(model, 'POST', '/api/session');
    assert.equal(login.count, 1);
    assert.equal(login.role, 'login');
    assert.equal(login.form?.submittedBy, 'script');
    assert.equal(login.form?.enctype, 'application/x-www-form-urlencoded');
    assert.equal(login.requestBody?.mimeType, 'multipart/form-data');
    assert.equal(login.requestBody?.kind, 'multipart');
    const workspace = property(login.requestBody?.schema, 'workspace');
    assert.deepEqual(workspace.enum, ['personal', 'acme']);
    assert.equal(workspace.default, 'personal');
    assert.equal(property(login.requestBody?.schema, 'login').minLength, 1);
    property(login.requestBody?.schema, 'remember');
    assert.ok(!Schema.requiredSet(login.requestBody?.schema).has('remember'));
    const show = lines(new EndpointDetailPresenter({ width: 200 }).render({ model, ref: String(EndpointIndex.of(model).numberOf(login)) }));
    assert.ok(show.some((line) => /^Sent by: +a script of the form, not the form itself$/.test(line)), show.join('\n'));
    assert.ok(show.some((line) => /^Sent as: +multipart\/form-data$/.test(line)), show.join('\n'));
    assert.ok(!show.some((line) => /^Enctype:/.test(line)), show.join('\n'));
  });

  test('an XHR that sends new URLSearchParams(new FormData(form)) to the form action is a script submission too, with the select enum', () => {
    const model = build(authenticated);
    const prefs = endpoint(model, 'POST', '/api/profile');
    assert.equal(prefs.count, 1);
    assert.equal(prefs.form?.submittedBy, 'script');
    assert.equal(prefs.requestBody?.mimeType, 'application/x-www-form-urlencoded');
    assert.deepEqual(property(prefs.requestBody?.schema, 'theme').enum, ['light', 'dark']);
    assert.equal(property(prefs.requestBody?.schema, 'display_name').maxLength, 20);
  });
});
