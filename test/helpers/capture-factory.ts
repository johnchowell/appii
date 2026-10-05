import type { BodyData, Capture, Cookie, Exchange, Header, PageSnapshot, ResourceType, WebSocketCapture } from '../../src/model/index.js';
import { Http } from '../../src/shared/index.js';

export type HeaderInput = Record<string, string | string[]> | Header[];

export type BodyInput = string | Uint8Array | { json: unknown };

export interface ExchangeSpec {
  url: string;
  method?: string;
  id?: string;
  resourceType?: ResourceType;
  pageUrl?: string;
  durationMs?: number;
  requestHeaders?: HeaderInput;
  requestBody?: BodyInput;
  requestType?: string;
  status?: number;
  responseHeaders?: HeaderInput;
  responseBody?: BodyInput;
  responseType?: string;
  error?: string;
  redirectedFrom?: string;
}

export interface FixtureFlow {
  factory: CaptureFactory;
  capture: Capture;
  csrf: string;
  sid: string;
  auth: string;
  ids: Record<string, string>;
}

export class CaptureFactory {
  static readonly ORIGIN = 'https://shop.example.com';
  static readonly EPOCH = Date.parse('2026-01-01T00:00:00.000Z');
  static readonly STEP_MS = 100;
  static readonly USER = { email: 'user@example.com', password: 'correct-horse' };
  static readonly ITEMS = [
    { id: 1, name: 'Widget', price: 9.99, tags: ['tools'], createdAt: '2026-01-02T03:04:05.000Z' },
    { id: 2, name: 'Gadget', price: 24.5, tags: ['tools', 'electronics'], createdAt: '2026-02-03T04:05:06.000Z' },
    { id: 3, name: 'Doohickey', price: 3, tags: [], createdAt: '2026-03-04T05:06:07.000Z' },
  ];

  readonly origin: string;
  readonly exchanges: Exchange[] = [];
  readonly pages: PageSnapshot[] = [];
  readonly cookies: Cookie[] = [];
  readonly websockets: WebSocketCapture[] = [];
  #clock = CaptureFactory.EPOCH;
  #sequence = 0;

  constructor(origin: string = CaptureFactory.ORIGIN) {
    this.origin = origin;
  }

  static loginHtml(csrf: string, email = ''): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Login</title></head><body><h1>Sign in</h1>
<form id="login" action="/login" method="post">
  <input type="hidden" name="csrf_token" value="${csrf}">
  <label for="email">Email</label>
  <input id="email" type="email" name="email" required autocomplete="username" value="${email}">
  <label for="password">Password</label>
  <input id="password" type="password" name="password" required minlength="8">
  <label><input type="checkbox" name="remember" value="yes"> Remember me</label>
  <button type="submit" name="action" value="login">Sign in</button>
</form>
<form action="/search" method="get" class="search">
  <input type="search" name="q" required placeholder="Search">
  <button>Go</button>
</form></body></html>`;
  }

  static signupHtml(): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>Signup</title></head><body><form id="signup" action="/signup" method="post" enctype="multipart/form-data">
  <input type="text" name="username" required pattern="[a-z0-9_]{3,16}" title="3-16 lowercase letters, digits or underscore">
  <input type="email" name="email" required>
  <input type="number" name="age" min="13" max="120" step="1">
  <input type="url" name="website">
  <input type="date" name="birthday" min="1900-01-01" max="2026-12-31">
  <select name="country" required><option value="">Choose...</option><option value="us">United States</option><option value="ca">Canada</option><option value="xx" disabled>Nowhere</option></select>
  <label><input type="radio" name="plan" value="free" checked> Free</label>
  <label><input type="radio" name="plan" value="pro"> Pro</label>
  <select name="interests" multiple><option value="a" selected>A</option><option value="b">B</option><option value="c" selected>C</option></select>
  <textarea name="bio" maxlength="200">Hello
world</textarea>
  <input type="checkbox" name="terms" required>
  <input type="file" name="avatar" accept="image/*">
  <fieldset disabled><input name="locked" value="nope"></fieldset>
  <input type="text" name="disabled_field" value="x" disabled>
  <input type="text" name="readonly_field" value="ro" readonly>
  <button type="submit" name="intent" value="create">Create</button>
  <button type="submit" name="intent" value="draft" formnovalidate formaction="/signup?draft=1">Save draft</button>
</form></body></html>`;
  }

  static page(title: string, body: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  }

  static body(input: BodyInput, contentType: string): BodyData {
    if (input instanceof Uint8Array) return Http.toBodyData(input, contentType);
    const text = typeof input === 'string' ? input : JSON.stringify(input.json);
    return Http.toBodyData(new TextEncoder().encode(text), contentType);
  }

  static headers(input: HeaderInput | undefined): Header[] {
    return Array.isArray(input) ? input.map((h) => ({ ...h })) : Http.recordToHeaders(input);
  }

  static fixture(origin: string = CaptureFactory.ORIGIN): FixtureFlow {
    const f = new CaptureFactory(origin);
    const sid = 'a1b2c3d4e5f6a7b8c9d0e1f2';
    const csrf = '0123456789abcdef0123456789abcdef';
    const auth = 'feedfacecafebeef0011223344556677';
    const browser = { 'user-agent': 'Mozilla/5.0', accept: '*/*', 'accept-language': 'en-US', 'sec-fetch-mode': 'cors' };
    const ids: Record<string, string> = {};
    const home = f.document('/', CaptureFactory.page('Home', '<h1>Fixture</h1><a href="/login">Login</a>'), {
      responseHeaders: { 'set-cookie': [`sid=${sid}; Path=/; HttpOnly; SameSite=Lax`, 'theme=dark; Path=/; Max-Age=3600'] },
    });
    ids.home = home.id;
    const cookieBase = `sid=${sid}; theme=dark`;
    const loginHtml = CaptureFactory.loginHtml(csrf);
    ids.loginPage = f.document('/login', loginHtml, { requestHeaders: { cookie: cookieBase } }).id;
    f.snapshot('/login', 'Login', loginHtml);
    const login = f.exchange({
      method: 'POST',
      url: '/login',
      resourceType: 'document',
      pageUrl: f.url('/login'),
      requestHeaders: { ...browser, cookie: cookieBase, origin: f.origin, 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: `csrf_token=${csrf}&email=user%40example.com&password=correct-horse&action=login`,
      status: 303,
      responseHeaders: { location: '/account', 'set-cookie': `auth=${auth}; Path=/; HttpOnly; SameSite=Lax`, 'content-length': '0' },
    });
    ids.login = login.id;
    const withAuth = `${cookieBase}; auth=${auth}`;
    ids.account = f.document('/account', CaptureFactory.page('Account', '<h1>Welcome</h1>'), {
      requestHeaders: { cookie: withAuth },
      redirectedFrom: login.id,
    }).id;
    ids.app = f.document('/app', CaptureFactory.page('App', '<div id="out"></div>'), {
      requestHeaders: { cookie: withAuth },
      responseHeaders: { 'set-cookie': `csrf=${csrf}; Path=/; SameSite=Strict` },
    }).id;
    const app = f.url('/app');
    const api = `${withAuth}; csrf=${csrf}`;
    const items = CaptureFactory.ITEMS;
    ids.list1 = f.json('GET', '/api/items?page=1&limit=2', 200, { items: items.slice(0, 2), page: 1, total: 3 }, { pageUrl: app, requestHeaders: { ...browser, cookie: api } }).id;
    ids.item1 = f.json('GET', '/api/items/1', 200, items[0], { pageUrl: app, requestHeaders: { ...browser, cookie: api } }).id;
    ids.item2 = f.json('GET', '/api/items/2', 200, items[1], { pageUrl: app, requestHeaders: { ...browser, cookie: api } }).id;
    ids.item999 = f.json('GET', '/api/items/999', 404, { error: 'not found' }, { pageUrl: app, requestHeaders: { ...browser, cookie: api } }).id;
    ids.create = f.json('POST', '/api/items', 201, { id: 4, name: 'Thing', price: 5, tags: [], createdAt: '2026-04-05T06:07:08.000Z' }, {
      pageUrl: app,
      requestHeaders: { ...browser, cookie: api, 'content-type': 'application/json', 'x-csrf-token': csrf },
      requestBody: { json: { name: 'Thing', price: 5 } },
    }).id;
    ids.createBad = f.json('POST', '/api/items', 400, { errors: { name: ['is required'], price: ['must be a non-negative number'] } }, {
      pageUrl: app,
      requestHeaders: { ...browser, cookie: api, 'content-type': 'application/json', 'x-csrf-token': csrf },
      requestBody: { json: { price: -1 } },
    }).id;
    ids.graphql = f.json('POST', '/graphql', 200, { data: { item: { id: '1', name: 'Widget' } } }, {
      pageUrl: app,
      requestHeaders: { ...browser, cookie: api, 'content-type': 'application/json' },
      requestBody: { json: { operationName: 'GetItem', query: 'query GetItem($id: ID!) { item(id: $id) { id name } }', variables: { id: '1' } } },
    }).id;
    ids.list2 = f.json('GET', '/api/items?page=2&limit=2', 200, { items: items.slice(2), page: 2, total: 3 }, {
      resourceType: 'xhr',
      pageUrl: app,
      requestHeaders: { ...browser, cookie: api },
    }).id;
    const signupHtml = CaptureFactory.signupHtml();
    ids.signupPage = f.document('/signup', signupHtml, { requestHeaders: { cookie: api } }).id;
    f.snapshot('/signup', 'Signup', signupHtml);
    const host = new URL(origin).hostname;
    f.cookie('sid', sid, { domain: host, httpOnly: true, sameSite: 'Lax' });
    f.cookie('theme', 'dark', { domain: host, sameSite: 'Lax', expires: (CaptureFactory.EPOCH + 3600_000) / 1000 });
    f.cookie('auth', auth, { domain: host, httpOnly: true, sameSite: 'Lax' });
    f.cookie('csrf', csrf, { domain: host, sameSite: 'Strict' });
    return { factory: f, capture: f.capture(), csrf, sid, auth, ids };
  }

  url(pathOrUrl: string): string {
    return /^[a-z][a-z0-9+.-]*:/i.test(pathOrUrl) ? pathOrUrl : this.origin + pathOrUrl;
  }

  exchange(spec: ExchangeSpec): Exchange {
    const startedAt = new Date(this.#tick()).toISOString();
    const requestHeaders = CaptureFactory.headers(spec.requestHeaders);
    const requestType = spec.requestType ?? Http.getHeader(requestHeaders, 'content-type') ?? '';
    const exchange: Exchange = {
      id: spec.id ?? `ex-${String(++this.#sequence).padStart(4, '0')}`,
      source: 'browser',
      resourceType: spec.resourceType ?? 'fetch',
      startedAt,
      durationMs: spec.durationMs ?? 20,
      request: {
        method: spec.method ?? 'GET',
        url: this.url(spec.url),
        headers: requestHeaders,
        ...(spec.requestBody !== undefined ? { body: CaptureFactory.body(spec.requestBody, requestType) } : {}),
      },
    };
    if (spec.pageUrl !== undefined) exchange.pageUrl = spec.pageUrl;
    if (spec.status !== undefined) {
      const responseHeaders = CaptureFactory.headers(spec.responseHeaders);
      const responseType = spec.responseType ?? Http.getHeader(responseHeaders, 'content-type') ?? '';
      exchange.response = {
        status: spec.status,
        statusText: Http.reasonPhrase(spec.status),
        headers: responseHeaders,
        ...(spec.responseBody !== undefined ? { body: CaptureFactory.body(spec.responseBody, responseType) } : {}),
      };
    }
    if (spec.error !== undefined) exchange.error = spec.error;
    if (spec.redirectedFrom !== undefined) exchange.redirectedFrom = spec.redirectedFrom;
    this.exchanges.push(exchange);
    return exchange;
  }

  json(method: string, url: string, status: number, body: unknown, extra: Partial<ExchangeSpec> = {}): Exchange {
    const headers = CaptureFactory.headers(extra.responseHeaders);
    const responseHeaders = Http.getHeader(headers, 'content-type') ? headers : [...headers, { name: 'content-type', value: 'application/json; charset=utf-8' }];
    return this.exchange({ ...extra, method, url, status, responseHeaders, ...(body === undefined ? {} : { responseBody: { json: body } }) });
  }

  document(url: string, html: string, extra: Partial<ExchangeSpec> = {}): Exchange {
    const headers = CaptureFactory.headers(extra.responseHeaders);
    return this.exchange({
      resourceType: 'document',
      status: 200,
      ...extra,
      url,
      responseHeaders: [{ name: 'content-type', value: 'text/html; charset=utf-8' }, ...headers],
      responseBody: html,
    });
  }

  snapshot(url: string, title: string, html: string): PageSnapshot {
    const snapshot: PageSnapshot = { url: this.url(url), title, capturedAt: new Date(this.#tick()).toISOString(), html };
    this.pages.push(snapshot);
    return snapshot;
  }

  cookie(name: string, value: string, extra: Partial<Cookie> = {}): Cookie {
    const cookie: Cookie = {
      name,
      value,
      domain: new URL(this.origin).hostname,
      path: '/',
      expires: null,
      httpOnly: false,
      secure: false,
      sameSite: 'Lax',
      hostOnly: true,
      ...extra,
    };
    this.cookies.push(cookie);
    return cookie;
  }

  websocket(url: string, messages: WebSocketCapture['messages'], pageUrl?: string): WebSocketCapture {
    const socket: WebSocketCapture = { id: `ws-${++this.#sequence}`, url, openedAt: new Date(this.#tick()).toISOString(), messages };
    if (pageUrl !== undefined) socket.pageUrl = pageUrl;
    this.websockets.push(socket);
    return socket;
  }

  capture(options: { startUrl?: string | null } = {}): Capture {
    const capture: Capture = {
      version: 1,
      tool: { name: 'appii', version: '0.0.0-test' },
      startedAt: new Date(CaptureFactory.EPOCH).toISOString(),
      endedAt: new Date(this.#clock + CaptureFactory.STEP_MS).toISOString(),
      exchanges: structuredClone(this.exchanges),
      websockets: structuredClone(this.websockets),
      cookies: structuredClone(this.cookies),
      storage: [],
      pages: structuredClone(this.pages),
    };
    const startUrl = options.startUrl === undefined ? this.origin + '/' : options.startUrl;
    if (startUrl !== null) capture.startUrl = startUrl;
    return capture;
  }

  #tick(): number {
    this.#clock += CaptureFactory.STEP_MS;
    return this.#clock;
  }
}
