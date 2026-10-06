import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelBuilder } from '../src/build/index.js';
import { CaptureSession } from '../src/capture/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import type { ApiModel, Capture, Endpoint } from '../src/model/index.js';
import { EndpointIndex, Samples } from '../src/shared/index.js';

const USER = 'alice';
const PASSWORD = 'hunter22';
const DEMO_PASSWORD = 'passwd';

function startAuthServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><title>Auth</title></head><body><h1>Auth</h1></body></html>');
      return;
    }
    const match = /^\/(?:auth|basic-auth)\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (match) {
      const expected = `Basic ${Buffer.from(`${decodeURIComponent(match[1] ?? '')}:${decodeURIComponent(match[2] ?? '')}`).toString('base64')}`;
      const ok = req.headers.authorization === expected;
      res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json', 'cache-control': 'no-store', ...(ok ? {} : { 'www-authenticate': 'Basic realm="x"' }) });
      res.end(JSON.stringify({ authenticated: ok, user: decodeURIComponent(match[1] ?? '') }));
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('missing');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

describe('a Basic password that is also a path segment becomes a redacted path parameter (NEW-4)', () => {
  let server: Server;
  let capture: Capture;
  let model: ApiModel;

  before(async () => {
    const started = await startAuthServer();
    server = started.server;
    try {
      capture = await CaptureSession.create({
        url: `${started.origin}/`,
        headless: true,
        idleMs: 300,
        script: async (page) => {
          const basic = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
          await page.evaluate(`fetch('/auth/${USER}/${PASSWORD}', { headers: { authorization: '${basic(USER, PASSWORD)}' } }).then((r) => r.text())`);
          await page.evaluate(`fetch('/basic-auth/user/${DEMO_PASSWORD}', { headers: { authorization: '${basic('user', DEMO_PASSWORD)}' } }).then((r) => r.text())`);
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

  test('the server checked the password in the path, so the capture is meaningful', () => {
    const statuses = capture.exchanges.filter((exchange) => /\/(?:basic-)?auth\//.test(exchange.request.url)).map((exchange) => exchange.response?.status);
    assert.deepEqual(statuses, [200, 200]);
  });

  test('the endpoint path, id and name hold a password parameter instead of the password', () => {
    const auth = endpoint(model, 'GET', `/auth/${USER}/{password}`);
    assert.deepEqual(auth.pathParams.map((param) => [param.name, param.examples]), [['password', [Samples.REDACTED]]]);
    assert.ok(!auth.id.includes(PASSWORD) && !auth.name.toLowerCase().includes(PASSWORD) && !auth.key.includes(PASSWORD), `${auth.id} ${auth.name} ${auth.key}`);
    const demo = endpoint(model, 'GET', '/basic-auth/user/{password}');
    assert.deepEqual(demo.pathParams.map((param) => param.name), ['password']);
    assert.ok(!demo.name.toLowerCase().includes(DEMO_PASSWORD), demo.name);
  });

  test('sample URLs match the documented path', () => {
    for (const path of [`/auth/${USER}/{password}`, '/basic-auth/user/{password}']) {
      const found = endpoint(model, 'GET', path);
      for (const sample of found.samples) assert.ok(EndpointIndex.matchPath(found.path, new URL(sample.url).pathname), `${sample.url} vs ${found.path}`);
    }
  });

  test('no output carries the password', () => {
    assert.ok(!JSON.stringify(model).includes(PASSWORD), 'api.json');
    assert.ok(!JSON.stringify(model).includes(`/${DEMO_PASSWORD}`), 'api.json demo password');
    const registry = ExporterRegistry.default();
    for (const format of registry.list().map((exporter) => exporter.format)) {
      const content = registry.get(format).export(model, { capture }).content;
      assert.ok(!content.includes(PASSWORD), `${format} contains ${PASSWORD}`);
      assert.ok(!content.includes(`/${DEMO_PASSWORD}`), `${format} contains /${DEMO_PASSWORD}`);
    }
  });
});
