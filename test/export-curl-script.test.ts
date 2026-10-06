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
import { CurlExporter, HtmlExporter, MarkdownExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { Curl, Samples } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { ExportModel } from './helpers/export-model.js';

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
  ms: number;
}

class Recorder {
  readonly requests: Received[] = [];
  #server: Server | undefined;
  origin = '';

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        this.requests.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks) });
        if (req.method === 'HEAD') {
          res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '5' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  last(): Received {
    const last = this.requests.at(-1);
    assert.ok(last, 'no request was received');
    return last;
  }
}

function run(file: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const clean: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C', ...env };
    execFile('bash', [file, ...args], { env: clean, timeout: 20_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr, ms: Date.now() - started });
    });
  });
}

function itemsModel(origin: string): ApiModel {
  const f = new CaptureFactory(origin);
  f.json('GET', '/api/items/1', 200, { id: 1 });
  f.json('GET', '/api/items/2', 200, { id: 2 });
  f.json('GET', '/api/items/3', 200, { id: 3 });
  f.json('GET', '/dl?signature=Zm9vYmFyYmF6cXV4MTIzNDU2Nzg5MA', 200, { ok: 1 });
  f.json('POST', '/api/login', 200, { ok: 1 }, { requestType: 'application/json', requestBody: { json: { user: 'bob', password: 'hunter2hunter2' } } });
  f.exchange({ method: 'HEAD', url: '/ping', status: 200, responseHeaders: { 'content-type': 'text/plain' } });
  return ModelBuilder.create().build(f.capture());
}

describe('the curl script sends what the browser sends', () => {
  const recorder = new Recorder();
  let dir = '';

  before(async () => {
    await recorder.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-curl-script-'));
  });

  after(async () => {
    await recorder.stop();
    await rm(dir, { recursive: true, force: true });
  });

  async function script(model: ApiModel, name: string): Promise<string> {
    const file = join(dir, name);
    await writeFile(file, new CurlExporter().export(model).content);
    return file;
  }

  test('path parameters are arguments with the captured example as default, and they are percent-encoded', async () => {
    const file = await script(itemsModel(recorder.origin), 'items.sh');
    const list = await run(file, []);
    assert.match(list.stdout, /\n1 {2}GET {5}\/api\/items\/\{itemId\} {2}getItem {4}\[ITEM_ID\]\n/);
    const before = recorder.requests.length;
    const two = await run(file, ['getItem', '2']);
    assert.equal(two.code, 0, two.stderr);
    assert.equal(recorder.requests.length, before + 1);
    assert.equal(recorder.last().url, '/api/items/2');
    await run(file, ['getItem']);
    assert.equal(recorder.last().url, '/api/items/1');
    await run(file, ['getItem', '-H', 'x-test: 1']);
    assert.equal(recorder.last().url, '/api/items/1');
    assert.equal(recorder.last().headers['x-test'], '1');
    await run(file, ['getItem'], { APPII_ITEM_ID: 'a b#c/\u00e9' });
    assert.equal(recorder.last().url, '/api/items/a%20b%23c%2F%C3%A9');
    assert.equal(decodeURIComponent(recorder.last().url.split('/').pop() ?? ''), 'a b#c/\u00e9');
  });

  test('query and JSON placeholders are encoded for their position and reach the server byte for byte', async () => {
    const file = await script(itemsModel(recorder.origin), 'values.sh');
    const query = await run(file, ['getDl'], { APPII_SIGNATURE: 'a+b/c==&x=1' });
    assert.equal(query.code, 0, query.stderr);
    assert.deepEqual([...new URL(recorder.last().url, recorder.origin).searchParams], [['signature', 'a+b/c==&x=1']]);
    const login = await run(file, ['postLogin'], { APPII_PASSWORD: 'p"q\\x\n\u00e9' });
    assert.equal(login.code, 0, login.stderr);
    assert.deepEqual(JSON.parse(recorder.last().body.toString('utf8')), { user: 'bob', password: 'p"q\\x\n\u00e9' });
  });

  test('a HEAD endpoint uses --head and returns at once', async () => {
    const file = await script(itemsModel(recorder.origin), 'head.sh');
    assert.match(await import('node:fs/promises').then((fs) => fs.readFile(file, 'utf8')), /curl -sS --head "\$\{APPII_BASE_URL\}\/ping"/);
    const head = await run(file, ['headPing', '-i']);
    assert.equal(head.code, 0, head.stderr);
    assert.ok(head.ms < 5000, String(head.ms));
    assert.equal(recorder.last().method, 'HEAD');
  });

  test('every variable that the script reads has the APPII_ prefix', async () => {
    const endpoint = ExportModel.endpoint({
      method: 'POST',
      path: '/env',
      origin: recorder.origin,
      requestBody: { mimeType: 'application/json', kind: 'json', examples: [{ path: '<redacted>', aws_secret_access_key: '<redacted>', home: '<redacted>', cookie: '<redacted>', base_url: '<redacted>' }] },
    });
    const model = ExportModel.model([endpoint], { primaryOrigin: recorder.origin });
    const text = new CurlExporter().export(model).content;
    for (const match of text.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const name = match[1] ?? '';
      assert.ok(/^(?:APPII_[A-Z0-9_]+|appii_[a-z0-9_]+|BASH_SOURCE|pair|name|wanted|pairs|command|byte|out|1)$/.test(name), name);
    }
    const file = await script(model, 'env.sh');
    const leak = { AWS_SECRET_ACCESS_KEY: 'leak', HOME: '/leak', COOKIE: 'leak=1', BASE_URL: 'http://leak.invalid' };
    const result = await run(file, ['postEnv'], leak);
    assert.equal(result.code, 0, result.stderr);
    const sent = JSON.parse(recorder.last().body.toString('utf8')) as Record<string, string>;
    assert.deepEqual(sent, { path: '', aws_secret_access_key: '', home: '', cookie: '', base_url: '' });
    assert.equal(recorder.last().headers.cookie, undefined);
    await run(file, ['postEnv'], { ...leak, APPII_PATH: 'p', APPII_AWS_SECRET_ACCESS_KEY: 'k', APPII_COOKIE_VALUE: 'c', APPII_BASE_URL_VALUE: 'b', APPII_COOKIE: 'sid=1' });
    assert.deepEqual(JSON.parse(recorder.last().body.toString('utf8')), { path: 'p', aws_secret_access_key: 'k', home: '', cookie: 'c', base_url: 'b' });
    assert.equal(recorder.last().headers.cookie, 'sid=1');
  });

  test('multipart names with = and NUL bytes, and urlencoded NUL bytes, are sent byte for byte', async () => {
    const multipart = ExportModel.endpoint({
      method: 'POST',
      path: '/mp',
      origin: recorder.origin,
      kind: 'form',
      requestBody: { mimeType: 'multipart/form-data', kind: 'multipart', examples: [{ 'a=b': 'val', nul: 'x\u0000y', 'q"n': 'z' }] },
    });
    const urlencoded = ExportModel.endpoint({
      method: 'POST',
      path: '/ue',
      origin: recorder.origin,
      kind: 'form',
      requestBody: { mimeType: 'application/x-www-form-urlencoded', kind: 'form', examples: [{ k: 'x\u0000y', 'a b': '1+1=2 \u00e9' }] },
    });
    const file = await script(ExportModel.model([multipart, urlencoded], { primaryOrigin: recorder.origin }), 'bytes.sh');
    const mp = await run(file, ['postMp']);
    assert.equal(mp.code, 0, mp.stderr);
    const received = recorder.last();
    const type = String(received.headers['content-type']);
    const boundary = /boundary=(.+)$/.exec(type)?.[1] ?? '';
    assert.ok(boundary !== '', type);
    const fields = [...received.body.toString('latin1').matchAll(/name="([^"]*)"\r\n\r\n([^\r]*)\r\n/g)].map((m) => [m[1], m[2]]);
    assert.deepEqual(fields, [['a=b', 'val'], ['nul', 'x\u0000y'], ['q%22n', 'z']]);
    assert.ok(received.body.toString('latin1').endsWith(`--${boundary}--\r\n`));
    const ue = await run(file, ['postUe']);
    assert.equal(ue.code, 0, ue.stderr);
    assert.equal(recorder.last().body.toString('latin1'), 'k=x%00y&a+b=1%2B1%3D2+%C3%A9');
  });

  test('text/plain forms, legacy charsets and empty file inputs are sent like a browser sends them', async () => {
    const f = new CaptureFactory(recorder.origin);
    f.document('/tp', '<!doctype html><form action="/t" method="post" enctype="text/plain"><input name="a" value="1"><textarea name="c">l1\nl2</textarea><button>Go</button></form>');
    f.exchange({ url: '/cs', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html; charset=windows-1252' }, responseBody: Uint8Array.from(Buffer.from('<!doctype html><form action="/c" method="post"><input name="city" value="Z\u00fcrich &#20013;"><button>Go</button></form>', 'latin1')) });
    f.document('/up', '<!doctype html><form action="/u" method="post" enctype="multipart/form-data"><input name="n" value="1"><input type="file" name="avatar"><button>Go</button></form>');
    const file = await script(ModelBuilder.create().build(f.capture()), 'forms.sh');
    const names = new CurlExporter().functionNames(ModelBuilder.create().build(f.capture()).endpoints);
    const call = async (path: string): Promise<Received> => {
      const name = [...names].find(([endpoint]) => endpoint.path === path)?.[1] ?? '';
      const result = await run(file, [name]);
      assert.equal(result.code, 0, `${path}: ${result.stderr}`);
      return recorder.last();
    };
    const plain = await call('/t');
    assert.equal(plain.headers['content-type'], 'text/plain');
    assert.equal(plain.body.toString('latin1'), 'a=1\r\nc=l1\r\nl2\r\n');
    assert.equal((await call('/c')).body.toString('latin1'), 'city=Z%FCrich+%26%2320013%3B');
    const upload = (await call('/u')).body.toString('latin1');
    assert.match(upload, /Content-Disposition: form-data; name="avatar"; filename=""\r\nContent-Type: application\/octet-stream\r\n\r\n\r\n/);
  });

  test('the comment line holds no control character even when the title has some', async () => {
    const model = ExportModel.model([ExportModel.endpoint({ method: 'GET', path: '/x\u001b[2J\u0007', origin: recorder.origin })], { name: 'Shop\u0000\u0001\u001b[31mX\u007f\u0085\u00e9', primaryOrigin: recorder.origin });
    const file = await script(model, 'comment.sh');
    const text = await import('node:fs/promises').then((fs) => fs.readFile(file, 'latin1'));
    assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\xff]/.test(text), JSON.stringify(text.match(/[\x00-\x09\x0b-\x1f\x7f-\xff]/g)));
    assert.match(text, /\n# Shop\\x00\\x01\\x1b\[31mX\\x7f\\x85\\u00e9: 1 endpoint, generated by /);
    const syntax = await new Promise<number>((resolve) => execFile('bash', ['-n', file], (err) => resolve(err ? 1 : 0)));
    assert.equal(syntax, 0);
    const list = await run(file, []);
    assert.match(list.stdout, /\/x\\x1b\[2J\\x07/);
  });
});

describe('example requests in every format send the cookies of the endpoint', () => {
  test('list --show, Markdown and HTML build the same command for a cookie endpoint', () => {
    const endpoint = ExportModel.endpoint({ method: 'GET', path: '/api/me', auth: { cookies: ['auth', 'sid'], headers: [], anonymous: 'untested', bearer: false, csrf: [] } });
    const model = ExportModel.model([endpoint]);
    const sample = Samples.requestSample(endpoint, { baseUrl: ExportModel.ORIGIN });
    const literal = Curl.curlCommand(sample);
    assert.match(literal, /-b 'auth=\{\{auth\}\}; sid=\{\{sid\}\}'/);
    const shell = Curl.curlCommand(sample, { variables: 'shell' });
    assert.match(shell, /-b "auth=\$\{APPII_AUTH\}; sid=\$\{APPII_SID\}"/);
    assert.deepEqual(Curl.placeholderNames(sample), ['APPII_AUTH', 'APPII_SID']);
    const markdown = new MarkdownExporter().export(model).content;
    assert.ok(markdown.includes(shell), markdown);
    assert.ok(!markdown.includes('{{'), markdown);
    const html = new HtmlExporter().export(model).content;
    assert.ok(html.includes('-b &quot;auth=${APPII_AUTH}; sid=${APPII_SID}&quot;'), html);
    assert.ok(!html.includes('{{auth}}'), html);
  });
});
