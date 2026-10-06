import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelBuilder } from '../src/build/index.js';
import { CaptureSession } from '../src/capture/index.js';
import type { Capture } from '../src/model/index.js';

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Wiki</title></head><body>${body}</body></html>`;
}

describe('--no-documents keeps navigations that a form produced (WIKI-4)', () => {
  let server: Server;
  let origin = '';
  let capture: Capture;

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/search') {
        res.writeHead(302, { location: `/results/${encodeURIComponent(url.searchParams.get('search') ?? '')}` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (url.pathname.startsWith('/results/')) res.end(page('<h1>Results</h1><a href="/">Home</a>'));
      else res.end(page('<form id="searchform" action="/search" method="get"><input name="search"><input type="hidden" name="title" value="Special:Search"><button>Search</button></form>'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    capture = await CaptureSession.create({
      url: `${origin}/`,
      headless: true,
      idleMs: 300,
      script: async (page) => {
        await page.fill('input[name=search]', 'Ada Lovelace');
        await Promise.all([page.waitForURL(/\/results\//), page.click('button')]);
        await page.goto(`${origin}/`, { waitUntil: 'load' });
      },
    }).run();
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  test('the submitted search keeps its hit and its 302, and plain page loads are left out', () => {
    const model = ModelBuilder.create({ now: new Date(0), includeDocuments: false }).build(capture);
    const search = model.endpoints.find((endpoint) => endpoint.method === 'GET' && endpoint.path === '/search');
    assert.ok(search, model.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).join(', '));
    assert.equal(search.count, 1);
    assert.deepEqual(search.responses.map((response) => response.status), [302]);
    assert.equal(search.kind, 'form');
    assert.match(search.samples[0]?.url ?? '', /\/search\?search=Ada\+Lovelace&title=Special%3ASearch$/);
    assert.ok(!model.endpoints.some((endpoint) => endpoint.path === '/' || endpoint.path.startsWith('/results')), model.endpoints.map((endpoint) => endpoint.path).join(', '));
  });
});
