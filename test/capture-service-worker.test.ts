import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSession, HarConverter } from '../src/capture/index.js';
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

  test('keeps the marks through a HAR file', () => {
    const converter = HarConverter.create();
    const back = converter.fromHar(converter.toHar(capture));
    const synth = back.exchanges.find((e) => new URL(e.request.url).pathname === '/api/synth');
    assert.equal(synth?.servedBy, 'service-worker');
  });
});
