import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthDetector, BodyParser, CsrfSourceResolver, EndpointFactory, EndpointGrouper, HtmlPages, ModelBuilder, ModelValidator, PageDocuments, PathTemplater, Redactor, SchemaInferrer } from '../src/build/index.js';
import { FormExtractor, TokenDetector } from '../src/forms/index.js';
import type { Capture, Endpoint } from '../src/model/index.js';
import { Samples, Schema } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const ORIGIN = CaptureFactory.ORIGIN;
const body = new BodyParser();
const tokens = new TokenDetector();
const extractor = new FormExtractor({ tokens });

function detector(): AuthDetector {
  return new AuthDetector({ extractor, tokens, body });
}

function group(capture: Capture): Endpoint[] {
  return new EndpointGrouper(
    { body, schemas: new SchemaInferrer(), paths: new PathTemplater(), redactor: new Redactor() },
    { includeStatic: false, includeDocuments: true, maxExamples: 1 },
  ).group(capture.exchanges);
}

function detect(capture: Capture): Endpoint[] {
  const endpoints = group(capture);
  detector().detect(endpoints, capture);
  return endpoints;
}

function find(endpoints: Endpoint[], key: string): Endpoint {
  const found = endpoints.find((endpoint) => endpoint.key === key);
  assert.ok(found, key);
  return found;
}

describe('AuthDetector on the fixture flow', () => {
  const { capture } = CaptureFactory.fixture();
  const endpoints = detect(capture);

  test('csrf header sourced from the csrf cookie sent with the same request', () => {
    const create = find(endpoints, `POST ${ORIGIN}/api/items`);
    assert.deepEqual(create.auth, {
      cookies: ['auth', 'csrf', 'sid', 'theme'],
      headers: [],
      bearer: false,
      csrf: [{ location: 'header', name: 'x-csrf-token', source: 'cookie', sourceName: 'csrf' }],
      sets: [['cookie:auth']],
    });
  });

  test('csrf body field sourced from the hidden field of the login page', () => {
    const login = find(endpoints, `POST ${ORIGIN}/login`);
    assert.deepEqual(login.auth.csrf, [{ location: 'body', name: 'csrf_token', source: 'hidden-field', sourceName: 'csrf_token', sourceUrl: `${ORIGIN}/login`, sessionCookies: ['sid'] }]);
    assert.deepEqual(login.auth.cookies, ['sid', 'theme']);
  });

  test('endpoints that sent only cookies list the cookie names and nothing else', () => {
    const item = find(endpoints, `GET ${ORIGIN}/api/items/{itemId}`);
    assert.deepEqual(item.auth, { cookies: ['auth', 'csrf', 'sid', 'theme'], headers: [], bearer: false, csrf: [], sets: [['cookie:auth']] });
    assert.deepEqual(find(endpoints, `GET ${ORIGIN}/`).auth.cookies, []);
  });
});

describe('AuthDetector token sources', () => {
  const token = 'tok-0123456789abcdef';

  test('meta tag tokens, preferring the page that issued the request', () => {
    const f = new CaptureFactory();
    f.snapshot('/other', 'Other', `<html><head><meta name="csrf-token" content="${token}"></head></html>`);
    f.snapshot('/app', 'App', `<html><head><meta name="csrf-token" content="${token}"><meta name="viewport" content="${token}"></head></html>`);
    f.json('POST', '/api/save', 200, {}, { pageUrl: f.url('/app'), requestHeaders: { 'x-csrf-token': token } });
    const [save] = detect(f.capture());
    assert.deepEqual(save?.auth.csrf, [{ location: 'header', name: 'x-csrf-token', source: 'meta', sourceName: 'csrf-token', sourceUrl: f.url('/app') }]);
  });

  test('hidden fields from HTML document responses when no snapshot exists', () => {
    const f = new CaptureFactory();
    f.document('/edit', `<form method="post" action="/save"><input type="hidden" name="authenticity_token" value="${token}"><input name="t"></form>`);
    f.exchange({
      method: 'POST',
      url: '/save?_token=' + token,
      resourceType: 'document',
      status: 302,
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: `authenticity_token=${encodeURIComponent(token)}&t=x`,
    });
    const save = find(detect(f.capture({ startUrl: null })), `POST ${ORIGIN}/save`);
    assert.deepEqual(save.auth.csrf, [
      { location: 'query', name: '_token', source: 'hidden-field', sourceName: 'authenticity_token', sourceUrl: f.url('/edit') },
      { location: 'body', name: 'authenticity_token', source: 'hidden-field', sourceName: 'authenticity_token', sourceUrl: f.url('/edit') },
    ]);
  });

  test('earlier JSON responses and response headers, but not later ones', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/session', 200, { data: { csrfToken: token, list: [{ deep: 'xsrf-value-123456' }] } });
    f.json('GET', '/api/ping', 200, {}, { responseHeaders: { 'x-csrf-token': 'from-header-123456' } });
    f.json('POST', '/api/a', 200, {}, { requestHeaders: { 'x-xsrf-token': token } });
    f.json('POST', '/api/b', 200, {}, { requestHeaders: { 'x-csrf-token': 'xsrf-value-123456' } });
    f.json('POST', '/api/c', 200, {}, { requestHeaders: { 'x-csrf-token': 'from-header-123456' } });
    f.json('POST', '/api/d', 200, {}, { requestHeaders: { 'x-csrf-token': 'later-value-123456' } });
    f.json('GET', '/api/late', 200, { token: 'later-value-123456' });
    const endpoints = detect(f.capture());
    assert.deepEqual(find(endpoints, `POST ${ORIGIN}/api/a`).auth.csrf, [
      { location: 'header', name: 'x-xsrf-token', source: 'response', sourceName: 'csrfToken', sourceUrl: f.url('/api/session'), sourceMethod: 'GET' },
    ]);
    assert.deepEqual(find(endpoints, `POST ${ORIGIN}/api/b`).auth.csrf[0]?.sourceName, 'deep');
    assert.deepEqual(find(endpoints, `POST ${ORIGIN}/api/c`).auth.csrf, [
      { location: 'header', name: 'x-csrf-token', source: 'response', sourceName: 'x-csrf-token', sourceUrl: f.url('/api/ping'), sourceMethod: 'GET' },
    ]);
    assert.deepEqual(find(endpoints, `POST ${ORIGIN}/api/d`).auth.csrf, [{ location: 'header', name: 'x-csrf-token', source: 'unknown' }]);
  });

  test('url-encoded cookie values (double submit) and short or empty values', () => {
    const f = new CaptureFactory();
    const raw = 'abc+def/ghi=jkl==';
    f.json('POST', '/api/x', 200, {}, { requestHeaders: { cookie: `XSRF-TOKEN=${encodeURIComponent(raw)}`, 'x-xsrf-token': raw } });
    f.json('POST', '/api/y', 200, {}, { requestHeaders: { cookie: 'c=short1', 'x-csrf-token': 'short1' } });
    f.json('POST', '/api/z', 200, {}, { requestHeaders: { 'x-csrf-token': '' } });
    const endpoints = detect(f.capture());
    assert.deepEqual(find(endpoints, `POST ${ORIGIN}/api/x`).auth.csrf, [{ location: 'header', name: 'x-xsrf-token', source: 'cookie', sourceName: 'XSRF-TOKEN' }]);
    assert.equal(find(endpoints, `POST ${ORIGIN}/api/y`).auth.csrf[0]?.source, 'unknown');
    assert.equal(find(endpoints, `POST ${ORIGIN}/api/z`).auth.csrf[0]?.source, 'unknown');
  });

  test('a known source from a later exchange replaces an unknown one', () => {
    const f = new CaptureFactory();
    f.json('POST', '/api/save', 200, {}, { requestHeaders: { 'x-csrf-token': 'unmatched-123456' } });
    f.json('POST', '/api/save', 200, {}, { requestHeaders: { 'x-csrf-token': 'cookie-value-123456', cookie: 'csrf=cookie-value-123456' } });
    const [save] = detect(f.capture());
    assert.deepEqual(save?.auth.csrf, [{ location: 'header', name: 'x-csrf-token', source: 'cookie', sourceName: 'csrf' }]);
  });

  test('json body token fields are candidates; ordinary fields are not', () => {
    const f = new CaptureFactory();
    f.snapshot('/p', 'P', `<form><input type="hidden" name="_csrf" value="${token}"></form>`);
    f.json('POST', '/api/j', 200, {}, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { _csrf: token, name: token, nested: { csrf: token } } } });
    const [j] = detect(f.capture());
    assert.deepEqual(j?.auth.csrf, [{ location: 'body', name: '_csrf', source: 'hidden-field', sourceName: '_csrf', sourceUrl: f.url('/p') }]);
  });

  test('the resolver is created lazily and can be substituted', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/plain', 200, {});
    let created = 0;
    const lazy = new AuthDetector({
      extractor,
      tokens,
      body,
      sources: (capture) => {
        created++;
        return new CsrfSourceResolver(capture, { tokens, body, documents: new PageDocuments({ extractor, pages: new HtmlPages({ body }) }) });
      },
    });
    const capture = f.capture();
    lazy.detect(group(capture), capture);
    assert.equal(created, 0);
    f.json('POST', '/api/post', 200, {}, { requestHeaders: { 'x-csrf-token': token } });
    const next = f.capture();
    lazy.detect(group(next), next);
    assert.equal(created, 1);
  });
});

describe('AuthDetector headers and bearer', () => {
  test('bearer tokens and auth headers are recorded per endpoint', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/me', 200, {}, { requestHeaders: { authorization: 'Bearer abc', 'x-api-key': 'k', 'x-request-id': '1' } });
    f.json('GET', '/api/basic', 200, {}, { requestHeaders: { Authorization: 'Basic dTpw' } });
    const endpoints = detect(f.capture());
    assert.deepEqual(find(endpoints, `GET ${ORIGIN}/api/me`).auth, { cookies: [], headers: ['authorization', 'x-api-key'], bearer: true, csrf: [], schemes: ['bearer'], sets: [['header:x-api-key', 'http:bearer']] });
    assert.deepEqual(find(endpoints, `GET ${ORIGIN}/api/basic`).auth, { cookies: [], headers: ['authorization'], bearer: false, csrf: [], schemes: ['basic'], sets: [['http:basic']] });
  });
});

describe('AuthDetector evidence of requests without credentials (EXP2-8)', () => {
  test('an endpoint is anonymous when a request without a session or auth cookie, bearer or auth header got a 2xx answer', () => {
    const f = new CaptureFactory();
    const sid = { cookie: 'sid=a1b2c3d4e5f6; auth=feedface' };
    f.json('GET', '/api/feed', 200, {}, { requestHeaders: sid });
    f.json('GET', '/api/feed', 200, {}, { requestHeaders: { cookie: 'theme=dark; _ga=GA1.1' } });
    f.json('GET', '/api/private', 200, {}, { requestHeaders: sid });
    f.json('GET', '/api/private', 401, {}, {});
    f.json('GET', '/api/bearer', 200, {}, { requestHeaders: { authorization: 'Bearer abc' } });
    f.json('GET', '/api/key', 200, {}, { requestHeaders: { 'x-api-key': 'k' } });
    f.document('/account', '', { status: 302, responseHeaders: { location: '/login' } });
    f.json('GET', '/api/public', 200, {});
    const endpoints = detect(f.capture());
    const anonymous = (path: string) => find(endpoints, `GET ${ORIGIN}${path}`).auth.anonymous;
    assert.equal(anonymous('/api/feed'), true);
    assert.equal(anonymous('/api/private'), undefined);
    assert.equal(anonymous('/api/bearer'), undefined);
    assert.equal(anonymous('/api/key'), undefined);
    assert.equal(anonymous('/account'), undefined);
    assert.equal(anonymous('/api/public'), true);
    assert.deepEqual(find(endpoints, `GET ${ORIGIN}/api/feed`).auth.cookies, ['_ga', 'auth', 'sid', 'theme']);
  });

  test('cache hits and responses made by a service worker are not evidence', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/feed', 200, {}, { requestHeaders: { cookie: 'sid=a1b2c3d4e5f6' } });
    f.json('GET', '/api/feed', 200, {}, { servedBy: 'cache', cacheKind: 'memory' });
    f.json('GET', '/api/feed', 200, {}, { servedBy: 'service-worker' });
    assert.equal(find(detect(f.capture()), `GET ${ORIGIN}/api/feed`).auth.anonymous, undefined);
  });

  test('the model validator accepts true or false and rejects other values', () => {
    const model = ModelBuilder.create().build(CaptureFactory.fixture().capture);
    const home = model.endpoints.find((endpoint) => endpoint.path === '/' && endpoint.method === 'GET')!;
    assert.equal(home.auth.anonymous, true);
    assert.deepEqual(new ModelValidator().validate(model), []);
    (home.auth as unknown as { anonymous: unknown }).anonymous = 'yes';
    assert.deepEqual(new ModelValidator().validate(model), [`endpoints[${model.endpoints.indexOf(home)}].auth.anonymous: expected true or false`]);
  });
});

describe('AuthDetector for endpoints without traffic', () => {
  function formEndpoint(method: string, origin: string, path: string, pageUrl: string): Endpoint {
    const endpoint = EndpointFactory.blank({ method, origin, path, kind: 'form' });
    endpoint.form = { pageUrl, selector: 'form', action: origin + path, method: method === 'GET' ? 'GET' : 'POST', enctype: 'application/x-www-form-urlencoded', charset: 'UTF-8', fields: [], submitters: [], tokenFields: ['csrf_token'] };
    return endpoint;
  }

  test('form token fields become hidden-field csrf tokens in the body or query', () => {
    const f = new CaptureFactory();
    const post = formEndpoint('POST', ORIGIN, '/signup', f.url('/signup'));
    const get = formEndpoint('GET', ORIGIN, '/search', f.url('/'));
    detector().detect([post, get], f.capture());
    assert.deepEqual(post.auth.csrf, [{ location: 'body', name: 'csrf_token', source: 'hidden-field', sourceName: 'csrf_token', sourceUrl: f.url('/signup') }]);
    assert.deepEqual(get.auth.csrf, [{ location: 'query', name: 'csrf_token', source: 'hidden-field', sourceName: 'csrf_token', sourceUrl: f.url('/') }]);
  });

  test('cookies a browser would send are predicted with RFC 6265bis matching and SameSite', () => {
    const f = new CaptureFactory();
    f.cookie('sid', 's', { httpOnly: true });
    f.cookie('scoped', 'x', { path: '/admin' });
    f.cookie('wide', 'w', { domain: 'example.com', hostOnly: false });
    f.cookie('other', 'o', { domain: 'other.example' });
    f.cookie('secure', 'z', { secure: true });
    f.cookie('expired', 'e', { expires: 1 });
    f.cookie('strict', 's', { sameSite: 'Strict' });
    f.cookie('none', 'n', { sameSite: 'None', secure: true });
    const capture = f.capture();
    const same = formEndpoint('POST', ORIGIN, '/signup', f.url('/signup'));
    assert.deepEqual(AuthDetector.predictCookies(same, capture), ['sid', 'wide', 'secure', 'strict', 'none']);
    const insecure = formEndpoint('POST', 'http://shop.example.com', '/signup', 'http://shop.example.com/');
    assert.deepEqual(AuthDetector.predictCookies(insecure, capture), ['sid', 'wide', 'strict']);
    const crossPost = formEndpoint('POST', ORIGIN, '/signup', 'https://evil.test/');
    assert.deepEqual(AuthDetector.predictCookies(crossPost, capture), ['none']);
    const crossGet = formEndpoint('GET', ORIGIN, '/search', 'https://evil.test/');
    assert.deepEqual(AuthDetector.predictCookies(crossGet, capture), ['sid', 'wide', 'secure', 'none']);
    const admin = formEndpoint('GET', ORIGIN, '/admin/{userId}', f.url('/'));
    assert.ok(AuthDetector.predictCookies(admin, capture).includes('scoped'));
    detector().detect([same], capture);
    assert.deepEqual(same.auth.cookies, ['none', 'secure', 'sid', 'strict', 'wide']);
  });
});

describe('AuthDetector token name policy', () => {
  test('generic token fields of APIs are not CSRF tokens without page evidence (FB-11)', () => {
    const f = new CaptureFactory('https://app.example.com');
    f.json('POST', '/api/auth/login', 200, { refreshToken: 'REFRESH-0123456789', csrfToken: 'CSRF-0123456789abc' }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { email: 'a@b.c', password: 'x' } } });
    f.json('POST', '/api/auth/refresh', 200, {}, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { token: 'REFRESH-0123456789' } } });
    f.json('POST', '/api/devices', 200, {}, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { token: 'fcm-device-token-0123456789', nonce: 'n-0123456789' } } });
    f.json('GET', '/api/verify-email?token=VERIFY-0123456789', 200, {});
    f.json('POST', '/api/orders', 200, {}, { requestHeaders: { 'x-nonce': 'client-nonce-0123456789', 'api-nonce': '1700000000123' } });
    const endpoints = detect(f.capture());
    assert.deepEqual(find(endpoints, 'POST https://app.example.com/api/orders').auth.csrf, []);
    assert.deepEqual(find(endpoints, 'POST https://app.example.com/api/auth/refresh').auth.csrf, []);
    assert.deepEqual(find(endpoints, 'POST https://app.example.com/api/devices').auth.csrf, []);
    assert.deepEqual(find(endpoints, 'GET https://app.example.com/api/verify-email').auth.csrf, []);
  });

  test('generic names are CSRF tokens when the value comes from a hidden token field, a CSRF meta tag or a CSRF cookie', () => {
    const f = new CaptureFactory();
    f.snapshot('/form', 'Form', '<html><head><meta name="csrf-token" content="meta-0123456789"></head><body><form method="post" action="/x"><input type="hidden" name="logintoken" value="hidden-0123456789"></form></body></html>');
    f.json('POST', '/api/a', 200, {}, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { token: 'meta-0123456789' } } });
    f.json('POST', '/api/b', 200, {}, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { logintoken: 'hidden-0123456789' } } });
    f.json('POST', '/api/c', 200, {}, { requestHeaders: { 'content-type': 'application/json', cookie: 'XSRF-TOKEN=cookie-0123456789' }, requestBody: { json: { _token: 'cookie-0123456789' } } });
    const endpoints = detect(f.capture());
    assert.deepEqual(find(endpoints, `POST ${ORIGIN}/api/a`).auth.csrf, [{ location: 'body', name: 'token', source: 'meta', sourceName: 'csrf-token', sourceUrl: f.url('/form') }]);
    assert.deepEqual(find(endpoints, `POST ${ORIGIN}/api/b`).auth.csrf, [{ location: 'body', name: 'logintoken', source: 'hidden-field', sourceName: 'logintoken', sourceUrl: f.url('/form') }]);
    assert.deepEqual(find(endpoints, `POST ${ORIGIN}/api/c`).auth.csrf, [{ location: 'body', name: '_token', source: 'cookie', sourceName: 'XSRF-TOKEN' }]);
  });

  test('hidden CSRF fields with framework names are token fields of the form (FB-10)', () => {
    const f = new CaptureFactory('https://moodle.example');
    const token = 'kXo3PzR9aB7cD1eF2gH3iJ4kL5mN6oP7';
    f.document('/login/index.php', CaptureFactory.page('Login', `<form method="post" action="/login/index.php"><input type="hidden" name="logintoken" value="${token}"><input name="username"><input type="password" name="password"></form>`));
    f.exchange({ method: 'POST', url: '/login/index.php', resourceType: 'document', status: 303, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: `logintoken=${token}&username=u&password=p` });
    const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture({ startUrl: 'https://moodle.example/login/index.php' }));
    const login = model.endpoints.find((endpoint) => endpoint.method === 'POST');
    assert.deepEqual(login?.form?.tokenFields, ['logintoken']);
    assert.deepEqual(login?.auth.csrf, [{ location: 'body', name: 'logintoken', source: 'hidden-field', sourceName: 'logintoken', sourceUrl: 'https://moodle.example/login/index.php' }]);
    const property = Schema.properties(login?.requestBody?.schema).logintoken;
    assert.equal(property?.['x-appii-token'], true);
    assert.equal(property?.default, undefined);
    assert.ok(!JSON.stringify(model).includes(token));
  });

  test('a token from a POST response records the method; a safe source is preferred (FB-12)', () => {
    const f = new CaptureFactory('https://app.example.com');
    f.json('POST', '/api/auth/login', 200, { csrfToken: 'CSRF-LOGIN-0123456789' }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { email: 'a@b.c' } } });
    f.json('POST', '/api/items', 201, {}, { requestHeaders: { 'content-type': 'application/json', 'x-csrf-token': 'CSRF-LOGIN-0123456789' }, requestBody: { json: { name: 'x' } } });
    f.json('POST', '/api/rotate', 200, { csrfToken: 'CSRF-BOTH-0123456789' });
    f.json('GET', '/api/csrf', 200, { csrfToken: 'CSRF-BOTH-0123456789' });
    f.json('POST', '/api/orders', 201, {}, { requestHeaders: { 'x-csrf-token': 'CSRF-BOTH-0123456789' } });
    const endpoints = detect(f.capture());
    assert.deepEqual(find(endpoints, 'POST https://app.example.com/api/items').auth.csrf, [
      { location: 'header', name: 'x-csrf-token', source: 'response', sourceName: 'csrfToken', sourceUrl: 'https://app.example.com/api/auth/login', sourceMethod: 'POST' },
    ]);
    assert.deepEqual(find(endpoints, 'POST https://app.example.com/api/orders').auth.csrf, [
      { location: 'header', name: 'x-csrf-token', source: 'response', sourceName: 'csrfToken', sourceUrl: 'https://app.example.com/api/csrf', sourceMethod: 'GET' },
    ]);
  });

  test('source URLs of CSRF tokens are redacted (FB-4)', () => {
    const f = new CaptureFactory();
    const token = 'tok-0123456789abcdef';
    f.snapshot('/dashboard?session_id=SESSIONIDSECRET42#access_token=FRAG', 'D', `<html><head><meta name="csrf-token" content="${token}"></head></html>`);
    f.json('GET', '/api/session?api_key=SESSIONAPIKEY123456', 200, { csrfToken: 'resp-0123456789abc' });
    f.json('POST', '/api/a', 200, {}, { requestHeaders: { 'x-csrf-token': token } });
    f.json('POST', '/api/b', 200, {}, { requestHeaders: { 'x-csrf-token': 'resp-0123456789abc' } });
    const endpoints = detect(f.capture());
    const encoded = encodeURIComponent(Samples.REDACTED);
    assert.equal(find(endpoints, `POST ${ORIGIN}/api/a`).auth.csrf[0]?.sourceUrl, `${ORIGIN}/dashboard?session_id=${encoded}#access_token=${encoded}`);
    assert.equal(find(endpoints, `POST ${ORIGIN}/api/b`).auth.csrf[0]?.sourceUrl, `${ORIGIN}/api/session?api_key=${encoded}`);
  });
});
