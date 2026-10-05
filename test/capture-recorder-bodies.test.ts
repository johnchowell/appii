import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { CaptureSession, PageNetworkTap, TrafficRecorder } from '../src/capture/index.js';
import type { TrafficRecorderOptions } from '../src/capture/index.js';
import { ModelBuilder } from '../src/build/index.js';
import { Http } from '../src/shared/index.js';
import type { Exchange } from '../src/model/index.js';
import { PageServers } from './fixtures/capture-pages.js';
import type { PageServer } from './fixtures/capture-pages.js';

const ALL_BYTES = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
const CSV = 'id,name\n1,Widget\n2,Gadget\n';
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

let browser: Browser;
let server: PageServer;
let dir: string;

before(async () => {
  browser = await chromium.launch({ headless: true });
  dir = await mkdtemp(join(tmpdir(), 'appii-recorder-'));
  const echo = (_req: unknown, res: import('node:http').ServerResponse, body: Buffer): void => PageServers.send(res, 200, 'application/json', JSON.stringify({ got: body.length }));
  server = await PageServers.start({
    '/': (_req, res) =>
      PageServers.send(
        res,
        200,
        'text/html',
        PageServers.html(
          'Upload',
          '<form id="upload" action="/up-form" method="post" enctype="multipart/form-data"><input name="title" value="Holiday"><input type="file" name="photo"><button>Send</button></form><a id="export" href="/export.csv">Export</a>',
        ),
      ),
    '/up-multipart': echo,
    '/up-blob': echo,
    '/up-beacon': echo,
    '/up-utf8': echo,
    '/up-latin1': echo,
    '/upload-page': (_req, res) =>
      PageServers.send(
        res,
        200,
        'text/html',
        PageServers.html(
          'Upload',
          `<script>
(async () => {
  const form = new FormData();
  form.append('title', 'Vacation');
  form.append('album', '7');
  form.append('photo', new File([new Uint8Array(32)], 'p.jpg', { type: 'image/jpeg' }));
  await fetch('/api/upload', { method: 'POST', body: form });
  document.title = 'done';
})();
</script>`,
        ),
      ),
    '/api/upload': (_req, res) => PageServers.send(res, 201, 'application/json', '{"id":1}'),
    '/up-form': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Done', 'done')),
    '/stream': (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      let n = 0;
      const timer = setInterval(() => {
        n++;
        res.write(`data: chunk ${n}\n\n`);
        if (n === 8) {
          clearInterval(timer);
          res.end('data: [DONE]\n\n');
        }
      }, 100);
    },
    '/blob-page': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Blob', 'blob')),
    '/export.csv': (_req, res) => PageServers.send(res, 200, 'text/csv', CSV, { 'content-disposition': 'attachment; filename="export.csv"' }),
    '/cached': (_req, res) => PageServers.send(res, 200, 'application/json', '{"cached":true}', { 'cache-control': 'max-age=3600' }),
    '/one': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('One', '<script>fetch("/cached")</script>')),
    '/two': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Two', '<script>fetch("/cached").then(() => { document.title = "done"; })</script>')),
    '/big': (_req, res) => PageServers.send(res, 200, 'application/octet-stream', Buffer.alloc(3000, 7)),
    '/framed': (_req, res) =>
      PageServers.send(
        res,
        200,
        'text/html',
        PageServers.html('Framed', `<iframe src="http://localhost:${server.port}/frame-doc"></iframe><script>addEventListener('message', () => { document.title = 'done'; });</script>`),
      ),
    '/frame-doc': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Frame', '<p>inside</p><script>fetch("/frame-api").then((r) => r.json()).then(() => parent.postMessage("done", "*"));</script>')),
    '/frame-api': (_req, res) => PageServers.send(res, 200, 'application/json', '{"framed":true}'),
    '/worker-page': (_req, res) =>
      PageServers.send(
        res,
        200,
        'text/html',
        PageServers.html('Worker', `<script>window.worker = new Worker('/worker.js'); worker.onmessage = (event) => { document.title = event.data; };</script>`),
      ),
    '/worker.js': (_req, res) =>
      PageServers.send(res, 200, 'application/javascript', `onmessage = () => { fetch('/worker-api').then((r) => r.text()).then(() => postMessage('done')); }; postMessage('started');`),
    '/worker-api': (_req, res) => PageServers.send(res, 200, 'application/json', '{"fromWorker":true}'),
    '/worker-early-page': (_req, res) =>
      PageServers.send(res, 200, 'text/html', PageServers.html('Worker', `<script>const worker = new Worker('/worker-early.js'); worker.onmessage = () => { document.title = 'done'; };</script>`)),
    '/worker-early.js': (_req, res) => PageServers.send(res, 200, 'application/javascript', `fetch('/worker-early-api').then((r) => r.text()).then((text) => postMessage(text));`),
    '/worker-early-api': (_req, res) => PageServers.send(res, 200, 'application/json', '{"fromWorker":true}', { 'content-length': '19' }),
    '/short-page': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Short', '<img src="/short.gif"><script>fetch("/head-only", { method: "HEAD" })</script>')),
    '/short.gif': (_req, res) => {
      res.writeHead(200, { 'content-type': 'image/gif', 'content-length': String(GIF.length + 1) });
      res.end(GIF);
    },
    '/head-only': (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': '13' });
      res.end();
    },
  });
});

after(async () => {
  await browser?.close();
  await server?.close();
  await rm(dir, { recursive: true, force: true });
});

async function record(options: TrafficRecorderOptions, fn: (context: BrowserContext, recorder: TrafficRecorder) => Promise<void>): Promise<Exchange[]> {
  const context = await browser.newContext();
  try {
    const recorder = new TrafficRecorder(options);
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

function received(path: string): Buffer {
  const hits = server.requests.filter((r) => r.path === path);
  assert.ok(hits.length > 0, `server received ${path}`);
  return hits[hits.length - 1]!.body;
}

describe('TrafficRecorder request bodies that hold a Blob or File', () => {
  test('keeps the exact bytes of FormData with a file part, Blob bodies and sendBeacon', async () => {
    const exchanges = await record({}, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/'));
      await page.evaluate(async (bytes) => {
        const all = new Uint8Array(bytes);
        const form = new FormData();
        form.append('note', 'hello');
        form.append('file', new Blob([all], { type: 'application/octet-stream' }), 'all.bin');
        await fetch('/up-multipart', { method: 'POST', body: form });
        await fetch('/up-blob', { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([all]) });
        await fetch('/up-utf8', { method: 'POST', headers: { 'content-type': 'text/plain;charset=UTF-8' }, body: new Blob([new Uint8Array([0x63, 0x61, 0x66, 0xc3, 0xa9])]) });
        await fetch('/up-latin1', { method: 'POST', headers: { 'content-type': 'text/plain;charset=windows-1252' }, body: new Blob([new Uint8Array([0x63, 0x61, 0x66, 0xe9])]) });
        navigator.sendBeacon('/up-beacon', new Blob(['{"event":"view"}'], { type: 'text/plain' }));
      }, [...ALL_BYTES]);
      await page.waitForTimeout(300);
    });
    for (const path of ['/up-multipart', '/up-blob', '/up-utf8', '/up-latin1', '/up-beacon']) {
      const body = only(exchanges, 'POST', path).request.body;
      assert.ok(body, `${path} has a body`);
      assert.equal(body.truncated, undefined, `${path} is complete`);
      assert.equal(Buffer.from(Http.bodyBytes(body)).toString('hex'), received(path).toString('hex'), `${path} bytes`);
      assert.equal(body.size, received(path).length);
    }
    assert.equal(Http.bodyText(only(exchanges, 'POST', '/up-utf8').request.body), 'caf\u00e9');
  });

  test('keeps the text fields of a native multipart form submit and marks the body incomplete when the browser omits file contents', async () => {
    const file = join(dir, 'photo.bin');
    await writeFile(file, Buffer.from('PHOTO-BYTES'));
    const exchanges = await record({}, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/'));
      await page.setInputFiles('input[type=file]', file);
      await Promise.all([page.waitForURL('**/up-form'), page.click('button')]);
    });
    const exchange = only(exchanges, 'POST', '/up-form');
    const body = exchange.request.body;
    assert.ok(body, 'the request body is recorded');
    assert.equal(body.size, received('/up-form').length);
    assert.equal(body.size, Number(Http.getHeader(exchange.request.headers, 'content-length')));
    const text = Http.bodyText(body);
    assert.match(text, /name="title"\r\n\r\nHoliday\r\n/);
    assert.match(text, /name="photo"; filename="photo.bin"/);
    assert.equal(body.truncated, true);
    assert.ok(Http.bodyBytes(body).length < body.size);
  });

  test('converts CDP post data strings back to the exact bytes', () => {
    assert.deepEqual([...PageNetworkTap.bytes('caf\u00e9', 5)!], [0x63, 0x61, 0x66, 0xc3, 0xa9]);
    assert.deepEqual([...PageNetworkTap.bytes('caf\u00e9', 4)!], [0x63, 0x61, 0x66, 0xe9]);
    assert.equal(PageNetworkTap.bytes('caf\u00e9', undefined), undefined);
    assert.deepEqual([...PageNetworkTap.bytes('\u20ac', undefined)!], [0xe2, 0x82, 0xac]);
    assert.deepEqual([...PageNetworkTap.bytes('\u00c3\u00a9', undefined)!], [0xc3, 0x83, 0xc2, 0xa9]);
    assert.deepEqual([...PageNetworkTap.bytes('ok', undefined)!], [0x6f, 0x6b]);
    assert.deepEqual([...PageNetworkTap.bytes(ALL_BYTES.toString('latin1'), 256)!], [...ALL_BYTES]);
  });
});

describe('TrafficRecorder response bodies and special responses', () => {
  test('keeps a streamed response body that takes longer than the read timeout', async () => {
    const exchanges = await record({ readTimeoutMs: 300 }, async (context) => {
      const page = await context.newPage();
      await page.goto(server.url('/blob-page'));
      const text = await page.evaluate(() => fetch('/stream', { method: 'POST', body: '{}' }).then((r) => r.text()));
      assert.match(text, /\[DONE\]/);
    });
    const stream = only(exchanges, 'POST', '/stream');
    assert.equal(stream.error, undefined);
    assert.match(Http.bodyText(stream.response?.body), /data: chunk 8\n\ndata: \[DONE\]\n\n$/);
    assert.equal(stream.response?.body?.truncated, undefined);
  });

  test('records no exchange for blob: URLs, which are not network traffic', async () => {
    const exchanges = await record({}, async (context) => {
      const page = await context.newPage();
      await page.goto(server.url('/blob-page'));
      await page.evaluate(async () => {
        const url = URL.createObjectURL(new Blob(['blobdata'], { type: 'text/plain' }));
        await fetch(url).then((r) => r.text());
      });
    });
    assert.deepEqual(
      exchanges.map((e) => new URL(e.request.url).protocol),
      ['http:'],
    );
  });

  test('records a download as a finished exchange with its body', async () => {
    const exchanges = await record({}, async (context) => {
      const page = await context.newPage();
      await page.goto(server.url('/'));
      const [download] = await Promise.all([page.waitForEvent('download'), page.click('#export')]);
      assert.equal(await download.failure(), null);
    });
    const csv = only(exchanges, 'GET', '/export.csv');
    assert.equal(csv.error, undefined);
    assert.equal(csv.response?.status, 200);
    assert.equal(Http.bodyText(csv.response?.body), CSV);
  });

  test('reports no remote address for a response served from the HTTP cache', async () => {
    const exchanges = await record({}, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/one'));
      await page.waitForLoadState('networkidle');
      await page.goto(server.url('/two'));
      await page.waitForFunction(() => document.title === 'done');
    });
    const cached = exchanges.filter((e) => new URL(e.request.url).pathname === '/cached');
    assert.equal(cached.length, 2);
    assert.equal(server.requests.filter((r) => r.path === '/cached').length, 1, 'the second load never reached the server');
    assert.match(cached[0]!.response?.remoteAddress ?? '', /^127\.0\.0\.1:\d+$/);
    assert.equal(cached[1]!.response?.remoteAddress, undefined);
    assert.deepEqual(Http.bodyJson(cached[1]!.response?.body), { cached: true });
    assert.equal(cached[0]!.servedBy, undefined);
    assert.equal(cached[1]!.servedBy, 'cache');
    assert.ok(cached[1]!.cacheKind === 'memory' || cached[1]!.cacheKind === 'disk', String(cached[1]!.cacheKind));
  });

  test('reads response bodies without sending a request that the page did not make (PW-REFETCH)', async () => {
    const exchanges = await record({}, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/short-page'));
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(500);
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(server.requests.filter((r) => r.path === '/short.gif').length, 1, 'the browser loaded the image once');
    assert.deepEqual(
      server.requests.filter((r) => r.path === '/head-only').map((r) => r.method),
      ['HEAD'],
    );
    const image = only(exchanges, 'GET', '/short.gif');
    assert.equal(image.response?.status, 200);
    assert.equal(image.error, 'net::ERR_CONTENT_LENGTH_MISMATCH');
    assert.equal(only(exchanges, 'HEAD', '/head-only').response?.body, undefined);
  });

  test('reads the bodies of out-of-process iframes through their own sessions', async () => {
    const isolated = await chromium.launch({ headless: true, args: ['--site-per-process'] });
    const context = await isolated.newContext();
    try {
      const recorder = new TrafficRecorder();
      recorder.attach(context);
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/framed'));
      await page.waitForFunction(() => document.title === 'done');
      await recorder.settled();
      recorder.detach();
      await recorder.settled();
      const exchanges = recorder.exchanges;
      assert.match(Http.bodyText(only(exchanges, 'GET', '/frame-doc').response?.body), /<p>inside<\/p>/);
      assert.deepEqual(Http.bodyJson(only(exchanges, 'GET', '/frame-api').response?.body), { framed: true });
      assert.equal(server.requests.filter((r) => r.path === '/frame-doc').length, 1);
      assert.equal(server.requests.filter((r) => r.path === '/frame-api').length, 1);
    } finally {
      await context.close();
      await isolated.close();
    }
  });

  test('reads the bodies of requests that a dedicated worker makes through the worker session', async () => {
    const exchanges = await record({}, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/worker-page'));
      await page.waitForFunction(() => document.title === 'started');
      let targets = await recorder.ready();
      for (let attempt = 0; attempt < 200 && !targets.some((target) => target.type === 'worker'); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        targets = await recorder.ready();
      }
      assert.ok(targets.some((target) => target.type === 'worker' && target.url.endsWith('/worker.js')));
      await page.evaluate(() => (window as unknown as { worker: Worker }).worker.postMessage('go'));
      await page.waitForFunction(() => document.title === 'done');
    });
    assert.deepEqual(Http.bodyJson(only(exchanges, 'GET', '/worker-api').response?.body), { fromWorker: true });
    assert.equal(server.requests.filter((r) => r.path === '/worker-api').length, 1);
  });

  test('records a request from the first moments of a dedicated worker once, with its body or an incomplete marker', async () => {
    const exchanges = await record({}, async (context, recorder) => {
      const page = await context.newPage();
      await recorder.prepare(page);
      await page.goto(server.url('/worker-early-page'));
      await page.waitForFunction(() => document.title === 'done');
      const started = Date.now();
      await recorder.settled();
      assert.ok(Date.now() - started < TrafficRecorder.READ_TIMEOUT_MS / 2, 'a body that never reaches the session does not hold the recorder');
    });
    const body = only(exchanges, 'GET', '/worker-early-api').response?.body;
    assert.equal(server.requests.filter((r) => r.path === '/worker-early-api').length, 1);
    assert.ok(body, 'the response keeps its body or an incomplete marker');
    if (body.truncated) assert.equal(body.size, '{"fromWorker":true}'.length);
    else assert.deepEqual(Http.bodyJson(body), { fromWorker: true });
  });

  test('keeps response bodies readable after the page navigates to other documents', async () => {
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const tap = await PageNetworkTap.open(context, page);
      assert.ok(tap);
      await page.goto(server.url('/blob-page'));
      const url = server.url('/big?kept');
      await page.evaluate((target) => fetch(target).then((r) => r.arrayBuffer()), url);
      await page.goto(server.url('/blob-page?second'));
      await page.goto(server.url('/one'));
      const record = tap.claim('GET', url, 0);
      assert.ok(record);
      assert.equal(record.state, 'finished');
      assert.equal(record.dataLength, 3000);
      const body = await tap.responseBody(record);
      assert.equal(body?.length, 3000);
      await tap.close();
    } finally {
      await context.close();
    }
  });

  test('keeps bodies within a total budget and marks the rest as incomplete with their real size', async () => {
    const exchanges = await record({ maxTotalBodyBytes: 4000 }, async (context) => {
      const page = await context.newPage();
      await page.goto(server.url('/blob-page'));
      await page.evaluate(async () => {
        await fetch('/big').then((r) => r.arrayBuffer());
        await fetch('/big?second').then((r) => r.arrayBuffer());
      });
    });
    const bigs = exchanges.filter((e) => new URL(e.request.url).pathname === '/big');
    assert.equal(bigs.length, 2);
    assert.equal(Http.bodyBytes(bigs[0]!.response?.body).length, 3000);
    const over = bigs[1]!.response?.body;
    assert.ok(over);
    assert.equal(over.truncated, true);
    assert.equal(over.data, '');
    assert.equal(over.size, 3000);
  });
});

describe('CaptureSession special navigations', () => {
  test('an upload made with FormData and a File reaches the model with every field', async () => {
    const capture = await CaptureSession.create({
      url: server.url('/upload-page'),
      headless: true,
      idleMs: 100,
      script: async (page) => {
        await page.waitForFunction(() => document.title === 'done');
      },
    }).run();
    const upload = capture.exchanges.find((e) => new URL(e.request.url).pathname === '/api/upload');
    assert.ok(upload?.request.body, 'the upload body is recorded');
    assert.equal(Buffer.from(Http.bodyBytes(upload.request.body)).toString('hex'), received('/api/upload').toString('hex'));
    const model = ModelBuilder.create({}).build(capture);
    const endpoint = model.endpoints.find((e) => e.method === 'POST' && e.path === '/api/upload');
    assert.ok(endpoint?.requestBody, 'the endpoint has a request body');
    assert.deepEqual(Object.keys((endpoint.requestBody.schema?.properties ?? {}) as Record<string, unknown>).sort(), ['album', 'photo', 'title']);
  });

  test('a headless capture whose start URL is a download completes and keeps the file', async () => {
    const capture = await CaptureSession.create({ url: server.url('/export.csv'), headless: true, idleMs: 100 }).run();
    const csv = capture.exchanges.find((e) => new URL(e.request.url).pathname === '/export.csv');
    assert.ok(csv);
    assert.equal(csv.error, undefined);
    assert.equal(Http.bodyText(csv.response?.body), CSV);
  });
});
