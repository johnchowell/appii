import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { TrafficRecorder } from '../src/capture/index.js';
import type { Exchange } from '../src/model/index.js';
import { PageServers } from './fixtures/capture-pages.js';
import type { PageServer } from './fixtures/capture-pages.js';

const STATIC = 12;
const LATE = 12;
const CACHED = { 'cache-control': 'public, max-age=31536000' };
const svg = (name: string): string => `<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>${name}</text>${'<!-- pad -->'.repeat(200)}</svg>`;

const PAGE = PageServers.html(
  'Cache',
  `${Array.from({ length: STATIC }, (_, i) => `<img src="/i${i}.svg"><script type="module" src="/m${i}.js"></script>`).join('')}
<script>
addEventListener('load', () => {
  for (let i = 0; i < ${LATE}; i++) {
    import('/d' + i + '.js');
    const image = new Image();
    image.src = '/l' + i + '.svg';
    document.body.append(image);
  }
});
</script>`,
);

let browser: Browser;
let server: PageServer;

before(async () => {
  const routes: Parameters<typeof PageServers.start>[0] = {};
  for (const path of ['/p0', '/p1', '/p2', '/p3']) routes[path] = (_req, res) => PageServers.send(res, 200, 'text/html; charset=utf-8', PAGE, { 'cache-control': 'no-store' });
  for (let i = 0; i < Math.max(STATIC, LATE); i++) {
    routes[`/i${i}.svg`] = (_req, res) => PageServers.send(res, 200, 'image/svg+xml', svg(`i${i}`), CACHED);
    routes[`/l${i}.svg`] = (_req, res) => PageServers.send(res, 200, 'image/svg+xml', svg(`l${i}`), CACHED);
    routes[`/m${i}.js`] = (_req, res) => PageServers.send(res, 200, 'application/javascript', `export const m${i} = ${i};${'//pad\n'.repeat(300)}`, CACHED);
    routes[`/d${i}.js`] = (_req, res) => PageServers.send(res, 200, 'application/javascript', `export const d${i} = ${i};${'//pad\n'.repeat(500)}`, CACHED);
  }
  server = await PageServers.start(routes);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

describe('TrafficRecorder and the memory cache', () => {
  test('labels every memory-cache hit of a reload as served from the cache, with its body and no server address (SPA-6)', async () => {
    const context = await browser.newContext();
    const urls = new Map<string, string>();
    const memoryHits: string[] = [];
    let exchanges: Exchange[];
    try {
      const recorder = TrafficRecorder.create();
      recorder.attach(context);
      const page = await context.newPage();
      await recorder.prepare(page);
      const oracle = await context.newCDPSession(page);
      oracle.on('Network.requestWillBeSent', (event) => urls.set(event.requestId, event.request.url));
      oracle.on('Network.requestServedFromCache', (event) => memoryHits.push(urls.get(event.requestId) ?? ''));
      await oracle.send('Network.enable');
      for (const path of ['/p0', '/p1', '/p2', '/p3']) {
        await page.goto(server.url(path), { waitUntil: 'load' });
        await page.waitForTimeout(400);
      }
      await recorder.settled();
      recorder.detach();
      await recorder.settled();
      exchanges = recorder.exchanges;
    } finally {
      await context.close();
    }
    const late = memoryHits.filter((url) => /\/(d\d+\.js|l\d+\.svg)$/.test(url));
    assert.ok(late.length >= LATE, `the browser served script-initiated loads from the memory cache: ${late.length}`);
    const assets = exchanges.filter((e) => /\/(i|l)\d+\.svg$|\/(m|d)\d+\.js$/.test(new URL(e.request.url).pathname));
    const memory = assets.filter((e) => e.servedBy === 'cache' && e.cacheKind === 'memory');
    const wrong = assets.filter((e) => e.servedBy === undefined && (e.response?.body?.data ?? '') === '');
    assert.deepEqual(
      wrong.map((e) => `${new URL(e.request.url).pathname} ${e.response?.remoteAddress ?? '-'} ${JSON.stringify(e.response?.body)}`),
      [],
      'no memory-cache hit is recorded as a network fetch with an empty body',
    );
    assert.equal(memory.length, memoryHits.filter((url) => assets.some((e) => e.request.url === url)).length);
    for (const exchange of memory) {
      assert.equal(exchange.response?.remoteAddress, undefined, exchange.request.url);
      assert.ok((exchange.response?.body?.data ?? '') !== '', `${exchange.request.url} keeps its body`);
    }
  });
});
