import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import { CurlExporter, OpenApiExporter, PostmanExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

type Json = Record<string, any>;

const ORIGIN = 'https://httpbin.example.com';
const BOUNDARY = '----WebKitFormBoundaryABC';

function part(name: string, value: string, file?: { filename: string; type: string }): string {
  const disposition = `Content-Disposition: form-data; name="${name}"${file ? `; filename="${file.filename}"\r\nContent-Type: ${file.type}` : ''}`;
  return `--${BOUNDARY}\r\n${disposition}\r\n\r\n${value}\r\n`;
}

function multipart(...parts: string[]): string {
  return `${parts.join('')}--${BOUNDARY}--\r\n`;
}

function model(withForm: boolean): ApiModel {
  const f = new CaptureFactory(ORIGIN);
  if (withForm) f.json('POST', '/post', 200, { form: { title: 'x' } }, { requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'title=x' });
  const body = multipart(part('title', 'hello'), part('upload', 'line one\nline two', { filename: 'notes.txt', type: 'text/plain' }));
  f.json('POST', '/post', 200, { files: { upload: 'line' } }, { requestHeaders: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, requestBody: body });
  const two = multipart(part('photos', 'a', { filename: 'a.png', type: 'image/png' }), part('photos', 'b', { filename: 'b.png', type: 'image/png' }), part('caption', 'two'));
  f.json('POST', '/gallery', 200, { ok: true }, { requestHeaders: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, requestBody: two });
  return ModelBuilder.create().build(f.capture());
}

function resolve(doc: Json, schema: Json): Json {
  return typeof schema.$ref === 'string' ? resolve(doc, doc.components.schemas[schema.$ref.split('/').pop() ?? ''] as Json) : schema;
}

function errors(doc: Json, schema: Json, value: unknown, at: string): string[] {
  const own = resolve(doc, schema);
  const types: string[] = own.type === undefined ? [] : Array.isArray(own.type) ? own.type : [own.type];
  const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'number' && Number.isInteger(value) ? 'integer' : typeof value;
  if (types.length > 0 && !types.includes(kind) && !(kind === 'integer' && types.includes('number'))) return [`${at}: ${kind} is not ${types.join('|')}`];
  if (kind === 'array' && own.items) return (value as unknown[]).flatMap((item, i) => errors(doc, own.items as Json, item, `${at}[${i}]`));
  if (kind === 'object' && own.properties) {
    return Object.entries(value as Json).flatMap(([key, item]) => (own.properties[key] ? errors(doc, own.properties[key] as Json, item, `${at}.${key}`) : []));
  }
  return [];
}

function multipartMedia(doc: Json, path: string): Json {
  const media = doc.paths[path].post.requestBody.content['multipart/form-data'] as Json | undefined;
  assert.ok(media, Object.keys(doc.paths[path].post.requestBody.content).join(', '));
  return media;
}

describe('OpenAPI multipart examples match the schema of their file parts (NEW-3)', () => {
  for (const withForm of [true, false]) {
    test(`a file part is the name of the sent file when multipart is ${withForm ? 'a variant' : 'the only body'}`, () => {
      const built = model(withForm);
      const doc = JSON.parse(new OpenApiExporter().export(built).content) as Json;
      const media = multipartMedia(doc, '/post');
      assert.equal(resolve(doc, media.schema).properties.upload.type, 'string');
      assert.deepEqual(media.examples.example1.value, { title: 'hello', upload: 'notes.txt' });
      assert.match(String(media.examples.example1.description), /name of the file/);
      assert.equal(media.encoding.upload.contentType, 'text/plain');
      for (const path of Object.keys(doc.paths)) {
        for (const [type, content] of Object.entries(doc.paths[path].post?.requestBody?.content ?? {}) as [string, Json][]) {
          for (const [name, example] of Object.entries(content.examples ?? {}) as [string, Json][]) {
            assert.deepEqual(errors(doc, content.schema as Json, example.value, `${path} ${type} ${name}`), []);
          }
        }
      }
    });
  }

  test('repeated file parts become a list of file names and the other exports keep the file', () => {
    const built = model(false);
    const doc = JSON.parse(new OpenApiExporter().export(built).content) as Json;
    const media = multipartMedia(doc, '/gallery');
    assert.deepEqual(media.examples.example1.value, { photos: ['a.png', 'b.png'], caption: 'two' });
    assert.deepEqual(errors(doc, media.schema as Json, media.examples.example1.value, 'gallery'), []);
    const post = built.endpoints.find((endpoint) => endpoint.path === '/post');
    assert.deepEqual(post?.requestBody?.examples[0], { title: 'hello', upload: { filename: 'notes.txt', contentType: 'text/plain', size: 17 } });
    const postman = JSON.parse(new PostmanExporter().export(built).content) as Json;
    const items = (postman.item as Json[]).flatMap((folder) => folder.item as Json[]);
    const formdata = items.map((item) => item.request.body?.formdata as Json[] | undefined).find((entries) => entries?.some((entry) => entry.key === 'upload'));
    assert.deepEqual(formdata?.find((entry) => entry.key === 'upload'), { key: 'upload', type: 'file', src: 'notes.txt' });
    assert.match(new CurlExporter().export(built).content, /-F 'upload=@notes\.txt'/);
  });
});
