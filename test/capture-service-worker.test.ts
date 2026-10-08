import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSession, HarConverter, ServiceWorkerRecorder, WorkerNetworkSwitch } from '../src/capture/index.js';
import { ModelBuilder } from '../src/build/index.js';
import { Http } from '../src/shared/index.js';
import type { Capture, Exchange } from '../src/model/index.js';
import { PageServers } from './fixtures/capture-pages.js';
import type { PageServer } from './fixtures/capture-pages.js';

const WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  event.waitUntil(fetch('/worker-sync.json').then((r) => r.text()).then((text) => event.source.postMessage(text)));
});
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.pathname === '/api/synth') {
    event.respondWith(new Response('{"synthetic":true}', { headers: { 'content-type': 'application/json' } }));
  } else if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(event.request));
  }
});
`;

const EARLY_WORKER = `
const top = fetch('/api/early-top').then((r) => r.text());
self.addEventListener('install', (event) => {
  event.waitUntil(Promise.all([top, fetch('/api/early-install').then((r) => r.text())]));
  self.skipWaiting();
});
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('message', (event) => {
  event.waitUntil(
    fetch('/api/early-redirect')
      .then((r) => r.text())
      .then(() => fetch('/api/early-broken').catch(() => 'failed'))
      .then(() => event.source.postMessage('done')),
  );
});
`;

const EARLY_PAGE = `<script>
(async () => {
  await navigator.serviceWorker.register('/early-sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) await new Promise((resolve) => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
  await new Promise((resolve) => { navigator.serviceWorker.addEventListener('message', resolve, { once: true }); navigator.serviceWorker.controller.postMessage('go'); });
  document.title = 'done';
})();
</script>`;

const UPLOAD_BYTES = 100000;
const VARIABLE_BEFORE = process.env[WorkerNetworkSwitch.VARIABLE];

let server: PageServer;

before(async () => {
  server = await PageServers.start({
    '/': (_req, res) =>
      PageServers.send(
        res,
        200,
        'text/html',
        PageServers.html('Worker', `<script>navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => { document.title = 'ready'; });</script>`),
        { 'set-cookie': 'sid=abc; Path=/' },
      ),
    '/sw.js': (_req, res) => PageServers.send(res, 200, 'application/javascript', WORKER),
    '/worker-sync.json': (_req, res) => PageServers.send(res, 200, 'application/json', '{"synced":true}'),
    '/api/pass': (_req, res, body) => PageServers.send(res, 200, 'application/json', JSON.stringify({ got: body.toString('utf8') })),
    '/api/cached': (_req, res) => PageServers.send(res, 200, 'application/json', '{"cached":true}', { 'cache-control': 'max-age=600' }),
    '/api/upload': (_req, res, body) => PageServers.send(res, 200, 'application/json', JSON.stringify({ length: body.length })),
    '/early': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Early', EARLY_PAGE)),
    '/early-sw.js': (_req, res) => PageServers.send(res, 200, 'application/javascript', EARLY_WORKER),
    '/api/early-top': (_req, res) => PageServers.send(res, 200, 'application/json', '{"top":true}'),
    '/api/early-install': (_req, res) => PageServers.send(res, 200, 'application/json', '{"install":true}'),
    '/api/early-redirect': (_req, res) => PageServers.send(res, 302, 'text/plain', '', { location: '/api/early-target' }),
    '/api/early-target': (_req, res) => PageServers.send(res, 200, 'application/json', '{"target":true}'),
    '/api/early-broken': (req) => {
      req.socket.destroy();
    },
  });
});

after(async () => {
  await server?.close();
});

function hits(path: string): number {
  return server.requests.filter((r) => r.path.split('?')[0] === path).length;
}

function all(capture: Capture, method: string, path: string): Exchange[] {
  return capture.exchanges.filter((e) => e.request.method === method && new URL(e.request.url).pathname === path);
}

describe('pages controlled by a service worker (CAP-5)', () => {
  let capture: Capture;

  before(async () => {
    capture = await CaptureSession.create({
      url: server.url('/'),
      headless: true,
      idleMs: 300,
      script: async (page) => {
        await page.waitForFunction(() => document.title === 'ready');
        await page.reload();
        await page.evaluate(async () => {
          await fetch('/api/pass?x=1', { method: 'POST', body: 'hello' }).then((r) => r.text());
          await fetch('/api/synth').then((r) => r.text());
          await fetch('/api/cached').then((r) => r.text());
          await fetch('/api/cached').then((r) => r.text());
          await fetch('/api/upload', { method: 'POST', body: new Blob(['u'.repeat(100000)], { type: 'application/octet-stream' }) }).then((r) => r.text());
          await new Promise<void>((resolve) => {
            navigator.serviceWorker.addEventListener('message', () => resolve(), { once: true });
            navigator.serviceWorker.controller?.postMessage('sync');
          });
        });
      },
    }).run();
  });

  test('records a request that the worker passes to the network once, with the real headers and the page URL', () => {
    const pass = all(capture, 'POST', '/api/pass');
    assert.equal(pass.length, 1);
    assert.equal(hits('/api/pass'), 1);
    const exchange = pass[0]!;
    assert.equal(Http.getHeader(exchange.request.headers, 'cookie'), 'sid=abc');
    assert.equal(exchange.pageUrl, server.url('/'));
    assert.equal(exchange.resourceType, 'fetch');
    assert.equal(exchange.servedBy, undefined);
    assert.equal(Http.bodyText(exchange.request.body), 'hello');
    assert.deepEqual(Http.bodyJson(exchange.response?.body), { got: 'hello' });
    assert.match(exchange.response?.remoteAddress ?? '', /^127\.0\.0\.1:\d+$/);
  });

  test('records the requests that the worker makes itself', () => {
    const sync = all(capture, 'GET', '/worker-sync.json');
    assert.equal(sync.length, 1);
    assert.equal(hits('/worker-sync.json'), 1);
    assert.equal(Http.getHeader(sync[0]!.request.headers, 'cookie'), 'sid=abc');
    assert.equal(sync[0]!.pageUrl, undefined);
    assert.equal(sync[0]!.servedBy, undefined);
    assert.deepEqual(Http.bodyJson(sync[0]!.response?.body), { synced: true });
  });

  test('marks a response that the worker made and keeps it out of the server endpoints', () => {
    const synth = all(capture, 'GET', '/api/synth');
    assert.equal(synth.length, 1);
    assert.equal(hits('/api/synth'), 0);
    assert.equal(synth[0]!.servedBy, 'service-worker');
    assert.equal(synth[0]!.response?.remoteAddress, undefined);
    const model = ModelBuilder.create({}).build(capture);
    const paths = model.endpoints.map((e) => `${e.method} ${e.path}`);
    assert.ok(!paths.includes('GET /api/synth'), paths.join(', '));
    const pass = model.endpoints.find((e) => e.method === 'POST' && e.path === '/api/pass');
    assert.equal(pass?.count, 1);
    assert.deepEqual(pass?.auth.cookies, ['sid']);
    assert.ok(paths.includes('GET /worker-sync.json'));
  });

  test('marks a request that the worker passes on and the HTTP cache answers as a cache answer, without a server address', () => {
    const cached = all(capture, 'GET', '/api/cached');
    assert.equal(hits('/api/cached'), 1);
    assert.equal(cached.length, 2);
    assert.equal(cached[0]!.servedBy, undefined);
    assert.match(cached[0]!.response?.remoteAddress ?? '', /^127\.0\.0\.1:\d+$/);
    assert.equal(cached[1]!.servedBy, 'cache');
    assert.equal(cached[1]!.cacheKind, 'disk');
    assert.equal(cached[1]!.response?.remoteAddress, undefined);
    assert.ok(cached.every((e) => e.pageUrl === server.url('/')));
  });

  test('keeps the bytes of a Blob body that the worker passes to the network', () => {
    const upload = all(capture, 'POST', '/api/upload');
    assert.equal(upload.length, 1);
    assert.equal(hits('/api/upload'), 1);
    assert.equal(upload[0]!.request.body?.truncated, undefined);
    assert.equal(Http.bodyText(upload[0]!.request.body), 'u'.repeat(UPLOAD_BYTES));
    assert.deepEqual(Http.bodyJson(upload[0]!.response?.body), { length: UPLOAD_BYTES });
  });

  test('restores the Playwright service worker switch when the capture ends', () => {
    assert.equal(process.env[WorkerNetworkSwitch.VARIABLE], VARIABLE_BEFORE);
    assert.equal(WorkerNetworkSwitch.shared.holders, 0);
  });

  test('keeps the marks through a HAR file', () => {
    const converter = HarConverter.create();
    const back = converter.fromHar(converter.toHar(capture));
    const synth = back.exchanges.find((e) => new URL(e.request.url).pathname === '/api/synth');
    assert.equal(synth?.servedBy, 'service-worker');
  });
});

describe('requests from the first moments of a service worker (CAP-5, CAP-18)', () => {
  let capture: Capture;

  before(async () => {
    capture = await CaptureSession.create({
      url: server.url('/early'),
      headless: true,
      idleMs: 200,
      script: async (page) => {
        await page.waitForFunction(() => document.title === 'done');
      },
    }).run();
  });

  function pageAgent(): string {
    const page = server.requests.filter((r) => r.path === '/early');
    assert.ok(page.length > 0);
    return String(page[page.length - 1]!.headers['user-agent']);
  }

  function workerRequest(path: string, body: unknown): void {
    const found = all(capture, 'GET', path);
    assert.equal(found.length, 1, `${path} is recorded once`);
    assert.equal(hits(path), 1);
    const exchange = found[0]!;
    assert.equal(exchange.servedBy, undefined);
    assert.equal(exchange.pageUrl, undefined);
    assert.equal(exchange.resourceType, 'fetch');
    assert.equal(exchange.error, undefined);
    assert.equal(exchange.response?.status, 200);
    assert.deepEqual(Http.bodyJson(exchange.response?.body), body);
    assert.match(exchange.response?.remoteAddress ?? '', /^127\.0\.0\.1:\d+$/);
    const agent = pageAgent();
    assert.doesNotMatch(agent, /HeadlessChrome/);
    const sent = server.requests.find((r) => r.path === path)!;
    assert.equal(String(sent.headers['user-agent']), agent, 'the worker sends the user agent of the page');
    assert.doesNotMatch(String(sent.headers['sec-ch-ua'] ?? ''), /HeadlessChrome/);
    assert.equal(Http.getHeader(exchange.request.headers, 'user-agent'), agent);
  }

  test('records the fetch that the worker script makes as it starts once, as a network request with the headed identity', () => {
    workerRequest('/api/early-top', { top: true });
  });

  test('records the fetch that the worker makes during install once, as a network request with the headed identity', () => {
    workerRequest('/api/early-install', { install: true });
  });

  test('records the main script of the worker once, with its body', () => {
    const script = all(capture, 'GET', '/early-sw.js');
    assert.equal(script.length, 1);
    assert.equal(script[0]!.resourceType, 'script');
    assert.equal(script[0]!.pageUrl, undefined);
    assert.equal(script[0]!.servedBy, undefined);
    assert.equal(Http.bodyText(script[0]!.response?.body), EARLY_WORKER);
  });

  test('keeps the redirect chain and the failure of requests that the worker makes', () => {
    const redirect = all(capture, 'GET', '/api/early-redirect');
    const target = all(capture, 'GET', '/api/early-target');
    assert.equal(redirect.length, 1);
    assert.equal(target.length, 1);
    assert.equal(redirect[0]!.response?.status, 302);
    assert.equal(target[0]!.redirectedFrom, redirect[0]!.id);
    assert.deepEqual(Http.bodyJson(target[0]!.response?.body), { target: true });
    const broken = all(capture, 'GET', '/api/early-broken');
    assert.equal(broken.length, 1);
    assert.equal(broken[0]!.response, undefined);
    assert.match(broken[0]!.error ?? '', /ERR_/);
    assert.equal(broken[0]!.pageUrl, undefined);
  });
});

describe('WorkerNetworkSwitch', () => {
  test('sets the Playwright switch while it is held and restores the value it found when the last holder lets go', () => {
    const env: NodeJS.ProcessEnv = {};
    const flag = new WorkerNetworkSwitch(env);
    const first = flag.hold();
    assert.equal(env[WorkerNetworkSwitch.VARIABLE], WorkerNetworkSwitch.ON);
    const second = flag.hold();
    first();
    first();
    assert.equal(flag.holders, 1);
    assert.equal(env[WorkerNetworkSwitch.VARIABLE], WorkerNetworkSwitch.ON, 'a second capture in the same process still needs it');
    second();
    assert.equal(flag.holders, 0);
    assert.equal(Object.hasOwn(env, WorkerNetworkSwitch.VARIABLE), false);
    env[WorkerNetworkSwitch.VARIABLE] = '';
    const third = flag.hold();
    assert.equal(env[WorkerNetworkSwitch.VARIABLE], WorkerNetworkSwitch.ON);
    third();
    assert.equal(env[WorkerNetworkSwitch.VARIABLE], '');
  });
});

describe('ServiceWorkerRecorder', () => {
  function exchange(id: string, url: string, redirectedFrom?: string): Exchange {
    return { id, source: 'browser', resourceType: 'fetch', startedAt: new Date(1000).toISOString(), durationMs: 1, request: { method: 'GET', url, headers: [] }, ...(redirectedFrom ? { redirectedFrom } : {}) };
  }

  test('holds a worker exchange while the page has a request to the same URL, hands it to the page that claims it, and emits every other one once', async () => {
    const emitted: Exchange[] = [];
    let pageBusy = true;
    const workers = ServiceWorkerRecorder.create({ emit: (e) => emitted.push(e), hasPageRequest: () => pageBusy });
    const passed = workers.track('GET', 'http://a.test/x', 1000);
    const waited = workers.claim('GET', 'http://a.test/x#part', 900, 1100);
    assert.equal(waited, passed, 'the page claims the worker request before it has finished');
    workers.settle(passed, exchange('w1', 'http://a.test/x'));
    assert.equal((await waited!.done)?.id, 'w1');
    workers.alias('w1', 'p1');
    const next = workers.track('GET', 'http://a.test/y', 1000);
    workers.settle(next, exchange('w2', 'http://a.test/y', 'w1'));
    assert.equal(emitted.length, 0, 'held while the page has a matching request');
    pageBusy = false;
    workers.release();
    workers.release();
    assert.deepEqual(
      emitted.map((e) => [e.id, e.redirectedFrom]),
      [['w2', 'p1']],
    );
    pageBusy = true;
    const late = workers.track('GET', 'http://a.test/z', 1000);
    workers.settle(late, exchange('w3', 'http://a.test/z'));
    workers.settle(late, exchange('w4', 'http://a.test/z'));
    workers.flush();
    assert.deepEqual(
      emitted.map((e) => e.id),
      ['w2', 'w3'],
    );
    assert.equal(workers.claim('GET', 'http://a.test/z', 900, 1100), undefined);
    const empty = workers.track('GET', 'http://a.test/e', 1000);
    workers.settle(empty, undefined);
    assert.equal(await empty.done, undefined);
    workers.flush();
    assert.equal(emitted.length, 2);
  });
});
