import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthDetector,
  BodyParser,
  CookieClassifier,
  CookieInventory,
  EndpointFactory,
  EndpointGrouper,
  EndpointNamer,
  ModelBuilder,
  ModelValidator,
  PathTemplater,
  Redactor,
  SchemaInferrer,
} from '../src/build/index.js';
import { CaptureValidator, CookieParser } from '../src/capture/index.js';
import { HtmlExporter, MarkdownExporter } from '../src/export/index.js';
import { CookieListPresenter } from '../src/present/index.js';
import { FormExtractor, TokenDetector } from '../src/forms/index.js';
import type { Capture, CookieInfo, Endpoint } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const classifier = new CookieClassifier();

function endpointsOf(capture: Capture): Endpoint[] {
  const body = new BodyParser();
  const endpoints = new EndpointGrouper(
    { body, schemas: new SchemaInferrer(), paths: new PathTemplater(), redactor: new Redactor() },
    { includeStatic: false, includeDocuments: true, maxExamples: 1 },
  ).group(capture.exchanges);
  const tokens = new TokenDetector();
  new AuthDetector({ extractor: new FormExtractor({ tokens }), tokens, body }).detect(endpoints, capture);
  new EndpointNamer().name(endpoints);
  return endpoints;
}

function inventory(redact = true, now?: () => Date): CookieInventory {
  return new CookieInventory({ classifier, parser: new CookieParser(now ? { now } : {}), redactor: new Redactor(redact) });
}

function cookie(list: CookieInfo[], name: string): CookieInfo {
  const found = list.find((entry) => entry.name === name);
  assert.ok(found, name);
  return found;
}

describe('CookieClassifier', () => {
  test('rule table roles', () => {
    const cases: [string, string][] = [
      ['sid', 'session'],
      ['session', 'session'],
      ['sess', 'session'],
      ['connect.sid', 'session'],
      ['PHPSESSID', 'session'],
      ['JSESSIONID', 'session'],
      ['ASP.NET_SessionId', 'session'],
      ['laravel_session', 'session'],
      ['_session_id', 'session'],
      ['_myapp_session', 'session'],
      ['__Host-sid', 'session'],
      ['auth', 'auth'],
      ['token', 'auth'],
      ['jwt', 'auth'],
      ['access_token', 'auth'],
      ['refresh-token', 'auth'],
      ['remember_web_59ba36addc2b2f94', 'auth'],
      ['remember_me', 'auth'],
      ['__Secure-next-auth.session-token', 'auth'],
      ['csrf', 'csrf'],
      ['_csrf', 'csrf'],
      ['xsrf', 'csrf'],
      ['csrftoken', 'csrf'],
      ['XSRF-TOKEN', 'csrf'],
      ['__RequestVerificationToken', 'csrf'],
      ['_ga', 'tracking'],
      ['_ga_ABC123', 'tracking'],
      ['_gid', 'tracking'],
      ['_gat', 'tracking'],
      ['_fbp', 'tracking'],
      ['_gcl_au', 'tracking'],
      ['__utma', 'tracking'],
      ['ajs_anonymous_id', 'tracking'],
      ['mp_abc_mixpanel', 'tracking'],
      ['_hjSessionUser_1', 'tracking'],
      ['amplitude_id_x', 'tracking'],
      ['_uetsid', 'tracking'],
      ['theme', 'preference'],
      ['lang', 'preference'],
      ['locale', 'preference'],
      ['consent', 'preference'],
      ['cookieconsent_status', 'preference'],
      ['tz', 'preference'],
      ['currency', 'preference'],
      ['NEXT_LOCALE', 'preference'],
      ['flavor', 'unknown'],
      ['author', 'unknown'],
      ['', 'unknown'],
    ];
    for (const [name, role] of cases) assert.equal(classifier.classify(name), role, name);
  });

  test('rules are ordered so csrf wins over token-like auth names', () => {
    assert.deepEqual(
      CookieClassifier.RULES.map((rule) => rule.role),
      ['csrf', 'tracking', 'session', 'auth', 'preference'],
    );
  });
});

describe('CookieInventory on the fixture flow', () => {
  const { capture, ids } = CaptureFactory.fixture();
  const endpoints = endpointsOf(capture);
  const cookies = inventory().build(capture, endpoints);

  test('lists the final jar with roles, flags and endpoint ids', () => {
    assert.deepEqual(
      cookies.map((entry) => [entry.name, entry.role]),
      [
        ['auth', 'auth'],
        ['csrf', 'csrf'],
        ['sid', 'session'],
        ['theme', 'preference'],
      ],
    );
    const sid = cookie(cookies, 'sid');
    assert.equal(sid.httpOnly, true);
    assert.equal(sid.session, true);
    assert.equal(sid.expires, null);
    assert.equal(sid.domain, 'shop.example.com');
    assert.deepEqual(sid.setBy, ['get-root']);
    assert.ok(sid.usedBy.includes('post-login') && sid.usedBy.includes('get-api-items-itemid'));
    assert.equal(sid.valueExample, '<redacted> (24 characters)');
    const auth = cookie(cookies, 'auth');
    assert.deepEqual(auth.setBy, ['post-login']);
    assert.ok(!auth.usedBy.includes('post-login'));
    assert.equal(cookie(cookies, 'csrf').setBy[0], 'get-app');
    const theme = cookie(cookies, 'theme');
    assert.equal(theme.valueExample, 'dark');
    assert.equal(theme.session, false);
    assert.equal(theme.expires, new Date(CaptureFactory.EPOCH + 3600_000).toISOString());
    assert.ok(ids.home);
  });

  test('redaction can be disabled', () => {
    assert.equal(cookie(inventory(false).build(capture, endpoints), 'sid').valueExample, 'a1b2c3d4e5f6a7b8c9d0e1f2');
  });
});

describe('CookieInventory observations', () => {
  test('merges Set-Cookie observations and Cookie headers when the jar is empty', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/login', 200, {}, {
      responseHeaders: {
        'set-cookie': ['session=abc123def; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=600', 'pref=x; Domain=example.com; Path=/'],
      },
    });
    f.json('GET', '/api/logout', 200, {}, { requestHeaders: { cookie: 'session=abc123def; pref=x; legacy=old-value' }, responseHeaders: { 'set-cookie': 'session=; Path=/; Max-Age=0' } });
    const capture = f.capture();
    const endpoints = endpointsOf(capture);
    const cookies = inventory().build(capture, endpoints);
    assert.deepEqual(
      cookies.map((entry) => [entry.name, entry.domain]),
      [
        ['pref', '.example.com'],
        ['legacy', 'shop.example.com'],
        ['session', 'shop.example.com'],
      ],
    );
    const session = cookie(cookies, 'session');
    assert.equal(session.httpOnly, true);
    assert.equal(session.secure, true);
    assert.equal(session.sameSite, 'Strict');
    assert.equal(session.session, false);
    assert.equal(session.expires, new Date(Date.parse(capture.exchanges[0]!.startedAt) + 20 + 600_000).toISOString());
    assert.deepEqual(session.setBy, ['get-api-login', 'get-api-logout']);
    assert.deepEqual(session.usedBy, ['get-api-logout']);
    assert.equal(session.valueExample, '<redacted> (9 characters)');
    const legacy = cookie(cookies, 'legacy');
    assert.deepEqual([legacy.setBy, legacy.usedBy, legacy.httpOnly, legacy.path, legacy.session], [[], ['get-api-logout'], false, '/', true]);
  });

  test('rejected Set-Cookie lines are ignored', () => {
    const f = new CaptureFactory('http://plain.example');
    f.json('GET', '/x', 200, {}, { responseHeaders: { 'set-cookie': ['__Host-bad=1; Path=/', 'secure=1; Secure', 'ok=1; Path=/'] } });
    const capture = f.capture();
    const cookies = inventory().build(capture, endpointsOf(capture));
    assert.deepEqual(cookies.map((entry) => entry.name), ['ok']);
  });

  test('third-party cookies are dropped unless an endpoint touches them; no endpoints keeps all', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/a', 200, {});
    f.cookie('_ga', 'GA1.2.3', { domain: 'tracker.example', hostOnly: false });
    f.cookie('sid', 'abcdef');
    const capture = f.capture();
    const endpoints = endpointsOf(capture);
    assert.deepEqual(inventory().build(capture, endpoints).map((entry) => entry.name), ['sid']);
    assert.deepEqual(inventory().build(capture, endpoints, ['https://tracker.example']).map((entry) => entry.name), ['_ga']);
    assert.deepEqual(inventory().build(capture, []).map((entry) => entry.name), ['sid', '_ga']);
  });

  test('form-only endpoints use their predicted cookies', () => {
    const f = new CaptureFactory();
    f.cookie('sid', 'abcdef', { httpOnly: true });
    f.cookie('admin_only', 'x', { path: '/admin' });
    const capture = f.capture();
    const endpoint = EndpointFactory.blank({ method: 'POST', origin: CaptureFactory.ORIGIN, path: '/signup', kind: 'form' });
    endpoint.id = 'post-signup';
    endpoint.auth.cookies = ['sid', 'admin_only'];
    const cookies = inventory().build(capture, [endpoint]);
    assert.deepEqual(cookie(cookies, 'sid').usedBy, ['post-signup']);
    assert.deepEqual(cookie(cookies, 'admin_only').usedBy, []);
  });

  test('applies matches domain and path like a browser', () => {
    const base = { name: 'a', value: '1', expires: null, httpOnly: false, secure: false, sameSite: null } as const;
    const url = new URL('https://shop.example.com/api/items');
    assert.equal(CookieInventory.applies({ ...base, domain: 'shop.example.com', path: '/', hostOnly: true }, url), true);
    assert.equal(CookieInventory.applies({ ...base, domain: 'example.com', path: '/api', hostOnly: false }, url), true);
    assert.equal(CookieInventory.applies({ ...base, domain: 'example.com', path: '/', hostOnly: true }, url), false);
    assert.equal(CookieInventory.applies({ ...base, domain: 'shop.example.com', path: '/ap', hostOnly: true }, url), false);
  });
});

describe('partitioned cookies (CAP-10)', () => {
  function partitioned(): Capture {
    const f = new CaptureFactory('https://widget.example.net');
    const base = { domain: 'widget.example.net', path: '/', expires: null, httpOnly: false, secure: true, sameSite: 'None' as const, hostOnly: true };
    f.cookies.push({ ...base, name: 'wid', value: 'shop-0123456789', partitionKey: 'https://example.com' });
    f.cookies.push({ ...base, name: 'wid', value: 'news-0123456789', partitionKey: 'https://example.org' });
    f.exchange({ url: '/api/state', pageUrl: 'https://www.example.com/cart', requestHeaders: { cookie: 'wid=shop-0123456789' }, status: 200 });
    f.exchange({ url: '/api/track', pageUrl: 'https://news.example.org/', requestHeaders: { cookie: 'wid=news-0123456789' }, status: 204 });
    return f.capture();
  }

  test('keeps one cookie per partition, each with its top-level site and the endpoints that sent it', () => {
    const capture = partitioned();
    const endpoints = endpointsOf(capture);
    const list = inventory().build(capture, endpoints);
    const wid = list.filter((entry) => entry.name === 'wid');
    assert.deepEqual(
      wid.map((entry) => [entry.partitionKey, entry.usedBy]),
      [
        ['https://example.com', ['get-api-state']],
        ['https://example.org', ['get-api-track']],
      ],
    );
  });

  test('the model validator accepts a partition key string and rejects other values', () => {
    const f = new CaptureFactory();
    f.cookies.push({ name: 'w', value: '1', domain: 'shop.example.com', path: '/', expires: null, httpOnly: false, secure: true, sameSite: 'None', hostOnly: true, partitionKey: 'https://top.example' });
    const capture = f.capture();
    assert.deepEqual(new CaptureValidator().validate(capture), []);
    const model = ModelBuilder.create({ now: new Date(0) }).build(capture);
    assert.equal(model.cookies[0]?.partitionKey, 'https://top.example');
    const validator = new ModelValidator();
    assert.deepEqual(validator.validate(model), []);
    const broken = JSON.parse(JSON.stringify(model)) as { cookies: Record<string, unknown>[] };
    broken.cookies[0]!.partitionKey = 7;
    assert.deepEqual(validator.validate(broken), ['cookies[0].partitionKey: expected a string']);
    const raw = JSON.parse(JSON.stringify(capture)) as { cookies: Record<string, unknown>[] };
    raw.cookies[0]!.partitionKey = false;
    assert.deepEqual(new CaptureValidator().validate(raw), ['cookies[0].partitionKey must be a string']);
  });

  test('the cookie list, Markdown and HTML show the partition', () => {
    const model = ModelBuilder.create({ now: new Date(0) }).build(partitioned());
    const shop = model.cookies.find((entry) => entry.partitionKey === 'https://example.com');
    assert.ok(shop);
    assert.match(CookieListPresenter.flags(shop), /Partitioned=https:\/\/example\.com/);
    const markdown = new MarkdownExporter().export(model, {}).content;
    assert.match(markdown, /\| SameSite \| Partition \| Expires \|/);
    assert.match(markdown, /\| `wid` \| `widget\.example\.net` \| `\/` \| [a-z]+ \| no \| yes \| None \| https:\/\/example\.com \| session \|/);
    const html = new HtmlExporter().export(model, {}).content;
    assert.match(html, /<th>Partition<\/th>/);
    assert.match(html, /<td>https:\/\/example\.org<\/td>/);
  });
});
