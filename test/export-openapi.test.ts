import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { OpenApiExporter, OpenApiYamlExporter, OpenApiPathPlanner } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { AppiiError, Json, Text } from '../src/shared/index.js';
import { ExportModel } from './helpers/export-model.js';
import type { ExportFixture } from './helpers/export-model.js';

type Doc = Record<string, unknown>;

const METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

function obj(value: unknown): Record<string, unknown> {
  assert.ok(Json.isPlainObject(value), `expected an object, got ${JSON.stringify(value)}`);
  return value;
}

function resolvePointer(doc: Doc, ref: string): unknown {
  if (!ref.startsWith('#/')) return undefined;
  let current: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!Json.isPlainObject(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

function validateOpenApi(doc: Doc): string[] {
  const problems: string[] = [];
  if (doc.openapi !== '3.1.0') problems.push('openapi must be 3.1.0');
  const info = doc.info;
  if (!Json.isPlainObject(info) || typeof info.title !== 'string' || typeof info.version !== 'string') problems.push('info.title and info.version are required');
  if (!Json.isPlainObject(doc.paths)) {
    problems.push('paths is required');
    return problems;
  }
  const operationIds = new Set<string>();
  const schemes = Json.isPlainObject(doc.components) && Json.isPlainObject(doc.components.securitySchemes) ? doc.components.securitySchemes : {};
  const shapes = new Map<string, string>();
  for (const [path, item] of Object.entries(doc.paths)) {
    if (!path.startsWith('/')) problems.push(`path ${path} must start with /`);
    const shape = path.replace(/\{[^}]*\}/g, '{}');
    if (shapes.has(shape)) problems.push(`paths ${path} and ${shapes.get(shape)} are identical templates`);
    shapes.set(shape, path);
    if (!Json.isPlainObject(item)) {
      problems.push(`path item ${path} must be an object`);
      continue;
    }
    const templateParams = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]);
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.includes(method)) continue;
      const where = `${method.toUpperCase()} ${path}`;
      if (!Json.isPlainObject(operation)) {
        problems.push(`${where} must be an object`);
        continue;
      }
      if (typeof operation.operationId === 'string') {
        if (operationIds.has(operation.operationId)) problems.push(`duplicate operationId ${operation.operationId}`);
        operationIds.add(operation.operationId);
      }
      const params = Array.isArray(operation.parameters) ? operation.parameters.filter(Json.isPlainObject) : [];
      const keys = new Set<string>();
      for (const p of params) {
        const key = `${String(p.in)}:${String(p.name)}`;
        if (keys.has(key)) problems.push(`${where} has duplicate parameter ${key}`);
        keys.add(key);
        if (!['path', 'query', 'header', 'cookie'].includes(String(p.in))) problems.push(`${where} parameter ${key} has an invalid location`);
        if (p.in === 'path' && !templateParams.includes(String(p.name))) problems.push(`${where} path parameter ${String(p.name)} is not in the template`);
        if (p.in === 'path' && p.required !== true) problems.push(`${where} path parameter ${String(p.name)} must be required`);
        if (p.schema === undefined && p.content === undefined) problems.push(`${where} parameter ${key} needs a schema`);
      }
      for (const name of templateParams) {
        if (!params.some((p) => p.in === 'path' && p.name === name && p.required === true)) problems.push(`${where} misses the required path parameter ${name}`);
      }
      const responses = operation.responses;
      if (!Json.isPlainObject(responses) || Object.keys(responses).length === 0) problems.push(`${where} needs responses`);
      else {
        for (const [code, response] of Object.entries(responses)) {
          if (!/^(?:[1-5][0-9]{2}|[1-5]XX|default)$/.test(code)) problems.push(`${where} response key ${code} is not a status code`);
          if (!Json.isPlainObject(response) || typeof response.description !== 'string') problems.push(`${where} response ${code} needs a description`);
        }
      }
      for (const requirement of Array.isArray(operation.security) ? operation.security : []) {
        for (const name of Object.keys(obj(requirement))) if (!Object.hasOwn(schemes, name)) problems.push(`${where} uses the unknown security scheme ${name}`);
      }
    }
  }
  Json.walk(doc, (node, path) => {
    if (path[path.length - 1] === '$ref' && typeof node === 'string' && resolvePointer(doc, node) === undefined) problems.push(`unresolved $ref ${node}`);
  });
  return problems;
}

function operation(doc: Doc, path: string, method: string): Record<string, unknown> {
  return obj(obj(obj(doc.paths)[path])[method]);
}

function deref(doc: Doc, schema: unknown): Record<string, unknown> {
  const s = obj(schema);
  return typeof s.$ref === 'string' ? obj(resolvePointer(doc, s.$ref)) : s;
}

function params(op: Record<string, unknown>): Record<string, unknown>[] {
  return (Array.isArray(op.parameters) ? op.parameters : []).map(obj);
}

describe('OpenApiExporter on a real browser capture of the fixture site', () => {
  let fixture: ExportFixture;
  let model: ApiModel;
  let doc: Doc;
  const exporter = new OpenApiExporter();

  before(async () => {
    fixture = await ExportModel.fixture();
    model = fixture.model;
    doc = JSON.parse(exporter.export(model).content) as Doc;
  });

  after(async () => {
    await fixture?.site.close();
  });

  test('the export result and the document pass the structural validator', () => {
    const result = exporter.export(model);
    assert.equal(result.format, 'openapi');
    assert.equal(result.filename, 'openapi.json');
    assert.equal(result.endpointCount, model.endpoints.length);
    assert.ok(Text.isAscii(result.content));
    assert.ok(result.content.endsWith('\n'));
    assert.deepEqual(validateOpenApi(doc), []);
    assert.deepEqual(JSON.parse(result.content), exporter.document(model, model.endpoints));
  });

  test('info, servers and tags', () => {
    assert.equal(obj(doc.info).title, model.name);
    assert.equal(obj(doc.info).version, '1.0.0');
    assert.match(String(obj(doc.info).description), /Inferred by appii .* captured HTTP exchanges/);
    assert.deepEqual(doc.servers, [{ url: fixture.site.origin, description: 'Captured origin' }]);
    const tags = (doc.tags as { name: string }[]).map((t) => t.name);
    assert.ok(tags.includes('items') && tags.includes('me') && tags.includes('login') && tags.includes('root'));
    assert.ok(!tags.includes('api'));
  });

  test('every endpoint becomes exactly one operation with operationId = endpoint.name', () => {
    const ids: string[] = [];
    for (const item of Object.values(obj(doc.paths))) for (const op of Object.values(obj(item))) ids.push(String(obj(op).operationId));
    assert.deepEqual(ids.sort(), model.endpoints.map((e) => e.name).sort());
  });

  test('path, query parameters and typed examples', () => {
    const getItem = operation(doc, '/api/items/{itemId}', 'get');
    assert.equal(getItem.operationId, 'getItem');
    const [itemId] = params(getItem);
    assert.deepEqual(itemId, { name: 'itemId', in: 'path', required: true, schema: { type: 'integer', examples: [1, 2, 999] } });
    assert.deepEqual(Object.keys(obj(getItem.responses)), ['200', '404']);
    const item200 = deref(doc, obj(obj(obj(obj(getItem.responses)['200']).content)['application/json']).schema);
    assert.deepEqual(Object.keys(obj(item200.properties)), ['id', 'name', 'price', 'tags', 'createdAt']);
    const list = operation(doc, '/api/items', 'get');
    assert.deepEqual(
      params(list).map((p) => [p.name, p.in, p.required, obj(p.schema).type]),
      [
        ['page', 'query', true, 'integer'],
        ['limit', 'query', true, 'integer'],
      ],
    );
  });

  test('JSON request body, CSRF header security and x-appii-csrf', () => {
    const create = operation(doc, '/api/items', 'post');
    const media = obj(obj(obj(create.requestBody).content)['application/json']);
    const schema = deref(doc, media.schema);
    assert.deepEqual(Object.keys(obj(schema.properties)), ['name', 'price']);
    assert.deepEqual(obj(media.examples).example1, { value: { name: 'Thing', price: 5 } });
    assert.deepEqual(create['x-appii-csrf'], [{ location: 'header', name: 'x-csrf-token', source: 'cookie', sourceName: 'csrf' }]);
    assert.ok(!params(create).some((p) => String(p.name).toLowerCase() === 'x-csrf-token'));
    const security = create.security as Record<string, unknown>[];
    assert.deepEqual(security, [{ authCookie: [], xCsrfTokenHeader: [] }]);
    const schemes = obj(obj(doc.components).securitySchemes);
    assert.deepEqual(obj(schemes.xCsrfTokenHeader).in, 'header');
    assert.equal(obj(schemes.xCsrfTokenHeader).name, 'x-csrf-token');
    assert.deepEqual({ ...obj(schemes.authCookie), description: '' }, { type: 'apiKey', in: 'cookie', name: 'auth', description: '' });
    assert.match(String(obj(schemes.authCookie).description), /^Authentication cookie auth \(HttpOnly/);
    assert.equal(schemes.sidCookie, undefined);
  });

  test('urlencoded login form with constraints, token field, redirect response and form origin', () => {
    const login = operation(doc, '/login', 'post');
    const media = obj(obj(obj(login.requestBody).content)['application/x-www-form-urlencoded']);
    const schema = deref(doc, media.schema);
    const props = obj(schema.properties);
    assert.equal(obj(props.csrf_token)['x-appii-token'], true);
    assert.equal(obj(props.csrf_token).readOnly, undefined);
    assert.equal(obj(props.email).format, undefined);
    assert.equal(obj(props.email)['x-html-type'], 'email');
    assert.match('first..last@localhost', new RegExp(String(obj(props.email).pattern), 'u'));
    assert.equal(obj(props.password).minLength, 4);
    assert.equal(obj(props.password)['x-html-minlength'], 8);
    assert.deepEqual(schema.required, ['email', 'password', 'action']);
    assert.deepEqual(login['x-appii-form'], { pageUrl: `${fixture.site.origin}/login`, selector: 'form#login', enctype: 'application/x-www-form-urlencoded' });
    assert.deepEqual(login['x-appii-csrf'], [{ location: 'body', name: 'csrf_token', source: 'hidden-field', sourceName: 'csrf_token', sourceUrl: `${fixture.site.origin}/login`, sessionCookies: ['sid'] }]);
    const redirect = obj(obj(login.responses)['303']);
    assert.equal(redirect.description, 'See Other');
    assert.deepEqual(Object.keys(obj(redirect.headers)), ['Location', 'Set-Cookie']);
    assert.match(String(obj(obj(redirect.headers)['Set-Cookie']).description), /auth/);
    assert.deepEqual(login.security, []);
  });

  test('multipart signup form with file and array encodings and the formaction query parameter', () => {
    const signup = operation(doc, '/signup', 'post');
    const media = obj(obj(obj(signup.requestBody).content)['multipart/form-data']);
    assert.deepEqual(media.encoding, { interests: { contentType: 'text/plain' }, avatar: { contentType: 'image/*' } });
    const schema = deref(doc, media.schema);
    assert.equal(obj(obj(schema.properties).avatar).format, 'binary');
    assert.equal(obj(obj(schema.properties).readonly_field).readOnly, undefined);
    assert.equal(obj(obj(schema.properties).readonly_field)['x-html-readonly'], true);
    assert.deepEqual(obj(obj(schema.properties).intent).enum, ['create', 'draft']);
    assert.deepEqual(params(signup).map((p) => [p.name, p.in, p.required]), [['draft', 'query', false]]);
    assert.deepEqual(obj(signup.responses), { default: { description: 'No response was captured for this endpoint.' } });
  });

  test('GET forms become query parameters without a request body', () => {
    const search = operation(doc, '/search', 'get');
    assert.equal(search.requestBody, undefined);
    const [q] = params(search);
    assert.equal(q?.name, 'q');
    assert.equal(q?.required, true);
    assert.equal(obj(q?.schema).minLength, 1);
    assert.equal(obj(search['x-appii-form']).selector, ':root > body:nth-child(2) > form:nth-child(3)');
  });

  test('GraphQL operation and JSON responses by status', () => {
    const graphql = operation(doc, '/graphql', 'post');
    assert.equal(graphql.operationId, 'graphqlGetItem');
    assert.deepEqual(graphql['x-appii-graphql-operations'], ['GetItem']);
    const schema = deref(doc, obj(obj(obj(graphql.requestBody).content)['application/json']).schema);
    assert.equal(obj(obj(schema.properties).operationName).const, 'GetItem');
    const me = operation(doc, '/api/me', 'get');
    assert.deepEqual(Object.keys(obj(me.responses)), ['200', '401']);
    assert.equal(obj(obj(me.responses)['401']).description, 'Unauthorized');
  });

  test('endpoint selection, title and baseUrl options', () => {
    const result = exporter.export(model, { endpoints: ['getItem', '3'], title: ' Fixture API ', baseUrl: 'https://proxy.example.com/site/' });
    assert.equal(result.endpointCount, 2);
    const selected = JSON.parse(result.content) as Doc;
    assert.deepEqual(Object.keys(obj(selected.paths)), ['/api/items', '/api/items/{itemId}']);
    assert.equal(obj(selected.info).title, 'Fixture API');
    assert.deepEqual(selected.servers, [
      { url: 'https://proxy.example.com/site', description: 'Base URL' },
      { url: fixture.site.origin, description: 'Captured origin' },
    ]);
    assert.deepEqual(validateOpenApi(selected), []);
    assert.throws(() => exporter.export(model, { baseUrl: 'ftp://x' }), (err: unknown) => err instanceof AppiiError && err.code === 'BAD_INPUT');
    assert.throws(() => exporter.export(model, { baseUrl: 'not a url' }), (err: unknown) => err instanceof AppiiError && err.code === 'BAD_INPUT');
    assert.throws(() => exporter.export(model, { endpoints: ['nope'] }), (err: unknown) => err instanceof AppiiError && err.code === 'NOT_FOUND');
  });

  test('the YAML exporter writes the same document', () => {
    const yaml = new OpenApiYamlExporter().export(model);
    assert.equal(yaml.format, 'openapi-yaml');
    assert.equal(yaml.filename, 'openapi.yaml');
    assert.ok(Text.isAscii(yaml.content));
    assert.match(yaml.content, /^openapi: 3\.1\.0\n/);
    assert.match(yaml.content, /\n {6}responses:\n {8}"200":/);
    assert.deepEqual(parseYaml(yaml.content), doc);
    assert.deepEqual(parseYaml(yaml.content, { version: '1.1' }), doc);
  });
});

describe('OpenApiExporter edge cases', () => {
  const exporter = new OpenApiExporter();
  const document = (model: ApiModel): Doc => JSON.parse(exporter.export(model).content) as Doc;

  function graphqlOp(name: string, variables: Record<string, unknown>): Endpoint {
    return ExportModel.endpoint({
      method: 'POST',
      path: '/graphql',
      kind: 'graphql',
      operationName: name,
      id: `post-graphql-${name.toLowerCase()}`,
      name: `graphql${name}`,
      requestBody: {
        mimeType: 'application/json',
        kind: 'graphql',
        schema: {
          type: 'object',
          properties: { operationName: { type: 'string' }, query: { type: 'string' }, variables: { type: 'object' } },
          required: ['operationName', 'query'],
        },
        examples: [{ operationName: name, query: `query ${name} { x }`, variables }],
      },
      responses: [{ status: 200, count: 1, headers: [], body: { mimeType: 'application/json', kind: 'json', schema: { type: 'object', properties: { data: { type: 'object' } } }, examples: [] } }],
    });
  }

  test('GraphQL operations sharing method and path merge into one operation with a discriminated oneOf', () => {
    const doc = document(ExportModel.model([graphqlOp('GetItem', { id: '1' }), graphqlOp('ListItems', {})]));
    assert.deepEqual(validateOpenApi(doc), []);
    const op = operation(doc, '/graphql', 'post');
    assert.equal(op.operationId, 'postGraphql');
    assert.deepEqual(op['x-appii-graphql-operations'], ['GetItem', 'ListItems']);
    const media = obj(obj(obj(op.requestBody).content)['application/json']);
    const schema = obj(media.schema);
    assert.deepEqual(schema.discriminator, {
      propertyName: 'operationName',
      mapping: { GetItem: '#/components/schemas/GraphqlGetItemRequest', ListItems: '#/components/schemas/GraphqlListItemsRequest' },
    });
    assert.equal((schema.oneOf as unknown[]).length, 2);
    assert.equal(obj(obj(deref(doc, (schema.oneOf as unknown[])[1]).properties).operationName).const, 'ListItems');
    assert.deepEqual(Object.keys(obj(media.examples)), ['GetItem', 'ListItems']);
    assert.equal(Object.keys(obj(op.responses)).length, 1);
    assert.equal((op['x-appii-endpoints'] as unknown[]).length, 2);
  });

  test('identical method and path on another origin moves a literal prefix into the operation server', () => {
    const a = ExportModel.endpoint({ method: 'GET', path: '/api/items' });
    const b = ExportModel.endpoint({ method: 'GET', path: '/api/items', origin: 'https://cdn.example.com', id: 'get-cdn-items', name: 'getCdnItems' });
    const c = ExportModel.endpoint({ method: 'GET', path: '/x', origin: 'https://cdn.example.com', id: 'get-x', name: 'getX' });
    const d = ExportModel.endpoint({ method: 'GET', path: '/x', id: 'get-x-2', name: 'getX2' });
    const e = ExportModel.endpoint({ method: 'PROPFIND', path: '/dav', id: 'propfind-dav', name: 'propfindDav' });
    const doc = document(ExportModel.model([a, b, c, d, e]));
    assert.deepEqual(validateOpenApi(doc), []);
    assert.equal(operation(doc, '/api/items', 'get').servers, undefined);
    assert.deepEqual(operation(doc, '/items', 'get').servers, [{ url: 'https://cdn.example.com/api' }]);
    assert.deepEqual(operation(doc, '/x', 'get').servers, [{ url: 'https://cdn.example.com' }]);
    assert.deepEqual(
      (doc['x-appii-unrepresented'] as Record<string, unknown>[]).map((u) => [u.operationId, u.method, u.url]),
      [
        ['getX2', 'GET', 'https://shop.example.com/x'],
        ['propfindDav', 'PROPFIND', 'https://shop.example.com/dav'],
      ],
    );
    assert.match(String(obj(doc.info).description), /2 operations that OpenAPI 3\.1 cannot represent are listed/);
  });

  test('equivalent templates with different parameter names share one path item', () => {
    const get = ExportModel.endpoint({
      method: 'GET',
      path: '/items/{itemId}',
      pathParams: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'integer' }, examples: ['7'] }],
    });
    const del = ExportModel.endpoint({ method: 'DELETE', path: '/items/{id}', id: 'delete-item', name: 'deleteItem' });
    const doc = document(ExportModel.model([get, del]));
    assert.deepEqual(validateOpenApi(doc), []);
    assert.deepEqual(Object.keys(obj(doc.paths)), ['/items/{itemId}']);
    assert.deepEqual(params(operation(doc, '/items/{itemId}', 'delete')), [{ name: 'itemId', in: 'path', required: true, schema: { type: 'string' } }]);
    const planner = new OpenApiPathPlanner();
    const plan = planner.plan([get, del], { base: (origin) => origin });
    assert.deepEqual([...(plan.plans[1]?.renames ?? new Map())], [['id', 'itemId']]);
  });

  test('bearer and API key headers become security schemes; ignored and covered headers are not parameters', () => {
    const endpoint = ExportModel.endpoint({
      method: 'GET',
      path: '/api/me',
      auth: { cookies: [], headers: ['authorization', 'x-api-key'], bearer: true, csrf: [] },
      headerParams: [
        { name: 'accept', in: 'header', required: true, schema: { type: 'string' }, examples: ['application/json'] },
        { name: 'x-api-key', in: 'header', required: true, schema: { type: 'string' }, examples: ['<redacted>'] },
        { name: 'x-requested-with', in: 'header', required: true, schema: { type: 'string' }, examples: ['XMLHttpRequest'] },
      ],
    });
    const doc = document(ExportModel.model([endpoint]));
    assert.deepEqual(validateOpenApi(doc), []);
    const op = operation(doc, '/api/me', 'get');
    assert.deepEqual(params(op), [{ name: 'x-requested-with', in: 'header', required: true, schema: { type: 'string', examples: ['XMLHttpRequest'] } }]);
    assert.deepEqual(op.security, [{ bearerAuth: [], xApiKeyHeader: [] }]);
    assert.deepEqual(obj(obj(obj(doc.components).securitySchemes).bearerAuth).scheme, 'bearer');
  });

  test('non-ASCII captured values are escaped losslessly in JSON and YAML', () => {
    const endpoint = ExportModel.endpoint({
      method: 'POST',
      path: '/caf%C3%A9',
      requestBody: { mimeType: 'application/json', kind: 'json', schema: { type: 'object', properties: { 'n\u00e4me': { type: 'string' } } }, examples: [{ 'n\u00e4me': 'Gr\u00fc\u00dfe \u{1F600}' }] },
    });
    const model = ExportModel.model([endpoint], { name: 'Caf\u00e9 \u2615' });
    const json = exporter.export(model).content;
    const yaml = new OpenApiYamlExporter().export(model).content;
    assert.ok(Text.isAscii(json) && Text.isAscii(yaml));
    const parsed = JSON.parse(json) as Doc;
    assert.equal(obj(parsed.info).title, 'Caf\u00e9 \u2615');
    assert.deepEqual(parseYaml(yaml), parsed);
    const example = obj(obj(obj(obj(operation(parsed, '/caf%C3%A9', 'post').requestBody).content)['application/json']).examples).example1;
    assert.deepEqual(example, { value: { 'n\u00e4me': 'Gr\u00fc\u00dfe \u{1F600}' } });
  });

  test('an empty model is still a valid document', () => {
    const doc = document(ExportModel.model([], { primaryOrigin: '', origins: [] }));
    assert.deepEqual(validateOpenApi(doc), []);
    assert.deepEqual(doc.paths, {});
    assert.equal(doc.servers, undefined);
    assert.equal(doc.components, undefined);
  });
});
