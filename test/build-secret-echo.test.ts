import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelBuilder, SecretCollector, SecretValues } from '../src/build/index.js';
import { CaptureSession } from '../src/capture/index.js';
import { ExporterRegistry, HarExporter } from '../src/export/index.js';
import type { ApiModel, Capture } from '../src/model/index.js';

const SESSION = 's3ss10nValue42';
const API_KEY = 'K3yValue-0001';
const TEXT_TOKEN = 'plain-T0ken-777';
const BEARER = 'b3arer-Tok3n-99';
const API_HEADER = 'h3ader-Key-55';
const BASIC_PASSWORD = 'Sup3rPass-x';
const BASIC = Buffer.from(`alice:${BASIC_PASSWORD}`).toString('base64');
const SECRETS = [SESSION, API_KEY, TEXT_TOKEN, BEARER, API_HEADER, BASIC_PASSWORD, BASIC];

function headerRecord(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < req.rawHeaders.length; i += 2) out[req.rawHeaders[i] ?? ''] = req.rawHeaders[i + 1] ?? '';
  return out;
}

function json(res: ServerResponse, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(value));
}

function startEchoServer(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const body = Buffer.concat(chunks).toString('utf8');
      if (url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><title>Echo</title></head><body><h1>Echo</h1></body></html>');
        return;
      }
      if (url.pathname === '/cookies/set') {
        res.writeHead(302, { location: '/cookies', 'set-cookie': `session=${url.searchParams.get('session') ?? ''}; Path=/` });
        res.end();
        return;
      }
      if (url.pathname === '/cookies') return json(res, { cookies: Object.fromEntries((req.headers.cookie ?? '').split(/; */).map((pair) => pair.split('='))) });
      if (url.pathname === '/headers') return json(res, { headers: headerRecord(req) });
      if (url.pathname === '/api/items') return json(res, { items: [1, 2], next: `${url.origin}${url.pathname}?${url.searchParams.toString().replace('page=1', 'page=2')}`, args: Object.fromEntries(url.searchParams) });
      if (url.pathname === '/anything/text') return json(res, { data: body, headers: headerRecord(req) });
      if (url.pathname === '/whoami') return json(res, { received: req.headers.authorization ?? '', echo: `you sent ${req.headers.authorization ?? ''}` });
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('not found');
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

describe('secrets that the server echoes back never reach the model or an export (HTTPBIN-1)', () => {
  let server: Server;
  let capture: Capture;
  let model: ApiModel;

  before(async () => {
    const started = await startEchoServer();
    server = started.server;
    try {
      capture = await CaptureSession.create({
        url: `${started.origin}/`,
        headless: true,
        idleMs: 300,
        script: async (page) => {
          const calls: [string, RequestInit][] = [
            [`/cookies/set?session=${SESSION}`, {}],
            ['/headers', { headers: { 'X-Api-Key': API_HEADER } }],
            [`/api/items?api_key=${API_KEY}&page=1`, {}],
            ['/anything/text', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: `token=${TEXT_TOKEN}\nnote=hello` }],
            ['/whoami', { headers: { authorization: `Bearer ${BEARER}` } }],
            ['/whoami', { headers: { authorization: `Basic ${BASIC}` } }],
          ];
          for (const [input, init] of calls) await page.evaluate(`fetch(${JSON.stringify(input)}, ${JSON.stringify(init)}).then((r) => r.text())`);
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

  test('the capture really echoed every secret, so the check below is meaningful', () => {
    const responses = capture.exchanges.map((exchange) => Buffer.from(exchange.response?.body?.data ?? '', exchange.response?.body?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8')).join('\n');
    for (const secret of [SESSION, API_KEY, TEXT_TOKEN, BEARER, API_HEADER, BASIC]) assert.ok(responses.includes(secret), secret);
  });

  test('the model holds none of the secret values, in any form', () => {
    const text = JSON.stringify(model);
    for (const secret of SECRETS) {
      assert.ok(!text.includes(secret), `api.json contains ${secret}`);
      assert.ok(!text.includes(encodeURIComponent(secret)), `api.json contains ${encodeURIComponent(secret)}`);
    }
    const headers = model.endpoints.find((endpoint) => endpoint.path === '/headers');
    const example = headers?.responses[0]?.body?.examples[0] as { headers: Record<string, string> } | undefined;
    assert.equal(example?.headers.Cookie, 'session=<redacted>');
    assert.ok(text.includes('"note=hello"') || text.includes('note=hello'), 'the non-secret part of the echoed text stays');
  });

  test('no exporter writes a secret value', () => {
    const registry = ExporterRegistry.default();
    const formats = registry.list().map((exporter) => exporter.format);
    assert.ok(formats.includes('har') && formats.includes('typescript') && formats.length >= 9, formats.join(', '));
    for (const format of formats) {
      const content = registry.get(format).export(model, { capture }).content;
      for (const secret of SECRETS) assert.ok(!content.includes(secret), `${format} contains ${secret}`);
    }
    assert.ok(HarExporter.create().export(model, { capture }).content.includes('note=hello'));
  });

  test('the collector gathers the values the redactor hides, and the policy hides their encodings', () => {
    const values = SecretCollector.create().collect(capture);
    for (const secret of SECRETS) assert.ok(values.has(secret), secret);
    const policy = new SecretValues(['ab c/12+3']);
    assert.equal(policy.scrub('x=ab%20c%2F12%2B3&y=ab c/12+3 "ab c/12+3"'), 'x=<redacted>&y=<redacted> "<redacted>"');
    assert.equal(new SecretValues(['true', 'deleted', 'abc']).size, 0);
  });
});
