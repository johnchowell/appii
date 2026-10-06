import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { PageNetworkTap, SessionConnection, TrafficRecorder } from '../src/capture/index.js';
import type { ConnectionListener, RootConnection, TrafficRecorderDeps } from '../src/capture/index.js';
import { Http } from '../src/shared/index.js';
import type { Exchange } from '../src/model/index.js';
import { PageServers } from './fixtures/capture-pages.js';
import type { PageServer } from './fixtures/capture-pages.js';

const PAYLOAD = JSON.stringify({ items: Array.from({ length: 40 }, (_, i) => ({ id: i, name: `item ${i}` })) });

let browser: Browser;
let server: PageServer;

before(async () => {
  browser = await chromium.launch({ headless: true });
  server = await PageServers.start({
    '/first': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('First', '<h1>first document</h1>')),
    '/second': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Second', '<h1>second document</h1>')),
    '/opener': (_req, res) =>
      PageServers.send(
        res,
        200,
        'text/html',
        PageServers.html('Opener', '<script>Promise.all([fetch("/api/plain").then((r) => r.text()), fetch("/api/chunked").then((r) => r.text()), fetch("/api/empty").then((r) => r.text())]).then(() => { document.title = "done"; });</script>'),
      ),
    '/api/plain': (_req, res) => PageServers.send(res, 200, 'application/json', PAYLOAD),
    '/api/chunked': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'transfer-encoding': 'chunked' });
      res.end(gzipSync(PAYLOAD));
    },
    '/api/empty': (_req, res) => {
      const empty = gzipSync(Buffer.alloc(0));
      res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': String(empty.length) });
      res.end(empty);
    },
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function record(deps: TrafficRecorderDeps, fn: (context: BrowserContext, recorder: TrafficRecorder) => Promise<void>): Promise<Exchange[]> {
  const context = await browser.newContext();
  try {
    const recorder = deps.tap === undefined ? TrafficRecorder.create() : new TrafficRecorder({}, deps);
    recorder.attach(context);
    await fn(context, recorder);
    await recorder.settled();
    recorder.detach();
    await recorder.settled();
    return recorder.exchanges;
  } finally {
    await context.close();
  }
}

function only(exchanges: Exchange[], path: string): Exchange {
  const found = exchanges.filter((exchange) => new URL(exchange.request.url).pathname === path);
  assert.equal(found.length, 1, `expected one request to ${path}, got ${found.length}`);
  return found[0]!;
}

class LateFinishConnection implements RootConnection {
  static readonly LAG_MS = 500;
  static readonly LATE: ReadonlySet<string> = new Set(['Network.loadingFinished']);
  readonly key = 'page';
  readonly #inner: SessionConnection;

  constructor(inner: SessionConnection) {
    this.#inner = inner;
  }

  send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    return this.#inner.send<T>(method, params);
  }

  on(listener: ConnectionListener): () => void {
    return this.#inner.on((method, params) => {
      if (LateFinishConnection.LATE.has(method)) setTimeout(() => listener(method, params), LateFinishConnection.LAG_MS);
      else listener(method, params);
    });
  }

  detach(): Promise<void> {
    return this.#inner.detach();
  }
}

describe('captures that do not depend on how fast appii handles browser events (CAPTURE-LOAD)', () => {
  test('a document keeps its body when the script navigates on as soon as Playwright reports the load, before appii hears that the document finished', async () => {
    const late: TrafficRecorderDeps = {
      watcher: async () => undefined,
      tap: async (context, page, options) => PageNetworkTap.attach(new LateFinishConnection(new SessionConnection(await context.newCDPSession(page))), options),
    };
    const exchanges = await record(late, async (context, recorder) => {
      const page = await context.newPage();
      assert.equal(await recorder.prepare(page), true);
      await page.goto(server.url('/first'));
      await page.goto(server.url('/second'));
    });
    assert.match(Http.bodyText(only(exchanges, '/first').response?.body), /<h1>first document<\/h1>/);
    assert.match(Http.bodyText(only(exchanges, '/second').response?.body), /<h1>second document<\/h1>/);
  });

  test('a response that appii could not observe is read from the page session only when that cannot send the request again', async () => {
    const before = server.requests.length;
    const exchanges = await record({ tap: async () => undefined, watcher: async () => undefined }, async (context) => {
      const page = await context.newPage();
      await page.goto(server.url('/opener'));
      await page.waitForFunction(() => document.title === 'done');
    });
    assert.match(Http.bodyText(only(exchanges, '/opener').response?.body), /fetch\("\/api\/plain"\)/);
    assert.deepEqual(Http.bodyJson(only(exchanges, '/api/plain').response?.body), JSON.parse(PAYLOAD));
    assert.deepEqual(Http.bodyJson(only(exchanges, '/api/chunked').response?.body), JSON.parse(PAYLOAD));
    const empty = only(exchanges, '/api/empty').response?.body;
    assert.equal(empty === undefined || empty.data === '', true, JSON.stringify(empty));
    const sent = server.requests.slice(before).map((request) => request.path).filter((path) => path !== '/favicon.ico');
    assert.deepEqual([...sent].sort(), ['/api/chunked', '/api/empty', '/api/plain', '/opener'], 'every request reached the server exactly once');
  });
});
