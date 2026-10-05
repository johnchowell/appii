import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { CaptureSession, TrafficRecorder } from '../src/capture/index.js';
import type { TrafficRecorderOptions } from '../src/capture/index.js';
import { ModelBuilder } from '../src/build/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import { AppiiError, Http } from '../src/shared/index.js';
import type { Exchange } from '../src/model/index.js';
import { PageServers } from './fixtures/capture-pages.js';
import type { PageServer } from './fixtures/capture-pages.js';

const KIB = 1024;
const SCRIPT = `window.loaded = true;/*${'s'.repeat(100 * KIB)}*/`;
const LIST = JSON.stringify({ items: Array.from({ length: 2600 }, (_, i) => ({ id: i, name: `Product ${i}`, price: i * 3 })) });
const CHUNKS = 10;
const CHUNK = 'c'.repeat(10 * KIB);
const UPLOADS = 12;
const SERVICE_WORKER = `self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => event.waitUntil(fetch('/api/sw-own').then((r) => r.text()).then(() => event.source.postMessage('own-done'))));`;
const LEGACY_PAGE = Buffer.from(
  '<!doctype html><title>Forms</title><form id="g" action="/find"><input name="q" value="Z\u00fcrich \u20ac"><button>Go</button></form>' +
    '<form id="t" method="post" action="/note" enctype="text/plain"><input name="city" value="Z\u00fcrich"><button>Send</button></form>',
  'latin1',
).map((byte) => (byte === 0xac ? 0x80 : byte)) as Buffer;
const WORKER_SCRIPT = `fetch('/api/worker').then((r) => r.json()).then(() => postMessage('done'));`;
const POSTS = 20;

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function png(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = width * 3 + 1;
  const raw = Buffer.alloc(row * height);
  let seed = 7;
  for (let i = 0; i < raw.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    raw[i] = i % row === 0 ? 0 : seed & 0xff;
  }
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw, { level: 0 })), chunk('IEND', Buffer.alloc(0))]);
}

const IMAGE = png(1000, 1000);
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

let browser: Browser;
let server: PageServer;

before(async () => {
  browser = await chromium.launch({ headless: true });
  server = await PageServers.start({
    '/shop': (_req, res) =>
      PageServers.send(
        res,
        200,
        'text/html',
        PageServers.html(
          'Shop',
          `<img src="/photo.png"><script src="/app.js"></script><script>
(async () => {
  await new Promise((resolve) => (document.querySelector('img').complete ? resolve() : document.querySelector('img').addEventListener('load', resolve)));
  await fetch('/api/products').then((r) => r.json());
  await fetch('/api/products/1').then((r) => r.json());
  await fetch('/api/cart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"id":1}' }).then((r) => r.json());
  document.title = 'done';
})();
</script>`,
        ),
      ),
    '/app.js': (_req, res) => PageServers.send(res, 200, 'application/javascript', SCRIPT),
    '/photo.png': (_req, res) => PageServers.send(res, 200, 'image/png', IMAGE),
    '/api/products': (_req, res) => PageServers.send(res, 200, 'application/json', LIST),
    '/api/products/1': (_req, res) => PageServers.send(res, 200, 'application/json', '{"id":1}'),
    '/api/cart': (_req, res) => PageServers.send(res, 201, 'application/json', '{"items":1}'),
    '/blank': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Blank', 'blank')),
    '/slow-stream': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      let sent = 0;
      const timer = setInterval(() => {
        res.write(CHUNK);
        if (++sent === CHUNKS) {
          clearInterval(timer);
          res.end();
        }
      }, 100);
    },
    '/echo': (_req, res, body) => {
      const digest = sha(body);
      setTimeout(() => PageServers.send(res, 200, 'application/json', JSON.stringify({ sha: digest, body: body.toString('utf8') }), { 'x-body-sha': digest }), Math.floor(Math.random() * 30));
    },
    '/opener': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Opener', '<a id="open" href="/popup" target="_blank">open</a>')),
    '/popup': (_req, res) => {
      setTimeout(
        () => PageServers.send(res, 200, 'text/html', PageServers.html('Popup', '<p>popup page</p><script>fetch("/api/first").then((r) => r.json()).then(() => { document.title = "done"; });</script>')),
        150,
      );
    },
    '/api/first': (_req, res) => PageServers.send(res, 200, 'application/json', '{"first":true}'),
    '/sw-page': (_req, res) =>
      PageServers.send(
        res,
        200,
        'text/html',
        PageServers.html(
          'Service worker',
          `<script>
(async () => {
  await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  await new Promise((resolve) => { navigator.serviceWorker.addEventListener('message', resolve, { once: true }); navigator.serviceWorker.controller.postMessage('go'); });
  document.title = 'done';
})();
</script>`,
        ),
      ),
    '/sw.js': (_req, res) => PageServers.send(res, 200, 'application/javascript', SERVICE_WORKER),
    '/api/sw-own': (_req, res) => PageServers.send(res, 200, 'application/json', '{"own":true}'),
    '/bom-page': (_req, res) =>
      PageServers.send(res, 200, 'text/html; charset=windows-1252', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<!doctype html><title>Bom</title><form action="/find"><input name="q" value="caf\u00e9"></form>', 'utf8')])),
    '/legacy-forms': (_req, res) => PageServers.send(res, 200, 'text/html; charset=windows-1252', LEGACY_PAGE),
    '/find': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Found', 'found')),
    '/note': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Noted', 'noted')),
    '/worker-page': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Worker', `<script>const worker = new Worker('/worker.js'); worker.onmessage = (event) => { document.title = event.data; };</script>`)),
    '/worker.js': (_req, res) => PageServers.send(res, 200, 'application/javascript', WORKER_SCRIPT),
    '/api/worker': (_req, res) => PageServers.send(res, 200, 'application/json', '{"fromWorker":true}'),
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function record(options: TrafficRecorderOptions, fn: (context: BrowserContext, recorder: TrafficRecorder) => Promise<void>): Promise<Exchange[]> {
  const context = await browser.newContext();
  try {
    const recorder = TrafficRecorder.create(options);
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

function only(exchanges: Exchange[], method: string, path: string): Exchange {
  const found = exchanges.filter((e) => e.request.method === method && new URL(e.request.url).pathname === path);
  assert.equal(found.length, 1, `expected one ${method} ${path}, got ${found.length}`);
  return found[0]!;
}

describe('TrafficRecorder with bodies larger than 64 KiB', () => {
  test('keeps a 100 KiB script, a 3 MB image and a 200 KB JSON list, the requests after them, and the browser keeps running (REG-1, PW-REFETCH)', async () => {
    const exchanges = await record({}, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/shop'));
      await page.waitForFunction(() => document.title === 'done');
    });
    assert.equal(browser.isConnected(), true, 'the browser is still running');
    assert.equal(Http.bodyText(only(exchanges, 'GET', '/app.js').response?.body), SCRIPT);
    const image = only(exchanges, 'GET', '/photo.png').response?.body;
    assert.equal(image?.truncated, undefined);
    assert.equal(sha(Http.bodyBytes(image)), sha(IMAGE));
    assert.equal(Http.bodyText(only(exchanges, 'GET', '/api/products').response?.body), LIST);
    assert.deepEqual(Http.bodyJson(only(exchanges, 'GET', '/api/products/1').response?.body), { id: 1 });
    assert.deepEqual(Http.bodyJson(only(exchanges, 'POST', '/api/cart').response?.body), { items: 1 });
    for (const path of ['/photo.png', '/app.js', '/api/products']) assert.equal(server.requests.filter((r) => r.path === path).length, 1, `${path} was requested once`);
  });

  test('keeps a streamed body larger than 64 KiB that takes longer than the read timeout (CAP-2)', async () => {
    const exchanges = await record({ readTimeoutMs: 300 }, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/blank'));
      await page.evaluate(() => fetch('/slow-stream').then((r) => r.text()));
    });
    const body = only(exchanges, 'GET', '/slow-stream').response?.body;
    assert.equal(body?.truncated, undefined);
    assert.equal(Http.bodyText(body), CHUNK.repeat(CHUNKS));
  });
});

describe('TrafficRecorder with concurrent requests to one URL', () => {
  test('gives each of 20 concurrent POSTs with identical headers its own request and response (PW-REFETCH, CAP-1)', async () => {
    const exchanges = await record({}, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/blank'));
      await page.evaluate(
        (count) => Promise.all(Array.from({ length: count }, (_, i) => fetch('/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query: `q${i}` }) }).then((r) => r.text()))),
        POSTS,
      );
    });
    const posts = exchanges.filter((e) => e.request.method === 'POST' && new URL(e.request.url).pathname === '/echo');
    assert.equal(posts.length, POSTS);
    const wrong = posts.filter((e) => {
      const sent = Http.bodyText(e.request.body);
      const answer = Http.bodyJson(e.response?.body) as { body?: string; sha?: string } | undefined;
      return answer?.body !== sent || answer?.sha !== Http.getHeader(e.response?.headers ?? [], 'x-body-sha');
    });
    assert.deepEqual(wrong.map((e) => Http.bodyText(e.request.body)), []);
  });

  test('gives each of 12 concurrent Blob uploads of equal length and identical headers its own bytes (CAP-1)', async () => {
    const exchanges = await record({}, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/blank'));
      await page.evaluate(
        (count) =>
          Promise.all(
            Array.from({ length: count }, (_, i) =>
              fetch('/echo', { method: 'POST', body: new Blob([`upload-${String(i).padStart(2, '0')}-${'x'.repeat(4000)}`], { type: 'application/octet-stream' }) }).then((r) => r.text()),
            ),
          ),
        UPLOADS,
      );
    });
    const uploads = exchanges.filter((e) => e.request.method === 'POST' && new URL(e.request.url).pathname === '/echo');
    assert.equal(uploads.length, UPLOADS);
    const bodies = new Set<string>();
    for (const upload of uploads) {
      const bytes = Http.bodyBytes(upload.request.body);
      bodies.add(sha(bytes));
      assert.equal(sha(bytes), Http.getHeader(upload.response?.headers ?? [], 'x-body-sha'), 'the recorded request body is the one the server answered');
      assert.equal((Http.bodyJson(upload.response?.body) as { sha?: string }).sha, sha(bytes), 'the recorded response belongs to the request');
    }
    assert.equal(bodies.size, UPLOADS);
  });
});

describe('TrafficRecorder with pages that the site opens', () => {
  test('keeps the document and the first fetch of a target=_blank popup (REG-2)', async () => {
    const exchanges = await record({}, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/opener'));
      const [popup] = await Promise.all([context.waitForEvent('page'), page.click('#open')]);
      await popup.waitForFunction(() => document.title === 'done');
    });
    assert.match(Http.bodyText(only(exchanges, 'GET', '/popup').response?.body), /<p>popup page<\/p>/);
    assert.deepEqual(Http.bodyJson(only(exchanges, 'GET', '/api/first').response?.body), { first: true });
  });
});

describe('TrafficRecorder with dedicated workers', () => {
  test('keeps the body of the main script of a dedicated worker (REG-5)', async () => {
    const exchanges = await record({}, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/worker-page'));
      await page.waitForFunction(() => document.title === 'done');
    });
    assert.equal(Http.bodyText(only(exchanges, 'GET', '/worker.js').response?.body), WORKER_SCRIPT);
    only(exchanges, 'GET', '/api/worker');
    assert.equal(server.requests.filter((r) => r.path === '/worker.js').length, 1);
  });
});

describe('CaptureSession identity in service workers', () => {
  test('requests that a service worker makes in a headless capture carry the headed identity (CAP-18)', async () => {
    const capture = await CaptureSession.create({
      url: server.url('/sw-page'),
      headless: true,
      idleMs: 100,
      script: async (page) => {
        await page.waitForFunction(() => document.title === 'done');
      },
    }).run();
    const sent = server.requests.filter((r) => r.path === '/api/sw-own');
    const page = server.requests.filter((r) => r.path === '/sw-page');
    assert.ok(sent.length > 0 && page.length > 0, 'the page and its service worker made their requests');
    const agent = String(page[page.length - 1]!.headers['user-agent']);
    assert.doesNotMatch(agent, /HeadlessChrome/);
    for (const request of sent) {
      assert.equal(String(request.headers['user-agent']), agent, 'the worker sends the user agent of the page');
      assert.doesNotMatch(String(request.headers['sec-ch-ua'] ?? ''), /HeadlessChrome/);
    }
    const own = capture.exchanges.find((e) => new URL(e.request.url).pathname === '/api/sw-own');
    assert.ok(own, 'the worker request is recorded');
    assert.doesNotMatch(Http.getHeader(own.request.headers, 'user-agent') ?? '', /HeadlessChrome/);
  });
});

describe('CaptureSession page encodings', () => {
  test('snapshots record the encoding that the browser chose for the document (FB-21)', async () => {
    const capture = await CaptureSession.create({ url: server.url('/bom-page'), headless: true, idleMs: 100 }).run();
    const pages = capture.pages.filter((p) => new URL(p.url).pathname === '/bom-page');
    assert.ok(pages.length > 0);
    assert.ok(pages.every((p) => p.characterSet === 'UTF-8'), JSON.stringify(pages.map((p) => p.characterSet)));
    const model = ModelBuilder.create({}).build(capture);
    assert.equal(model.forms.find((form) => new URL(form.action).pathname === '/find')?.charset, 'UTF-8');
  });
});

describe('legacy-charset form submissions (EXP2-11)', () => {
  test('a windows-1252 GET form and text/plain form decode as the browser encoded them, and the curl script sends the same bytes', async () => {
    const capture = await CaptureSession.create({
      url: server.url('/legacy-forms'),
      headless: true,
      idleMs: 100,
      script: async (page) => {
        await Promise.all([page.waitForURL('**/find**'), page.click('#g button')]);
        await page.goBack();
        await Promise.all([page.waitForURL('**/note'), page.click('#t button')]);
      },
    }).run();
    const query = server.requests.find((r) => r.path.startsWith('/find?'))?.path.split('?')[1];
    const note = server.requests.find((r) => r.method === 'POST' && r.path === '/note')?.body;
    assert.equal(query, 'q=Z%FCrich+%80');
    assert.equal(note?.toString('hex'), Buffer.from('city=Z\u00fcrich\r\n', 'latin1').toString('hex'));
    const model = ModelBuilder.create({}).build(capture);
    const find = model.endpoints.find((e) => e.method === 'GET' && e.path === '/find');
    assert.deepEqual(find?.queryParams.find((p) => p.name === 'q')?.examples, ['Z\u00fcrich \u20ac']);
    const posted = model.endpoints.find((e) => e.method === 'POST' && e.path === '/note');
    assert.equal(posted?.requestBody?.kind, 'text');
    assert.deepEqual(posted?.requestBody?.examples, ['city=Z\u00fcrich\r\n']);
    assert.ok(Object.hasOwn(posted?.requestBody?.schema?.properties ?? {}, 'city'));
    const curl = ExporterRegistry.default().get('curl').export(model, {}).content;
    assert.ok(curl.includes(`/find?${query}`), curl);
    assert.ok(curl.includes("'city=Z\\374rich\\015\\012'"), curl);
  });
});

describe('CaptureSession when the browser dies', () => {
  test('a browser crash fails the capture and keeps what was recorded until then (REG-1)', async () => {
    const session = CaptureSession.create({
      url: server.url('/blank'),
      headless: true,
      idleMs: 100,
      script: async (page) => {
        await page.evaluate(() => fetch('/api/first').then((r) => r.json()));
        const cdp = await page.context().browser()!.newBrowserCDPSession();
        await cdp.send('Browser.crash' as never).catch(() => undefined);
        await page.waitForTimeout(200).catch(() => undefined);
      },
    });
    await assert.rejects(session.run(), (err: unknown) => {
      assert.ok(err instanceof AppiiError);
      assert.equal(err.code, 'BROWSER');
      assert.equal(err.message, CaptureSession.BROWSER_LOST);
      const capture = (err.details as { capture?: { exchanges: Exchange[] } }).capture;
      assert.ok(capture?.exchanges.some((e) => new URL(e.request.url).pathname === '/api/first'));
      return true;
    });
  });
});
