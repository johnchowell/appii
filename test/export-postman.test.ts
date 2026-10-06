import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PostmanExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { Json, Text } from '../src/shared/index.js';
import { LiteralPlaceholderSite } from './fixtures/foundation-literal-placeholders.js';
import { ExportModel } from './helpers/export-model.js';
import type { ExportFixture } from './helpers/export-model.js';

type Item = Record<string, unknown>;

function obj(value: unknown): Record<string, unknown> {
  assert.ok(Json.isPlainObject(value), `expected an object, got ${JSON.stringify(value)}`);
  return value;
}

function requests(collection: Record<string, unknown>): Item[] {
  return (collection.item as Item[]).flatMap((folder) => folder.item as Item[]);
}

function find(collection: Record<string, unknown>, name: string): Item {
  const item = requests(collection).find((entry) => String(obj(entry.request).description).includes(`\`${name}\``));
  assert.ok(item, name);
  return item;
}

function referenced(value: unknown): Set<string> {
  const names = new Set<string>();
  Json.walk(value, (node) => {
    if (typeof node === 'string') for (const m of node.matchAll(/\{\{([^{}]+)\}\}/g)) names.add(m[1] ?? '');
  });
  return names;
}

describe('PostmanExporter on a real browser capture of the fixture site', () => {
  let fixture: ExportFixture;
  let model: ApiModel;
  let collection: Record<string, unknown>;
  const exporter = new PostmanExporter();

  before(async () => {
    fixture = await ExportModel.fixture();
    model = fixture.model;
    collection = JSON.parse(exporter.export(model).content) as Record<string, unknown>;
  });

  after(async () => {
    await fixture?.site.close();
  });

  test('collection info, filename and determinism', () => {
    const result = exporter.export(model);
    assert.equal(result.filename, 'postman_collection.json');
    assert.equal(result.format, 'postman');
    assert.equal(result.endpointCount, model.endpoints.length);
    assert.ok(Text.isAscii(result.content));
    const info = obj(collection.info);
    assert.equal(info.schema, 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
    assert.match(String(info._postman_id), /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(info.name, model.name);
    assert.equal(exporter.export(model).content, result.content);
    assert.notEqual(obj(obj(JSON.parse(exporter.export(model, { endpoints: ['getItem'] }).content)).info)._postman_id, info._postman_id);
  });

  test('variables cover the base URL and every placeholder that requests reference', () => {
    const variables = collection.variable as Item[];
    assert.deepEqual(variables[0], { key: 'baseUrl', value: fixture.site.origin, type: 'string', description: `Base URL for ${fixture.site.origin}` });
    const keys = new Set(variables.map((v) => String(v.key)));
    for (const name of ['csrf', 'csrf_token', 'password']) assert.ok(keys.has(name), name);
    assert.ok(!keys.has('x_csrf_token'));
    for (const name of referenced(collection.item)) assert.ok(keys.has(name), `variable ${name} is not defined`);
  });

  test('folders follow the first meaningful path segment, the login folder runs first, and every endpoint is one request', () => {
    const folders = (collection.item as Item[]).map((folder) => folder.name);
    assert.deepEqual(folders, ['login', 'root', 'account', 'items', 'me', 'app', 'graphql', 'products', 'search', 'signup']);
    assert.equal(requests(collection).length, model.endpoints.length);
  });

  test('path variables, query entries and saved responses', () => {
    const getItem = find(collection, 'getItem');
    const url = obj(obj(getItem.request).url);
    assert.equal(url.raw, '{{baseUrl}}/api/items/:itemId');
    assert.deepEqual(url.path, ['api', 'items', ':itemId']);
    assert.deepEqual(url.variable, [{ key: 'itemId', value: '1', description: 'integer' }]);
    const responses = getItem.response as Item[];
    assert.deepEqual(responses.map((r) => [r.code, r.status, r.name]), [
      [200, 'OK', '200 OK'],
      [404, 'Not Found', '404 Not Found'],
    ]);
    assert.equal(JSON.parse(String(responses[0]?.body)).name, 'Widget');
    assert.equal(obj(responses[0]?.originalRequest).description, undefined);
    const list = obj(obj(find(collection, 'listItems').request).url);
    assert.equal(list.raw, '{{baseUrl}}/api/items?page=1&limit=2');
    assert.deepEqual(list.query, [
      { key: 'page', value: '1', description: 'integer' },
      { key: 'limit', value: '2', description: 'integer' },
    ]);
  });

  test('raw JSON, urlencoded and formdata bodies with placeholders', () => {
    const create = obj(find(collection, 'createItem').request);
    assert.deepEqual(create.header, [
      { key: 'x-csrf-token', value: '{{csrf}}', type: 'text' },
      { key: 'Content-Type', value: 'application/json', type: 'text' },
    ]);
    const body = obj(create.body);
    assert.equal(body.mode, 'raw');
    assert.deepEqual(body.options, { raw: { language: 'json' } });
    assert.deepEqual(JSON.parse(String(body.raw)), { name: 'Thing', price: 5 });
    const login = obj(obj(find(collection, 'postLogin').request).body);
    assert.equal(login.mode, 'urlencoded');
    assert.deepEqual(login.urlencoded, [
      { key: 'csrf_token', value: '{{csrf_token}}', type: 'text' },
      { key: 'email', value: '{{email}}', type: 'text' },
      { key: 'password', value: '{{password}}', type: 'text' },
      { key: 'action', value: 'login', type: 'text' },
    ]);
    const signup = obj(find(collection, 'postSignup').request);
    assert.deepEqual(obj(signup.url).query, [{ key: 'draft', value: '1', description: 'integer', disabled: true }]);
    assert.equal(obj(signup.url).raw, '{{baseUrl}}/signup');
    const formdata = obj(signup.body).formdata as Item[];
    assert.deepEqual(formdata.filter((entry) => entry.key === 'interests').map((entry) => entry.value), ['a', 'c']);
    assert.ok(String(obj(signup).description).includes('Inferred from an HTML form'));
    const graphql = obj(obj(find(collection, 'graphqlGetItem').request).body);
    assert.equal(JSON.parse(String(graphql.raw)).operationName, 'GetItem');
  });

  test('descriptions document CSRF sources and forms', () => {
    const login = String(obj(find(collection, 'postLogin').request).description);
    assert.match(login, /CSRF token `csrf_token` \(body\) from hidden-field `csrf_token` on http:\/\/127\.0\.0\.1:\d+\/login/);
    assert.match(login, /Form `form#login`/);
  });

  test('baseUrl option sets the variable value and maps documented URLs', () => {
    const custom = JSON.parse(exporter.export(model, { baseUrl: 'https://proxy.example.com/app', title: 'Shop' }).content) as Record<string, unknown>;
    assert.equal((custom.variable as Item[])[0]?.value, 'https://proxy.example.com/app');
    assert.equal(obj(custom.info).name, 'Shop');
    assert.match(String(obj(find(custom, 'postLogin').request).description), /on https:\/\/proxy\.example\.com\/app\/login/);
  });
});

describe('PostmanExporter edge cases', () => {
  test('one base URL variable per extra origin, file parts and non-ASCII values', () => {
    const upload = ExportModel.endpoint({
      method: 'POST',
      path: '/upload',
      kind: 'form',
      requestBody: {
        mimeType: 'multipart/form-data',
        kind: 'multipart',
        examples: [{ title: 'Caf\u00e9', file: { filename: 'photo.png', contentType: 'image/png', size: 12 } }],
      },
    });
    const cdn = ExportModel.endpoint({ method: 'GET', path: '/v1/config', origin: 'https://cdn.example.com:8443', id: 'get-config', name: 'getConfig' });
    const result = new PostmanExporter().export(ExportModel.model([upload, cdn]));
    assert.ok(Text.isAscii(result.content));
    const collection = JSON.parse(result.content) as Record<string, unknown>;
    assert.deepEqual((collection.variable as Item[]).map((v) => [v.key, v.value]), [
      ['baseUrl', 'https://shop.example.com'],
      ['baseUrlCdnExampleCom8443', 'https://cdn.example.com:8443'],
    ]);
    const items = requests(collection);
    assert.deepEqual(obj(obj(items[0]?.request).body).formdata, [
      { key: 'title', value: 'Caf\u00e9', type: 'text' },
      { key: 'file', type: 'file', src: 'photo.png' },
    ]);
    assert.equal(obj(obj(items[1]?.request).url).raw, '{{baseUrlCdnExampleCom8443}}/v1/config');
    assert.deepEqual((collection.item as Item[]).map((folder) => folder.name), ['upload', 'config']);
  });

  test('an empty model exports an empty collection', () => {
    const collection = JSON.parse(new PostmanExporter().export(ExportModel.model([], { primaryOrigin: '' })).content) as Record<string, unknown>;
    assert.deepEqual(collection.item, []);
    assert.deepEqual(collection.variable, []);
  });
});

describe('PostmanExporter keeps captured text literal', () => {
  function sent(request: Item): Set<string> {
    const names = new Set<string>();
    const visit = (node: unknown): void => {
      if (typeof node === 'string') for (const m of node.matchAll(/\{\{([^{}]*)\}\}/g)) names.add(m[1] ?? '');
      else if (Array.isArray(node)) node.forEach(visit);
      else if (Json.isPlainObject(node) && node.disabled !== true) for (const [key, value] of Object.entries(node)) if (key !== 'description') visit(value);
    };
    visit(request);
    return names;
  }

  test('captured values that look like variables are never resolved by Postman', () => {
    const collection = JSON.parse(PostmanExporter.create().export(LiteralPlaceholderSite.model()).content) as Record<string, unknown>;
    assert.deepEqual((collection.variable as Item[]).map((variable) => variable.key), ['baseUrl']);
    for (const item of requests(collection)) assert.deepEqual([...sent(obj(item.request))], ['baseUrl'], String(item.name));
    const search = obj(find(collection, 'getSearch').request);
    assert.equal(obj(search.url).raw, '{{baseUrl}}/api/search?q=%7B%7Baws_secret_access_key%7D%7D');
    const trace = (search.header as Item[]).find((header) => header.key === 'x-trace');
    assert.equal(trace?.disabled, true);
    assert.equal(trace?.value, '');
    assert.match(String(trace?.description), /\{\{github_token\}\}/);
    const note = obj(obj(find(collection, 'postNote').request).body);
    assert.ok(!String(note.raw).includes('{{'));
    assert.deepEqual(JSON.parse(String(note.raw)), { note: '{{home}}', n2: 'x{{path}}y' });
    const form = obj(obj(find(collection, 'postForm').request).body).urlencoded as Item[];
    assert.deepEqual(form.map((entry) => [entry.key, entry.disabled]), [['comment', true], ['c', true]]);
  });
});
