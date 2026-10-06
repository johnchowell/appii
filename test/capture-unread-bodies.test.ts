import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { EventEmitter } from 'node:events';
import { gzipSync } from 'node:zlib';
import type { BrowserContext, CDPSession, Request } from 'playwright';
import { CaptureSession, NetworkIdleMonitor, PageNetworkTap, SessionConnection } from '../src/capture/index.js';
import type { TapRecord } from '../src/capture/index.js';
import type { Capture, Exchange } from '../src/model/index.js';
import { Http } from '../src/shared/index.js';

const NO_STORE = { 'content-type': 'application/json', 'cache-control': 'no-store' };

function startUnreadSite(): Promise<{ server: Server; origin: string }> {
  const unread = (paths: string[]): string =>
    paths.map((path) => `fetch(${JSON.stringify(path)}).then((response) => { document.title += ' ' + response.status; });`).join('\n');
  const server = createServer((req, res) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    if (path === '/' || path === '/next') {
      const script = path === '/' ? unread(['/api/chunked', '/api/length', '/api/gzip', '/api/empty']) : '';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>unread</title></head><body><script>${script}</script></body></html>`);
      return;
    }
    if (path === '/api/chunked') {
      res.writeHead(200, NO_STORE);
      res.write('{"items":[1,');
      setTimeout(() => res.end('2,3]}'), 200);
      return;
    }
    if (path === '/api/length') {
      const body = JSON.stringify({ error: 'login required' });
      res.writeHead(401, { ...NO_STORE, 'content-length': String(Buffer.byteLength(body)) });
      res.end(body);
      return;
    }
    if (path === '/api/gzip') {
      const body = gzipSync(JSON.stringify({ zipped: true }));
      res.writeHead(200, { ...NO_STORE, 'content-encoding': 'gzip', 'content-length': String(body.length) });
      res.end(body);
      return;
    }
    if (path === '/api/empty') {
      res.writeHead(200, { ...NO_STORE, 'content-length': '0' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end();
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

function only(capture: Capture, pathname: string): Exchange {
  const found = capture.exchanges.filter((exchange) => new URL(exchange.request.url).pathname === pathname);
  assert.equal(found.length, 1, capture.exchanges.map((exchange) => `${exchange.request.url} ${exchange.response?.status ?? exchange.error ?? ''}`).join('\n'));
  return found[0]!;
}

describe('capture: a no-store fetch response whose body the page never reads (LV2-2)', () => {
  test('does not hold the capture until the stall limit, and every body that arrived is recorded in full and without an error', async () => {
    const { server, origin } = await startUnreadSite();
    try {
      const started = Date.now();
      const capture = await CaptureSession.create({ url: `${origin}/`, visits: [`${origin}/next`], headless: true, idleMs: 400, recorder: { readTimeoutMs: 5000 } }).run();
      const took = Date.now() - started;
      assert.ok(took < 12000, `the capture took ${took} ms; Chromium never finishes an unread no-store body, so waiting for that stalls until ${NetworkIdleMonitor.DEFAULT_STALLED_AFTER_MS} ms`);
      const chunked = only(capture, '/api/chunked');
      assert.equal(chunked.error, undefined);
      assert.equal(chunked.response?.status, 200);
      assert.deepEqual(Http.bodyJson(chunked.response?.body), { items: [1, 2, 3] });
      assert.notEqual(chunked.response?.body?.truncated, true);
      const length = only(capture, '/api/length');
      assert.equal(length.error, undefined);
      assert.equal(length.response?.status, 401);
      assert.deepEqual(Http.bodyJson(length.response?.body), { error: 'login required' });
      assert.notEqual(length.response?.body?.truncated, true);
      const gzip = only(capture, '/api/gzip');
      assert.equal(gzip.error, undefined);
      assert.ok((gzip.response?.body?.data ?? '') !== '', JSON.stringify(gzip.response));
      const empty = only(capture, '/api/empty');
      assert.equal(empty.error, undefined, 'Chromium cancels the empty body itself; the response arrived in full');
      assert.equal(empty.response?.status, 200);
      assert.ok(chunked.durationMs < 5000, `the duration ends when the body arrived, not when the page went away: ${chunked.durationMs}`);
      assert.ok(capture.exchanges.some((exchange) => new URL(exchange.request.url).pathname === '/next'));
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

class StreamingSession extends EventEmitter {
  async send(method: string): Promise<unknown> {
    if (method === 'Network.streamResourceContent') return { bufferedData: '' };
    if (method === 'Network.getResponseBody') throw new Error('No data found for resource with given identifier');
    return {};
  }

  response(requestId: string, url: string, headers: { name: string; value: string }[], status = 200): void {
    this.emit('Network.requestWillBeSent', { requestId, request: { url, method: 'GET', headers: {} }, wallTime: 1000, timestamp: 10, type: 'Fetch' });
    this.emit('Fetch.requestPaused', { requestId: `i-${requestId}`, networkId: requestId, request: { url, method: 'GET', headers: {} }, resourceType: 'XHR', responseStatusCode: status, responseHeaders: headers });
  }

  received(requestId: string, url: string, status = 200): void {
    this.emit('Network.responseReceived', { requestId, timestamp: 11, response: { url, status, headers: {} } });
  }

  data(requestId: string, bytes: Buffer, encodedDataLength = bytes.length): void {
    this.emit('Network.dataReceived', { requestId, dataLength: bytes.length, encodedDataLength, data: bytes.toString('base64') });
  }
}

async function streamingTap(quietMs = 100): Promise<{ session: StreamingSession; tap: PageNetworkTap; settles: [string, boolean][] }> {
  const session = new StreamingSession();
  const settles: [string, boolean][] = [];
  const tap = await PageNetworkTap.attach(new SessionConnection(session as unknown as CDPSession), {
    quietMs,
    onSettle: (_tap: PageNetworkTap, record: TapRecord) => settles.push([record.url, record.settled]),
  });
  assert.ok(tap);
  return { session, tap, settles };
}

async function until(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !condition(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('PageNetworkTap: a response body has arrived when its bytes say so, not only when the page finished it', () => {
  test('a body with a Content-Length has arrived once that many bytes came, and a later cancel by the page keeps it', async () => {
    const { session, tap, settles } = await streamingTap();
    const json = Buffer.from('{"error":"login required"}');
    session.response('r1', 'http://x/api/length', [{ name: 'Content-Length', value: String(json.length) }], 401);
    await until(() => tap.peek({ method: 'GET', url: 'http://x/api/length', startTime: 0 })?.stream !== undefined);
    session.received('r1', 'http://x/api/length', 401);
    session.data('r1', json.subarray(0, 5));
    const record = tap.peek({ method: 'GET', url: 'http://x/api/length', startTime: 0 });
    assert.equal(record?.settled, false);
    session.data('r1', json.subarray(5));
    assert.equal(record?.settled, true);
    assert.deepEqual(settles, [['http://x/api/length', true]]);
    assert.equal((await tap.responseBody(record!))?.bytes.toString(), json.toString(), 'the body is there before the page finished the request');
    session.emit('Network.loadingFailed', { requestId: 'r1', timestamp: 12, errorText: 'net::ERR_ABORTED', canceled: true });
    assert.equal(record?.state, 'finished');
    const claimed = tap.claim({ method: 'GET', url: 'http://x/api/length', startTime: 0 });
    assert.equal((await tap.responseBody(claimed!))?.bytes.toString(), json.toString());
    await tap.close();
  });

  test('a content-encoded body is counted in the bytes that came over the wire', async () => {
    const { session, tap } = await streamingTap();
    const wire = gzipSync('{"zipped":true}');
    session.response('r2', 'http://x/api/gzip', [
      { name: 'content-encoding', value: 'gzip' },
      { name: 'content-length', value: String(wire.length) },
    ]);
    await until(() => tap.peek({ method: 'GET', url: 'http://x/api/gzip', startTime: 0 })?.stream !== undefined);
    session.received('r2', 'http://x/api/gzip');
    session.data('r2', Buffer.from('{"zipped":true}'), wire.length);
    assert.equal(tap.peek({ method: 'GET', url: 'http://x/api/gzip', startTime: 0 })?.settled, true);
    await tap.close();
  });

  test('a body without a length has arrived once no more bytes came for the quiet time; more bytes take that back', async () => {
    const { session, tap, settles } = await streamingTap(80);
    session.response('r3', 'http://x/api/chunked', [{ name: 'transfer-encoding', value: 'chunked' }]);
    await until(() => tap.peek({ method: 'GET', url: 'http://x/api/chunked', startTime: 0 })?.stream !== undefined);
    session.received('r3', 'http://x/api/chunked');
    const record = tap.peek({ method: 'GET', url: 'http://x/api/chunked', startTime: 0 })!;
    assert.equal(record.settled, false, 'headers alone are not a body');
    session.data('r3', Buffer.from('{"items":[1,'));
    assert.equal(record.settled, false);
    await until(() => record.settled);
    assert.equal(record.settled, true);
    session.data('r3', Buffer.from('2]}'));
    assert.equal(record.settled, false);
    await until(() => record.settled);
    assert.deepEqual(settles, [
      ['http://x/api/chunked', true],
      ['http://x/api/chunked', false],
      ['http://x/api/chunked', true],
    ]);
    assert.equal((await tap.responseBody(record))?.bytes.toString(), '{"items":[1,2]}');
    await tap.close();
  });

  test('a body cut off before all its bytes came is kept as a part, never as the whole body', async () => {
    const { session, tap } = await streamingTap();
    session.response('r4', 'http://x/api/cut', [{ name: 'content-length', value: '100' }]);
    await until(() => tap.peek({ method: 'GET', url: 'http://x/api/cut', startTime: 0 })?.stream !== undefined);
    session.received('r4', 'http://x/api/cut');
    session.data('r4', Buffer.from('{"partial":'));
    const record = tap.peek({ method: 'GET', url: 'http://x/api/cut', startTime: 0 })!;
    assert.equal(tap.partialBody(record)?.bytes.toString(), '{"partial":');
    session.emit('Network.loadingFailed', { requestId: 'r4', timestamp: 12, errorText: 'net::ERR_CONNECTION_RESET' });
    assert.equal(record.state, 'failed');
    assert.equal(record.settled, false);
    assert.equal(await tap.responseBody(record), undefined);
    assert.equal(tap.partialBody(record)?.bytes.toString(), '{"partial":');
    await tap.close();
  });
});

class FakeContext extends EventEmitter {}

function fakeRequest(): Request {
  return { resourceType: () => 'fetch' } as unknown as Request;
}

describe('NetworkIdleMonitor: a request whose response has arrived does not hold the network busy', () => {
  test('a settled request lets the network be idle, and taking that back makes it busy again', async () => {
    const context = new FakeContext();
    const monitor = new NetworkIdleMonitor({ stalledAfterMs: 60000 });
    monitor.attach(context as unknown as BrowserContext);
    const request = fakeRequest();
    context.emit('request', request);
    assert.equal(monitor.inflight, 1);
    let idle = false;
    const waited = monitor.waitForIdle(30).then(() => {
      idle = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(idle, false);
    monitor.settle(request);
    assert.equal(monitor.inflight, 0);
    monitor.settle(request, false);
    assert.equal(monitor.inflight, 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(idle, false, 'more bytes made the request busy again before the idle time passed');
    monitor.settle(request);
    await waited;
    assert.equal(idle, true);
    context.emit('requestfinished', request);
    assert.equal(monitor.inflight, 0);
    monitor.settle(fakeRequest());
    assert.equal(monitor.inflight, 0, 'a request that the monitor does not track is ignored');
    monitor.detach();
  });
});
