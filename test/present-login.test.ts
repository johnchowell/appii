import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import type { ApiModel, Capture, Endpoint } from '../src/model/index.js';
import { CaptureSummaryPresenter, CookieListPresenter, EndpointDetailPresenter, EndpointListPresenter, SummaryPresenter } from '../src/present/index.js';
import { Ansi, EndpointIndex } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const ORIGIN = 'https://quotes.example';
const ANON = 'anon.9f8e7d6c5b4a39281706f5e4d3c2b1a0';
const USER = 'user.0a1b2c3d4e5f60718293a4b5c6d7e8f9';
const LATER = 'anon.f0e1d2c3b4a5968778695a4b3c2d1e0f';
const CSRF = 'Zx81Qw72Er63Ty54Ui45Op36As27Df18';

function loginPage(): string {
  return CaptureFactory.page('Login', `<form action="/login" method="post"><input type="hidden" name="csrf_token" value="${CSRF}"><input type="text" name="username"><input type="password" name="password"><input type="submit" value="Login"></form>`);
}

function quotes(loggedIn: boolean): Capture {
  const f = new CaptureFactory(ORIGIN);
  f.document('/', CaptureFactory.page('Quotes', '<a href="/login">Login</a>'));
  f.document('/login', loginPage(), { responseHeaders: { 'set-cookie': `session=${ANON}; HttpOnly; Path=/` } });
  f.snapshot('/login', 'Login', loginPage());
  f.document('/account', '', { status: 302, requestHeaders: { cookie: `session=${ANON}` }, responseHeaders: { location: '/login' } });
  if (loggedIn) {
    const login = f.exchange({
      method: 'POST',
      url: '/login',
      resourceType: 'document',
      pageUrl: f.url('/login'),
      requestHeaders: { cookie: `session=${ANON}`, 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: `csrf_token=${CSRF}&username=appii-test&password=appii-pass-2026`,
      status: 302,
      responseHeaders: { location: '/', 'set-cookie': `session=${USER}; HttpOnly; Path=/` },
    });
    f.document('/', CaptureFactory.page('Quotes', '<a href="/logout">Logout</a>'), { requestHeaders: { cookie: `session=${USER}` }, redirectedFrom: login.id });
    f.document('/account', CaptureFactory.page('Account', '<h1>Account</h1>'), { requestHeaders: { cookie: `session=${USER}` } });
    f.document('/tag/love/', CaptureFactory.page('Love', '<h1>Love</h1>'), { requestHeaders: { cookie: `session=${USER}` } });
    f.document('/logout', '', { status: 302, requestHeaders: { cookie: `session=${USER}` }, responseHeaders: { location: '/', 'set-cookie': `session=${LATER}; HttpOnly; Path=/` } });
  }
  f.cookie('session', loggedIn ? LATER : ANON, { httpOnly: true, sameSite: null });
  return f.capture();
}

function model(loggedIn: boolean): ApiModel {
  return ModelBuilder.create({ now: new Date(0) }).build(quotes(loggedIn));
}

function number(value: ApiModel, method: string, path: string): number {
  const index = EndpointIndex.of(value);
  const found = value.endpoints.find((endpoint: Endpoint) => endpoint.method === method && endpoint.path === path);
  assert.ok(found, `${method} ${path}`);
  return index.numberOf(found);
}

function lines(text: string): string[] {
  return Ansi.strip(text).split('\n');
}

function row(text: string, n: number): string[] {
  const line = lines(text).find((candidate) => new RegExp(`^\\| +${n} \\|`).test(candidate)) ?? '';
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

describe('list summary, AUTH marks, --show and --cookies for login and logout (L2, QL-2, QL-3, QL-6)', () => {
  test('an anonymous model names the login endpoint known from the form', () => {
    const anon = model(false);
    const out = new EndpointListPresenter({ width: 160 }).render(anon);
    const login = number(anon, 'POST', '/login');
    assert.ok(lines(out).includes(`Login:        #${login} POST /login with username and password, known from a form; not submitted yet`), out);
    assert.equal(row(out, login)[6], 'login,csrf');
    assert.ok(!lines(out).some((line) => line.startsWith('Logout:')));
    assert.ok(!lines(out).some((line) => line.startsWith('After login:')));
    assert.ok(lines(out).includes(`Login needed: ${number(anon, 'GET', '/account')} (refused requests without credentials)`), out);
    const detail = lines(new EndpointDetailPresenter({ width: 160 }).render({ model: anon, ref: login }));
    assert.ok(detail.includes('Role:               login, known from a form; not submitted yet'));
    assert.ok(detail.includes('Login fields:       identifier username, password password'));
    assert.ok(detail.includes('Issues:             nothing observed yet'));
    assert.ok(detail.includes('Anonymous:          not tested, no request was observed'));
    assert.ok(detail.includes('Seen:               not observed'));
    const account = lines(new EndpointDetailPresenter({ width: 160 }).render({ model: anon, ref: number(anon, 'GET', '/account') }));
    assert.ok(account.includes('Anonymous:          refused, every request without credentials was refused (302)'), account.join('\n'));
  });

  test('a logged-in model shows the observed login, the logout, the endpoints seen only after login and the credential cookie lifecycle', () => {
    const authed = model(true);
    const out = new EndpointListPresenter({ width: 160 }).render(authed);
    const login = number(authed, 'POST', '/login');
    const logout = number(authed, 'GET', '/logout');
    const love = number(authed, 'GET', '/tag/love/');
    const all = lines(out);
    assert.ok(all.includes(`Login:        #${login} POST /login with username and password, issues cookie session`), out);
    assert.ok(all.includes(`Logout:       #${logout} GET /logout, revokes cookie session`), out);
    assert.ok(all.includes(`Login needed: ${number(authed, 'GET', '/account')} (refused requests without credentials)`), out);
    assert.ok(all.includes(`After login:  ${[love, logout].sort((a, b) => a - b).join(',')} (seen only with a logged-in credential)`), out);
    assert.equal(row(out, logout)[6], 'logout,cookie~');
    assert.equal(row(out, love)[6], 'cookie~');
    assert.equal(row(out, number(authed, 'GET', '/'))[6], 'cookie?');
    assert.equal(row(out, number(authed, 'GET', '/account'))[6], 'cookie');
    assert.ok(all.join(' ').replace(/ +/g, ' ').includes('a label ending in ~ means no request without those credentials was seen, so anonymous access was not tested'), out);
    const detail = lines(new EndpointDetailPresenter({ width: 160 }).render({ model: authed, ref: login }));
    assert.ok(detail.includes('Role:               login, a submission issued a credential'));
    assert.ok(detail.includes('Issues:             cookie session'));
    assert.ok(detail.includes('Anonymous:          allowed, a request without credentials was not refused'));
    assert.ok(detail.includes('Seen:               anonymous'));
    const signOut = lines(new EndpointDetailPresenter({ width: 160 }).render({ model: authed, ref: logout }));
    assert.equal(signOut[2], 'Name: getLogout');
    assert.ok(signOut.includes('Role:               logout, signs out'));
    assert.ok(signOut.includes('Revokes:            cookie session'));
    assert.ok(signOut.includes('Credentials:        cookie session (anonymous access not tested)'));
    assert.ok(signOut.includes('Seen:               authenticated'));
    const home = lines(new EndpointDetailPresenter({ width: 160 }).render({ model: authed, ref: number(authed, 'GET', '/') }));
    assert.ok(home.includes('Seen:               anonymous, authenticated'));
    const cookies = lines(new CookieListPresenter({ width: 160 }).render(authed));
    assert.ok(cookies.includes('Login and logout:'));
    assert.ok(cookies.includes(`  session: issued by #${login} POST /login; revoked by #${logout} GET /logout`), cookies.join('\n'));
  });

  test('the login and logout lines are plain text that fits narrow widths with and without color', () => {
    const authed = model(true);
    for (const width of [60, 100]) {
      const plain = new EndpointListPresenter({ width }).render(authed);
      const color = new EndpointListPresenter({ width, color: true }).render(authed);
      assert.equal(Ansi.strip(color), plain);
      for (const line of lines(plain)) assert.ok(Ansi.width(line) <= width, `${width}: ${line}`);
    }
  });

  test('a filtered list keeps only the matching login lines and subsets keep issuedBy and revokedBy of kept endpoints', () => {
    const authed = model(true);
    const filtered = lines(new EndpointListPresenter({ width: 160, filter: { method: 'GET' } }).render(authed));
    assert.ok(!filtered.some((line) => line.startsWith('Login:')));
    assert.ok(filtered.some((line) => line.startsWith('Logout:')));
    const logout = authed.endpoints.find((endpoint) => endpoint.role === 'logout')!;
    const subset = EndpointIndex.subset(authed, [logout]);
    assert.deepEqual(subset.cookies.map((cookie) => [cookie.name, cookie.issuedBy, cookie.revokedBy]), [['session', undefined, [logout.id]]]);
  });

  test('the summary lists every capture an updated model was built from (QL-1)', () => {
    const authed = model(true);
    const updated: ApiModel = {
      ...authed,
      source: {
        ...authed.source,
        captures: [
          { file: 'anon.json', startUrl: `${ORIGIN}/`, capturedFrom: '2026-01-01T00:00:00.000Z', capturedTo: '2026-01-01T00:00:30.000Z', exchanges: 4 },
          { file: 'authed.json', capturedFrom: '2026-01-01T00:05:00.000Z', capturedTo: '2026-01-01T00:06:00.000Z', exchanges: 12 },
        ],
      },
    };
    const out = lines(new SummaryPresenter({ width: 200 }).render(updated));
    assert.ok(out.includes('Built from:     anon.json (4 requests, 2026-01-01T00:00:00.000Z to 2026-01-01T00:00:30.000Z (30 s)); authed.json (12 requests, 2026-01-01T00:05:00.000Z to 2026-01-01T00:06:00.000Z (1 min 0 s))'), out.join('\n'));
    assert.ok(!lines(new SummaryPresenter({ width: 200 }).render(authed)).some((line) => line.startsWith('Built from:')));
  });

  test('summary helpers describe what a login issues', () => {
    assert.equal(EndpointListPresenter.issued({ evidence: 'observed', password: 'p', issues: { cookies: ['sid'], tokens: ['data.accessToken'] } }), 'cookie sid and bearer token from data.accessToken');
    assert.equal(EndpointListPresenter.loginSummary({ evidence: 'form', password: 'p', issues: { cookies: [], tokens: [] } }, true), 'with p, submitted, but no credential was issued');
  });
});

describe('the capture summary keeps requests that appii stopped while probing a login form apart (LV2-4)', () => {
  test('a probe is not counted as a request or a failure and is named on its own line', () => {
    const f = new CaptureFactory(ORIGIN);
    f.document('/login', CaptureFactory.page('Login', '<form id="login"><input name="username"><input type="password" name="password"><button>Log in</button></form>'));
    const stopped = f.exchange({
      method: 'POST',
      url: 'https://api.quotes.example/v1/session',
      pageUrl: f.url('/login'),
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: { json: { username: 'probe-user', password: 'probe-pass' } },
      error: 'net::ERR_BLOCKED_BY_CLIENT',
    });
    stopped.source = 'probe';
    const text = Ansi.strip(new CaptureSummaryPresenter({ width: 160 }).render({ capture: f.capture({ startUrl: `${ORIGIN}/login` }) }));
    assert.match(text, /\nRequests: +1 \(1 page, 0 fetch\/XHR, 0 other\) to 1 origin\n/);
    assert.match(text, /\nProbed: +POST https:\/\/api\.quotes\.example\/v1\/session \(stopped in the browser while probing the login form; not sent\)/);
  });

  test('a probe to the origin of the start URL is named by its path, once', () => {
    const f = new CaptureFactory(ORIGIN);
    f.document('/login', CaptureFactory.page('Login', '<form id="login"><input name="username"><input type="password" name="password"><button>Log in</button></form>'));
    for (let i = 0; i < 2; i++) {
      const stopped = f.exchange({ method: 'POST', url: '/api/auth/login', pageUrl: f.url('/login'), requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { username: 'u', password: 'p' } }, error: 'net::ERR_BLOCKED_BY_CLIENT' });
      stopped.source = 'probe';
    }
    const text = Ansi.strip(new CaptureSummaryPresenter({ width: 160 }).render({ capture: f.capture({ startUrl: `${ORIGIN}/login` }) }));
    assert.match(text, /\nProbed: +POST \/api\/auth\/login \(stopped in the browser while probing the login form; not sent\)/);
  });
});
