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

describe('--no-documents never turns a page form that was not submitted into an endpoint (WIKI-R1)', () => {
  const search = '<form id="searchform" action="/w/index.php" method="get"><input name="search"><input type="hidden" name="title" value="Special:Search"><button id="go">Search</button></form>';
  const bannerHtml =
    '<form id="frb-form"><input type="radio" name="amount" value="2.75"><input type="radio" name="amount" value="15"><input type="text" name="otherAmount"><input type="radio" name="frequency" value="onetime" checked><button id="frb-first">Continue</button><button id="frb-yes">Donate monthly</button></form>';
  const inject = `<div id="banner"></div><script>setTimeout(() => { document.getElementById('banner').innerHTML = ${JSON.stringify(bannerHtml)}; for (const b of document.querySelectorAll('#frb-form button')) b.addEventListener('click', (e) => e.preventDefault()); }, 30);</script>`;
  const selfBanner = '<form id="self-banner" method="get" action="/wiki/Main_Page"><input type="radio" name="gift" value="5" checked><input type="text" name="otherGift"><button name="pay" value="card">Card</button></form>';
  const unvisited = '<form id="finder" method="get" action="/find"><input name="q"><button>Find</button></form>';
  const login =
    '<form id="login"><input name="email" type="email"><input name="password" type="password"><button id="signin">Sign in</button></form><script>document.getElementById(\'login\').addEventListener(\'submit\', async (e) => { e.preventDefault(); await fetch(\'/api/login\', { method: \'POST\', headers: { \'content-type\': \'application/json\' }, body: JSON.stringify({ email: document.querySelector(\'[name=email]\').value, password: document.querySelector(\'[name=password]\').value }) }); });</script>';
  const seen: string[] = [];
  let server: Server;
  let origin = '';
  let capture: Capture;

  before(async () => {
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname === '/w/index.php') {
        res.writeHead(302, { location: `/wiki/${(url.searchParams.get('search') ?? '').replace(/ /g, '_')}` });
        res.end();
        return;
      }
      if (url.pathname === '/api/login') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      if (url.pathname === '/login') res.end(page(login));
      else if (url.pathname === '/wiki/Main_Page') res.end(page(search + inject + selfBanner + unvisited + '<a href="/login">Log in</a>'));
      else res.end(page(search + inject + '<a href="/login">Log in</a>'));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    capture = await CaptureSession.create({
      url: `${origin}/wiki/Main_Page`,
      headless: true,
      idleMs: 300,
      script: async (page) => {
        await page.waitForSelector('#frb-form');
        await page.fill('input[name=search]', 'Alan Turing');
        await Promise.all([page.waitForURL(/Alan_Turing/), page.click('#go')]);
        await page.waitForSelector('#frb-form');
        await page.click('#frb-first');
        await page.goto(`${origin}/login`, { waitUntil: 'load' });
        await page.fill('input[name=email]', 'reader@example.com');
        await page.fill('input[name=password]', 'correct-horse-battery');
        await Promise.all([page.waitForResponse(/\/api\/login/), page.click('#signin')]);
      },
    }).run();
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  const describeAll = (model: ReturnType<ModelBuilder['build']>): string => model.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path} ${endpoint.kind} ${endpoint.count} [${endpoint.queryParams.map((param) => param.name).join(',')}]`).join('; ');

  for (const includeDocuments of [false, true]) {
    test(`includeDocuments ${includeDocuments}: no 0-hit GET endpoint for a page whose form was never submitted`, () => {
      assert.ok(!seen.some((line) => /amount=|gift=|password=/.test(line)), seen.join(' | '));
      const model = ModelBuilder.create({ now: new Date(0), includeDocuments }).build(capture);
      const phantom = model.endpoints.filter((endpoint) => endpoint.method === 'GET' && endpoint.queryParams.some((param) => ['amount', 'otherAmount', 'gift', 'otherGift', 'email', 'password'].includes(param.name)));
      assert.deepEqual(phantom.map((endpoint) => endpoint.path), [], describeAll(model));
      const searchEndpoint = model.endpoints.find((endpoint) => endpoint.method === 'GET' && endpoint.path === '/w/index.php');
      assert.equal(searchEndpoint?.count, 1, describeAll(model));
      assert.deepEqual(searchEndpoint?.responses.map((response) => response.status), [302]);
      const loginApi = model.endpoints.find((endpoint) => endpoint.method === 'POST' && endpoint.path === '/api/login');
      assert.equal(loginApi?.form?.selector, 'form#login', describeAll(model));
      const banner = model.forms.find((form) => form.selector === 'form#frb-form');
      assert.ok(banner, model.forms.map((form) => form.selector).join(', '));
      for (const id of banner.endpoints ?? []) assert.ok((model.endpoints.find((endpoint) => endpoint.id === id)?.count ?? 0) > 0, `banner linked to ${id}`);
    });

    test(`includeDocuments ${includeDocuments}: a GET form to a page nobody loaded keeps its 0-hit form endpoint`, () => {
      const model = ModelBuilder.create({ now: new Date(0), includeDocuments }).build(capture);
      const find = model.endpoints.find((endpoint) => endpoint.method === 'GET' && endpoint.path === '/find');
      assert.ok(find, describeAll(model));
      assert.equal(find.kind, 'form');
      assert.equal(find.count, 0);
      assert.deepEqual(find.queryParams.map((param) => param.name), ['q']);
    });
  }
});
