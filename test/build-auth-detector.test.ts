import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthDetector, BodyParser, CsrfSourceResolver, EndpointFactory, EndpointGrouper, PathTemplater, Redactor, SchemaInferrer } from '../src/build/index.js';
import { FormExtractor, TokenDetector } from '../src/forms/index.js';
import type { Capture, Endpoint } from '../src/model/index.js';
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
    });
  });

  test('csrf body field sourced from the hidden field of the login page', () => {
    const login = find(endpoints, `POST ${ORIGIN}/login`);
    assert.deepEqual(login.auth.csrf, [{ location: 'body', name: 'csrf_token', source: 'hidden-field', sourceName: 'csrf_token', sourceUrl: `${ORIGIN}/login` }]);
    assert.deepEqual(login.auth.cookies, ['sid', 'theme']);
  });

  test('endpoints that sent only cookies list the cookie names and nothing else', () => {
    const item = find(endpoints, `GET ${ORIGIN}/api/items/{itemId}`);
    assert.deepEqual(item.auth, { cookies: ['auth', 'csrf', 'sid', 'theme'], headers: [], bearer: false, csrf: [] });
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
      { location: 'header', name: 'x-xsrf-token', source: 'response', sourceName: 'csrfToken', sourceUrl: f.url('/api/session') },
    ]);
    assert.deepEqual(find(endpoints, `POST ${ORIGIN}/api/b`).auth.csrf[0]?.sourceName, 'deep');
    assert.deepEqual(find(endpoints, `POST ${ORIGIN}/api/c`).auth.csrf, [
      { location: 'header', name: 'x-csrf-token', source: 'response', sourceName: 'x-csrf-token', sourceUrl: f.url('/api/ping') },
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
        return new CsrfSourceResolver(capture, { extractor, tokens, body });
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
    assert.deepEqual(find(endpoints, `GET ${ORIGIN}/api/me`).auth, { cookies: [], headers: ['authorization', 'x-api-key'], bearer: true, csrf: [] });
    assert.deepEqual(find(endpoints, `GET ${ORIGIN}/api/basic`).auth, { cookies: [], headers: ['authorization'], bearer: false, csrf: [] });
  });
});

describe('AuthDetector for endpoints without traffic', () => {
  function formEndpoint(method: string, origin: string, path: string, pageUrl: string): Endpoint {
    const endpoint = EndpointFactory.blank({ method, origin, path, kind: 'form' });
    endpoint.form = { pageUrl, selector: 'form', enctype: 'application/x-www-form-urlencoded', fields: [], submitters: [], tokenFields: ['csrf_token'] };
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
