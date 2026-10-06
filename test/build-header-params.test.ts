import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { HeaderPolicy, ModelBuilder } from '../src/build/index.js';
import { CaptureSession } from '../src/capture/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';

function startServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>Docs</title></head><body><h1>Docs</h1></body></html>');
        return;
      }
      if (url.pathname === '/bytes') {
        const data = Buffer.alloc(64, 97);
        const range = /^bytes=([0-9]+)-([0-9]+)$/.exec(String(req.headers.range ?? ''));
        if (!range) {
          res.writeHead(200, { 'content-type': 'application/octet-stream', 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
          res.end(data);
          return;
        }
        const start = Number(range[1]);
        const end = Math.min(Number(range[2]), data.length - 1);
        res.writeHead(206, { 'content-type': 'application/octet-stream', 'content-range': `bytes ${start}-${end}/${data.length}`, 'cache-control': 'no-store' });
        res.end(data.subarray(start, end + 1));
        return;
      }
      if (url.pathname === '/tag') {
        if (req.headers['if-none-match'] === '"abc"') {
          res.writeHead(304, { etag: '"abc"', 'cache-control': 'no-store' });
          res.end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json', etag: '"abc"', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ tag: 'abc' }));
        return;
      }
      if (url.pathname === '/doc' && req.method === 'PUT') {
        const ok = req.headers['if-match'] === '"v1"';
        res.writeHead(ok ? 200 : 428, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(ok ? { saved: true } : { error: 'precondition required' }));
        return;
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('missing');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

describe('Range and conditional headers set by a page script are optional parameters (NEW-5)', () => {
  let server: Server;
  let model: ApiModel;

  before(async () => {
    const started = await startServer();
    server = started.server;
    try {
      const capture = await CaptureSession.create({
        url: `${started.origin}/`,
        headless: true,
        idleMs: 300,
        script: async (page) => {
          await page.evaluate(`(async () => {
            await fetch('/bytes', { headers: { Range: 'bytes=0-15' } }).then((r) => r.arrayBuffer());
            await fetch('/tag', { headers: { 'If-None-Match': '"abc"' } });
            await fetch('/doc', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: '{"text":"a"}' });
            await fetch('/doc', { method: 'PUT', headers: { 'content-type': 'application/json', 'If-Match': '"v1"' }, body: '{"text":"a"}' });
          })()`);
        },
      }).run();
      model = ModelBuilder.create({ now: new Date(0) }).build(capture);
    } catch (err) {
      server.close();
      throw err;
    }
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  test('the server answered the partial and conditional requests, so the capture is meaningful', () => {
    assert.deepEqual(endpoint(model, 'GET', '/bytes').responses.map((response) => response.status), [206]);
    assert.deepEqual(endpoint(model, 'GET', '/tag').responses.map((response) => response.status), [304]);
  });

  test('a header that only makes a request partial or conditional is not required', () => {
    assert.deepEqual(endpoint(model, 'GET', '/bytes').headerParams.map((param) => [param.name, param.required, param.examples]), [['range', false, ['bytes=0-15']]]);
    assert.deepEqual(endpoint(model, 'GET', '/tag').headerParams.map((param) => [param.name, param.required, param.examples]), [['if-none-match', false, ['"abc"']]]);
    const doc = JSON.parse(ExporterRegistry.default().export(model, 'openapi').content) as { paths: Record<string, Record<string, { parameters?: { name: string; in: string; required?: boolean }[] }>> };
    for (const [path, name] of [['/bytes', 'range'], ['/tag', 'if-none-match']] as const) {
      const param = doc.paths[path]?.get?.parameters?.find((candidate) => candidate.in === 'header' && candidate.name === name);
      assert.ok(param, `${path} ${name}`);
      assert.notEqual(param.required, true, `${path} ${name}`);
    }
  });

  test('a precondition the server demanded with 428 Precondition Required stays required', () => {
    assert.deepEqual(endpoint(model, 'PUT', '/doc').headerParams.map((param) => [param.name, param.required]), [['if-match', true]]);
    assert.ok(HeaderPolicy.isOptionalByProtocol('If-None-Match'));
    assert.ok(HeaderPolicy.isOptionalByProtocol('range'));
    assert.ok(!HeaderPolicy.isOptionalByProtocol('x-api-key'));
  });
});
