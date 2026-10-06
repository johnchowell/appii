import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelBuilder, Redactor, SecretCollector } from '../src/build/index.js';
import { CaptureSession } from '../src/capture/index.js';
import { ExporterRegistry, HarExporter } from '../src/export/index.js';
import type { ApiModel, Capture, Endpoint, JsonSchema } from '../src/model/index.js';
import { Samples, Schema } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const SID = 'Q7f9xK2mPz81';
const TRACKING = 'GA1.1.1234567890.1700000000';
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl';

const ORDER_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Order</title></head><body>
<form id="order" method="post" action="/order">
  <select name="view"><option value="compact">Compact</option><option value="detailed">Detailed</option></select>
  <label><input type="checkbox" name="topping" value="bacon"> Bacon</label>
  <label><input type="checkbox" name="topping" value="mushroom"> Mushroom</label>
  <button type="submit">Order</button>
</form></body></html>`;

function startShop(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const origin = `http://${req.headers.host ?? 'localhost'}`;
      if (url.pathname === '/') {
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'set-cookie': ['last_topping=mushroom; Path=/', 'view_mode=detailed; Path=/', `sid=${SID}; Path=/; HttpOnly`, `_ga=${TRACKING}; Path=/`],
        });
        res.end(ORDER_PAGE);
        return;
      }
      if (url.pathname === '/order' && req.method === 'POST') {
        const form = Object.fromEntries([...new URLSearchParams(Buffer.concat(chunks).toString('utf8')).keys()].map((key) => [key, new URLSearchParams(Buffer.concat(chunks).toString('utf8')).getAll(key)]));
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ form, received: req.headers.cookie ?? '' }));
        return;
      }
      if (url.pathname === '/api/feed') {
        res.writeHead(401, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-credentials': 'true', 'access-control-allow-origin': origin });
        res.end(JSON.stringify({ errors: { token: ['is missing'] } }));
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

function choices(schema: JsonSchema | undefined): unknown[] {
  const node = Schema.asSchema(schema);
  const items = Schema.items(node);
  return [...((node?.enum as unknown[] | undefined) ?? []), ...((items?.enum as unknown[] | undefined) ?? [])];
}

describe('value-based scrubbing uses only values that are secret by evidence (NEW-1, NEW-SPA-2)', () => {
  let server: Server;
  let capture: Capture;
  let model: ApiModel;

  before(async () => {
    const started = await startShop();
    server = started.server;
    try {
      capture = await CaptureSession.create({
        url: `${started.origin}/`,
        headless: true,
        idleMs: 300,
        script: async (page) => {
          await page.evaluate(`fetch('/api/feed', { credentials: 'include' }).then((r) => r.text())`);
          await page.selectOption('select[name=view]', 'detailed');
          await page.check('input[value=mushroom]');
          await Promise.all([page.waitForURL('**/order'), page.click('#order button')]);
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

  test('the capture holds the cookies and the echoed values, so the checks below are meaningful', () => {
    const order = capture.exchanges.find((exchange) => exchange.request.url.endsWith('/order'));
    const text = Buffer.from(order?.response?.body?.data ?? '', order?.response?.body?.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8');
    for (const value of [SID, 'last_topping=mushroom', 'view_mode=detailed', TRACKING]) assert.ok(text.includes(value), value);
  });

  test('preference, tracking and word-valued cookies are not secrets; the HttpOnly session id is', () => {
    const values = SecretCollector.create().collect(capture);
    assert.ok(values.has(SID));
    for (const value of ['mushroom', 'detailed', TRACKING]) assert.ok(!values.has(value), value);
  });

  test('form choices keep the values that a cookie also holds, in the model, OpenAPI and the TypeScript client', () => {
    const order = endpoint(model, 'POST', '/order');
    const properties = Schema.properties(order.requestBody?.schema);
    assert.ok(choices(properties.topping).includes('mushroom'), JSON.stringify(properties.topping));
    assert.ok(choices(properties.view).includes('detailed'), JSON.stringify(properties.view));
    const example = order.requestBody?.examples[0] as Record<string, unknown>;
    assert.deepEqual(example.view, 'detailed');
    assert.ok(JSON.stringify(example.topping).includes('mushroom'), JSON.stringify(example));
    const text = JSON.stringify(model);
    assert.ok(!text.includes(SID), 'api.json holds the session id');
    const received = (order.responses[0]?.body?.examples[0] as { received?: string } | undefined)?.received ?? '';
    assert.ok(received.includes('last_topping=mushroom') && received.includes(`sid=${Samples.REDACTED}`), received);
    const registry = ExporterRegistry.default();
    const openapi = registry.export(model, 'openapi').content;
    assert.ok(!openapi.includes(SID));
    assert.match(openapi, /"mushroom"/);
    assert.doesNotMatch(openapi, /"enum": \[[^\]]*<redacted>/);
    const client = registry.export(model, 'typescript').content;
    assert.match(client, /"mushroom"/);
    assert.doesNotMatch(client, /"<redacted>"\)?\[\]|\| "<redacted>"/);
    for (const format of registry.list().map((exporter) => exporter.format)) assert.ok(!registry.get(format).export(model, { capture }).content.includes(SID), format);
  });

  test('CORS policy headers and validation messages are not secrets, in the model, OpenAPI, Postman and HAR', () => {
    const feed = endpoint(model, 'GET', '/api/feed');
    assert.deepEqual(feed.responses[0]?.body?.examples[0], { errors: { token: ['is missing'] } });
    const registry = ExporterRegistry.default();
    for (const format of ['openapi', 'postman']) assert.ok(registry.export(model, format).content.includes('is missing'), format);
    const har = JSON.parse(HarExporter.create().export(model, { capture }).content) as { log: { entries: { request: { url: string }; response: { headers: { name: string; value: string }[]; content: { text?: string } } }[] } };
    const entry = har.log.entries.find((candidate) => candidate.request.url.endsWith('/api/feed'));
    assert.equal(entry?.response.headers.find((header) => header.name.toLowerCase() === 'access-control-allow-credentials')?.value, 'true');
    assert.ok(entry?.response.content.text?.includes('is missing'), entry?.response.content.text);
  });
});

describe('Redactor keeps protocol headers and error messages (NEW-SPA-2)', () => {
  const redactor = Redactor.create();

  test('CORS response and preflight headers are public, secret headers stay redacted', () => {
    assert.equal(redactor.header('Access-Control-Allow-Credentials', 'true'), 'true');
    assert.equal(redactor.header('access-control-allow-headers', 'authorization, x-csrf-token'), 'authorization, x-csrf-token');
    assert.equal(redactor.header('Access-Control-Request-Headers', 'authorization'), 'authorization');
    assert.equal(redactor.header('X-Auth-Token', 'abc'), Samples.REDACTED);
    assert.equal(redactor.header('Access-Control-Allow-Origin', JWT), Samples.REDACTED);
  });

  test('messages under error objects are kept, while tokens and password messages are not', () => {
    assert.deepEqual(redactor.deep({ errors: { token: ['is missing'], email: ['is invalid'] } }), { errors: { token: ['is missing'], email: ['is invalid'] } });
    assert.deepEqual(redactor.deep({ error: { session: 'expired, please sign in again' } }), { error: { session: 'expired, please sign in again' } });
    assert.deepEqual(redactor.deep({ errors: { token: [JWT] } }), { errors: { token: [Samples.REDACTED] } });
    assert.deepEqual(redactor.deep({ errors: { password: ['is too short'] } }), { errors: { password: [Samples.REDACTED] } });
    assert.deepEqual(redactor.deep({ token: 'abc123def456', access_token: 'x' }), { token: Samples.REDACTED, access_token: Samples.REDACTED });
    assert.deepEqual(redactor.deep({ error: 'invalid_token', token: 'is missing' }), { error: 'invalid_token', token: Samples.REDACTED });
  });

  test('a cookie alias keeps each value distinct and the redaction marker, so the cookie lifecycle survives (QTS-R3)', () => {
    const aliases = new Map<string, string>();
    const alias = (name: string, value: string): string => {
      const key = `${name}=${value}`;
      if (!aliases.has(key)) aliases.set(key, `${Samples.REDACTED}${aliases.size + 1}`);
      return aliases.get(key) ?? '';
    };
    assert.equal(redactor.header('Cookie', 'session=a1; theme=dark', alias), `session=${Samples.REDACTED}1; theme=${Samples.REDACTED}2`);
    assert.equal(redactor.header('Set-Cookie', 'session=a2; Path=/; HttpOnly\nsession=a1; Path=/', alias), `session=${Samples.REDACTED}3; Path=/; HttpOnly\nsession=${Samples.REDACTED}1; Path=/`);
    assert.equal(redactor.header('Cookie', 'session=a1'), `session=${Samples.REDACTED}`);
  });
});

describe('SecretCollector evidence rules (NEW-1)', () => {
  test('cookie values count only for credential, CSRF and secret-named cookies or token-shaped values', () => {
    const f = new CaptureFactory();
    f.document('/', CaptureFactory.page('Home', '<h1>Home</h1>'), {
      responseHeaders: {
        'set-cookie': [
          'sessionid=loggedout; Path=/',
          'remember_me=forever; Path=/',
          'csrftoken=Zq81mPxk0Lw27Rty; Path=/',
          'theme=midnight; Path=/',
          '_ga=GA1.1.99887766.1700000000; Path=/',
          'last_topping=mushroom; Path=/',
          'cart=Kd8sPq2LmX91aZ0w; Path=/; HttpOnly',
          'build_secret=s3cr3t-77; Path=/',
        ],
      },
    });
    const values = SecretCollector.create().collect(f.capture());
    for (const value of ['Zq81mPxk0Lw27Rty', 'Kd8sPq2LmX91aZ0w', 's3cr3t-77']) assert.ok(values.has(value), value);
    for (const value of ['loggedout', 'forever', 'midnight', 'GA1.1.99887766.1700000000', 'mushroom']) assert.ok(!values.has(value), value);
  });

  test('response words under secret-named keys are not secrets, response tokens are', () => {
    const f = new CaptureFactory();
    f.json('POST', '/oauth/token', 200, { token_type: 'bearer', access_token: 'Rt5x-91kQzP-0aa', scope: 'read' }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { grant_type: 'client_credentials' } } });
    f.json('POST', '/signup', 422, { errors: { password: ['required'], token: ['expired_or_invalid'] } }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { email: 'a@b.example' } } });
    const values = SecretCollector.create().collect(f.capture());
    assert.ok(values.has('Rt5x-91kQzP-0aa'));
    for (const value of ['bearer', 'required', 'expired_or_invalid']) assert.ok(!values.has(value), value);
  });

  test('a typed password that is also ordinary site content in unrelated places is not scrubbed from that content', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/products/1', 200, { id: 1, flavor: 'chocolate' });
    f.json('GET', '/api/products/2', 200, { id: 2, flavor: 'chocolate' });
    f.exchange({
      method: 'POST',
      url: '/login',
      resourceType: 'document',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: 'username=ann&password=chocolate',
      status: 303,
      responseHeaders: { location: '/' },
    });
    f.json('POST', '/api/check', 200, { ok: true }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { password: 'Wq9-unique-77' } } });
    const capture = f.capture();
    const values = SecretCollector.create().collect(capture);
    assert.ok(!values.has('chocolate'));
    assert.ok(values.has('Wq9-unique-77'));
    const model = ModelBuilder.create({ now: new Date(0) }).build(capture);
    assert.deepEqual(endpoint(model, 'GET', '/api/products/{productId}').responses[0]?.body?.examples[0], { id: 1, flavor: 'chocolate' });
    const login = endpoint(model, 'POST', '/login').requestBody?.examples[0] as Record<string, unknown>;
    assert.equal(login.password, Samples.REDACTED);
  });
});
