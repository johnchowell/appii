import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AuthDetector,
  BodyParser,
  CookieClassifier,
  CookieInventory,
  EndpointGrouper,
  EndpointNamer,
  FormLinker,
  ModelBuilder,
  OriginSelector,
  PathTemplater,
  Redactor,
  SchemaInferrer,
} from '../src/build/index.js';
import { CaptureSession, CookieParser, HarConverter } from '../src/capture/index.js';
import { FormExtractor, FormSchemaBuilder, TokenDetector } from '../src/forms/index.js';
import type { ApiModel, Capture, Endpoint, JsonSchema } from '../src/model/index.js';
import { AppiiError, EndpointIndex, Samples, Schema } from '../src/shared/index.js';
import { FIXTURE_USER, startFixtureSite } from './fixtures/site.js';
import type { FixtureSite } from './fixtures/site.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const ORIGIN = CaptureFactory.ORIGIN;
const NOW = new Date('2026-06-01T12:00:00.000Z');

function endpoint(model: ApiModel, ref: string): Endpoint {
  return EndpointIndex.of(model).require(ref);
}

function prop(schema: JsonSchema | undefined, name: string): JsonSchema {
  const found = Schema.properties(schema)[name];
  assert.ok(found, name);
  return found;
}

function isAppiiError(code: string) {
  return (err: unknown): boolean => err instanceof AppiiError && err.code === code;
}

function withThirdParty(): Capture {
  const { factory } = CaptureFactory.fixture();
  factory.json('GET', 'https://cdn.example.com/api/config', 200, { flags: [] });
  factory.json('POST', 'https://www.google-analytics.com/collect', 204, undefined, { requestHeaders: { 'content-type': 'text/plain' }, requestBody: 'v=1' });
  factory.websocket('wss://shop.example.com/live', [
    { direction: 'sent', at: '2026-01-01T00:00:01.000Z', opcode: 'text', data: '{"type":"auth","token":"secret-token"}' },
    { direction: 'received', at: '2026-01-01T00:00:02.000Z', opcode: 'text', data: 'hello' },
    { direction: 'received', at: '2026-01-01T00:00:03.000Z', opcode: 'binary', data: 'AQID' },
    { direction: 'received', at: '2026-01-01T00:00:04.000Z', opcode: 'text', data: 'hello' },
  ]);
  factory.websocket('wss://ws.tracker.example/feed', [{ direction: 'received', at: '2026-01-01T00:00:05.000Z', opcode: 'text', data: 'x' }]);
  return factory.capture();
}

describe('ModelBuilder on a hand-built fixture capture', () => {
  const capture = withThirdParty();
  const model = ModelBuilder.create({ now: NOW }).build(capture);

  test('model header, origins and source', () => {
    assert.equal(model.version, 1);
    assert.equal(model.name, 'shop.example.com');
    assert.equal(model.generatedAt, NOW.toISOString());
    assert.equal(model.primaryOrigin, ORIGIN);
    assert.deepEqual(model.origins, ['https://cdn.example.com', ORIGIN]);
    assert.deepEqual(model.source, { startUrl: `${ORIGIN}/`, exchanges: capture.exchanges.length, capturedFrom: capture.startedAt, capturedTo: capture.endedAt });
  });

  test('endpoints are sorted by origin, path and method with stable ids and names', () => {
    assert.deepEqual(
      model.endpoints.map((e) => [e.id, e.name, e.kind]),
      [
        ['get-api-config', 'getConfig', 'json'],
        ['get-root', 'getHomePage', 'document'],
        ['get-account', 'getAccountPage', 'document'],
        ['get-api-items', 'listItems', 'json'],
        ['post-api-items', 'createItem', 'json'],
        ['get-api-items-itemid', 'getItem', 'json'],
        ['get-app', 'getAppPage', 'document'],
        ['post-graphql-getitem', 'graphqlGetItem', 'graphql'],
        ['get-login', 'getLoginPage', 'document'],
        ['post-login', 'postLogin', 'form'],
        ['get-search', 'getSearch', 'form'],
        ['get-signup', 'getSignupPage', 'document'],
        ['post-signup', 'postSignup', 'form'],
      ],
    );
    assert.ok(model.endpoints.every((e) => e.firstParty));
    assert.deepEqual(Object.keys(endpoint(model, 'post-login')), [
      'id', 'name', 'key', 'method', 'origin', 'path', 'kind', 'firstParty', 'pathParams', 'queryParams', 'headerParams', 'requestBody', 'responses', 'auth', 'form', 'resourceTypes', 'samples', 'count',
    ]);
    assert.deepEqual(Object.keys(endpoint(model, 'post-graphql-getitem')).slice(0, 8), ['id', 'name', 'key', 'method', 'origin', 'path', 'operationName', 'kind']);
  });

  test('auth, csrf and forms are combined on the endpoints', () => {
    assert.deepEqual(endpoint(model, 'createItem').auth.csrf, [{ location: 'header', name: 'x-csrf-token', source: 'cookie', sourceName: 'csrf' }]);
    const login = endpoint(model, 'postLogin');
    assert.deepEqual(login.auth.csrf, [{ location: 'body', name: 'csrf_token', source: 'hidden-field', sourceName: 'csrf_token', sourceUrl: `${ORIGIN}/login` }]);
    assert.equal(prop(login.requestBody?.schema, 'password')['x-html-minlength'], 8);
    const signup = endpoint(model, 'postSignup');
    assert.deepEqual(signup.auth.cookies, ['auth', 'csrf', 'sid', 'theme']);
    assert.equal(signup.requestBody?.mimeType, 'multipart/form-data');
    assert.equal(endpoint(model, 'getSearch').queryParams[0]?.name, 'q');
    assert.equal(model.forms.length, 3);
  });

  test('cookies, websockets and the request samples other namespaces build from the model', () => {
    assert.deepEqual(
      model.cookies.map((c) => [c.name, c.role, c.setBy]),
      [
        ['auth', 'auth', ['post-login']],
        ['csrf', 'csrf', ['get-app']],
        ['sid', 'session', ['get-root']],
        ['theme', 'preference', ['get-root']],
      ],
    );
    assert.deepEqual(model.websockets, [{ url: 'wss://shop.example.com/live', messages: 4, examples: ['{"type":"auth","token":"<redacted>"}', 'hello'] }]);
    const sample = Samples.requestSample(endpoint(model, 'createItem'));
    assert.equal(String(sample.url), `${ORIGIN}/api/items`);
    assert.deepEqual(
      sample.headers.map((header) => ({ name: header.name, value: String(header.value) })),
      [
        { name: 'x-csrf-token', value: '{{csrf}}' },
        { name: 'Content-Type', value: 'application/json' },
      ],
    );
    assert.equal(String(Samples.requestSample(endpoint(model, 'getItem')).url), `${ORIGIN}/api/items/1`);
  });

  test('building is deterministic and does not mutate the capture', () => {
    const copy = structuredClone(capture);
    const again = ModelBuilder.create({ now: NOW }).build(capture);
    assert.deepEqual(again, model);
    assert.equal(JSON.stringify(again), JSON.stringify(model));
    assert.deepEqual(capture, copy);
  });

  test('the model is plain JSON data', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(model)), model);
  });
});

describe('ModelBuilder options', () => {
  test('origins, allOrigins and the default first-party selection', () => {
    const capture = withThirdParty();
    assert.deepEqual(ModelBuilder.firstPartyOrigins(capture), ['https://cdn.example.com', ORIGIN]);
    const all = ModelBuilder.create({ allOrigins: true, now: NOW }).build(capture);
    assert.deepEqual(all.origins, ['https://cdn.example.com', ORIGIN, 'https://www.google-analytics.com']);
    const analytics = all.endpoints.find((e) => e.origin === 'https://www.google-analytics.com');
    assert.equal(analytics?.firstParty, false);
    assert.equal(all.websockets.length, 2);
    const only = ModelBuilder.create({ origins: ['https://cdn.example.com/some/path', 'https://cdn.example.com'], now: NOW }).build(capture);
    assert.deepEqual(only.origins, ['https://cdn.example.com']);
    assert.deepEqual(only.endpoints.map((e) => e.id), ['get-api-config']);
    assert.equal(only.primaryOrigin, 'https://cdn.example.com');
    assert.deepEqual(only.cookies, []);
    assert.deepEqual(only.forms, []);
  });

  test('name, includeDocuments, includeStatic, maxExamples and redact', () => {
    const { factory } = CaptureFactory.fixture();
    factory.exchange({ url: '/app.js', resourceType: 'script', status: 200, responseHeaders: { 'content-type': 'text/javascript' }, responseBody: 'x' });
    const capture = factory.capture();
    const lean = ModelBuilder.create({ name: 'Shop', includeDocuments: false, maxExamples: 1, now: NOW }).build(capture);
    assert.equal(lean.name, 'Shop');
    assert.ok(lean.endpoints.every((e) => e.kind !== 'document'));
    assert.ok(lean.endpoints.some((e) => e.id === 'get-search'));
    assert.ok(lean.endpoints.every((e) => e.samples.length <= 1));
    assert.ok(!lean.endpoints.some((e) => e.path === '/app.js'));
    const full = ModelBuilder.create({ includeStatic: true, redact: false, now: NOW }).build(capture);
    assert.ok(full.endpoints.some((e) => e.path === '/app.js'));
    assert.deepEqual(endpoint(full, 'createItem').headerParams[0]?.examples, ['0123456789abcdef0123456789abcdef']);
    assert.equal(full.cookies.find((c) => c.name === 'sid')?.valueExample, 'a1b2c3d4e5f6a7b8c9d0e1f2');
    assert.equal(prop(endpoint(full, 'postLogin').requestBody?.schema, 'csrf_token')['x-appii-token-example'], '0123456789abcdef0123456789abcdef');
    const redacted = ModelBuilder.create({ now: NOW }).build(capture);
    assert.ok(!JSON.stringify(redacted).includes('0123456789abcdef0123456789abcdef'));
    assert.ok(!JSON.stringify(redacted).includes('a1b2c3d4e5f6a7b8c9d0e1f2'));
    assert.ok(!JSON.stringify(redacted).includes('feedfacecafebeef0011223344556677'));
  });

  test('invalid options are rejected with BAD_INPUT', () => {
    assert.throws(() => ModelBuilder.create({ maxExamples: -1 }), isAppiiError('BAD_INPUT'));
    assert.throws(() => ModelBuilder.create({ maxExamples: 1.5 }), isAppiiError('BAD_INPUT'));
    assert.throws(() => ModelBuilder.create({ origins: ['example.com'] }), isAppiiError('BAD_INPUT'));
    assert.throws(() => ModelBuilder.create({ origins: ['ftp://example.com'] }), isAppiiError('BAD_INPUT'));
    assert.throws(() => ModelBuilder.create({ now: new Date('nope') }), isAppiiError('BAD_INPUT'));
    assert.equal(ModelBuilder.normalizeOrigin(' https://Example.COM:443/x?y '), 'https://example.com');
  });

  test('an empty capture builds an empty model', () => {
    const capture = new CaptureFactory().capture({ startUrl: null });
    const model = ModelBuilder.create({ now: NOW }).build(capture);
    assert.deepEqual(
      { ...model, generatedAt: '' },
      {
        version: 1,
        name: 'api',
        generatedAt: '',
        source: { exchanges: 0, capturedFrom: capture.startedAt, capturedTo: capture.endedAt },
        primaryOrigin: '',
        origins: [],
        endpoints: [],
        cookies: [],
        forms: [],
        websockets: [],
      },
    );
  });

  test('parts built by their own create factories match ModelBuilder.create', () => {
    const capture = CaptureFactory.fixture().capture;
    const parts = {
      grouper: EndpointGrouper.create(),
      auth: AuthDetector.create(),
      cookies: CookieInventory.create(),
      forms: FormLinker.create(),
      namer: new EndpointNamer(),
    };
    assert.deepEqual(new ModelBuilder(parts, { now: NOW }).build(capture), ModelBuilder.create({ now: NOW }).build(capture));
    const open = new ModelBuilder(
      { grouper: EndpointGrouper.create({ redact: false, maxExamples: 1 }), auth: AuthDetector.create(), cookies: CookieInventory.create({ redact: false }), forms: FormLinker.create({ redact: false }), namer: new EndpointNamer() },
      { now: NOW },
    ).build(capture);
    assert.equal(open.cookies.find((c) => c.name === 'auth')?.valueExample, 'feedfacecafebeef0011223344556677');
    assert.ok(open.endpoints.every((e) => e.samples.length <= 1));
    assert.equal(prop(endpoint(open, 'postLogin').requestBody?.schema, 'csrf_token')['x-appii-token-example'], '0123456789abcdef0123456789abcdef');
  });

  test('custom parts are used as injected', () => {
    const body = new BodyParser();
    const schemas = new SchemaInferrer();
    const tokens = new TokenDetector();
    const extractor = new FormExtractor({ tokens });
    const calls: string[] = [];
    class TracingNamer extends EndpointNamer {
      override name(endpoints: Endpoint[]): void {
        calls.push(`name:${endpoints.length}`);
        super.name(endpoints);
        for (const e of endpoints) e.name = `x_${e.name}`;
      }
    }
    const builder = new ModelBuilder(
      {
        grouper: new EndpointGrouper({ body, schemas, paths: new PathTemplater(), redactor: new Redactor() }, { includeStatic: false, includeDocuments: false, maxExamples: 2 }),
        auth: new AuthDetector({ extractor, tokens, body }),
        cookies: new CookieInventory({ classifier: new CookieClassifier(), parser: new CookieParser(), redactor: new Redactor() }),
        forms: new FormLinker({ extractor, schemas: new FormSchemaBuilder({ tokens }), inferrer: schemas }),
        namer: new TracingNamer(),
      },
      { now: NOW },
    );
    const model = builder.build(CaptureFactory.fixture().capture);
    assert.deepEqual(calls, [`name:${model.endpoints.length}`]);
    assert.ok(model.endpoints.every((e) => e.name.startsWith('x_')));
    assert.ok(model.endpoints.every((e) => e.kind !== 'document'));
  });
});

describe('OriginSelector', () => {
  test('first-party domains follow the start url and its redirect chain', () => {
    const f = new CaptureFactory('http://example.com');
    const start = f.exchange({ url: '/', resourceType: 'document', status: 301, responseHeaders: { location: 'https://www.example.org/' } });
    f.document('https://www.example.org/', '<p>moved</p>', { redirectedFrom: start.id });
    f.json('GET', 'https://api.example.org/v1/me', 200, {});
    f.json('GET', 'https://static.example.com/x', 200, {});
    f.json('GET', 'https://other.test/x', 200, {});
    const capture = f.capture({ startUrl: 'http://example.com' });
    assert.deepEqual(OriginSelector.startChain(capture), ['http://example.com/', 'https://www.example.org/']);
    assert.deepEqual([...OriginSelector.referenceDomains(capture)].sort(), ['example.com', 'example.org']);
    assert.deepEqual(ModelBuilder.firstPartyOrigins(capture), ['http://example.com', 'https://api.example.org', 'https://static.example.com', 'https://www.example.org']);
    assert.equal(OriginSelector.primary(capture, ModelBuilder.firstPartyOrigins(capture)), 'https://www.example.org');
  });

  test('an SSO redirect at the start URL does not make the identity provider first party (FB-23)', () => {
    const f = new CaptureFactory('https://app.example.com');
    const idp = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=1&redirect_uri=https%3A%2F%2Fapp.example.com%2Fauth%2Fcallback';
    const start = f.exchange({ url: '/dashboard', resourceType: 'document', status: 302, responseHeaders: { location: idp } });
    f.document(idp, '<form method=post action="/signin"><input name=identifier><button>Next</button></form>', { redirectedFrom: start.id });
    f.json('POST', 'https://accounts.google.com/_/signin/challenge', 200, { ok: 1 }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { a: 1 } } });
    const callback = f.exchange({ url: '/auth/callback?code=abc', resourceType: 'document', status: 302, responseHeaders: { location: '/dashboard' } });
    f.document('/dashboard', '<h1>Dashboard</h1>', { redirectedFrom: callback.id });
    for (let i = 0; i < 5; i++) f.json('GET', `/api/projects/${i + 1}`, 200, { id: i + 1 });
    f.json('GET', 'https://www.google.com/recaptcha/api2/anchor?k=x', 200, {});
    f.json('POST', 'https://play.google.com/log?format=json', 200, {}, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: [1] } });
    const capture = f.capture({ startUrl: 'https://app.example.com/dashboard' });
    const model = ModelBuilder.create({ now: new Date(0) }).build(capture);
    assert.equal(model.primaryOrigin, 'https://app.example.com');
    assert.equal(model.name, 'app.example.com');
    assert.deepEqual(model.origins, ['https://app.example.com']);
    assert.deepEqual([...OriginSelector.referenceDomains(capture)], ['example.com']);
    const all = ModelBuilder.create({ now: new Date(0), allOrigins: true }).build(capture);
    assert.equal(all.primaryOrigin, 'https://app.example.com');
    assert.ok(all.endpoints.filter((endpoint) => endpoint.origin.includes('google.com')).every((endpoint) => !endpoint.firstParty));
  });

  test('a temporary redirect to another domain is a move when the start domain never returns', () => {
    const f = new CaptureFactory('https://old.example.com');
    const start = f.exchange({ url: '/', resourceType: 'document', status: 302, responseHeaders: { location: 'https://www.newbrand.test/' } });
    f.document('https://www.newbrand.test/', '<p>new</p>', { redirectedFrom: start.id });
    f.json('GET', 'https://api.newbrand.test/v1/me', 200, {});
    const capture = f.capture({ startUrl: 'https://old.example.com/' });
    assert.deepEqual([...OriginSelector.referenceDomains(capture)].sort(), ['example.com', 'newbrand.test']);
    assert.equal(OriginSelector.primary(capture, ModelBuilder.firstPartyOrigins(capture)), 'https://www.newbrand.test');
  });

  test('without a start url the most frequent document origin decides', () => {
    const f = new CaptureFactory('https://app.example.net');
    f.document('/', '<p/>');
    f.document('/b', '<p/>');
    f.document('https://login.other.test/', '<p/>');
    for (let i = 0; i < 5; i++) f.json('GET', 'https://other.test/api', 200, {});
    const capture = f.capture({ startUrl: null });
    assert.deepEqual(ModelBuilder.firstPartyOrigins(capture), ['https://app.example.net']);
    const noDocuments = new CaptureFactory('https://x.example');
    noDocuments.json('GET', '/a', 200, {});
    assert.deepEqual(ModelBuilder.firstPartyOrigins(noDocuments.capture({ startUrl: null })), ['https://x.example']);
  });

  test('localhost ports and IP hosts are one site each', () => {
    const f = new CaptureFactory('http://localhost:3000');
    f.document('/', '<p/>');
    f.json('GET', 'http://localhost:4000/api', 200, {});
    f.json('GET', 'http://127.0.0.1:4000/api', 200, {});
    assert.deepEqual(ModelBuilder.firstPartyOrigins(f.capture({ startUrl: 'http://localhost:3000/' })), ['http://localhost:3000', 'http://localhost:4000']);
  });
});

describe('ModelBuilder with HAR imports', () => {
  test('a HAR round trip of the capture yields the same endpoints', () => {
    const capture = CaptureFactory.fixture().capture;
    const har = new HarConverter();
    const imported = har.fromHar(har.toHar(capture));
    const direct = ModelBuilder.create({ now: NOW }).build(capture);
    const viaHar = ModelBuilder.create({ now: NOW }).build(imported);
    assert.deepEqual(
      viaHar.endpoints.map((e) => [e.id, e.name, e.count]),
      direct.endpoints.map((e) => [e.id, e.name, e.count]),
    );
  });
});

describe('ModelBuilder integration with a real browser capture', () => {
  let site: FixtureSite;
  let capture: Capture;
  let model: ApiModel;

  before(async () => {
    site = await startFixtureSite();
    capture = await CaptureSession.create({
      url: site.url,
      headless: true,
      idleMs: 400,
      script: async (page) => {
        await page.goto(site.origin + '/login');
        await page.fill('#email', FIXTURE_USER.email);
        await page.fill('#password', FIXTURE_USER.password);
        await Promise.all([page.waitForURL('**/account'), page.click('#login button[type=submit]')]);
        await page.goto(site.origin + '/app');
        await page.waitForFunction(() => document.getElementById('out')?.textContent === 'done 2');
        await page.goto(site.origin + '/signup');
      },
    }).run();
    model = ModelBuilder.create({ now: NOW }).build(capture);
  });

  after(async () => {
    await site?.close();
  });

  test('origins and first-party endpoints', () => {
    assert.deepEqual(model.origins, [site.origin]);
    assert.equal(model.primaryOrigin, site.origin);
    assert.ok(model.endpoints.every((e) => e.firstParty && e.origin === site.origin));
  });

  test('item endpoint with 200 and 404, list endpoint with integer page and limit', () => {
    const item = endpoint(model, 'getItem');
    assert.equal(item.path, '/api/items/{itemId}');
    assert.deepEqual(item.responses.map((r) => r.status), [200, 404]);
    assert.equal(item.pathParams[0]?.schema.type, 'integer');
    const list = endpoint(model, 'listItems');
    assert.equal(list.path, '/api/items');
    assert.deepEqual(
      list.queryParams.map((p) => [p.name, p.required, p.schema.type]),
      [
        ['page', true, 'integer'],
        ['limit', true, 'integer'],
      ],
    );
  });

  test('POST /api/items with the csrf header sourced from the csrf cookie', () => {
    const create = endpoint(model, 'createItem');
    assert.equal(create.key, `POST ${site.origin}/api/items`);
    assert.deepEqual(create.auth.csrf, [{ location: 'header', name: 'x-csrf-token', source: 'cookie', sourceName: 'csrf' }]);
    assert.deepEqual(create.responses.map((r) => r.status), [201, 400]);
    assert.deepEqual(create.requestBody?.schema?.required, ['price']);
  });

  test('POST /login is a form endpoint with a hidden-field csrf token and email/password constraints', () => {
    const login = endpoint(model, 'postLogin');
    assert.equal(login.kind, 'form');
    assert.equal(login.count, 1);
    assert.deepEqual(login.auth.csrf, [{ location: 'body', name: 'csrf_token', source: 'hidden-field', sourceName: 'csrf_token', sourceUrl: `${site.origin}/login` }]);
    assert.equal(login.form?.selector, 'form#login');
    const schema = login.requestBody?.schema;
    assert.deepEqual(schema?.required, ['email', 'password', 'action']);
    assert.equal(prop(schema, 'email').format, 'email');
    assert.equal(prop(schema, 'email')['x-html-type'], 'email');
    assert.equal(prop(schema, 'password')['x-html-minlength'], 8);
    assert.equal(prop(schema, 'csrf_token')['x-appii-token'], true);
    assert.deepEqual(login.responses.map((r) => [r.status, r.headers]), [[303, ['location', 'set-cookie: auth']]]);
    assert.ok(!JSON.stringify(model).includes(FIXTURE_USER.password));
  });

  test('POST /signup is a multipart form endpoint with all constraints, from the form alone', () => {
    const signup = endpoint(model, 'postSignup');
    assert.equal(signup.count, 0);
    assert.equal(signup.requestBody?.mimeType, 'multipart/form-data');
    const schema = signup.requestBody?.schema;
    assert.deepEqual(schema?.required, ['intent']);
    const create = schema?.then as JsonSchema;
    assert.deepEqual(create.required, ['username', 'email', 'country', 'terms', 'intent']);
    assert.equal(prop(create, 'username').pattern, '^(?:[a-z0-9_]{3,16})$');
    assert.equal(prop(schema, 'email').format, 'email');
    assert.deepEqual([prop(create, 'age').minimum, prop(create, 'age').maximum], [13, 120]);
    assert.equal(prop(schema, 'website')['x-html-type'], 'url');
    assert.deepEqual([prop(schema, 'birthday')['x-html-min'], prop(schema, 'birthday')['x-html-max']], ['1900-01-01', '2026-12-31']);
    assert.deepEqual(prop(create, 'country').enum, ['us', 'ca']);
    assert.deepEqual(prop(schema, 'plan').enum, ['free', 'pro']);
    assert.deepEqual(prop(schema, 'interests').items, { type: 'string', enum: ['a', 'b', 'c'], 'x-html-labels': ['A', 'B', 'C'], 'x-html-type': 'select-multiple' });
    assert.deepEqual([prop(schema, 'bio').maxLength, prop(schema, 'bio')['x-html-maxlength']], [400, 200]);
    assert.equal(prop(schema, 'terms')['x-html-required'], true);
    assert.equal(prop(schema, 'avatar')['x-html-accept'], 'image/*');
    assert.equal(prop(schema, 'readonly_field').readOnly, true);
    assert.deepEqual(prop(schema, 'intent').enum, ['create', 'draft']);
    assert.deepEqual(signup.queryParams.map((p) => [p.name, p.required]), [['draft', false]]);
  });

  test('GET /search is created from the search form alone', () => {
    const search = endpoint(model, 'getSearch');
    assert.equal(search.kind, 'form');
    assert.equal(search.count, 0);
    assert.deepEqual(search.queryParams.map((p) => [p.name, p.required]), [['q', true]]);
  });

  test('GraphQL GetItem', () => {
    const graphql = model.endpoints.find((e) => e.operationName === 'GetItem');
    assert.ok(graphql);
    assert.equal(graphql.kind, 'graphql');
    assert.equal(graphql.path, '/graphql');
    assert.equal(graphql.name, 'graphqlGetItem');
    assert.equal(graphql.requestBody?.kind, 'graphql');
  });

  test('cookies sid (session, HttpOnly) and auth (auth)', () => {
    const sid = model.cookies.find((c) => c.name === 'sid');
    const auth = model.cookies.find((c) => c.name === 'auth');
    assert.equal(sid?.role, 'session');
    assert.equal(sid?.httpOnly, true);
    assert.equal(auth?.role, 'auth');
    assert.equal(auth?.httpOnly, true);
    assert.deepEqual(auth?.setBy, ['post-login']);
    assert.equal(model.cookies.find((c) => c.name === 'csrf')?.role, 'csrf');
    assert.equal(model.cookies.find((c) => c.name === 'theme')?.role, 'preference');
  });
});
