import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelBuilder } from '../src/build/index.js';
import { CurlExporter, HtmlExporter, MarkdownExporter, OpenApiExporter, PostmanExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { PresenterFactory } from '../src/present/index.js';
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

describe('the curl script and list --show send every request media type (HTTPBIN-2)', () => {
  const received: { method: string; url: string; headers: IncomingHttpHeaders; body: string }[] = [];
  let server: Server;
  let origin = '';
  let dir = '';
  let built: ApiModel;

  const bash = (args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const clean = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: dir, LANG: 'C', APPII_BASE_URL: origin, ...env };
      execFile('bash', [join(dir, 'endpoints.sh'), ...args], { cwd: dir, env: clean, timeout: 20_000, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
      });
    });

  before(async () => {
    built = model();
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    dir = await mkdtemp(join(tmpdir(), 'appii-variants-'));
    await writeFile(join(dir, 'endpoints.sh'), new CurlExporter().export(built).content);
    await writeFile(join(dir, 'notes.txt'), 'captured notes\n');
    await writeFile(join(dir, 'other.txt'), 'another file\n');
  });

  after(async () => {
    server.closeAllConnections();
    server.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the list shows a function for each media type and the dispatcher runs it', async () => {
    const list = await bash([]);
    assert.equal(list.code, 0, list.stderr);
    const rows = list.stdout.split('\n').filter((line) => /\bpostPost/.test(line));
    assert.equal(rows.length, 3, list.stdout);
    assert.match(rows[0] ?? '', /^\s*\d+\s+POST\s+\/post\s+postPost\s+/);
    assert.match(rows[1] ?? '', /^\s+POST\s+\/post \(application\/json\)\s+postPostJson\s+\[name=\] \[qty=\]$/);
    assert.match(rows[2] ?? '', /^\s+POST\s+\/post \(multipart\/form-data\)\s+postPostMultipart\s+\[title=\]$/);
  });

  test('each function sends its own body', async () => {
    const form = await bash(['postPost']);
    assert.equal(form.code, 0, form.stderr);
    assert.equal(received.at(-1)?.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(received.at(-1)?.body, 'custname=Ada');
    const json = await bash(['postPostJson', 'qty=5']);
    assert.equal(json.code, 0, json.stderr);
    assert.equal(received.at(-1)?.method, 'POST');
    assert.equal(received.at(-1)?.url, '/post');
    assert.equal(received.at(-1)?.headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(received.at(-1)?.body ?? ''), { name: 'widget', qty: 5 });
    const multipart = await bash(['postPostMultipart']);
    assert.equal(multipart.code, 0, multipart.stderr);
    assert.match(String(received.at(-1)?.headers['content-type']), /^multipart\/form-data; boundary=/);
    assert.match(received.at(-1)?.body ?? '', /name="title"\r\n\r\nhello\r\n/);
    assert.match(received.at(-1)?.body ?? '', /name="upload"; filename="notes\.txt"\r\nContent-Type: text\/plain\r\n\r\ncaptured notes\n/);
    const chosen = await bash(['postPostMultipart'], { APPII_UPLOAD_FILE: join(dir, 'other.txt') });
    assert.equal(chosen.code, 0, chosen.stderr);
    assert.match(received.at(-1)?.body ?? '', /name="upload"; filename="other\.txt"\r\nContent-Type: text\/plain\r\n\r\nanother file\n/);
    const count = received.length;
    const missing = await bash(['postPostMultipart'], { APPII_UPLOAD_FILE: join(dir, 'missing.txt') });
    assert.equal(missing.code, 2);
    assert.equal(missing.stderr, `postPostMultipart: cannot read the file ${join(dir, 'missing.txt')} to upload: set APPII_UPLOAD_FILE to a file that you can read.\n`);
    assert.equal(received.length, count, 'nothing is sent without the file');
  });

  test('list --show prints one curl example per media type', () => {
    const detail = new PresenterFactory({ width: 200 }).detail().render({ model: built, ref: built.endpoints.find((endpoint) => endpoint.path === '/post')?.id ?? '' });
    const headings = detail.split('\n').filter((line) => line.startsWith('Example request'));
    assert.deepEqual(headings, ['Example request (curl, application/x-www-form-urlencoded)', 'Example request (curl, application/json)', 'Example request (curl, multipart/form-data)']);
    assert.match(detail, /Example request \(curl, application\/json\)\n-+\ncurl -sS -X POST 'https:\/\/httpbin\.example\.com\/post' \\\n {2}-H 'Content-Type: application\/json' \\\n {2}--data-raw '\{"name":"widget","qty":2\}'/);
    assert.match(detail, /Example request \(curl, multipart\/form-data\)\n-+\ncurl -sS -X POST 'https:\/\/httpbin\.example\.com\/post' \\\n {2}--form-string 'title=hello' \\\n {2}-F 'upload=@notes\.txt'/);
  });
});
