import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ModelBuilder } from '../src/build/index.js';
import { TypeScriptExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { TsClientHarness } from './fixtures/export-ts-harness.js';
import type { Module } from './fixtures/export-ts-harness.js';
import { CaptureFactory } from './helpers/capture-factory.js';

interface Received {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

const BOUNDARY = '----WebKitFormBoundaryABC';
const LOGIN_PAGE = '<!doctype html><title>Login</title><form method="post" action="/login"><input name="username"><input type="password" name="password"><button>Login</button></form>';
const ORDER_PAGE = '<!doctype html><form method="post" action="/post"><input name="custname"><button>Go</button></form>';

class HttpbinServer {
  readonly received: Received[] = [];
  #server: Server | undefined;
  origin = '';

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const path = new URL(req.url ?? '/', 'http://localhost').pathname;
        const body = Buffer.concat(chunks);
        this.received.push({ method: req.method ?? '', path, headers: req.headers, body });
        if (path === '/bearer') {
          const auth = req.headers.authorization ?? '';
          const ok = /^Bearer \S+$/.test(auth);
          res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
          res.end(JSON.stringify(ok ? { authenticated: true, token: auth.slice(7) } : { authenticated: false }));
          return;
        }
        if (path === '/login' && req.method === 'POST') {
          res.writeHead(302, { location: '/', 'content-type': 'text/html' });
          res.end('<p>Redirecting</p>');
          return;
        }
        if (path === '/post') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ contentType: req.headers['content-type'] ?? '', body: body.toString('utf8') }));
          return;
        }
        if (path === '/lines') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"id":0,"name":"a"}\n{"id":1,"name":"b"}\n{"id":2,"name":"c"}\n');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(path === '/login' ? LOGIN_PAGE : path === '/forms/post' ? ORDER_PAGE : '<!doctype html><title>Home</title>');
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  last(path: string): Received {
    const found = this.received.filter((item) => item.path === path).at(-1);
    assert.ok(found, path);
    return found;
  }
}

function model(origin: string): ApiModel {
  const f = new CaptureFactory(origin);
  f.document('/login', LOGIN_PAGE);
  f.snapshot('/login', 'Login', LOGIN_PAGE);
  f.exchange({
    method: 'POST',
    url: '/login',
    resourceType: 'document',
    status: 302,
    requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
    requestBody: 'username=ada&password=secret-pass',
    responseHeaders: { location: '/', 'content-type': 'text/html' },
    responseBody: '<p>Redirecting</p>',
  });
  f.document('/', '<!doctype html><title>Home</title>');
  f.json('GET', '/bearer', 200, { authenticated: true, token: 'abc' }, { requestHeaders: { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz0123456789' } });
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
  f.exchange({ url: '/lines', status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: '{"id":0,"name":"a"}\n{"id":1,"name":"b"}\n' });
  return ModelBuilder.create().build(f.capture());
}

const USAGE = `import { Client, MissingCredentialError } from './CLIENT';

export async function follow(client: Client): Promise<string> {
  const login = await client.postLogin({ body: { username: 'ada', password: 'pw' } });
  if (login.status === 302) {
    // @ts-expect-error the client follows the redirect, so a 302 has no typed body
    const page: string = login.data;
    return page;
  }
  return String(login.status);
}

export async function manual(): Promise<string> {
  const client = new Client({ redirect: 'manual' });
  const login = await client.postLogin({ body: { username: 'ada', password: 'pw' } });
  if (login.status === 302) {
    const page: string = login.data;
    return page;
  }
  return '';
}

export async function tokens(): Promise<boolean> {
  const fixed = new Client({ accessToken: 'abc' });
  const lazy = new Client({ accessToken: async () => 'abc' });
  const one = await fixed.getBearer({ accessToken: 'other' });
  const two = await lazy.getBearer({ headers: { authorization: 'Bearer x' } });
  const error: Error = new MissingCredentialError('getBearer');
  return one.status === 200 && two.status === 200 && error instanceof Error;
}

export async function bodies(client: Client): Promise<number> {
  await client.postPost({ body: { custname: 'Ada' } });
  await client.postPost({ contentType: 'application/json', body: { name: 'widget', qty: 2 } });
  await client.postPost({ contentType: 'multipart/form-data', body: { title: 'hello', upload: new Blob(['x']) } });
  // @ts-expect-error the JSON body has its own type
  await client.postPost({ contentType: 'application/json', body: { custname: 'Ada' } });
  const lines = await client.listLines();
  if (lines.status === 200) {
    const id: number | undefined = lines.data[0]?.id;
    return id ?? -1;
  }
  return -1;
}
`;

describe('TypeScript client: bearer tokens, redirects, request body types and JSON lines (HTTPBIN-6, QTS-6, HTTPBIN-2, HTTPBIN-10)', () => {
  const server = new HttpbinServer();
  let harness: TsClientHarness;
  let built: ApiModel;
  let mod: Module;
  let file = '';

  before(async () => {
    await server.start();
    harness = await TsClientHarness.open();
    built = model(server.origin);
    const loaded = await harness.load(built);
    mod = loaded.mod;
    file = loaded.file;
  });

  after(async () => {
    await server.stop();
    await harness?.close();
  });

  function client(options: Record<string, unknown> = {}): ReturnType<typeof TsClientHarness.client> {
    return TsClientHarness.client(mod, built, options);
  }

  test('the generated types compile: follow and manual redirect modes, token options and body variants', async () => {
    const name = TypeScriptExporter.clientName(built);
    const usage = USAGE.replaceAll('./CLIENT', `./${file.replace(/\.ts$/, '.js')}`).replace(/\bClient\b/g, name);
    await writeFile(join(harness.dir, 'usage.ts'), usage);
    const result = await harness.compile([file, 'usage.ts'], true);
    assert.equal(result.code, 0, result.output);
  });

  test('a bearer endpoint sends the token of the options or the request, and throws without one', async () => {
    const before = server.received.length;
    await assert.rejects(TsClientHarness.call(client(), 'getBearer'), (err: Error) => err.name === 'MissingCredentialError' && /getBearer needs a bearer token/.test(err.message));
    assert.equal(server.received.length, before);
    const fixed = await TsClientHarness.call(client({ accessToken: 'tok-1' }), 'getBearer');
    assert.equal(fixed.status, 200);
    assert.equal(server.last('/bearer').headers.authorization, 'Bearer tok-1');
    await TsClientHarness.call(client({ accessToken: async () => 'tok-2' }), 'getBearer');
    assert.equal(server.last('/bearer').headers.authorization, 'Bearer tok-2');
    await TsClientHarness.call(client({ accessToken: 'tok-1' }), 'getBearer', { accessToken: 'tok-3' });
    assert.equal(server.last('/bearer').headers.authorization, 'Bearer tok-3');
    await TsClientHarness.call(client({ accessToken: 'tok-1' }), 'getBearer', { headers: { Authorization: 'Bearer own' } });
    assert.equal(server.last('/bearer').headers.authorization, 'Bearer own');
  });

  test('the default client returns the final page of a redirect and redirect manual returns the 302', async () => {
    const followed = await TsClientHarness.call(client(), 'postLogin', { body: { username: 'ada', password: 'pw' } });
    assert.equal(followed.status, 200);
    assert.equal(followed.redirected, true);
    assert.match(String(followed.data), /<title>Home<\/title>/);
    const manual = await TsClientHarness.call(client({ redirect: 'manual' }), 'postLogin', { body: { username: 'ada', password: 'pw' } });
    assert.equal(manual.status, 302);
    assert.equal(manual.data, '<p>Redirecting</p>');
  });

  test('contentType chooses the request body: form, JSON or multipart', async () => {
    const api = client();
    await TsClientHarness.call(api, 'postPost', { body: { custname: 'Ada Lovelace' } });
    assert.equal(server.last('/post').headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(server.last('/post').body.toString('utf8'), 'custname=Ada+Lovelace');
    await TsClientHarness.call(api, 'postPost', { contentType: 'application/json', body: { name: 'widget', qty: 3 } });
    assert.equal(server.last('/post').headers['content-type'], 'application/json');
    assert.deepEqual(JSON.parse(server.last('/post').body.toString('utf8')), { name: 'widget', qty: 3 });
    await TsClientHarness.call(api, 'postPost', { contentType: 'multipart/form-data', body: { title: 'hello', upload: new File(['line'], 'notes.txt', { type: 'text/plain' }) } });
    const sent = server.last('/post');
    assert.match(String(sent.headers['content-type']), /^multipart\/form-data; boundary=/);
    assert.match(sent.body.toString('utf8'), /name="upload"; filename="notes.txt"\r\nContent-Type: text\/plain\r\n\r\nline\r\n/);
    await assert.rejects(TsClientHarness.call(api, 'postPost', { contentType: 'text/csv', body: 'a,b' }), /takes no text\/csv body\. It takes application\/x-www-form-urlencoded, application\/json, multipart\/form-data/);
  });

  test('a JSON lines response is a list of the parsed lines', async () => {
    const lines = await TsClientHarness.call(client(), 'listLines');
    assert.equal(lines.status, 200);
    assert.deepEqual(lines.data, [
      { id: 0, name: 'a' },
      { id: 1, name: 'b' },
      { id: 2, name: 'c' },
    ]);
  });
});
