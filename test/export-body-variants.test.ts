import { before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import { HtmlExporter, MarkdownExporter, OpenApiExporter, PostmanExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

type Json = Record<string, any>;

const ORIGIN = 'https://httpbin.example.com';
const BOUNDARY = '----WebKitFormBoundaryABC';
const ORDER_PAGE = '<!doctype html><form method="post" action="/post"><input name="custname"><button>Go</button></form>';

function model(): ApiModel {
  const f = new CaptureFactory(ORIGIN);
  f.document('/forms/post', ORDER_PAGE);
  f.snapshot('/forms/post', 'Order', ORDER_PAGE);
  f.exchange({
    method: 'POST',
    url: '/post',
    resourceType: 'document',
    status: 200,
    requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
    requestBody: 'custname=Ada',
    responseHeaders: { 'content-type': 'application/json' },
    responseBody: { json: { form: { custname: 'Ada' } } },
  });
  f.json('POST', '/post', 200, { json: { name: 'widget', qty: 2 } }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { name: 'widget', qty: 2 } } });
  const multipart = `--${BOUNDARY}\r\nContent-Disposition: form-data; name="title"\r\n\r\nhello\r\n--${BOUNDARY}\r\nContent-Disposition: form-data; name="upload"; filename="notes.txt"\r\nContent-Type: text/plain\r\n\r\nline\r\n--${BOUNDARY}--\r\n`;
  f.json('POST', '/post', 200, { files: { upload: 'line' } }, { requestHeaders: { 'content-type': `multipart/form-data; boundary=${BOUNDARY}` }, requestBody: multipart });
  f.exchange({ url: '/stream/3', status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: '{"id":0,"url":"a"}\n{"id":1,"url":"b"}\n{"id":2,"url":"c"}\n' });
  return ModelBuilder.create().build(f.capture());
}

describe('every request media type and JSON lines bodies in the documents (HTTPBIN-2, HTTPBIN-10)', () => {
  let built: ApiModel;

  before(() => {
    built = model();
    const post = built.endpoints.find((endpoint) => endpoint.path === '/post');
    assert.deepEqual([post?.requestBody?.kind, ...(post?.otherRequestBodies ?? []).map((body) => body.kind)], ['form', 'json', 'multipart']);
  });

  test('OpenAPI lists the form, JSON and multipart request bodies of one operation', () => {
    const doc = JSON.parse(new OpenApiExporter().export(built).content) as Json;
    const body = doc.paths['/post'].post.requestBody as Json;
    assert.deepEqual(Object.keys(body.content), ['application/x-www-form-urlencoded', 'application/json', 'multipart/form-data']);
    const resolve = (schema: Json): Json => (typeof schema.$ref === 'string' ? (doc.components.schemas[schema.$ref.split('/').pop() ?? ''] as Json) : schema);
    assert.deepEqual(Object.keys(resolve(body.content['application/json'].schema).properties), ['name', 'qty']);
    const multipart = body.content['multipart/form-data'];
    assert.deepEqual(Object.keys(resolve(multipart.schema).properties), ['title', 'upload']);
    assert.equal(multipart.encoding.upload.contentType, 'text/plain');
    assert.deepEqual(Object.keys(resolve(body.content['application/x-www-form-urlencoded'].schema).properties), ['custname']);
  });

  test('OpenAPI describes a JSON lines response as a list of its values, never as a JSON string', () => {
    const doc = JSON.parse(new OpenApiExporter().export(built).content) as Json;
    const path = Object.keys(doc.paths).find((key) => key.startsWith('/stream/')) ?? '';
    const response = doc.paths[path].get.responses['200'] as Json;
    const media = response.content['application/json'] as Json;
    assert.equal(media['x-appii-json-lines'], true);
    assert.equal(media.schema.type, 'array');
    const items = typeof media.schema.items.$ref === 'string' ? doc.components.schemas[media.schema.items.$ref.split('/').pop()] : media.schema.items;
    assert.deepEqual(Object.keys(items.properties), ['id', 'url']);
    assert.match(response.description, /JSON lines/);
    assert.deepEqual(Object.values(media.examples as Json)[0].value, [
      { id: 0, url: 'a' },
      { id: 1, url: 'b' },
      { id: 2, url: 'c' },
    ]);
  });

  test('Postman has one request per media type', () => {
    const collection = JSON.parse(new PostmanExporter().export(built).content) as Json;
    const items = (collection.item as Json[]).flatMap((folder) => folder.item as Json[]).filter((item) => /^Post post/.test(item.name));
    assert.deepEqual(items.map((item) => item.name), ['Post post', 'Post post (application/json)', 'Post post (multipart/form-data)']);
    assert.equal(items[0]?.request.body.mode, 'urlencoded');
    assert.deepEqual(JSON.parse(items[1]?.request.body.raw), { name: 'widget', qty: 2 });
    assert.deepEqual((items[2]?.request.body.formdata as Json[]).map((entry) => [entry.key, entry.type]), [['title', 'text'], ['upload', 'file']]);
    const lines = (collection.item as Json[]).flatMap((folder) => folder.item as Json[]).find((item) => /stream/i.test(JSON.stringify(item.request.url)));
    assert.equal(lines?.response[0].body, '{"id":0,"url":"a"}\n{"id":1,"url":"b"}\n{"id":2,"url":"c"}\n');
  });

  test('Markdown and HTML show each request body with its example request', () => {
    const markdown = new MarkdownExporter().export(built).content;
    for (const type of ['application/x-www-form-urlencoded', 'application/json', 'multipart/form-data']) assert.ok(markdown.includes(`**Request body** (\`${type}\`)`), type);
    assert.match(markdown, /\*\*Example request\*\* \(`application\/json`\)\n\n```bash\ncurl -sS -X POST 'https:\/\/httpbin\.example\.com\/post' \\\n {2}-H 'Content-Type: application\/json' \\\n {2}--data-raw '\{"name":"widget","qty":2\}'/);
    assert.match(markdown, /\*\*Example request\*\* \(`multipart\/form-data`\)\n\n```bash\ncurl -sS -X POST 'https:\/\/httpbin\.example\.com\/post' \\\n {2}--form-string 'title=hello' \\\n {2}-F 'upload=@notes\.txt'/);
    assert.ok(markdown.includes('`application/json, JSON lines`'));
    const html = new HtmlExporter().export(built).content;
    assert.equal(html.match(/<h3>Request body<\/h3>/g)?.length, 3);
    assert.ok(html.includes('<h3>Example request (<code>application/json</code>)</h3>'));
    assert.ok(html.includes('<h3>Example request (<code>multipart/form-data</code>)</h3>'));
    assert.ok(html.includes('(json, JSON lines)'));
  });
});
