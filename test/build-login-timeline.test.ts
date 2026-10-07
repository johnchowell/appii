import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { ModelBuilder, ModelValidator } from '../src/build/index.js';
import { CaptureMerger, CaptureSession } from '../src/capture/index.js';
import type { LoginField } from '../src/capture/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import type { ApiModel, Capture, Endpoint } from '../src/model/index.js';
import { EndpointDetailPresenter } from '../src/present/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { LoginShell } from './helpers/login-shell.js';

interface OpenApi {
  paths: Record<string, Record<string, { security?: Record<string, string[]>[] }>>;
  components?: { securitySchemes?: Record<string, { in?: string; name?: string }> };
}

const LOGIN_FORM = '<h1>Taskboard</h1><form method="post" action="/login"><input type="hidden" name="_csrf" value="csrf-0123456789abcdef"><input name="login" autocomplete="username" required><input type="password" name="pass" required><button>Sign in</button></form>';
const SHELL = '<p id="banner"></p><tb-app></tb-app><script src="/static/app.js"></script>';
const TASKS = { tasks: [{ id: 101, title: 'Plan sprint 42' }] };

function build(capture: Capture): ApiModel {
  const model = ModelBuilder.create({ now: new Date(0) }).build(capture);
  assert.deepEqual(new ModelValidator().validate(model), []);
  return model;
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((each) => `${each.method} ${each.path}`).join(', ')}`);
  return found;
}

function security(model: ApiModel, path: string): Record<string, string[]>[] | undefined {
  const document = JSON.parse(ExporterRegistry.default().export(model, 'openapi').content) as OpenApi;
  const scheme = Object.entries(document.components?.securitySchemes ?? {}).find(([, value]) => value.in === 'cookie' && value.name === 'tbk')?.[0];
  assert.ok(scheme, JSON.stringify(document.components?.securitySchemes));
  const operation = document.paths[path]?.get;
  return operation?.security?.map((entry) => Object.fromEntries(Object.entries(entry).map(([name, scopes]) => [name === scheme ? 'tbk' : name, scopes])));
}

function expectUpdated(model: ApiModel): void {
  const login = endpoint(model, 'POST', '/login');
  assert.equal(login.role, 'login');
  assert.deepEqual(login.login?.issues, { cookies: ['tbk'], tokens: [] });
  for (const path of ['/api/me', '/api/tasks']) {
    const auth = endpoint(model, 'GET', path).auth;
    assert.equal(auth.anonymous, 'refused', path);
    assert.deepEqual(auth.sets, [['cookie:tbk']], path);
  }
  assert.deepEqual(model.cookies.find((cookie) => cookie.name === 'tbk')?.issuedBy, [login.id]);
  assert.deepEqual(security(model, '/api/tasks'), [{ tbk: [] }]);
}

function anonymousVisit(f: CaptureFactory, sid: string): void {
  f.document('/', CaptureFactory.page('Taskboard', SHELL));
  f.json('GET', '/api/me', 401, { error: 'authentication required' });
  f.json('GET', '/api/csrf', 200, { csrfToken: 'csrf-0123456789abcdef' }, { responseHeaders: { 'set-cookie': `tbk=${sid}; Path=/; HttpOnly` } });
  f.snapshot('/', 'Taskboard', CaptureFactory.page('Taskboard', '<p>Loading...</p>'));
  f.document('/tasks', CaptureFactory.page('Taskboard', SHELL), { requestHeaders: { cookie: `tbk=${sid}` } });
  f.json('GET', '/api/me', 401, { error: 'authentication required' }, { requestHeaders: { cookie: `tbk=${sid}` } });
  f.json('GET', '/api/tasks', 401, { error: 'authentication required' }, { requestHeaders: { cookie: `tbk=${sid}` } });
  f.snapshot('/tasks', 'Taskboard', CaptureFactory.page('Taskboard', LOGIN_FORM));
}

function login(f: CaptureFactory, from: string, sid: string, session: string): void {
  f.snapshot(from, 'Taskboard', CaptureFactory.page('Taskboard', LOGIN_FORM));
  const post = f.exchange({
    method: 'POST',
    url: '/login',
    resourceType: 'document',
    pageUrl: f.url(from),
    requestHeaders: { 'content-type': 'application/x-www-form-urlencoded', cookie: `tbk=${sid}` },
    requestBody: '_csrf=csrf-0123456789abcdef&login=dana&pass=Board-Pass-2026',
    status: 303,
    responseHeaders: { location: '/tasks', 'set-cookie': `tbk=${session}; Path=/; HttpOnly` },
  });
  f.document('/tasks', CaptureFactory.page('Taskboard', SHELL), { redirectedFrom: post.id, requestHeaders: { cookie: `tbk=${session}` } });
  f.json('GET', '/api/me', 200, { name: 'dana' }, { requestHeaders: { cookie: `tbk=${session}` } });
  f.json('GET', '/api/tasks', 200, TASKS, { requestHeaders: { cookie: `tbk=${session}` } });
  f.snapshot('/tasks', 'Taskboard', CaptureFactory.page('Taskboard', '<h1>Tasks of dana</h1><ul><li>Plan sprint 42</li></ul><a href="/signout">Sign out</a>'));
}

describe('login-page evidence follows the state and the time it was seen in (LV3-1)', () => {
  test('a route that showed the login form only while logged out does not make the later login count as refused', () => {
    const f = new CaptureFactory();
    anonymousVisit(f, 'anon-sid-0000000000000001');
    f.document('/', CaptureFactory.page('Taskboard', SHELL));
    f.json('GET', '/api/csrf', 200, { csrfToken: 'csrf-0123456789abcdef' }, { responseHeaders: { 'set-cookie': 'tbk=anon-sid-0000000000000002; Path=/; HttpOnly' } });
    login(f, '/', 'anon-sid-0000000000000002', 'user-sid-0000000000000003');
    expectUpdated(build(f.capture()));
  });

  test('a single capture that starts on the guarded route and logs in there is not refused either', () => {
    const f = new CaptureFactory();
    f.document('/tasks', CaptureFactory.page('Taskboard', SHELL));
    f.json('GET', '/api/me', 401, { error: 'authentication required' });
    f.json('GET', '/api/csrf', 200, { csrfToken: 'csrf-0123456789abcdef' }, { responseHeaders: { 'set-cookie': 'tbk=anon-sid-0000000000000001; Path=/; HttpOnly' } });
    f.json('GET', '/api/tasks', 401, { error: 'authentication required' }, { requestHeaders: { cookie: 'tbk=anon-sid-0000000000000001' } });
    login(f, '/tasks', 'anon-sid-0000000000000001', 'user-sid-0000000000000002');
    expectUpdated(build(f.capture()));
  });

  test('a failed form login that redirects back to the login page, or answers 422, is still refused', () => {
    for (const failure of ['redirect', 'unprocessable']) {
      const f = new CaptureFactory();
      f.document('/login', CaptureFactory.page('Sign in', LOGIN_FORM), { responseHeaders: { 'set-cookie': 'tbk=anon-sid-0000000000000001; Path=/; HttpOnly' } });
      const post = f.exchange({
        method: 'POST',
        url: '/login',
        resourceType: 'document',
        requestHeaders: { 'content-type': 'application/x-www-form-urlencoded', cookie: 'tbk=anon-sid-0000000000000001' },
        requestBody: '_csrf=csrf-0123456789abcdef&login=dana&pass=Wrong-Pass-2026',
        ...(failure === 'redirect'
          ? { status: 302, responseHeaders: { location: '/login?error=1', 'set-cookie': 'tbk=anon-sid-0000000000000002; Path=/; HttpOnly' } }
          : { status: 422, responseHeaders: { 'content-type': 'text/html', 'set-cookie': 'tbk=anon-sid-0000000000000002; Path=/; HttpOnly' }, responseBody: CaptureFactory.page('Sign in', LOGIN_FORM) }),
      });
      if (failure === 'redirect') f.document('/login?error=1', CaptureFactory.page('Sign in', LOGIN_FORM), { redirectedFrom: post.id, requestHeaders: { cookie: 'tbk=anon-sid-0000000000000002' } });
      f.json('GET', '/api/tasks', 401, { error: 'authentication required' }, { requestHeaders: { cookie: 'tbk=anon-sid-0000000000000002' } });
      const model = build(f.capture());
      assert.deepEqual(endpoint(model, 'POST', '/login').login?.issues, { cookies: [], tokens: [] }, failure);
      assert.equal(model.cookies.find((cookie) => cookie.name === 'tbk')?.issuedBy, undefined, failure);
    }
  });

  test('a protected page that redirects to a page whose document shows the login form is refused, also on a path without a sign-in word', () => {
    const f = new CaptureFactory();
    const members = f.document('/members', '', { status: 302, responseHeaders: { location: '/portal/entry?next=/members' } });
    f.document('/portal/entry?next=/members', CaptureFactory.page('Portal', LOGIN_FORM), { redirectedFrom: members.id });
    const reports = f.document('/reports', '', { status: 302, responseHeaders: { location: '/portal/home' } });
    f.document('/portal/home', CaptureFactory.page('Portal', '<h1>Home</h1>'), { redirectedFrom: reports.id });
    const model = build(f.capture());
    assert.equal(endpoint(model, 'GET', '/members').auth.anonymous, 'refused');
    assert.equal(endpoint(model, 'GET', '/reports').auth.anonymous, 'allowed');
  });
});

interface Board {
  server: Server;
  origin: string;
}

const APP_JS = `
(function () {
  var host = document.querySelector('tb-app');
  function show(html) { host.innerHTML = html; }
  function renderLogin() {
    fetch('/api/csrf', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (d) {
      setTimeout(function () {
        show('<form method="post" action="/login"><input type="hidden" name="_csrf" value="' + d.csrfToken + '"><input name="login" autocomplete="username" required><input type="password" name="pass" required><button>Sign in</button></form>');
      }, 200);
    });
  }
  function renderTasks() {
    fetch('/api/tasks', { credentials: 'same-origin' }).then(function (r) { return r.status === 401 ? null : r.json(); }).then(function (d) {
      if (!d) { renderLogin(); return; }
      show('<h1>Tasks</h1><ul>' + d.tasks.map(function (t) { return '<li>' + t.title + '</li>'; }).join('') + '</ul>');
    });
  }
  fetch('/api/me', { credentials: 'same-origin' }).then(function (r) {
    if (r.status === 401) { renderLogin(); return; }
    renderTasks();
  });
})();
`;

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const pair of (req.headers.cookie ?? '').split(/; */)) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
}

function startBoard(): Promise<Board> {
  const sessions = new Map<string, { csrf: string; user?: string }>();
  const open = (user?: string): string => {
    const id = randomBytes(15).toString('hex');
    sessions.set(id, user === undefined ? { csrf: randomBytes(12).toString('hex') } : { csrf: randomBytes(12).toString('hex'), user });
    return id;
  };
  const send = (res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => send(res, status, 'application/json', JSON.stringify(value), headers);
  const handle = (req: IncomingMessage, res: ServerResponse, url: URL, body: string): void => {
    const id = readCookie(req, 'tbk');
    const session = id === undefined ? undefined : sessions.get(id);
    const p = url.pathname;
    if (req.method === 'GET' && (p === '/' || p === '/tasks')) return send(res, 200, 'text/html; charset=utf-8', `<!doctype html><html><head><meta charset="utf-8"><title>Taskboard</title></head><body>${SHELL}</body></html>`);
    if (req.method === 'GET' && p === '/static/app.js') return send(res, 200, 'text/javascript', APP_JS);
    if (req.method === 'GET' && p === '/api/csrf') {
      if (session) return json(res, 200, { csrfToken: session.csrf });
      const fresh = open();
      return json(res, 200, { csrfToken: sessions.get(fresh)!.csrf }, { 'set-cookie': `tbk=${fresh}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (req.method === 'POST' && p === '/login') {
      const form = new URLSearchParams(body);
      if (!session || form.get('_csrf') !== session.csrf) return send(res, 403, 'text/html', '<h1>Bad CSRF token</h1>');
      if (form.get('login') !== 'dana' || form.get('pass') !== 'Board-Pass-2026') return send(res, 401, 'text/html', '<h1>Wrong login</h1>');
      sessions.delete(id!);
      return send(res, 303, 'text/plain', '', { location: '/tasks', 'set-cookie': `tbk=${open('dana')}; Path=/; HttpOnly; SameSite=Lax` });
    }
    if (p.startsWith('/api/') && session?.user === undefined) return json(res, 401, { error: 'authentication required' });
    if (req.method === 'GET' && p === '/api/me') return json(res, 200, { name: session!.user });
    if (req.method === 'GET' && p === '/api/tasks') return json(res, 200, TASKS);
    return json(res, 404, { error: 'not found' });
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), Buffer.concat(chunks).toString('utf8')));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

const CREDENTIALS: LoginField[] = [
  { name: 'login', value: 'dana' },
  { name: 'pass', value: 'Board-Pass-2026' },
];

function capture(url: string, visits: readonly string[], login?: readonly LoginField[]): Promise<Capture> {
  return CaptureSession.create({ url, visits, headless: true, idleMs: 400, recorder: { readTimeoutMs: 5000 }, ...(login === undefined ? {} : { login }) }).run();
}

describe('a single-page app whose routes render the login form while logged out (LV3-1, LV3-4, live)', () => {
  let board: Board | undefined;
  let anon: Capture | undefined;

  before(async () => {
    board = await startBoard();
    anon = await capture(`${board.origin}/`, [`${board.origin}/tasks`, `${board.origin}/api/tasks`]);
  });

  after(() => {
    board?.server.closeAllConnections();
    board?.server.close();
  });

  test('an anonymous capture that visits the guarded route, updated with a logged-in capture', async () => {
    const origin = board!.origin;
    const authed = await capture(`${origin}/`, [`${origin}/tasks`], CREDENTIALS);
    const merged = CaptureMerger.create().merge([{ capture: anon!, file: 'anon.json' }, { capture: authed, file: 'authed.json' }]);
    expectUpdated(build(merged.capture));
  });

  test('the anonymous model binds the CSRF token to the cookie its JSON source set, so the documented example works (LV3-4)', async () => {
    const model = build(anon!);
    const login = endpoint(model, 'POST', '/login');
    const token = login.auth.csrf.find((each) => each.name === '_csrf');
    assert.equal(token?.source, 'response');
    assert.deepEqual(token?.sessionCookies, ['tbk']);
    const detail = new EndpointDetailPresenter({ width: 200 }).render({ model, ref: login.id }).split('\n');
    const start = detail.findIndex((line) => line.startsWith('curl '));
    const end = detail.findIndex((line, at) => at > start && !line.endsWith('\\'));
    const example = detail.slice(start, end + 1).join('\n');
    assert.match(example, /-b "tbk=\$\{APPII_TBK:\?\}"/);
    const source = await fetch(`${board!.origin}/api/csrf`);
    const cookie = /^tbk=([^;]*)/.exec(source.headers.get('set-cookie') ?? '')?.[1];
    const { csrfToken } = (await source.json()) as { csrfToken: string };
    assert.ok(cookie);
    const run = await LoginShell.run(['-c', `${example.replace(/^curl -sS/, 'curl -sS -o /dev/null -w "%{http_code}"')}`], process.cwd(), {
      APPII_TBK: cookie,
      APPII_CSRF: csrfToken,
      APPII_LOGIN: 'dana',
      APPII_PASS: 'Board-Pass-2026',
    });
    assert.equal(run.stdout.trim(), '303', run.stderr);
  });

  test('a single capture that starts on the guarded route and logs in there', async () => {
    const origin = board!.origin;
    const single = await capture(`${origin}/tasks`, [], CREDENTIALS);
    const model = build(single);
    const login = endpoint(model, 'POST', '/login');
    assert.deepEqual(login.login?.issues, { cookies: ['tbk'], tokens: [] });
    assert.equal(endpoint(model, 'GET', '/api/me').auth.anonymous, 'refused');
    assert.deepEqual(endpoint(model, 'GET', '/api/me').auth.sets, [['cookie:tbk']]);
    assert.deepEqual(model.cookies.find((cookie) => cookie.name === 'tbk')?.issuedBy, [login.id]);
  });
});
