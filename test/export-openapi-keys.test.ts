import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import { ExporterRegistry, OpenApiExporter } from '../src/export/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { ExportModel } from './helpers/export-model.js';

type Doc = { paths: Record<string, Record<string, Record<string, unknown>>> };

function media(operation: Record<string, unknown> | undefined, type: string): Record<string, unknown> {
  const body = operation?.requestBody as { content: Record<string, Record<string, unknown>> } | undefined;
  return body?.content[type] ?? {};
}

describe('OpenAPI export keeps site-controlled keys such as __proto__', () => {
  test('GraphQL examples, discriminator mapping, multipart encoding and response headers keep every key', () => {
    const f = new CaptureFactory();
    const b = 'BB';
    const multipart = `--${b}\r\nContent-Disposition: form-data; name="__proto__"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n--${b}\r\nContent-Disposition: form-data; name="title"\r\n\r\nt\r\n--${b}--\r\n`;
    f.json('POST', '/up', 200, { ok: 1 }, { requestType: `multipart/form-data; boundary=${b}`, requestBody: multipart });
    f.json('POST', '/graphql', 200, { data: { a: 1 } }, { requestType: 'application/json', requestBody: { json: { query: 'query __proto__ { a }', operationName: '__proto__' } } });
    f.json('POST', '/graphql', 200, { data: { b: 1 } }, { requestType: 'application/json', requestBody: { json: { query: 'query other { b }', operationName: 'other' } } });
    const model = ModelBuilder.create().build(f.capture());
    const doc = JSON.parse(new OpenApiExporter().export(model).content) as Doc;
    const graphql = media(doc.paths['/graphql']?.post, 'application/json');
    assert.deepEqual(Object.keys(graphql.examples as object), ['__proto__', 'other']);
    const mapping = ((graphql.schema as Record<string, unknown>).discriminator as { mapping: Record<string, string> } | undefined)?.mapping;
    assert.deepEqual(Object.keys(mapping ?? {}), ['__proto__', 'other']);
    const encoding = media(doc.paths['/up']?.post, 'multipart/form-data').encoding as Record<string, unknown>;
    assert.ok(Object.hasOwn(encoding, '__proto__'), JSON.stringify(encoding));
    const headers = ExportModel.endpoint({ method: 'GET', path: '/h', responses: [{ status: 200, count: 1, headers: ['__proto__', 'x-other'] }] });
    const headerDoc = JSON.parse(new OpenApiExporter().export(ExportModel.model([headers])).content) as Doc;
    const responses = headerDoc.paths['/h']?.get?.responses as Record<string, { headers?: Record<string, unknown> }>;
    assert.deepEqual(Object.keys(responses['200']?.headers ?? {}), ['__proto__', 'x-other']);
  });

  test('ExporterRegistry.normalize never returns inherited members', () => {
    for (const name of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      assert.equal(ExporterRegistry.normalize(name), name.toLowerCase());
      assert.equal(typeof ExporterRegistry.normalize(name), 'string');
    }
    assert.equal(ExporterRegistry.normalize(' YML '), 'openapi-yaml');
  });
});
