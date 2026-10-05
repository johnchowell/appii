import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BodyParser, EndpointGrouper, FormCollector, FormLinker, HtmlPages, PageDocuments, PathTemplater, Redactor, SchemaInferrer } from '../src/build/index.js';
import { EntrySlotFactory, FormExtractor, FormSchemaBuilder, TokenDetector } from '../src/forms/index.js';
import type { Capture, Endpoint, JsonSchema } from '../src/model/index.js';
import { Samples, Schema } from '../src/shared/index.js';
import { SchemaCheck } from './fixtures/build-schema-check.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const ORIGIN = CaptureFactory.ORIGIN;
const tokens = new TokenDetector();
const extractor = new FormExtractor({ tokens });

function linker(): FormLinker {
  return new FormLinker({ extractor, schemas: new FormSchemaBuilder({ tokens }), inferrer: new SchemaInferrer() });
}

function grouped(capture: Capture, includeDocuments = true): Endpoint[] {
  return new EndpointGrouper(
    { body: new BodyParser(), schemas: new SchemaInferrer(), paths: new PathTemplater(), redactor: new Redactor() },
    { includeStatic: false, includeDocuments, maxExamples: 3 },
  ).group(capture.exchanges);
}

function find(endpoints: Endpoint[], key: string): Endpoint {
  const found = endpoints.find((endpoint) => endpoint.key === key);
  assert.ok(found, `${key} in ${endpoints.map((endpoint) => endpoint.key).join(', ')}`);
  return found;
}

function prop(schema: JsonSchema | undefined, name: string): JsonSchema {
  const found = Schema.properties(schema)[name];
  assert.ok(found, name);
  return found;
}

describe('FormLinker on the fixture flow', () => {
  const { capture, csrf } = CaptureFactory.fixture();
  const input = grouped(capture);
  const { endpoints, forms } = linker().link(input, capture);

  test('collects and deduplicates the forms of the captured pages', () => {
    assert.deepEqual(
      forms.map((form) => [new URL(form.pageUrl).pathname, form.selector]),
      [
        ['/login', 'form#login'],
        ['/login', ':root > body:nth-child(2) > form:nth-child(3)'],
        ['/signup', 'form#signup'],
      ],
    );
    assert.equal(endpoints.length, input.length + 2);
  });

  test('the login form is attached to the observed POST /login with form constraints winning', () => {
    const login = find(endpoints, `POST ${ORIGIN}/login`);
    assert.equal(login.kind, 'form');
    assert.equal(login.count, 1);
    assert.equal(login.form?.selector, 'form#login');
    assert.equal(login.form?.pageUrl, `${ORIGIN}/login`);
    assert.deepEqual(login.form?.tokenFields, ['csrf_token']);
    const body = login.requestBody;
    assert.equal(body?.mimeType, 'application/x-www-form-urlencoded');
    assert.equal(body?.kind, 'form');
    assert.deepEqual(body?.schema?.required, ['email', 'password', 'action']);
    assert.deepEqual(prop(body?.schema, 'password'), { type: 'string', title: 'Password', minLength: 4, 'x-html-minlength': 8, 'x-html-type': 'password', 'x-html-required': true });
    assert.equal(prop(body?.schema, 'email').format, undefined);
    assert.equal(prop(body?.schema, 'email').pattern, EntrySlotFactory.PATTERNS.email);
    assert.equal(prop(body?.schema, 'csrf_token')['x-appii-token'], true);
    assert.equal(prop(body?.schema, 'csrf_token')['x-appii-token-example'], Samples.REDACTED);
    assert.equal(login.form?.fields.find((field) => field.name === 'csrf_token')?.value, Samples.REDACTED);
    assert.equal(forms[0]?.fields[0]?.value, Samples.REDACTED);
    assert.ok(!JSON.stringify({ endpoints, forms }).includes(csrf));
    assert.deepEqual(Object.keys(Schema.properties(body?.schema)), ['csrf_token', 'email', 'password', 'remember', 'action']);
    assert.equal(body?.examples.length, 1);
  });

  test('the GET search form creates an endpoint from the form alone', () => {
    const search = find(endpoints, `GET ${ORIGIN}/search`);
    assert.equal(search.kind, 'form');
    assert.equal(search.count, 0);
    assert.deepEqual(search.samples, []);
    assert.deepEqual(search.responses, []);
    assert.equal(search.requestBody, undefined);
    assert.deepEqual(search.queryParams, [
      { name: 'q', in: 'query', required: true, schema: { type: 'string', minLength: 1, 'x-html-type': 'search', 'x-html-required': true, 'x-html-placeholder': 'Search' }, examples: [] },
    ]);
    assert.equal(search.form?.enctype, 'application/x-www-form-urlencoded');
  });

  test('the multipart signup form keeps every validating constraint and accepts both submitters', () => {
    const signup = find(endpoints, `POST ${ORIGIN}/signup`);
    assert.equal(signup.kind, 'form');
    const body = signup.requestBody;
    assert.equal(body?.mimeType, 'multipart/form-data');
    assert.equal(body?.kind, 'multipart');
    assert.deepEqual(body?.examples, []);
    const schema = body?.schema;
    assert.deepEqual(schema?.required, ['intent']);
    assert.deepEqual(schema?.if, { required: ['intent'], properties: { intent: { const: 'create' } } });
    const create = schema?.then as JsonSchema;
    assert.deepEqual(create.required, ['username', 'email', 'country', 'terms', 'intent']);
    assert.equal(prop(create, 'username').pattern, '^(?:[a-z0-9_]{3,16})?$');
    assert.deepEqual([prop(create, 'age').minimum, prop(create, 'age').maximum, prop(create, 'age').type], [13, 120, ['integer', 'string']]);
    assert.deepEqual(prop(create, 'country').enum, ['us', 'ca']);
    assert.equal(prop(schema, 'username')['x-html-pattern'], '[a-z0-9_]{3,16}');
    assert.equal(prop(schema, 'username').pattern, undefined);
    assert.deepEqual([prop(schema, 'website').format, prop(schema, 'website')['x-html-type']], [undefined, 'url']);
    assert.equal(prop(schema, 'birthday')['x-html-max'], '2026-12-31');
    assert.deepEqual(prop(schema, 'plan').enum, ['free', 'pro']);
    assert.equal(prop(schema, 'interests').uniqueItems, true);
    assert.deepEqual([prop(schema, 'bio').maxLength, prop(schema, 'bio')['x-html-maxlength']], [400, 200]);
    assert.equal(prop(schema, 'terms').const, 'on');
    assert.deepEqual(prop(schema, 'avatar'), { type: 'string', format: 'binary', 'x-html-accept': 'image/*', 'x-html-type': 'file' });
    assert.equal(prop(schema, 'readonly_field').readOnly, true);
    assert.ok(!('locked' in Schema.properties(schema)) && !('disabled_field' in Schema.properties(schema)));
    assert.deepEqual(prop(schema, 'intent'), { type: 'string', 'x-html-type': 'submit', enum: ['create', 'draft'], 'x-html-labels': ['Create', 'Save draft'] });
    const valid = { username: 'good_name', email: 'g@example.com', country: 'us', terms: 'on', intent: 'create' };
    assert.deepEqual(SchemaCheck.errors(schema, valid), []);
    assert.deepEqual(SchemaCheck.errors(schema, { ...valid, age: '', website: '', birthday: '' }), [], 'empty optional controls are valid');
    assert.ok(!SchemaCheck.valid(schema, { ...valid, age: 'x' }));
    assert.ok(!SchemaCheck.valid(schema, { ...valid, email: 'not-an-email' }));
    assert.deepEqual(SchemaCheck.errors(schema, { intent: 'draft', username: '', country: '' }), []);
    assert.ok(!SchemaCheck.valid(schema, { ...valid, username: 'A!' }));
    assert.ok(!SchemaCheck.valid(schema, { intent: 'create' }));
    assert.deepEqual(signup.queryParams, [{ name: 'draft', in: 'query', required: false, schema: { type: 'integer' }, examples: ['1'] }]);
    assert.equal(signup.form?.enctype, 'multipart/form-data');
    assert.equal(signup.form?.submitters.length, 2);
  });
});

describe('FormLinker redaction', () => {
  test('token values, secret defaults and secret query values in urls are redacted unless disabled', () => {
    const f = new CaptureFactory();
    f.snapshot(
      '/settings?session_id=s3cr3t',
      'Settings',
      `<form method="post" action="/settings?token=abc"><input type="hidden" name="_csrf" value="tok-123456789">
       <input type="hidden" name="api_key" value="k-1"><input name="nickname" value="bob"><input type="checkbox" name="pin" value="yes" checked>
       <button name="save" value="1" formaction="/settings?auth=xyz">Save</button></form>`,
    );
    const capture = f.capture();
    const redacting = new FormLinker({ extractor, schemas: new FormSchemaBuilder({ tokens }), inferrer: new SchemaInferrer(), redactor: new Redactor(true) });
    const { endpoints, forms } = redacting.link([], capture);
    const settings = endpoints[0];
    assert.ok(settings);
    const schema = settings.requestBody?.schema;
    assert.equal(prop(schema, '_csrf')['x-appii-token-example'], Samples.REDACTED);
    assert.equal(prop(schema, 'api_key').default, Samples.REDACTED);
    assert.equal(prop(schema, 'nickname').default, 'bob');
    assert.equal(prop(schema, 'pin').const, 'yes');
    const fields = Object.fromEntries((settings.form?.fields ?? []).map((field) => [field.name, field.value]));
    assert.deepEqual(fields, { _csrf: Samples.REDACTED, api_key: Samples.REDACTED, nickname: 'bob', pin: 'yes' });
    assert.equal(settings.form?.pageUrl, `${ORIGIN}/settings?session_id=%3Credacted%3E`);
    assert.equal(forms[0]?.action, `${ORIGIN}/settings?token=%3Credacted%3E`);
    assert.equal(forms[0]?.submitters[0]?.formAction, `${ORIGIN}/settings?auth=%3Credacted%3E`);
    assert.deepEqual(settings.queryParams.map((param) => [param.name, param.required, param.examples]), [['auth', true, [Samples.REDACTED]]]);
    assert.equal(settings.path, '/settings');
    const raw = new FormLinker({ extractor, schemas: new FormSchemaBuilder({ tokens }), inferrer: new SchemaInferrer(), redactor: new Redactor(false) }).link([], capture);
    assert.equal(prop(raw.endpoints[0]?.requestBody?.schema, '_csrf')['x-appii-token-example'], 'tok-123456789');
    assert.equal(raw.forms[0]?.action, `${ORIGIN}/settings?token=abc`);
  });
});

describe('FormLinker matching rules', () => {
  test('a GET form overlays an observed document endpoint: form kind, form constraints, observed examples', () => {
    const f = new CaptureFactory();
    f.document('/', '<form action="/find"><input name="q" required maxlength="20"><select name="sort"><option>new</option><option>old</option></select></form>');
    f.document('/find?q=shoes&sort=new&extra=1', '<p>results</p>');
    const capture = f.capture();
    const { endpoints } = linker().link(grouped(capture), capture);
    const find_ = find(endpoints, `GET ${ORIGIN}/find`);
    assert.equal(find_.kind, 'form');
    assert.equal(find_.count, 1);
    assert.deepEqual(
      find_.queryParams.map((param) => [param.name, param.required, param.examples, param.schema['x-html-type'] ?? param.schema.type]),
      [
        ['q', true, ['shoes'], 'text'],
        ['sort', false, ['new'], 'select-one'],
        ['extra', true, ['1'], 'integer'],
      ],
    );
    assert.equal(find(endpoints, `GET ${ORIGIN}/`).kind, 'document');
  });

  test('form actions are templated and matched against templated endpoints', () => {
    const f = new CaptureFactory();
    f.document('/items', '<form method="post" action="/items/42/edit"><input name="name"></form><form method="post" action="/items/7/edit"><input name="name"></form>');
    f.json('POST', '/api/items/9', 200, {}, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { name: 'x', note: 'n' } } });
    f.snapshot('/edit', 'Edit', '<form method="post" action="/api/items/5"><input name="name" required></form>');
    const capture = f.capture();
    const { endpoints } = linker().link(grouped(capture), capture);
    const edit = find(endpoints, `POST ${ORIGIN}/items/{itemId}/edit`);
    assert.deepEqual(edit.pathParams, [{ name: 'itemId', in: 'path', required: true, schema: { type: 'integer' }, examples: ['42', '7'] }]);
    assert.equal(edit.requestBody?.mimeType, 'application/x-www-form-urlencoded');
    const api = find(endpoints, `POST ${ORIGIN}/api/items/{itemId}`);
    assert.equal(api.kind, 'json');
    assert.equal(api.requestBody?.mimeType, 'application/json');
    assert.deepEqual(Object.keys(Schema.properties(api.requestBody?.schema)), ['name', 'note']);
    assert.deepEqual(api.requestBody?.schema?.required, ['name', 'note']);
    assert.equal(prop(api.requestBody?.schema, 'name')['x-html-required'], true);
    assert.deepEqual(api.requestBody?.examples, [{ name: 'x', note: 'n' }]);
  });

  test('dialog forms, javascript actions and other schemes are skipped', () => {
    const f = new CaptureFactory();
    f.snapshot(
      '/',
      'Home',
      `<form method="dialog"><button>x</button></form>
       <form action="javascript:void(0)"><input name="a"></form>
       <form action="mailto:x@example.com" method="post"><input name="b"></form>
       <form method="post" action="/real"><button formmethod="dialog">Close</button><button name="go" value="1">Go</button></form>`,
    );
    const capture = f.capture();
    const { endpoints, forms } = linker().link([], capture);
    assert.equal(forms.length, 4);
    assert.deepEqual(endpoints.map((endpoint) => endpoint.key), [`POST ${ORIGIN}/real`]);
    assert.equal(prop(endpoints[0]?.requestBody?.schema, 'go').const, '1');
  });

  test('forms come from HTML document responses when snapshots are missing and are deduplicated', () => {
    const f = new CaptureFactory();
    const html = '<form method="post" action="/subscribe"><input type="email" name="email" required></form>';
    f.document('/news', html);
    f.document('/news', html);
    f.document('/news#top', html);
    f.document('/other', html);
    const capture = f.capture();
    const collected = new FormCollector({ documents: new PageDocuments({ extractor, pages: new HtmlPages() }) }).collect(capture);
    assert.equal(collected.length, 2);
    const { endpoints } = linker().link([], capture);
    assert.equal(endpoints.length, 1);
    assert.equal(endpoints[0]?.form?.pageUrl, `${ORIGIN}/news`);
  });

  test('snapshots take precedence over document responses of the same url', () => {
    const f = new CaptureFactory();
    f.document('/p', '<form method="post" action="/from-response"><input name="a"></form>');
    f.snapshot('/p', 'P', '<form method="post" action="/from-snapshot"><input name="a"></form>');
    const capture = f.capture();
    assert.deepEqual(new HtmlPages().collect(capture).map((page) => page.source), ['snapshot']);
    const { endpoints } = linker().link([], capture);
    assert.deepEqual(endpoints.map((endpoint) => endpoint.path), ['/from-snapshot']);
  });

  test('graphql endpoints are never form targets', () => {
    const f = new CaptureFactory();
    f.json('POST', '/graphql', 200, {}, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { query: 'query Q { q }' } } });
    f.snapshot('/', 'Home', '<form method="post" action="/graphql"><input name="query"></form>');
    const capture = f.capture();
    const { endpoints } = linker().link(grouped(capture), capture);
    assert.equal(find(endpoints, `POST ${ORIGIN}/graphql#Q`).form, undefined);
    assert.equal(find(endpoints, `POST ${ORIGIN}/graphql`).kind, 'form');
  });

  test('page urls that cannot be parsed are skipped without failing', () => {
    const capture = new CaptureFactory().capture();
    capture.pages.push({ url: 'not a url', title: '', capturedAt: capture.startedAt, html: '<form action="/x" method="post"><input name="a"></form>' });
    assert.deepEqual(linker().link([], capture), { endpoints: [], forms: [] });
  });
});
