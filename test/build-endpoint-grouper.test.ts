import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BodyParser, EndpointGrouper, HeaderPolicy, ModelBuilder, ModelValidator, PathTemplater, Redactor, SchemaInferrer } from '../src/build/index.js';
import type { EndpointGrouperOptions } from '../src/build/index.js';
import type { Endpoint } from '../src/model/index.js';
import { Samples } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const ORIGIN = CaptureFactory.ORIGIN;

function grouper(options: Partial<EndpointGrouperOptions> = {}, redact = true): EndpointGrouper {
  return new EndpointGrouper(
    { body: new BodyParser(), schemas: new SchemaInferrer(), paths: new PathTemplater(), redactor: new Redactor(redact) },
    { includeStatic: false, includeDocuments: true, maxExamples: 3, ...options },
  );
}

function byKey(endpoints: Endpoint[], key: string): Endpoint {
  const found = endpoints.find((endpoint) => endpoint.key === key);
  assert.ok(found, `${key} in ${endpoints.map((endpoint) => endpoint.key).join(', ')}`);
  return found;
}

describe('EndpointGrouper on the fixture flow', () => {
  const { capture, csrf, ids } = CaptureFactory.fixture();
  const endpoints = grouper().group(capture.exchanges);

  test('groups by method, origin and path template', () => {
    assert.deepEqual(endpoints.map((endpoint) => endpoint.key).sort(), [
      `GET ${ORIGIN}/`,
      `GET ${ORIGIN}/account`,
      `GET ${ORIGIN}/api/items`,
      `GET ${ORIGIN}/api/items/{itemId}`,
      `GET ${ORIGIN}/app`,
      `GET ${ORIGIN}/login`,
      `GET ${ORIGIN}/signup`,
      `POST ${ORIGIN}/api/items`,
      `POST ${ORIGIN}/graphql#GetItem`,
      `POST ${ORIGIN}/login`,
    ]);
    for (const endpoint of endpoints) {
      assert.equal(endpoint.id, endpoint.key);
      assert.deepEqual(endpoint.auth, { cookies: [], headers: [], bearer: false, csrf: [] });
      assert.equal(endpoint.firstParty, false);
    }
  });

  test('item endpoint: path param, statuses, kinds and diverse samples', () => {
    const item = byKey(endpoints, `GET ${ORIGIN}/api/items/{itemId}`);
    assert.equal(item.kind, 'json');
    assert.equal(item.count, 3);
    assert.deepEqual(item.pathParams, [{ name: 'itemId', in: 'path', required: true, schema: { type: 'integer' }, examples: ['1', '2', '999'] }]);
    assert.deepEqual(
      item.responses.map((response) => [response.status, response.count, response.headers]),
      [
        [200, 2, ['content-type']],
        [404, 1, ['content-type']],
      ],
    );
    const ok = item.responses[0]?.body;
    assert.equal(ok?.kind, 'json');
    assert.equal(ok?.mimeType, 'application/json');
    assert.deepEqual(ok?.schema, {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: 'string' },
        price: { type: 'number' },
        tags: { type: 'array', items: { type: 'string' } },
        createdAt: { type: 'string', format: 'date-time' },
      },
      required: ['id', 'name', 'price', 'tags', 'createdAt'],
    });
    assert.equal(ok?.examples.length, 2);
    assert.deepEqual(item.responses[1]?.body?.examples, [{ error: 'not found' }]);
    assert.deepEqual(item.resourceTypes, ['fetch']);
    assert.deepEqual(item.samples.map((sample) => sample.exchangeId), [ids.item1, ids.item2, ids.item999]);
    assert.deepEqual(item.samples.map((sample) => sample.status), [200, 200, 404]);
  });

  test('list endpoint: integer query params required in every sample, fetch and xhr', () => {
    const list = byKey(endpoints, `GET ${ORIGIN}/api/items`);
    assert.deepEqual(list.queryParams, [
      { name: 'page', in: 'query', required: true, schema: { type: 'integer' }, examples: ['1', '2'] },
      { name: 'limit', in: 'query', required: true, schema: { type: 'integer' }, examples: ['2'] },
    ]);
    assert.deepEqual(list.resourceTypes, ['fetch', 'xhr']);
    assert.equal(list.requestBody, undefined);
  });

  test('json post: merged request body, csrf header param redacted in examples only', () => {
    const create = byKey(endpoints, `POST ${ORIGIN}/api/items`);
    assert.equal(create.kind, 'json');
    assert.deepEqual(create.requestBody, {
      mimeType: 'application/json',
      kind: 'json',
      schema: { type: 'object', properties: { name: { type: 'string' }, price: { type: 'integer' } }, required: ['price'] },
      examples: [{ name: 'Thing', price: 5 }, { price: -1 }],
    });
    assert.deepEqual(create.headerParams, [{ name: 'x-csrf-token', in: 'header', required: true, schema: { type: 'string' }, examples: [Samples.REDACTED] }]);
    assert.ok(!JSON.stringify(create).includes(csrf));
    assert.deepEqual(create.responses.map((response) => response.status), [201, 400]);
  });

  test('form post: urlencoded body with secrets redacted, redirect headers and set-cookie names', () => {
    const login = byKey(endpoints, `POST ${ORIGIN}/login`);
    assert.equal(login.kind, 'form');
    assert.deepEqual(login.requestBody?.schema, {
      type: 'object',
      properties: { csrf_token: { type: 'string' }, email: { type: 'string', format: 'email' }, password: { type: 'string' }, action: { type: 'string' } },
      required: ['csrf_token', 'email', 'password', 'action'],
    });
    assert.deepEqual(login.requestBody?.examples, [{ csrf_token: Samples.REDACTED, email: 'user@example.com', password: Samples.REDACTED, action: 'login' }]);
    assert.deepEqual(login.responses, [{ status: 303, count: 1, headers: ['location', 'set-cookie: auth'], redirectTo: ['https://shop.example.com/account'] }]);
    assert.deepEqual(login.headerParams, []);
  });

  test('graphql and documents', () => {
    const graphql = byKey(endpoints, `POST ${ORIGIN}/graphql#GetItem`);
    assert.equal(graphql.kind, 'graphql');
    assert.equal(graphql.operationName, 'GetItem');
    assert.equal(graphql.requestBody?.kind, 'graphql');
    const home = byKey(endpoints, `GET ${ORIGIN}/`);
    assert.equal(home.kind, 'document');
    assert.deepEqual(home.responses[0]?.headers, ['content-type', 'set-cookie: sid', 'set-cookie: theme']);
    assert.deepEqual(home.responses[0]?.body, { mimeType: 'text/html', kind: 'html', schema: { type: 'string' }, examples: [] });
  });
});

describe('EndpointGrouper filtering', () => {
  function sample(): CaptureFactory {
    const f = new CaptureFactory();
    f.document('/', '<p>home</p>');
    f.exchange({ url: '/static/app.js', resourceType: 'script', status: 200, responseHeaders: { 'content-type': 'text/javascript' }, responseBody: 'x()' });
    f.exchange({ url: '/logo.png', resourceType: 'image', status: 200, responseHeaders: { 'content-type': 'image/png' } });
    f.exchange({ url: '/favicon.ico', resourceType: 'other', status: 404, responseHeaders: { 'content-type': 'text/html' } });
    f.exchange({ url: '/fonts/x', resourceType: 'other', status: 200, responseHeaders: { 'content-type': 'font/woff2' } });
    f.exchange({ url: '/styles', resourceType: 'other', status: 200, responseHeaders: { 'content-type': 'text/css' } });
    f.exchange({
      method: 'OPTIONS',
      url: '/api/data',
      status: 204,
      requestHeaders: { 'access-control-request-method': 'PUT', origin: 'https://other.example' },
    });
    f.exchange({ url: 'wss://shop.example.com/socket', resourceType: 'websocket', status: 101 });
    f.exchange({ url: 'data:text/plain,hi', status: 200 });
    f.exchange({ method: 'OPTIONS', url: '/api/data', status: 204 });
    f.json('GET', '/api/data', 200, { ok: true });
    f.exchange({ method: 'POST', url: '/upload.png', status: 201, requestHeaders: { 'content-type': 'image/png' }, requestBody: new Uint8Array([1, 2]) });
    return f;
  }

  test('skips static assets, preflights, websockets and non-http urls by default', () => {
    const keys = grouper()
      .group(sample().capture().exchanges)
      .map((endpoint) => endpoint.key);
    assert.deepEqual(keys, [`GET ${ORIGIN}/`, `OPTIONS ${ORIGIN}/api/data`, `GET ${ORIGIN}/api/data`, `POST ${ORIGIN}/upload.png`]);
  });

  test('includeStatic keeps assets and includeDocuments=false drops GET navigations', () => {
    const all = grouper({ includeStatic: true }).group(sample().capture().exchanges).map((endpoint) => endpoint.path);
    assert.ok(all.includes('/static/app.js') && all.includes('/logo.png') && all.includes('/favicon.ico') && all.includes('/fonts/x'));
    assert.ok(!all.includes('/socket'));
    const noDocs = grouper({ includeDocuments: false }).group(sample().capture().exchanges).map((endpoint) => endpoint.path);
    assert.ok(!noDocs.includes('/'));
  });

  test('isStaticAsset, isDocument and isPreflight decisions', () => {
    const f = new CaptureFactory();
    const g = grouper();
    const json = f.json('GET', '/api/x.json', 200, {});
    assert.equal(g.isStaticAsset(json), false);
    const js = f.exchange({ url: '/lib.mjs', status: 200 });
    assert.equal(g.isStaticAsset(js), true);
    const postJs = f.exchange({ method: 'POST', url: '/lib.js', status: 200 });
    assert.equal(g.isStaticAsset(postJs), false);
    const redirect = f.exchange({ url: '/go', resourceType: 'document', status: 302, responseHeaders: { location: '/' } });
    assert.equal(g.isDocument(redirect), true);
    const jsonNav = f.json('GET', '/api/nav', 200, {}, { resourceType: 'document' });
    assert.equal(g.isDocument(jsonNav), false);
    const failedNav = f.exchange({ url: '/down', resourceType: 'document', error: 'net::ERR_CONNECTION_REFUSED' });
    assert.equal(g.isDocument(failedNav), true);
    assert.equal(EndpointGrouper.extension('/a/b.min.JS'), 'js');
    assert.equal(EndpointGrouper.extension('/a/.hidden'), '');
  });

  test('a file name with an encoded query keeps its real extension (BOOKS-5)', () => {
    assert.equal(EndpointGrouper.extension('/a/b.woff%3Fv=3.2.1'), 'woff');
    assert.equal(EndpointGrouper.extension('/a/b.svg%23icon'), 'svg');
    assert.equal(EndpointGrouper.extension('/a/report%2Ev1.PDF'), 'pdf');
    const f = new CaptureFactory();
    const font = f.exchange({ url: '/static/fonts/fontawesome-webfont.woff%3Fv=3.2.1', resourceType: 'other', status: 200, responseHeaders: { 'content-type': 'application/octet-stream' }, responseBody: 'wOFF' });
    assert.equal(grouper().isStaticAsset(font), true);
    assert.deepEqual(grouper().group([font]), []);
  });
});

describe('EndpointGrouper details', () => {
  test('failed exchanges count but add no response, header params exclude browser headers', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/me', 200, { email: 'a@b.c' }, {
      requestHeaders: {
        authorization: 'Bearer abc.def',
        'x-api-key': 'k-123',
        'x-request-id': 'r1',
        'user-agent': 'UA',
        'accept-language': 'en',
        'sec-ch-ua': 'x',
        referer: 'https://shop.example.com/',
        'if-match': 'W/"1"',
        range: 'bytes=0-1',
        priority: 'u=1',
        traceparent: '00-abc-def-01',
      },
    });
    f.exchange({ url: '/api/me', requestHeaders: { authorization: 'Bearer zzz', 'x-api-key': 'k-456' }, error: 'net::ERR_FAILED' });
    const [me] = grouper().group(f.capture().exchanges);
    assert.ok(me);
    assert.equal(me.count, 2);
    assert.equal(me.responses.length, 1);
    assert.deepEqual(me.samples.map((sample) => sample.status), [200, undefined]);
    assert.deepEqual(
      me.headerParams.map((param) => [param.name, param.required, param.examples]),
      [
        ['authorization', true, ['Bearer <redacted>']],
        ['x-api-key', true, [Samples.REDACTED]],
        ['x-request-id', false, ['r1']],
        ['if-match', false, ['W/"1"']],
        ['range', false, ['bytes=0-1']],
        ['traceparent', false, ['00-abc-def-01']],
      ],
    );
  });

  test('maxExamples bounds samples, examples and param examples; zero disables them', () => {
    const f = new CaptureFactory();
    for (let i = 1; i <= 6; i++) f.json('GET', `/api/things/${i}?q=${i}`, i === 6 ? 500 : 200, { n: i });
    const [one] = grouper({ maxExamples: 2 }).group(f.capture().exchanges);
    assert.ok(one);
    assert.deepEqual(one.samples.map((sample) => sample.status), [200, 500]);
    assert.deepEqual(one.pathParams[0]?.examples, ['1', '2']);
    assert.deepEqual(one.queryParams[0]?.examples, ['1', '2']);
    assert.equal(one.responses[0]?.body?.examples.length, 2);
    const [none] = grouper({ maxExamples: 0 }).group(f.capture().exchanges);
    assert.deepEqual(none?.samples, []);
    assert.deepEqual(none?.pathParams[0]?.examples, []);
    assert.deepEqual(none?.responses[0]?.body?.examples, []);
  });

  test('sample urls redact secret query values; disabling redaction keeps everything', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/reset?token=s3cr3t-value&page=2', 200, { access_token: 'abc', user: 'u' });
    const [redacted] = grouper().group(f.capture().exchanges);
    assert.equal(redacted?.samples[0]?.url, `${ORIGIN}/api/reset?token=%3Credacted%3E&page=2`);
    assert.deepEqual(redacted?.queryParams.map((param) => param.examples), [[Samples.REDACTED], ['2']]);
    assert.deepEqual(redacted?.responses[0]?.body?.examples, [{ access_token: Samples.REDACTED, user: 'u' }]);
    assert.deepEqual(redacted?.responses[0]?.body?.schema, { type: 'object', properties: { access_token: { type: 'string' }, user: { type: 'string' } }, required: ['access_token', 'user'] });
    const [raw] = grouper({}, false).group(f.capture().exchanges);
    assert.equal(raw?.samples[0]?.url, `${ORIGIN}/api/reset?token=s3cr3t-value&page=2`);
    assert.deepEqual(raw?.responses[0]?.body?.examples, [{ access_token: 'abc', user: 'u' }]);
  });

  test('samples name the page that made the request, with secret query values redacted (EXP2-9)', () => {
    const f = new CaptureFactory();
    f.json('POST', '/api/items', 201, { id: 1 }, { pageUrl: f.url('/app?session_token=s3cr3t-value&tab=1'), requestBody: { json: { name: 'x' } }, requestHeaders: { 'content-type': 'application/json' } });
    f.json('GET', '/api/me', 200, { id: 1 });
    const endpoints = grouper().group(f.capture().exchanges);
    assert.equal(byKey(endpoints, `POST ${ORIGIN}/api/items`).samples[0]?.pageUrl, `${ORIGIN}/app?session_token=%3Credacted%3E&tab=1`);
    assert.equal(Object.hasOwn(byKey(endpoints, `GET ${ORIGIN}/api/me`).samples[0] ?? {}, 'pageUrl'), false);
    const raw = grouper({}, false).group(f.capture().exchanges);
    assert.equal(byKey(raw, `POST ${ORIGIN}/api/items`).samples[0]?.pageUrl, `${ORIGIN}/app?session_token=s3cr3t-value&tab=1`);
  });

  test('graphql operations split endpoints; GET graphql is detected from the query parameter', () => {
    const f = new CaptureFactory();
    f.json('POST', '/graphql', 200, { data: {} }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { query: 'query A { a }' } } });
    f.json('POST', '/graphql', 200, { data: {} }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { query: 'mutation B { b }' } } });
    f.json('POST', '/graphql', 200, { data: {} }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { query: '{ c }' } } });
    f.json('GET', `/graphql?query=${encodeURIComponent('query C { c }')}`, 200, { data: {} });
    f.json('GET', '/search?query=red+shoes', 200, []);
    const endpoints = grouper().group(f.capture().exchanges);
    assert.deepEqual(
      endpoints.map((endpoint) => [endpoint.key, endpoint.kind]),
      [
        [`POST ${ORIGIN}/graphql#A`, 'graphql'],
        [`POST ${ORIGIN}/graphql#B`, 'graphql'],
        [`POST ${ORIGIN}/graphql`, 'graphql'],
        [`GET ${ORIGIN}/graphql#C`, 'graphql'],
        [`GET ${ORIGIN}/search`, 'json'],
      ],
    );
  });

  test('multipart bodies describe files as binary strings and keep file metadata in examples', () => {
    const f = new CaptureFactory();
    const raw =
      '--b\r\nContent-Disposition: form-data; name="title"\r\n\r\nHi\r\n--b\r\nContent-Disposition: form-data; name="photo"; filename="a.png"\r\nContent-Type: image/png\r\n\r\nPNG\r\n--b\r\nContent-Disposition: form-data; name="docs"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n1\r\n--b\r\nContent-Disposition: form-data; name="docs"; filename="y.bin"\r\nContent-Type: application/octet-stream\r\n\r\n22\r\n--b--\r\n';
    f.json('POST', '/upload', 201, { ok: true }, { requestHeaders: { 'content-type': 'multipart/form-data; boundary=b' }, requestBody: raw });
    const [upload] = grouper().group(f.capture().exchanges);
    assert.equal(upload?.kind, 'form');
    assert.deepEqual(upload?.requestBody?.schema, {
      type: 'object',
      properties: {
        title: { type: 'string' },
        photo: { type: 'string', format: 'binary', contentMediaType: 'image/png' },
        docs: { type: 'array', items: { type: 'string', format: 'binary' } },
      },
      required: ['title', 'photo', 'docs'],
    });
    assert.deepEqual(upload?.requestBody?.examples, [
      {
        title: 'Hi',
        photo: { filename: 'a.png', contentType: 'image/png', size: 3 },
        docs: [
          { filename: 'x.bin', contentType: 'application/octet-stream', size: 1 },
          { filename: 'y.bin', contentType: 'application/octet-stream', size: 2 },
        ],
      },
    ]);
  });

  test('responses whose bodies were not captured are described by their declared media type', () => {
    const f = new CaptureFactory();
    f.exchange({ url: '/api/lost', status: 200, responseHeaders: { 'content-type': 'application/json', 'content-length': '93' } });
    f.exchange({ url: '/api/lost', status: 204, responseHeaders: { 'content-type': 'application/json' } });
    f.exchange({ url: '/api/empty', status: 200, responseHeaders: { 'content-type': 'application/json', 'content-length': '0' } });
    f.exchange({ method: 'HEAD', url: '/api/head', status: 200, responseHeaders: { 'content-type': 'application/json' } });
    const endpoints = grouper().group(f.capture().exchanges);
    const lost = endpoints.find((endpoint) => endpoint.path === '/api/lost');
    assert.equal(lost?.kind, 'json');
    assert.deepEqual(lost?.responses, [
      { status: 200, count: 1, body: { mimeType: 'application/json', kind: 'json', examples: [] }, headers: ['content-type'] },
      { status: 204, count: 1, headers: ['content-type'] },
    ]);
    const empty = endpoints.find((endpoint) => endpoint.path === '/api/empty');
    assert.equal(empty?.kind, 'other');
    assert.equal(empty?.responses[0]?.body, undefined);
    assert.equal(endpoints.find((endpoint) => endpoint.path === '/api/head')?.responses[0]?.body, undefined);
  });

  test('response examples are compacted while request examples stay exact', () => {
    const f = new CaptureFactory();
    const long = 'x'.repeat(2000);
    const items = Array.from({ length: 30 }, (_, i) => i);
    f.json('POST', '/api/bulk', 200, { items, text: long }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { items, text: long } } });
    const [bulk] = grouper().group(f.capture().exchanges);
    const response = bulk?.responses[0]?.body?.examples[0] as { items: number[]; text: string };
    assert.equal(response.items.length, 10);
    assert.equal(response.text.length, 500);
    const request = bulk?.requestBody?.examples[0] as { items: number[]; text: string };
    assert.equal(request.items.length, 30);
    assert.equal(request.text.length, 2000);
  });

  test('repeated query keys become array params', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/filter?tag=a&tag=b', 200, []);
    f.json('GET', '/api/filter?tag=c', 200, []);
    const [filter] = grouper().group(f.capture().exchanges);
    assert.deepEqual(filter?.queryParams, [{ name: 'tag', in: 'query', required: true, schema: { type: 'array', items: { type: 'string' } }, examples: ['a', 'b', 'c'] }]);
  });
});

describe('Redactor', () => {
  const redactor = new Redactor();

  test('secret fields are detected on snake-cased word boundaries', () => {
    for (const name of ['password', 'newPassword', 'csrf_token', 'X-CSRF-Token', 'accessToken', 'api_key', 'apiKey', 'client_secret', 'sid', 'sessionId', 'pin', 'cvv']) {
      assert.equal(redactor.isSecretField(name), true, name);
    }
    for (const name of ['author', 'tokens', 'pinned', 'spinner', 'key', 'name', 'email', 'passage', '']) {
      assert.equal(redactor.isSecretField(name), false, name);
    }
  });

  test('headers keep authorization schemes and cookie names', () => {
    assert.equal(redactor.header('Authorization', 'Bearer abc'), 'Bearer <redacted>');
    assert.equal(redactor.header('authorization', 'opaque'), Samples.REDACTED);
    assert.equal(redactor.header('Cookie', 'a=1; b=2'), 'a=<redacted>; b=<redacted>');
    assert.equal(redactor.header('Set-Cookie', 'sid=abc; Path=/; HttpOnly\nx=1'), 'sid=<redacted>; Path=/; HttpOnly\nx=<redacted>');
    assert.equal(redactor.header('X-Session-Token', 'abc'), Samples.REDACTED);
    assert.equal(redactor.header('X-Custom', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl'), Samples.REDACTED);
    assert.equal(redactor.header('X-Request-Id', 'abc'), 'abc');
  });

  test('deep redaction is pure, keeps booleans and redacts whole secret subtrees', () => {
    const input = { user: 'a', password: 'p', remember_token: true, credentials: { login: 'x', pin: 1234, list: ['a', 2] }, nested: [{ secret: 7 }], jwt: null };
    const before = structuredClone(input);
    assert.deepEqual(redactor.deep(input), {
      user: 'a',
      password: Samples.REDACTED,
      remember_token: true,
      credentials: { login: Samples.REDACTED, pin: Samples.REDACTED, list: [Samples.REDACTED, Samples.REDACTED] },
      nested: [{ secret: Samples.REDACTED }],
      jwt: null,
    });
    assert.deepEqual(input, before);
  });

  test('urls redact secret query values and passwords; disabled redactors change nothing', () => {
    assert.equal(redactor.url('https://u:pw@example.com/a?token=x&b=1#f'), 'https://u:%3Credacted%3E@example.com/a?token=%3Credacted%3E&b=1#f');
    assert.equal(redactor.url('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(redactor.url('not a url'), 'not a url');
    const off = new Redactor(false);
    assert.equal(off.enabled, false);
    assert.equal(off.header('Authorization', 'Bearer x'), 'Bearer x');
    assert.deepEqual(off.deep({ password: 'p' }), { password: 'p' });
    assert.equal(off.field('password', 'p'), 'p');
    assert.equal(off.url('https://e.com/?token=x'), 'https://e.com/?token=x');
  });
});

describe('HeaderPolicy', () => {
  const policy = new HeaderPolicy();

  test('classifies params, auth headers, csrf headers and notable response headers', () => {
    for (const name of ['x-csrf-token', 'authorization', 'x-api-key', 'traceparent', 'x-requested-with']) assert.equal(policy.isParam(name), true, name);
    for (const name of ['User-Agent', 'accept-encoding', 'sec-fetch-site', 'cookie', 'if-match', 'range', 'priority', 'proxy-authorization', ':authority', 'content-type', '']) {
      assert.equal(policy.isParam(name), false, name);
    }
    for (const name of ['Authorization', 'x-api-key', 'api-key', 'x-auth-token', 'x-my-api-key', 'ocp-apim-subscription-key']) assert.equal(policy.isAuth(name), true, name);
    assert.equal(policy.isAuth('x-request-id'), false);
    for (const name of ['x-csrf-token', 'X-XSRF-TOKEN', 'RequestVerificationToken', 'x-csrftoken']) assert.equal(policy.isCsrf(name), true, name);
    assert.equal(policy.isCsrf('x-request-id'), false);
    for (const name of ['Content-Type', 'location', 'x-ratelimit-remaining', 'RateLimit-Reset', 'www-authenticate']) assert.equal(policy.isNotableResponse(name), true, name);
    assert.equal(policy.isNotableResponse('date'), false);
  });
});

describe('GraphQL detection (FB-22)', () => {
  test('GET persisted queries without a query parameter are split by operation', () => {
    const f = new CaptureFactory();
    const extensions = encodeURIComponent(JSON.stringify({ persistedQuery: { version: 1, sha256Hash: 'abc' } }));
    for (const operation of ['GetViewer', 'ListProducts']) {
      f.json('GET', `/graphql?operationName=${operation}&variables=%7B%7D&extensions=${extensions}`, 200, { data: {} });
    }
    const endpoints = grouper().group(f.capture().exchanges);
    assert.deepEqual(endpoints.map((endpoint) => [endpoint.key, endpoint.kind]).sort(), [
      [`GET ${ORIGIN}/graphql#GetViewer`, 'graphql'],
      [`GET ${ORIGIN}/graphql#ListProducts`, 'graphql'],
    ]);
  });

  test('free text that starts with a GraphQL keyword is not a document', () => {
    const f = new CaptureFactory();
    f.json('GET', '/search?query=mutation+testing', 200, {});
    f.json('GET', '/search?query=shoes', 200, {});
    f.json('POST', '/api/search', 200, {}, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { query: 'fragment shader tutorial' } } });
    f.json('POST', '/api/search', 200, {}, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { query: 'query letters' } } });
    f.json('GET', '/graphql?query=' + encodeURIComponent('query Q($id: ID!) @live { item(id: $id) { id } }'), 200, {});
    const endpoints = grouper().group(f.capture().exchanges);
    assert.deepEqual(endpoints.map((endpoint) => [endpoint.key, endpoint.kind]).sort(), [
      [`GET ${ORIGIN}/graphql#Q`, 'graphql'],
      [`GET ${ORIGIN}/search`, 'json'],
      [`POST ${ORIGIN}/api/search`, 'json'],
    ]);
  });
});

describe('EndpointGrouper content from script requests (HTTPBIN-2, HTTPBIN-5, HTTPBIN-7, HTTPBIN-10)', () => {
  test('a fetch that returns an image is an endpoint, an image element load is a static asset', () => {
    const f = new CaptureFactory();
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    f.exchange({ url: '/api/avatar', resourceType: 'fetch', status: 200, responseHeaders: { 'content-type': 'image/png' }, responseBody: png, responseType: 'image/png' });
    f.exchange({ url: '/image/png', resourceType: 'xhr', status: 200, responseHeaders: { 'content-type': 'image/png' }, responseBody: png, responseType: 'image/png' });
    f.exchange({ url: '/logo', resourceType: 'image', status: 200, responseHeaders: { 'content-type': 'image/png' } });
    f.exchange({ url: '/bundle.js', resourceType: 'fetch', status: 200, responseHeaders: { 'content-type': 'text/javascript' } });
    const endpoints = grouper().group(f.capture().exchanges);
    assert.deepEqual(endpoints.map((endpoint) => endpoint.key), [`GET ${ORIGIN}/api/avatar`, `GET ${ORIGIN}/image/png`]);
    assert.deepEqual(byKey(endpoints, `GET ${ORIGIN}/api/avatar`).responses[0]?.body, { mimeType: 'image/png', kind: 'binary', examples: [] });
  });

  test('Range and conditional headers set by page script are parameters; validators the cache sent are not', () => {
    const f = new CaptureFactory();
    f.exchange({ url: '/range/64', status: 206, requestHeaders: { range: 'bytes=0-15' }, responseHeaders: { 'content-type': 'application/octet-stream', 'content-range': 'bytes 0-15/64' } });
    f.exchange({ url: '/etag/abc', status: 304, requestHeaders: { 'if-none-match': '"abc"', 'cache-control': 'max-age=0' }, responseHeaders: { etag: 'abc' } });
    f.json('GET', '/api/me', 200, { id: 1 }, { responseHeaders: { etag: 'W/"v1"', 'last-modified': 'Tue, 06 Oct 2026 00:00:00 GMT' } });
    f.exchange({ url: '/api/me', status: 304, requestHeaders: { 'if-none-match': 'W/"v1"', 'if-modified-since': 'Tue, 06 Oct 2026 00:00:00 GMT' } });
    f.exchange({ url: '/doc', resourceType: 'document', status: 206, requestHeaders: { range: 'bytes=0-1' }, responseHeaders: { 'content-type': 'text/html' } });
    const endpoints = grouper().group(f.capture().exchanges);
    const params = (key: string) => byKey(endpoints, key).headerParams.map((param) => [param.name, param.required, param.examples]);
    assert.deepEqual(params(`GET ${ORIGIN}/range/{range}`), [['range', false, ['bytes=0-15']]]);
    assert.deepEqual(params(`GET ${ORIGIN}/etag/abc`), [['if-none-match', false, ['"abc"']]]);
    assert.deepEqual(params(`GET ${ORIGIN}/api/me`), []);
    assert.deepEqual(params(`GET ${ORIGIN}/doc`), []);
    assert.equal(new HeaderPolicy().isParam('range'), false);
    assert.equal(new HeaderPolicy().isParam('range', new Set(['range'])), true);
  });

  test('newline-delimited JSON served as application/json keeps an item schema', () => {
    const f = new CaptureFactory();
    const lines = [0, 1, 2].map((id) => JSON.stringify({ id, url: 'https://e.com/stream/3', args: {} })).join('\n') + '\n';
    f.exchange({ url: '/stream/3', status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: lines, responseType: 'application/json' });
    const [stream] = grouper().group(f.capture().exchanges);
    const body = stream?.responses[0]?.body;
    assert.equal(body?.kind, 'json');
    assert.equal(body?.mimeType, 'application/json');
    assert.equal(body?.jsonLines, true);
    assert.deepEqual(body?.schema, { type: 'object', properties: { id: { type: 'integer' }, url: { type: 'string', format: 'uri' }, args: { type: 'object', properties: {} } }, required: ['id', 'url', 'args'] });
    assert.deepEqual(body?.examples[0], { id: 0, url: 'https://e.com/stream/3', args: {} });
  });

  test('one endpoint keeps every request media type it received', async () => {
    const f = new CaptureFactory();
    f.exchange({ method: 'POST', url: '/post', resourceType: 'document', status: 200, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'custname=a&size=small' });
    f.json('POST', '/post', 200, { ok: true }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { name: 'n', qty: 2 } } });
    const form = new FormData();
    form.append('title', 't');
    form.append('upload', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
    const request = new Request('http://x/', { method: 'POST', body: form });
    const bytes = new Uint8Array(await request.arrayBuffer());
    f.json('POST', '/post', 200, { ok: true }, { requestHeaders: { 'content-type': request.headers.get('content-type') ?? '' }, requestBody: bytes });
    const [post] = grouper().group(f.capture().exchanges);
    assert.equal(post?.requestBody?.kind, 'form');
    assert.deepEqual(post?.otherRequestBodies?.map((body) => [body.kind, body.mimeType]), [['json', 'application/json'], ['multipart', 'multipart/form-data']]);
    const multipart = post?.otherRequestBodies?.[1]?.schema as { properties?: Record<string, unknown> } | undefined;
    assert.deepEqual(multipart?.properties?.upload, { type: 'string', format: 'binary', contentMediaType: 'text/plain' });
    const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
    assert.deepEqual(new ModelValidator().validate(model), []);
    assert.equal(model.endpoints.find((endpoint) => endpoint.path === '/post')?.otherRequestBodies?.length, 2);
  });
});
