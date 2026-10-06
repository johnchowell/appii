import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import type { CDPSession, Page } from 'playwright';
import { ModelBuilder } from '../src/build/index.js';
import { CaptureSession, PageNetworkTap, SessionConnection } from '../src/capture/index.js';
import type { Capture, Exchange } from '../src/model/index.js';
import { Http } from '../src/shared/index.js';
import { LOGIN_USER, startNavigatingTokenSite } from './fixtures/login-sites.js';

const CREDENTIALS = [
  { name: 'username', value: LOGIN_USER.username },
  { name: 'password', value: LOGIN_USER.password },
];

function find(capture: Capture, method: string, pathname: string): Exchange[] {
  return capture.exchanges.filter((exchange) => exchange.request.method === method && new URL(exchange.request.url).pathname === pathname);
}

function listing(capture: Capture): string {
  return capture.exchanges.map((exchange) => `${exchange.request.method} ${exchange.request.url} ${exchange.response?.status ?? exchange.error ?? ''}`).join('\n');
}

async function logIn(origin: string): Promise<Capture> {
  return CaptureSession.create({ url: `${origin}/signin`, login: CREDENTIALS, headless: true, idleMs: 300, recorder: { readTimeoutMs: 5000 } }).run();
}

describe('capture: a response that the page reads right before it navigates away keeps its body', () => {
  for (const xhr of [false, true]) {
    test(`a bearer login sent with ${xhr ? 'XMLHttpRequest' : 'fetch'}: the token in the JSON body is recorded, so the build finds the login and what it issues`, async () => {
      const site = await startNavigatingTokenSite({ bearer: true, xhr });
      try {
        const capture = await logIn(site.origin);
        const login = find(capture, 'POST', '/api/auth/login');
        assert.equal(login.length, 1, listing(capture));
        const body = login[0]!.response?.body;
        assert.ok(body && body.truncated !== true && body.data !== '', JSON.stringify(body));
        const token = (Http.bodyJson(body) as { accessToken?: string }).accessToken;
        assert.match(token ?? '', /^[0-9a-f]{48}$/);
        const profile = find(capture, 'GET', '/api/profile');
        assert.equal(profile[0]?.response?.status, 200, listing(capture));
        assert.equal(Http.getHeader(profile[0]!.request.headers, 'authorization'), `Bearer ${token}`);
        const model = ModelBuilder.create({ now: new Date(0) }).build(capture);
        const endpoint = model.endpoints.find((candidate) => candidate.method === 'POST' && candidate.path === '/api/auth/login');
        assert.equal(endpoint?.role, 'login', JSON.stringify(endpoint?.login));
        assert.deepEqual(endpoint?.login?.issues.tokens, ['accessToken']);
        assert.ok(!JSON.stringify(model).includes(token!), 'the token value never reaches the model');
      } finally {
        await site.close();
      }
    });
  }

  test('a cookie login: the JSON body is recorded next to the cookie, so its schema is known', async () => {
    const site = await startNavigatingTokenSite();
    try {
      const capture = await logIn(site.origin);
      const login = find(capture, 'POST', '/api/auth/login')[0];
      assert.ok(login, listing(capture));
      assert.deepEqual(Http.bodyJson(login.response?.body), { ok: true, user: { name: LOGIN_USER.username } });
      assert.match(Http.getHeaderAll(login.response!.headers, 'set-cookie').join('\n'), /^auth_token=/);
    } finally {
      await site.close();
    }
  });
});

interface Timings {
  firstChunkMs: number;
  totalMs: number;
  sseEvent: string;
  eventSource: string;
  bigLength: number;
}

function startStreamingSite(): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><html><head><meta charset="utf-8"><title>Streams</title></head><body>streams</body></html>');
      return;
    }
    if (path === '/ndjson') {
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(`${JSON.stringify({ line: sent })}\n`);
        sent++;
        if (sent === 6) {
          clearInterval(timer);
          res.end();
        }
      }, 150);
      req.on('close', () => clearInterval(timer));
      return;
    }
    if (path === '/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      res.write('data: first\n\n');
      const timer = setInterval(() => res.write('data: more\n\n'), 200);
      req.on('close', () => clearInterval(timer));
      return;
    }
    if (path === '/big') {
      const big = Buffer.from(JSON.stringify({ blob: 'b'.repeat(2 * 1024 * 1024) }));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': String(big.length) });
      res.end(big);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

describe('capture: recording response bodies does not change how responses reach the page', () => {
  test('a streamed response arrives chunk by chunk, an endless event stream still delivers, a body above the limit is cut, and a route set by a script still answers', async () => {
    const { server, origin } = await startStreamingSite();
    let timings: Timings | undefined;
    let mocked = '';
    try {
      const capture = await CaptureSession.create({
        url: `${origin}/`,
        headless: true,
        idleMs: 300,
        recorder: { maxBodyBytes: 100000, readTimeoutMs: 5000 },
        script: async (page: Page) => {
          timings = await page.evaluate(async () => {
            const started = performance.now();
            const response = await fetch('/ndjson');
            const reader = response.body!.getReader();
            await reader.read();
            const firstChunkMs = performance.now() - started;
            while (!(await reader.read()).done) continue;
            const totalMs = performance.now() - started;
            const events = await fetch('/events');
            const eventReader = events.body!.getReader();
            const sseEvent = new TextDecoder().decode((await eventReader.read()).value);
            await eventReader.cancel();
            const eventSource = await new Promise<string>((resolve) => {
              const source = new EventSource('/events');
              source.onmessage = (event) => {
                source.close();
                resolve(String(event.data));
              };
            });
            const bigLength = (await (await fetch('/big')).text()).length;
            return { firstChunkMs, totalMs, sseEvent, eventSource, bigLength };
          });
          await page.route('**/mocked', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '{"mocked":true}' }));
          mocked = await page.evaluate(() => fetch('/mocked').then((response) => response.text()));
        },
      }).run();
      assert.ok(timings);
      assert.ok(timings.totalMs >= 600, JSON.stringify(timings));
      assert.ok(timings.firstChunkMs < timings.totalMs / 2, `the first chunk waited for the whole body: ${JSON.stringify(timings)}`);
      assert.equal(timings.sseEvent, 'data: first\n\n');
      assert.equal(timings.eventSource, 'first');
      assert.equal(mocked, '{"mocked":true}');
      const ndjson = find(capture, 'GET', '/ndjson')[0];
      assert.equal(Http.bodyText(ndjson?.response?.body).trim().split('\n').length, 6, JSON.stringify(ndjson?.response?.body));
      const big = find(capture, 'GET', '/big')[0]?.response?.body;
      assert.equal(timings.bigLength, 2 * 1024 * 1024 + 11);
      assert.equal(big?.truncated, true);
      assert.equal(big?.size, 2 * 1024 * 1024 + 11);
      assert.ok((big?.data.length ?? 0) <= 100000, String(big?.data.length));
      assert.deepEqual(Http.bodyJson(find(capture, 'GET', '/mocked')[0]?.response?.body), { mocked: true });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

class PausingSession extends EventEmitter {
  readonly sent: { method: string; params: Record<string, unknown> }[] = [];

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push({ method, params });
    if (method === 'Network.streamResourceContent') {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { bufferedData: '' };
    }
    if (method === 'Network.getResponseBody') throw new Error('No resource with given identifier found');
    return {};
  }

  request(requestId: string, url: string, method = 'GET'): void {
    this.emit('Network.requestWillBeSent', { requestId, request: { url, method, headers: {} }, wallTime: 1000, timestamp: 10, type: 'Fetch' });
  }

  pause(interceptionId: string, networkId: string, status: number | undefined, headers: { name: string; value: string }[] = [], error?: string): void {
    this.emit('Fetch.requestPaused', {
      requestId: interceptionId,
      networkId,
      request: { url: 'http://x/', method: 'GET', headers: {} },
      resourceType: 'XHR',
      ...(status === undefined ? {} : { responseStatusCode: status, responseHeaders: headers }),
      ...(error === undefined ? {} : { responseErrorReason: error }),
    });
  }

  methods(): string[] {
    return this.sent.map((entry) => entry.method).filter((method) => method !== 'Network.enable' && method !== 'Target.setAutoAttach' && method !== 'Fetch.enable');
  }
}

async function pausingTap(options: { streamBytes?: number; holdLimitMs?: number } = {}): Promise<{ session: PausingSession; tap: PageNetworkTap }> {
  const session = new PausingSession();
  const tap = await PageNetworkTap.attach(new SessionConnection(session as unknown as CDPSession), options);
  assert.ok(tap);
  return { session, tap };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('PageNetworkTap: fetch and XHR responses are held at their headers only until streaming of their body is on', () => {
  test('intercepts only fetch and XHR responses, and turns streaming on before it lets the response continue', async () => {
    const { session, tap } = await pausingTap();
    const enable = session.sent.find((entry) => entry.method === 'Fetch.enable');
    assert.deepEqual(enable?.params, { patterns: [...PageNetworkTap.RESPONSE_PATTERNS] });
    session.request('n1', 'http://x/api/login', 'POST');
    session.pause('i1', 'n1', 200, [{ name: 'Content-Type', value: 'application/json' }]);
    await until(() => session.methods().includes('Fetch.continueResponse'));
    assert.deepEqual(session.methods(), ['Network.streamResourceContent', 'Fetch.continueResponse']);
    assert.deepEqual(session.sent.find((entry) => entry.method === 'Network.streamResourceContent')?.params, { requestId: 'n1' });
    assert.deepEqual(session.sent.find((entry) => entry.method === 'Fetch.continueResponse')?.params, { requestId: 'i1' });
    const json = Buffer.from('{"accessToken":"abc"}');
    session.emit('Network.responseReceived', { requestId: 'n1', timestamp: 11, response: { url: 'http://x/api/login', status: 200, headers: {} } });
    session.emit('Network.dataReceived', { requestId: 'n1', dataLength: 10, data: json.subarray(0, 10).toString('base64') });
    session.emit('Network.dataReceived', { requestId: 'n1', dataLength: json.length - 10, data: json.subarray(10).toString('base64') });
    session.emit('Network.loadingFinished', { requestId: 'n1', timestamp: 12 });
    const record = tap.claim({ method: 'POST', url: 'http://x/api/login', startTime: 0 });
    assert.ok(record);
    const body = await tap.responseBody(record);
    assert.equal(body?.bytes.toString(), json.toString());
    assert.equal(body?.text, false);
    assert.ok(!session.methods().includes('Network.getResponseBody'), 'the body came from the stream, not from a read after the page moved on');
    await tap.close();
  });

  test('lets an event stream, a body above the limit, a redirect and a failed response continue at once, without streaming', async () => {
    const { session, tap } = await pausingTap({ streamBytes: 1000 });
    session.request('n2', 'http://x/events');
    session.request('n3', 'http://x/big');
    session.request('n4', 'http://x/moved');
    session.request('n5', 'http://x/down');
    session.pause('i2', 'n2', 200, [{ name: 'content-type', value: 'text/event-stream; charset=utf-8' }]);
    session.pause('i3', 'n3', 200, [{ name: 'content-length', value: '1001' }]);
    session.pause('i4', 'n4', 302, [{ name: 'location', value: '/elsewhere' }]);
    session.pause('i5', 'n5', undefined, [], 'ConnectionRefused');
    await until(() => session.methods().length === 4);
    assert.deepEqual(session.methods(), ['Fetch.continueResponse', 'Fetch.continueResponse', 'Fetch.continueResponse', 'Fetch.continueRequest']);
    assert.deepEqual(
      session.sent.filter((entry) => entry.method.startsWith('Fetch.continue')).map((entry) => entry.params.requestId),
      ['i2', 'i3', 'i4', 'i5'],
    );
    await tap.close();
  });

  test('a pause whose request the tap never saw, or whose streaming cannot start, is still let through', async () => {
    const { session, tap } = await pausingTap({ holdLimitMs: 100 });
    session.send = async function (method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      this.sent.push({ method, params });
      if (method === 'Network.streamResourceContent') throw new Error('Request with the provided ID does not exists');
      return {};
    };
    session.pause('i6', 'unknown', 200);
    session.request('n7', 'http://x/worker-owned');
    session.pause('i7', 'n7', 200);
    await until(() => session.methods().filter((method) => method === 'Fetch.continueResponse').length === 2);
    assert.deepEqual(session.methods(), ['Network.streamResourceContent', 'Fetch.continueResponse', 'Fetch.continueResponse']);
    assert.deepEqual(
      session.sent.filter((entry) => entry.method === 'Fetch.continueResponse').map((entry) => entry.params.requestId),
      ['i7', 'i6'],
      'a pause whose request is not reported yet is held for the request, at most the hold limit, and then let through',
    );
    await tap.close();
  });

  test('a response is let through after the hold limit when streaming never answers', async () => {
    const { session, tap } = await pausingTap({ holdLimitMs: 50 });
    session.send = async function (method: string, params: Record<string, unknown> = {}): Promise<unknown> {
      this.sent.push({ method, params });
      if (method === 'Network.streamResourceContent') return new Promise(() => undefined);
      return {};
    };
    session.request('n8', 'http://x/api/slow');
    session.pause('i8', 'n8', 200);
    await until(() => session.methods().includes('Fetch.continueResponse'));
    assert.deepEqual(session.methods(), ['Network.streamResourceContent', 'Fetch.continueResponse']);
    await tap.close();
  });

  test('with bodies off nothing is intercepted', async () => {
    const session = new PausingSession();
    const tap = await PageNetworkTap.attach(new SessionConnection(session as unknown as CDPSession), { bodies: false });
    assert.ok(tap);
    assert.ok(!session.sent.some((entry) => entry.method === 'Fetch.enable'));
    await tap.close();
  });
});
