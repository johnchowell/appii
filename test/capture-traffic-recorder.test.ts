import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { TrafficRecorder } from '../src/capture/index.js';
import { AppiiError, Http } from '../src/shared/index.js';
import type { Exchange } from '../src/model/index.js';
import { startFixtureSite } from './fixtures/site.js';
import type { FixtureSite } from './fixtures/site.js';
import { startWebSocketSite } from './fixtures/capture-ws-server.js';
import type { WebSocketSite } from './fixtures/capture-ws-server.js';

let browser: Browser;
let site: FixtureSite;
let sockets: WebSocketSite;

before(async () => {
  browser = await chromium.launch({ headless: true });
  site = await startFixtureSite();
  sockets = await startWebSocketSite();
});

after(async () => {
  await browser?.close();
  await site?.close();
  await sockets?.close();
});

async function withContext<T>(fn: (context: BrowserContext) => Promise<T>): Promise<T> {
  const context = await browser.newContext();
  try {
    return await fn(context);
  } finally {
    await context.close();
  }
}

function find(exchanges: Exchange[], method: string, pathAndQuery: string): Exchange[] {
  return exchanges.filter((e) => e.request.method === method && new URL(e.request.url).pathname + new URL(e.request.url).search === pathAndQuery);
}

function one(exchanges: Exchange[], method: string, pathAndQuery: string): Exchange {
  const found = find(exchanges, method, pathAndQuery);
  assert.equal(found.length, 1, `expected exactly one ${method} ${pathAndQuery}, got ${found.length}`);
  return found[0]!;
}

describe('TrafficRecorder against a real browser', () => {
  test('records fetch/XHR traffic with bodies, network-stack Cookie headers and duplicate Set-Cookie headers', async () => {
    await withContext(async (context) => {
      const recorder = new TrafficRecorder();
      recorder.attach(context);
      const page = await context.newPage();
      await page.goto(site.url);
      await page.goto(site.origin + '/set-cookies');
      await page.goto(site.origin + '/app');
      await page.waitForFunction(() => document.getElementById('out')?.textContent === 'done 2');
      await recorder.settled();
      const cookies = await context.cookies();
      const sid = cookies.find((c) => c.name === 'sid')?.value;
      const csrf = cookies.find((c) => c.name === 'csrf')?.value;
      assert.ok(sid && csrf);
      const ex = recorder.exchanges;

      const home = one(ex, 'GET', '/');
      assert.equal(home.resourceType, 'document');
      assert.equal(home.source, 'browser');
      assert.equal(home.pageUrl, undefined);
      assert.equal(Http.getHeader(home.request.headers, 'cookie'), undefined);
      assert.ok(Http.getHeaderAll(home.response!.headers, 'set-cookie').some((v) => v.startsWith('sid=')));
      assert.match(Http.bodyText(home.response!.body), /<h1>Fixture<\/h1>/);

      const appDoc = one(ex, 'GET', '/app');
      assert.match(Http.getHeader(appDoc.request.headers, 'cookie') ?? '', new RegExp(`(^|; )sid=${sid}(;|$)`));
      assert.equal(appDoc.response?.body?.encoding, 'utf8');
      assert.match(appDoc.response?.remoteAddress ?? '', /^127\.0\.0\.1:\d+$/);

      const setCookies = one(ex, 'GET', '/set-cookies');
      assert.equal(Http.getHeaderAll(setCookies.response!.headers, 'set-cookie').length, 8);

      const list = one(ex, 'GET', '/api/items?page=1&limit=2');
      assert.equal(list.resourceType, 'fetch');
      assert.equal(list.pageUrl, site.origin + '/app');
      assert.equal(list.response?.status, 200);
      assert.equal((Http.bodyJson(list.response?.body) as { items: unknown[] }).items.length, 2);
      assert.match(Http.getHeader(list.request.headers, 'cookie') ?? '', new RegExp(`sid=${sid}`));

      const xhr = one(ex, 'GET', '/api/items?page=2&limit=2');
      assert.equal(xhr.resourceType, 'xhr');
      assert.equal((Http.bodyJson(xhr.response?.body) as { page: number }).page, 2);

      assert.equal(one(ex, 'GET', '/api/items/999').response?.status, 404);
      assert.deepEqual(Http.bodyJson(one(ex, 'GET', '/api/items/1').response?.body), site.items[0]);

      const posts = find(ex, 'POST', '/api/items');
      assert.equal(posts.length, 2);
      const created = posts.find((p) => p.response?.status === 201);
      const invalid = posts.find((p) => p.response?.status === 400);
      assert.ok(created && invalid);
      assert.deepEqual(Http.bodyJson(created.request.body), { name: 'Thing', price: 5 });
      assert.equal(Http.getHeader(created.request.headers, 'x-csrf-token'), csrf);
      assert.equal(Http.mimeEssence(created.request.body?.mimeType), 'application/json');
      assert.deepEqual(Http.bodyJson(invalid.request.body), { price: -1 });
      assert.ok((Http.bodyJson(invalid.response?.body) as { errors: Record<string, unknown> }).errors.name);

      const graphql = one(ex, 'POST', '/graphql');
      assert.equal((Http.bodyJson(graphql.request.body) as { operationName: string }).operationName, 'GetItem');
      assert.deepEqual(Http.bodyJson(graphql.response?.body), { data: { item: { id: '1', name: 'Widget' } } });

      assert.equal(new Set(ex.map((e) => e.id)).size, ex.length);
      for (const e of ex) {
        assert.ok(!Number.isNaN(Date.parse(e.startedAt)));
        assert.ok(e.durationMs >= 0);
        assert.ok(!e.request.headers.some((h) => h.name.startsWith(':')));
      }
      const starts = ex.map((e) => Date.parse(e.startedAt));
      assert.deepEqual(starts, [...starts].sort((a, b) => a - b));
      recorder.detach();
    });
  });

  test('links redirect chains through redirectedFrom and keeps every hop', async () => {
    await withContext(async (context) => {
      const recorder = new TrafficRecorder();
      recorder.attach(context);
      const page = await context.newPage();
      await page.goto(site.origin + '/redirect?n=2');
      await recorder.settled();
      const first = one(recorder.exchanges, 'GET', '/redirect?n=2');
      const second = one(recorder.exchanges, 'GET', '/redirect?n=1&code=302');
      const last = one(recorder.exchanges, 'GET', '/echo');
      assert.equal(first.response?.status, 302);
      assert.equal(first.response?.body, undefined);
      assert.equal(Http.getHeader(first.response!.headers, 'location'), '/redirect?n=1&code=302');
      assert.ok(Http.getHeaderAll(first.response!.headers, 'set-cookie').includes('hop2=1; Path=/'));
      assert.equal(first.redirectedFrom, undefined);
      assert.equal(second.redirectedFrom, first.id);
      assert.equal(last.redirectedFrom, second.id);
      assert.match(Http.getHeader(last.request.headers, 'cookie') ?? '', /hop2=1; hop1=1|hop1=1; hop2=1/);
      recorder.detach();
    });
  });

  test('records failed requests and flushes in-flight requests when detached', async () => {
    await withContext(async (context) => {
      const recorder = new TrafficRecorder();
      recorder.attach(context);
      const page = await context.newPage();
      await page.goto(site.origin + '/products');
      await page.evaluate(() => fetch('http://127.0.0.1:1/nothing').catch(() => 'failed'));
      const slowSeen = page.waitForRequest((r) => r.url().includes('/slow'));
      await page.evaluate(() => {
        void fetch('/slow?ms=4000').catch(() => undefined);
      });
      await slowSeen;
      await new Promise((r) => setTimeout(r, 100));
      await recorder.settled();
      const failed = recorder.exchanges.find((e) => e.request.url === 'http://127.0.0.1:1/nothing');
      assert.ok(failed, 'connection refused request recorded');
      assert.equal(failed.response, undefined);
      assert.match(failed.error ?? '', /ERR_|refused/i);
      assert.equal(failed.pageUrl, site.origin + '/products');
      assert.equal(recorder.exchanges.find((e) => e.request.url.includes('/slow')), undefined);
      recorder.detach();
      await recorder.settled();
      const slow = recorder.exchanges.find((e) => e.request.url.includes('/slow'));
      assert.ok(slow, 'in-flight request flushed on detach');
      assert.equal(slow.error, 'Capture ended before the request completed');
      assert.equal(slow.response, undefined);
      assert.ok(slow.request.headers.length > 0);
      const count = recorder.exchanges.length;
      await page.goto(site.origin + '/search?q=x');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(recorder.exchanges.length, count, 'nothing is recorded after detach');
    });
  });

  test('honors captureBodies, maxBodyBytes and maxExchanges', async () => {
    await withContext(async (context) => {
      const noBodies = new TrafficRecorder({ captureBodies: false });
      noBodies.attach(context);
      const page = await context.newPage();
      await page.goto(site.origin + '/app');
      await page.waitForFunction(() => document.getElementById('out')?.textContent === 'done 2');
      await noBodies.settled();
      assert.ok(noBodies.exchanges.length >= 9);
      assert.ok(noBodies.exchanges.every((e) => e.request.body === undefined && e.response?.body === undefined));
      noBodies.detach();

      const small = new TrafficRecorder({ maxBodyBytes: 10, maxExchanges: 2 });
      small.attach(context);
      await page.goto(site.origin + '/products');
      await page.evaluate(() => fetch('/api/items/1').then((r) => r.text()));
      await page.evaluate(() => fetch('/api/items/2').then((r) => r.text()));
      await small.settled();
      assert.equal(small.exchanges.length, 2);
      assert.deepEqual(
        small.exchanges.map((e) => new URL(e.request.url).pathname),
        ['/api/items/1', '/api/items/2'],
      );
      const body = small.exchanges[0]!.response!.body!;
      assert.equal(body.truncated, true);
      assert.equal(body.data.length, 10);
      assert.ok(body.size > 10);
      small.detach();
    });
  });

  test('keeps the exact bytes of content-encoded and non-UTF-8 request bodies', async () => {
    await withContext(async (context) => {
      const recorder = new TrafficRecorder();
      recorder.attach(context);
      const page = await context.newPage();
      await page.goto(site.origin + '/products');
      await page.evaluate(async () => {
        const stream = new Blob(['{"event":"view","user":42}']).stream().pipeThrough(new CompressionStream('gzip'));
        const gzip = await new Response(stream).arrayBuffer();
        await fetch('/echo?gzip', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8', 'content-encoding': 'gzip' }, body: gzip });
        await fetch('/echo?latin1', { method: 'POST', headers: { 'content-type': 'text/plain; charset=windows-1252' }, body: new Uint8Array([0x63, 0x61, 0x66, 0xe9]) });
      });
      await recorder.settled();
      const gzipped = one(recorder.exchanges, 'POST', '/echo?gzip').request.body!;
      assert.equal(gzipped.encoding, 'base64');
      assert.equal(gunzipSync(Buffer.from(Http.bodyBytes(gzipped))).toString('utf8'), '{"event":"view","user":42}');
      assert.equal(gzipped.size, Http.bodyBytes(gzipped).length);
      const latin1 = one(recorder.exchanges, 'POST', '/echo?latin1').request.body!;
      assert.equal(latin1.encoding, 'base64');
      assert.equal(Buffer.from(Http.bodyBytes(latin1)).toString('hex'), '636166e9');
      recorder.detach();
    });
  });

  test('notifies listeners, supports unsubscribe and clear()', async () => {
    await withContext(async (context) => {
      const recorder = new TrafficRecorder();
      const seen: string[] = [];
      const unsubscribe = recorder.onExchange((e) => seen.push(new URL(e.request.url).pathname));
      recorder.onExchange(() => {
        throw new Error('listener failures do not stop recording');
      });
      recorder.attach(context);
      const page = await context.newPage();
      await page.goto(site.origin + '/products');
      await recorder.settled();
      assert.deepEqual(seen, ['/products']);
      unsubscribe();
      await page.goto(site.origin + '/search?q=w');
      await recorder.settled();
      assert.deepEqual(seen, ['/products']);
      assert.equal(recorder.exchanges.length, 2);
      recorder.clear();
      assert.equal(recorder.exchanges.length, 0);
      await page.goto(site.origin + '/products');
      await recorder.settled();
      assert.equal(recorder.exchanges.length, 1);
      recorder.detach();
    });
  });

  test('captures popups through context-level events', async () => {
    await withContext(async (context) => {
      const recorder = new TrafficRecorder();
      recorder.attach(context);
      const page = await context.newPage();
      await page.goto(site.url);
      const [popup] = await Promise.all([context.waitForEvent('page'), page.evaluate(() => void window.open('/products'))]);
      await popup.waitForLoadState('load');
      await popup.evaluate(() => fetch('/api/items/3').then((r) => r.json()));
      await recorder.settled();
      assert.equal(one(recorder.exchanges, 'GET', '/products').resourceType, 'document');
      assert.equal(one(recorder.exchanges, 'GET', '/api/items/3').pageUrl, site.origin + '/products');
      recorder.detach();
    });
  });

  test('records WebSocket frames in both directions', async () => {
    await withContext(async (context) => {
      const recorder = new TrafficRecorder();
      recorder.attach(context);
      const page = await context.newPage();
      await page.goto(sockets.url);
      await page.waitForFunction(() => document.getElementById('log')?.textContent === 'closed');
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(recorder.websockets.length, 1);
      const ws = recorder.websockets[0]!;
      assert.equal(ws.url, sockets.origin.replace('http', 'ws') + '/ws');
      assert.equal(ws.pageUrl, sockets.url);
      assert.ok(ws.closedAt);
      const frames = ws.messages.map((m) => `${m.direction}:${m.opcode}:${m.data}`);
      assert.ok(frames.includes('sent:text:hello'));
      assert.ok(frames.includes('sent:binary:' + Buffer.from([1, 2, 3]).toString('base64')));
      assert.ok(frames.includes('received:text:welcome'));
      assert.ok(frames.includes('received:text:echo:hello'));
      assert.ok(frames.includes('received:binary:' + Buffer.from([3, 2, 1]).toString('base64')));
      assert.ok(ws.messages.every((m) => !Number.isNaN(Date.parse(m.at))));
      recorder.detach();
    });
  });
});

describe('TrafficRecorder contract', () => {
  test('rejects invalid options', () => {
    assert.throws(() => new TrafficRecorder({ maxExchanges: 0 }), (err: unknown) => err instanceof AppiiError && err.code === 'BAD_INPUT');
    assert.throws(() => new TrafficRecorder({ maxBodyBytes: -1 }), AppiiError);
    assert.throws(() => new TrafficRecorder({ maxExchanges: 1.5 }), AppiiError);
    assert.doesNotThrow(() => new TrafficRecorder({ maxBodyBytes: 0 }));
  });

  test('can only be attached to one context at a time', async () => {
    const a = await browser.newContext();
    const b = await browser.newContext();
    try {
      const recorder = new TrafficRecorder();
      recorder.attach(a);
      recorder.attach(a);
      assert.throws(() => recorder.attach(b), (err: unknown) => err instanceof AppiiError && err.code === 'CAPTURE');
      recorder.detach();
      recorder.detach();
      recorder.attach(b);
      recorder.detach();
      await recorder.settled();
    } finally {
      await a.close();
      await b.close();
    }
  });
});
