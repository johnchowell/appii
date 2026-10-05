import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import { HtmlExporter, MarkdownExporter, OpenApiExporter, PostmanExporter } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { EndpointIndex, PatternAudit, Samples, Schema } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

type Doc = {
  paths: Record<string, Record<string, { description?: string; requestBody?: { content: Record<string, { schema: { properties: Record<string, Record<string, unknown>> } }> } }>>;
  components: { securitySchemes: Record<string, { description?: string }>; schemas?: Record<string, { properties: Record<string, Record<string, unknown>> }> };
};

function find(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((endpoint) => endpoint.method === method && endpoint.path === path);
  assert.ok(found, `${method} ${path}`);
  return found;
}

function postmanText(collection: unknown): string {
  return JSON.stringify(collection);
}

describe('token sources in the descriptions (EXP2-5)', () => {
  const f = new CaptureFactory('https://app.example.com');
  f.json('POST', '/api/session', 200, { csrfToken: 'Tok-AAAAAAAAAAAAAAAAAAAAAAAA1' }, { requestType: 'application/json', requestBody: { json: { device: 'web' } } });
  f.json('POST', '/api/items', 201, { id: 1 }, {
    requestType: 'application/json',
    requestBody: { json: { name: 'x' } },
    requestHeaders: { 'content-type': 'application/json', 'x-csrf-token': 'Tok-AAAAAAAAAAAAAAAAAAAAAAAA1' },
  });
  const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
  const source = 'https://app.example.com/api/session';

  test('the shared rule tells a token of a stored response from a token of a page that a client can load again', () => {
    const [token] = find(model, 'POST', '/api/items').auth.csrf;
    assert.equal(token?.sourceMethod, 'POST');
    assert.equal(EndpointIndex.tokenRequest(token!), 'POST');
    assert.equal(EndpointIndex.tokenSource(token!, model.endpoints), find(model, 'POST', '/api/session'));
    assert.equal(EndpointIndex.tokenRequest({ ...token!, sourceMethod: 'GET' }), undefined);
    assert.equal(EndpointIndex.tokenRequest({ ...token!, sourceMethod: 'get' }), undefined);
    assert.equal(EndpointIndex.tokenRequest({ location: 'header', name: 'x', source: 'cookie', sourceName: 'csrf', sourceMethod: 'POST' }), undefined);
  });

  test('OpenAPI, Markdown, HTML and Postman name the method of a token source that is not a page load', () => {
    const doc = JSON.parse(new OpenApiExporter().export(model).content) as Doc;
    assert.match(doc.paths['/api/items']?.post?.description ?? '', /CSRF token `x-csrf-token` \(header\) comes from response `csrfToken` of POST https:\/\/app\.example\.com\/api\/session\./);
    const scheme = Object.values(doc.components.securitySchemes).find((item) => /x-csrf-token header/.test(item.description ?? ''));
    assert.match(scheme?.description ?? '', /takes it from response csrfToken of POST https:\/\/app\.example\.com\/api\/session\./);
    const markdown = new MarkdownExporter().export(model).content;
    assert.ok(markdown.includes(`- **CSRF:** \`x-csrf-token\` in the header, from response \`csrfToken\` of POST \`${source}\``), markdown);
    const html = new HtmlExporter().export(model).content;
    assert.ok(html.includes(`from response <code>csrfToken</code> of POST <code>${source}</code>`));
    const postman = postmanText(JSON.parse(new PostmanExporter().export(model).content));
    assert.ok(postman.includes(`CSRF token \`x-csrf-token\` (header) from response \`csrfToken\` of POST ${source}.`));
  });

  test('a token from a page that the client loads with GET still names the page', () => {
    const fixture = ModelBuilder.create({ now: new Date(0) }).build(CaptureFactory.fixture().capture);
    const markdown = new MarkdownExporter().export(fixture).content;
    assert.ok(markdown.includes(`from hidden-field \`csrf_token\` on \`${CaptureFactory.ORIGIN}/login\``), markdown);
  });
});

describe('patterns that can take exponential time (EXP2-19)', () => {
  const f = new CaptureFactory();
  f.snapshot('/code', 'Code', '<form method="post" action="/code"><input name="code" pattern="(a+)+b" required><input name="zip" pattern="[0-9]{5}"><button>Go</button></form>');
  const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
  const endpoint = find(model, 'POST', '/code');

  test('the shared audit finds the unsafe pattern and the constraint summary marks it', () => {
    const audit = new PatternAudit();
    assert.equal(audit.unsafe('(a+)+b'), true);
    assert.equal(audit.unsafe('[0-9]{5}'), false);
    const props = Schema.properties(endpoint.requestBody?.schema);
    assert.deepEqual(Schema.constraintSummary(props.code).filter((item) => item.startsWith('pattern')), [`pattern (a+)+b (${Schema.UNSAFE_PATTERN})`]);
    assert.deepEqual(Schema.constraintSummary(props.zip).filter((item) => item.startsWith('pattern')), ['pattern [0-9]{5}']);
    assert.deepEqual(Schema.unsafePatterns(endpoint.requestBody?.schema), ['(a+)+b']);
  });

  test('OpenAPI marks the property and tells what the generated client does', () => {
    const doc = JSON.parse(new OpenApiExporter().export(model).content) as Doc;
    const media = doc.paths['/code']?.post?.requestBody?.content['application/x-www-form-urlencoded']?.schema;
    const ref = String((media as { $ref?: string } | undefined)?.$ref ?? '').split('/').pop() ?? '';
    const props = doc.components.schemas?.[ref]?.properties ?? {};
    assert.equal(props.code?.['x-appii-unsafe-pattern'], true);
    assert.match(String(props.code?.description), /exponential time.*unsafePatterns/);
    assert.equal(props.zip?.['x-appii-unsafe-pattern'], undefined);
    assert.equal(props.zip?.description, undefined);
  });

  test('Markdown marks the field and adds one note to the endpoint', () => {
    const markdown = new MarkdownExporter().export(model).content;
    assert.ok(markdown.includes(`pattern \\(a+\\)+b \\(${Schema.UNSAFE_PATTERN}\\)`) || markdown.includes(`pattern (a+)+b (${Schema.UNSAFE_PATTERN})`), markdown);
    assert.equal(markdown.split('unsafePatterns').length - 1, 1);
  });

  test('request samples do not run the unsafe pattern and ask for the value', () => {
    const started = Date.now();
    const sample = Samples.requestSample(endpoint);
    assert.ok(Date.now() - started < 2000);
    assert.ok(Samples.placeholderNames(sample).some((name) => /code/i.test(name)), JSON.stringify(Samples.placeholderNames(sample)));
  });
});
