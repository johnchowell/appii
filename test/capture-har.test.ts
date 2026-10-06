import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureSession, HarConverter, ResourceTypeMapper } from '../src/capture/index.js';
import type { Har, HarEntry } from '../src/capture/index.js';
import { ModelBuilder } from '../src/build/index.js';
import { AppiiError, Http, Json } from '../src/shared/index.js';
import type { Capture, Exchange } from '../src/model/index.js';
import { startFixtureSite } from './fixtures/site.js';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

function sampleCapture(): Capture {
  const html = '<!DOCTYPE html><html><head><title>Home</title></head><body><form action="/login" method="post"><input type="hidden" name="csrf" value="abc"></form></body></html>';
  const exchanges: Exchange[] = [
    {
      id: 'e1',
      source: 'browser',
      resourceType: 'document',
      startedAt: '2026-05-01T10:00:00.000Z',
      durationMs: 12.5,
      request: { method: 'GET', url: 'https://example.com/', headers: [{ name: 'Accept', value: 'text/html' }] },
      response: {
        status: 200,
        statusText: 'OK',
        headers: [
          { name: 'Content-Type', value: 'text/html; charset=utf-8' },
          { name: 'Set-Cookie', value: 'sid=1; Path=/; HttpOnly; SameSite=Lax' },
          { name: 'Set-Cookie', value: 'theme=dark; Max-Age=3600' },
        ],
        body: Http.toBodyData(Buffer.from(html), 'text/html; charset=utf-8'),
        remoteAddress: '93.184.216.34:443',
      },
    },
    {
      id: 'e2',
      source: 'browser',
      resourceType: 'document',
      pageUrl: 'https://example.com/',
      startedAt: '2026-05-01T10:00:01.000Z',
      durationMs: 30,
      request: {
        method: 'POST',
        url: 'https://example.com/login',
        headers: [
          { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
          { name: 'Cookie', value: 'sid=1; theme=dark' },
        ],
        body: Http.toBodyData(Buffer.from('csrf=abc&email=a%40b.c'), 'application/x-www-form-urlencoded'),
      },
      response: {
        status: 303,
        statusText: 'See Other',
        headers: [
          { name: 'Location', value: '/account' },
          { name: 'Set-Cookie', value: 'auth=tok; Path=/; HttpOnly; Secure' },
        ],
      },
    },
    {
      id: 'e3',
      source: 'browser',
      resourceType: 'document',
      pageUrl: 'https://example.com/',
      startedAt: '2026-05-01T10:00:01.031Z',
      durationMs: 5,
      request: { method: 'GET', url: 'https://example.com/account', headers: [{ name: 'Cookie', value: 'sid=1; theme=dark; auth=tok' }] },
      response: { status: 200, statusText: 'OK', headers: [{ name: 'Content-Type', value: 'text/html' }], body: Http.toBodyData(Buffer.from('<p>hi</p>'), 'text/html') },
      redirectedFrom: 'e2',
    },
    {
      id: 'e4',
      source: 'browser',
      resourceType: 'image',
      pageUrl: 'https://example.com/account',
      startedAt: '2026-05-01T10:00:02.000Z',
      durationMs: 3,
      request: { method: 'GET', url: 'https://example.com/logo.png', headers: [] },
      response: {
        status: 200,
        statusText: 'OK',
        headers: [
          { name: 'Content-Type', value: 'image/png' },
          { name: 'Content-Length', value: String(PNG.length) },
        ],
        body: Http.toBodyData(PNG, 'image/png'),
      },
    },
    {
      id: 'e5',
      source: 'browser',
      resourceType: 'fetch',
      pageUrl: 'https://example.com/account',
      startedAt: '2026-05-01T10:00:03.000Z',
      durationMs: 44.125,
      request: {
        method: 'GET',
        url: 'https://api.example.com/items?page=1&limit=2&q=a%20b',
        headers: [
          { name: 'Accept', value: 'application/json' },
          { name: 'Cookie', value: 'sid=1' },
        ],
      },
      response: {
        status: 200,
        statusText: '',
        headers: [
          { name: 'content-type', value: 'application/json' },
          { name: 'content-encoding', value: 'br' },
        ],
        body: Http.toBodyData(Buffer.from(JSON.stringify({ items: [1, 2, 3, 4, 5, 6, 7, 8] })), 'application/json', { maxBytes: 16 }),
        remoteAddress: '[2001:db8::1]:8443',
      },
    },
    {
      id: 'e6',
      source: 'browser',
      resourceType: 'fetch',
      pageUrl: 'https://example.com/account',
      startedAt: '2026-05-01T10:00:04.000Z',
      durationMs: 9,
      request: { method: 'PUT', url: 'https://example.com/upload', headers: [{ name: 'Content-Type', value: 'application/octet-stream' }], body: Http.toBodyData(PNG, 'application/octet-stream') },
      response: { status: 204, statusText: 'No Content', headers: [] },
    },
    {
      id: 'e7',
      source: 'browser',
      resourceType: 'script',
      pageUrl: 'https://example.com/account',
      startedAt: '2026-05-01T10:00:05.000Z',
      durationMs: 1,
      request: { method: 'GET', url: 'https://down.example.net/app.js', headers: [] },
      error: 'net::ERR_NAME_NOT_RESOLVED',
    },
  ];
  return {
    version: 1,
    tool: { name: 'appii', version: '0.1.0' },
    startUrl: 'https://example.com/',
    startedAt: '2026-05-01T09:59:59.000Z',
    endedAt: '2026-05-01T10:01:00.000Z',
    exchanges,
    websockets: [
      {
        id: 'ws1',
        url: 'wss://example.com/live',
        pageUrl: 'https://example.com/account',
        openedAt: '2026-05-01T10:00:02.500Z',
        closedAt: '2026-05-01T10:00:09.250Z',
        messages: [
          { direction: 'sent', at: '2026-05-01T10:00:02.600Z', opcode: 'text', data: 'subscribe' },
          { direction: 'received', at: '2026-05-01T10:00:02.700Z', opcode: 'binary', data: 'AAEC' },
        ],
      },
      { id: 'ws2', url: 'wss://example.com/broken', openedAt: '2026-05-01T10:00:06.000Z', error: 'connection refused', messages: [] },
    ],
    cookies: [{ name: 'sid', value: '1', domain: 'example.com', path: '/', expires: null, httpOnly: true, secure: false, sameSite: 'Lax', hostOnly: true }],
    storage: [{ origin: 'https://example.com', localStorage: { k: 'v' }, sessionStorage: {} }],
    pages: [{ url: 'https://example.com/', title: 'Home', capturedAt: '2026-05-01T10:00:00.100Z', html }],
  };
}

function assertHar12(har: Har): void {
  assert.equal(har.log.version, '1.2');
  assert.equal(typeof har.log.creator.name, 'string');
  assert.equal(typeof har.log.creator.version, 'string');
  const pageIds = new Set((har.log.pages ?? []).map((p) => p.id));
  for (const page of har.log.pages ?? []) {
    assert.ok(!Number.isNaN(Date.parse(page.startedDateTime)));
    assert.equal(typeof page.title, 'string');
    assert.equal(typeof page.pageTimings, 'object');
  }
  let previous = Number.NEGATIVE_INFINITY;
  for (const e of har.log.entries) {
    if (e.pageref !== undefined) assert.ok(pageIds.has(e.pageref), `pageref ${e.pageref}`);
    const start = Date.parse(e.startedDateTime);
    assert.ok(!Number.isNaN(start) && /T.*(Z|[+-]\d\d:\d\d)$/.test(e.startedDateTime));
    assert.ok(start >= previous, 'entries sorted by startedDateTime');
    previous = start;
    const r = e.request;
    assert.equal(typeof r.method, 'string');
    assert.equal(typeof r.url, 'string');
    assert.equal(typeof r.httpVersion, 'string');
    for (const list of [r.cookies, r.headers, r.queryString]) assert.ok(Array.isArray(list));
    assert.equal(r.headersSize, -1);
    assert.equal(typeof r.bodySize, 'number');
    if (r.postData) {
      assert.equal(typeof r.postData.mimeType, 'string');
      assert.ok(!(r.postData.text !== undefined && r.postData.params !== undefined), 'text and params are mutually exclusive');
    }
    const s = e.response;
    assert.equal(typeof s.status, 'number');
    assert.equal(typeof s.statusText, 'string');
    assert.equal(typeof s.httpVersion, 'string');
    assert.ok(Array.isArray(s.cookies) && Array.isArray(s.headers));
    assert.equal(typeof s.content.size, 'number');
    assert.equal(typeof s.content.mimeType, 'string');
    assert.equal(typeof s.redirectURL, 'string');
    assert.equal(s.headersSize, -1);
    assert.equal(typeof s.bodySize, 'number');
    assert.deepEqual(e.cache, {});
    for (const key of ['send', 'wait', 'receive'] as const) assert.ok(e.timings[key] >= 0);
    const sum = Object.entries(e.timings)
      .filter(([k, v]) => k !== 'comment' && typeof v === 'number' && v >= 0)
      .reduce((total, [, v]) => total + (v as number), 0);
    assert.equal(e.time, sum, 'time is the sum of the timings');
  }
}

function withSource(capture: Capture, source: 'browser' | 'har'): Capture {
  const copy = Json.clone(capture);
  for (const e of copy.exchanges) e.source = source;
  return copy;
}

describe('HarConverter.toHar', () => {
  const converter = new HarConverter();
  const capture = sampleCapture();
  const har = converter.toHar(capture);
  const entry = (id: string): HarEntry => har.log.entries.find((e) => e._appiiId === id)!;

  test('produces a structurally valid HAR 1.2 log', () => {
    assertHar12(har);
    assert.equal(har.log.creator.name, 'appii');
    assert.equal(har.log.entries.length, 9);
    assert.deepEqual(
      har.log.entries.map((e) => e._appiiId),
      ['e1', 'e2', 'e3', 'e4', 'ws1', 'e5', 'e6', 'e7', 'ws2'],
    );
  });

  test('maps requests: cookies, query string, post data and binary bodies', () => {
    const login = entry('e2');
    assert.deepEqual(login.request.cookies, [
      { name: 'sid', value: '1' },
      { name: 'theme', value: 'dark' },
    ]);
    assert.deepEqual(login.request.postData, { mimeType: 'application/x-www-form-urlencoded', text: 'csrf=abc&email=a%40b.c' });
    assert.equal(login.request.bodySize, 22);
    assert.deepEqual(entry('e5').request.queryString, [
      { name: 'page', value: '1' },
      { name: 'limit', value: '2' },
      { name: 'q', value: 'a b' },
    ]);
    const upload = entry('e6').request.postData!;
    assert.equal(upload._appiiEncoding, 'base64');
    assert.equal(Buffer.from(upload.text!, 'base64').equals(PNG), true);
    assert.equal(entry('e1').request.bodySize, 0);
  });

  test('maps responses: Set-Cookie attributes, redirects, content encodings and sizes', () => {
    const home = entry('e1');
    assert.deepEqual(home.response.cookies[0], { name: 'sid', value: '1', path: '/', httpOnly: true, sameSite: 'Lax' });
    assert.equal(home.response.cookies[1]?.name, 'theme');
    assert.equal(home.response.cookies[1]?.expires, new Date(Date.parse('2026-05-01T10:00:00.000Z') + 12.5 + 3600 * 1000).toISOString());
    assert.equal(home.response.content.mimeType, 'text/html; charset=utf-8');
    assert.match(home.response.content.text!, /<title>Home<\/title>/);
    assert.equal(home.serverIPAddress, '93.184.216.34');
    assert.equal(entry('e2').response.redirectURL, '/account');
    assert.equal(entry('e2').response.content.text, undefined);
    assert.equal(entry('e2').response.bodySize, -1);
    const image = entry('e4').response;
    assert.equal(image.content.encoding, 'base64');
    assert.equal(image.content.size, PNG.length);
    assert.equal(image.bodySize, PNG.length);
    const truncated = entry('e5');
    assert.equal(truncated.response.content._appiiTruncated, true);
    assert.equal(truncated.response.bodySize, -1);
    assert.equal(truncated.serverIPAddress, '2001:db8::1');
    assert.equal(truncated._appiiRemoteAddress, '[2001:db8::1]:8443');
    assert.equal(entry('e6').response.bodySize, 0);
  });

  test('maps failures Chrome-style and keeps appii fields for lossless round trips', () => {
    const failed = entry('e7');
    assert.equal(failed.response.status, 0);
    assert.equal(failed.response._error, 'net::ERR_NAME_NOT_RESOLVED');
    assert.equal(failed.response.content.mimeType, 'x-unknown');
    assert.equal(failed._appiiError, 'net::ERR_NAME_NOT_RESOLVED');
    assert.equal(entry('e3')._appiiRedirectedFrom, 'e2');
    assert.equal(entry('e3')._appiiPageUrl, 'https://example.com/');
    assert.equal(entry('e1')._resourceType, 'document');
    assert.equal(entry('e4')._resourceType, 'image');
  });

  test('maps WebSockets to Chrome-style _webSocketMessages entries', () => {
    const ws = entry('ws1');
    assert.equal(ws._resourceType, 'websocket');
    assert.equal(ws.response.status, 101);
    assert.equal(ws.time, 6750);
    assert.deepEqual(ws._webSocketMessages, [
      { type: 'send', time: Date.parse('2026-05-01T10:00:02.600Z') / 1000, opcode: 1, data: 'subscribe' },
      { type: 'receive', time: Date.parse('2026-05-01T10:00:02.700Z') / 1000, opcode: 2, data: 'AAEC' },
    ]);
    const broken = entry('ws2');
    assert.equal(broken.response.status, 0);
    assert.equal(broken.response._error, 'connection refused');
  });

  test('groups entries into pages by pageUrl, titled from snapshots', () => {
    assert.deepEqual(
      har.log.pages?.map((p) => [p.id, p.title]),
      [
        ['page_1', 'Home'],
        ['page_2', 'https://example.com/account'],
      ],
    );
    assert.equal(entry('e1').pageref, 'page_1');
    assert.equal(entry('e2').pageref, 'page_2');
    assert.equal(entry('e3').pageref, 'page_2');
    assert.equal(entry('ws1').pageref, 'page_2');
  });

  test('accepts a bare exchange list without capture-level extras', () => {
    const bare = converter.toHar(capture.exchanges.slice(0, 2));
    assertHar12(bare);
    assert.equal(bare.log.entries.length, 2);
    assert.equal(bare.log._appiiCookies, undefined);
    assert.equal(bare.log._appiiStartedAt, undefined);
  });
});

describe('HarConverter round trips', () => {
  test('capture -> HAR -> capture is lossless apart from the source marker', () => {
    const converter = new HarConverter();
    const capture = sampleCapture();
    const har = converter.toHar(capture);
    const back = converter.fromHar(har);
    assert.deepEqual(back, withSource({ ...capture, tool: back.tool }, 'har'));
    const fromText = converter.fromHar(JSON.stringify(har));
    assert.deepEqual(fromText, back);
  });

  test('a real browser capture survives the HAR round trip', async () => {
    const site = await startFixtureSite();
    try {
      const capture = await CaptureSession.create({ url: site.origin + '/app', headless: true, idleMs: 300 }).run();
      assert.ok(capture.exchanges.length >= 9);
      const converter = new HarConverter();
      const har = JSON.parse(JSON.stringify(converter.toHar(capture))) as Har;
      assertHar12(har);
      const back = converter.fromHar(har);
      assert.deepEqual(back, withSource(capture, 'har'));
    } finally {
      await site.close();
    }
  });
});

describe('HarConverter.fromHar with third-party HARs', () => {
  const chromeHar = {
    log: {
      version: '1.2',
      creator: { name: 'WebInspector', version: '537.36' },
      pages: [{ startedDateTime: '2026-03-01T08:00:00.000Z', id: 'page_1', title: 'https://shop.test/', pageTimings: { onContentLoad: 100, onLoad: 200 } }],
      entries: [
        {
          _resourceType: 'document',
          pageref: 'page_1',
          startedDateTime: '2026-03-01T08:00:00.000Z',
          time: 50,
          request: {
            method: 'GET',
            url: 'https://shop.test/',
            httpVersion: 'http/2.0',
            headers: [
              { name: ':authority', value: 'shop.test' },
              { name: ':method', value: 'GET' },
              { name: ':path', value: '/' },
              { name: ':scheme', value: 'https' },
              { name: 'accept', value: 'text/html' },
            ],
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: 0,
          },
          response: {
            status: 200,
            statusText: '',
            httpVersion: 'http/2.0',
            headers: [
              { name: 'content-type', value: 'text/html; charset=utf-8' },
              { name: 'set-cookie', value: 'sid=abc; Path=/; HttpOnly\ntheme=light; Path=/' },
            ],
            cookies: [],
            content: {
              size: 180,
              mimeType: 'text/html',
              text: '<html><head><title>\n Shop &amp;  Home </title></head><body><form action="/login" method="post"><input type="hidden" name="csrf" value="t0k"></form></body></html>',
            },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
            _transferSize: 300,
          },
          cache: {},
          timings: { blocked: 1, dns: -1, ssl: -1, connect: -1, send: 1, wait: 40, receive: 8 },
          serverIPAddress: '203.0.113.5',
          connection: '1234',
        },
        {
          _resourceType: 'document',
          pageref: 'page_1',
          startedDateTime: '2026-03-01T08:00:05.000Z',
          time: 20,
          request: {
            method: 'post',
            url: 'https://shop.test/login',
            httpVersion: 'http/2.0',
            headers: [
              { name: 'content-type', value: 'application/x-www-form-urlencoded' },
              { name: 'cookie', value: 'sid=abc; theme=light' },
            ],
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: 14,
            postData: { mimeType: 'application/x-www-form-urlencoded', text: 'csrf=t0k&user=a', params: [{ name: 'csrf', value: 't0k' }] },
          },
          response: {
            status: 302,
            statusText: '',
            httpVersion: 'http/2.0',
            headers: [
              { name: 'location', value: '/home#top' },
              { name: 'set-cookie', value: 'auth=zzz; Path=/; Secure; HttpOnly; SameSite=Lax' },
            ],
            cookies: [],
            content: { size: 0, mimeType: 'x-unknown' },
            redirectURL: '/home#top',
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: 1, wait: 18, receive: 1 },
        },
        {
          _resourceType: 'document',
          pageref: 'page_1',
          startedDateTime: '2026-03-01T08:00:05.030Z',
          time: 10,
          request: { method: 'GET', url: 'https://shop.test/home', httpVersion: 'http/2.0', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
          response: {
            status: 200,
            statusText: '',
            httpVersion: 'http/2.0',
            headers: [{ name: 'content-type', value: 'text/html' }],
            cookies: [],
            content: { size: 20, mimeType: 'text/html', text: '<h1>Welcome back</h1>' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: 0, wait: 10, receive: 0 },
        },
        {
          _resourceType: 'image',
          pageref: 'page_1',
          startedDateTime: '2026-03-01T08:00:01.000Z',
          time: 5,
          request: { method: 'GET', url: 'https://cdn.shop.test/logo.png', httpVersion: 'http/2.0', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
          response: {
            status: 200,
            statusText: '',
            httpVersion: 'http/2.0',
            headers: [{ name: 'content-type', value: 'image/png' }],
            cookies: [],
            content: { size: PNG.length, mimeType: 'image/png', text: PNG.toString('base64'), encoding: 'base64' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: 0, wait: 5, receive: 0 },
        },
        {
          _resourceType: 'xhr',
          pageref: 'page_1',
          startedDateTime: '2026-03-01T08:00:02.000Z',
          time: 7,
          request: { method: 'GET', url: 'https://shop.test/api/cart?id=7', httpVersion: 'http/2.0', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
          response: {
            status: 200,
            statusText: '',
            httpVersion: 'http/2.0',
            headers: [{ name: 'content-type', value: 'application/json' }],
            cookies: [],
            content: { size: 14, mimeType: 'application/json', text: '{"items":[7]}' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1,
          },
          cache: {},
          timings: { send: 0, wait: 7, receive: 0 },
        },
        {
          _resourceType: 'websocket',
          pageref: 'page_1',
          startedDateTime: '2026-03-01T08:00:03.000Z',
          time: 0,
          request: { method: 'GET', url: 'wss://shop.test/ws', httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
          response: { status: 101, statusText: 'Switching Protocols', httpVersion: 'HTTP/1.1', headers: [], cookies: [], content: { size: 0, mimeType: 'x-unknown' }, redirectURL: '', headersSize: -1, bodySize: 0 },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
          _webSocketMessages: [
            { type: 'send', time: 1772352003.5, opcode: 1, data: 'ping' },
            { type: 'receive', time: 1772352003.75, opcode: 2, data: 'AAE=' },
            { type: 'receive', time: 1772352004, opcode: 9, data: '' },
          ],
        },
        {
          _resourceType: 'script',
          startedDateTime: '2026-03-01T08:00:04.000Z',
          time: 0,
          request: { method: 'GET', url: 'https://ads.test/x.js', httpVersion: '', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
          response: { status: 0, statusText: '', httpVersion: '', headers: [], cookies: [], content: { size: 0, mimeType: 'x-unknown' }, redirectURL: '', headersSize: -1, bodySize: -1, _error: 'net::ERR_BLOCKED_BY_CLIENT' },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
        },
        {
          _resourceType: 'image',
          startedDateTime: '2026-03-01T08:00:04.500Z',
          time: 0,
          request: { method: 'GET', url: 'data:image/png;base64,AAAA', httpVersion: '', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
          response: { status: 200, statusText: '', httpVersion: '', headers: [], cookies: [], content: { size: 3, mimeType: 'image/png' }, redirectURL: '', headersSize: -1, bodySize: 0 },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
        },
      ],
    },
  };

  test('imports Chrome DevTools HARs', () => {
    const capture = new HarConverter().fromHar(chromeHar as unknown as Har);
    assert.equal(capture.exchanges.length, 6);
    assert.ok(capture.exchanges.every((e) => e.source === 'har' && e.id.length > 0));
    const [home, login, account, logo, cart, blocked] = capture.exchanges as [Exchange, Exchange, Exchange, Exchange, Exchange, Exchange];
    assert.deepEqual(home.request.headers, [{ name: 'accept', value: 'text/html' }]);
    assert.equal(home.resourceType, 'document');
    assert.equal(home.durationMs, 50);
    assert.equal(home.response?.remoteAddress, '203.0.113.5');
    assert.equal(home.pageUrl, undefined);
    assert.equal(login.pageUrl, 'https://shop.test/');
    assert.equal(login.request.method, 'POST');
    assert.equal(Http.bodyText(login.request.body), 'csrf=t0k&user=a');
    assert.equal(login.request.body?.size, 14);
    assert.equal(account.redirectedFrom, login.id);
    assert.equal(logo.resourceType, 'image');
    assert.equal(logo.response?.body?.encoding, 'base64');
    assert.ok(Buffer.from(Http.bodyBytes(logo.response?.body)).equals(PNG));
    assert.equal(cart.resourceType, 'xhr');
    assert.deepEqual(Http.bodyJson(cart.response?.body), { items: [7] });
    assert.equal(blocked.response, undefined);
    assert.equal(blocked.error, 'net::ERR_BLOCKED_BY_CLIENT');
    assert.equal(blocked.pageUrl, undefined);

    assert.equal(capture.websockets.length, 1);
    const ws = capture.websockets[0]!;
    assert.equal(ws.url, 'wss://shop.test/ws');
    assert.equal(ws.pageUrl, 'https://shop.test/');
    assert.deepEqual(ws.messages, [
      { direction: 'sent', at: '2026-03-01T08:00:03.500Z', opcode: 'text', data: 'ping' },
      { direction: 'received', at: '2026-03-01T08:00:03.750Z', opcode: 'binary', data: 'AAE=' },
    ]);

    assert.deepEqual(capture.cookies.map((c) => c.name).sort(), ['auth', 'sid', 'theme']);
    assert.equal(capture.cookies.find((c) => c.name === 'auth')?.secure, true);
    assert.equal(capture.startUrl, 'https://shop.test/');
    assert.equal(capture.startedAt, '2026-03-01T08:00:00.000Z');
    assert.equal(capture.endedAt, '2026-03-01T08:00:05.040Z');
    assert.deepEqual(capture.storage, []);
    assert.deepEqual(
      capture.pages.map((p) => [p.url, p.title]),
      [
        ['https://shop.test/', 'Shop & Home'],
        ['https://shop.test/home', ''],
      ],
    );
    assert.match(capture.pages[0]!.html, /name="csrf" value="t0k"/);
    assert.equal(capture.pages[0]!.capturedAt, '2026-03-01T08:00:00.050Z');
  });

  test('imports Firefox-style HARs: inferred resource types and params-only post data', async () => {
    const entry = (url: string, extra: Record<string, unknown>) => ({
      startedDateTime: '2026-03-02T09:00:00.000+01:00',
      timings: { blocked: 0, dns: 2, connect: 3, ssl: -1, send: 1, wait: 10, receive: 4 },
      ...extra,
      request: { method: 'GET', url, httpVersion: 'HTTP/2', headers: [], cookies: [], queryString: [], headersSize: 100, bodySize: 0, ...(extra.request as object) },
      response: {
        status: 200,
        statusText: 'OK',
        httpVersion: 'HTTP/2',
        headers: [],
        cookies: [],
        content: { size: 0, mimeType: 'text/plain' },
        redirectURL: '',
        headersSize: 10,
        bodySize: 0,
        ...(extra.response as object),
      },
    });
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'Firefox', version: '140.0' },
        browser: { name: 'Firefox', version: '140.0' },
        pages: [{ startedDateTime: '2026-03-02T09:00:00.000+01:00', id: 'page_1', title: 'Firefox Shop', pageTimings: {} }],
        entries: [
          entry('https://ff.test/', {
            pageref: 'page_1',
            request: { headers: [{ name: 'Accept', value: 'text/html,application/xhtml+xml' }, { name: 'Sec-Fetch-Dest', value: 'document' }] },
            response: { headers: [{ name: 'Content-Type', value: 'text/html' }], content: { size: 30, mimeType: 'text/html', text: '<title>FF</title><form></form>' } },
          }),
          entry('https://ff.test/form', {
            pageref: 'page_1',
            startedDateTime: '2026-03-02T09:00:01.000+01:00',
            request: {
              method: 'POST',
              headers: [{ name: 'Sec-Fetch-Mode', value: 'navigate' }],
              postData: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'a', value: '1 2' }, { name: 'b', value: 'x&y' }, { name: 'c' }] },
            },
          }),
          entry('https://ff.test/upload', {
            pageref: 'page_1',
            request: {
              method: 'POST',
              headers: [{ name: 'Sec-Fetch-Dest', value: 'empty' }],
              postData: {
                mimeType: 'multipart/form-data; boundary=----ffBoundary',
                params: [
                  { name: 'title', value: 'Hello "World"' },
                  { name: 'file', fileName: 'a.txt', contentType: 'text/plain', value: 'file body' },
                ],
              },
            },
          }),
          entry('https://ff.test/app.js', { response: { headers: [{ name: 'Content-Type', value: 'application/javascript' }] } }),
          entry('https://ff.test/api/legacy', { request: { headers: [{ name: 'X-Requested-With', value: 'XMLHttpRequest' }] } }),
          entry('https://ff.test/api/data', {
            request: { headers: [{ name: 'Sec-Fetch-Dest', value: 'empty' }] },
            response: { headers: [{ name: 'Content-Type', value: 'application/json' }], content: { size: 2, mimeType: 'application/json' } },
          }),
          entry('https://ff.test/stream', { response: { headers: [{ name: 'Content-Type', value: 'text/event-stream' }] } }),
          entry('https://ff.test/style.css', { response: { content: { size: 0, mimeType: 'text/css' } } }),
        ],
      },
    };
    const capture = new HarConverter().fromHar(har as unknown as Har);
    const byPath = new Map(capture.exchanges.map((e) => [new URL(e.request.url).pathname, e]));
    assert.equal(byPath.get('/')?.resourceType, 'document');
    assert.equal(byPath.get('/')?.startedAt, '2026-03-02T08:00:00.000Z');
    assert.equal(byPath.get('/')?.durationMs, 0 + 2 + 3 + 1 + 10 + 4);
    assert.equal(byPath.get('/form')?.resourceType, 'document');
    assert.equal(Http.bodyText(byPath.get('/form')?.request.body), 'a=1+2&b=x%26y&c=');
    assert.equal(byPath.get('/form')?.pageUrl, 'https://ff.test/');
    const upload = byPath.get('/upload')!;
    assert.equal(upload.resourceType, 'fetch');
    assert.equal(upload.request.body?.mimeType, 'multipart/form-data; boundary=----ffBoundary');
    const form = await new Request('http://x/', {
      method: 'POST',
      headers: { 'content-type': upload.request.body!.mimeType },
      body: new Uint8Array(Http.bodyBytes(upload.request.body)),
    }).formData();
    assert.equal(form.get('title'), 'Hello "World"');
    const file = form.get('file');
    assert.ok(file instanceof File);
    assert.equal(file.name, 'a.txt');
    assert.equal(await file.text(), 'file body');
    assert.equal(byPath.get('/app.js')?.resourceType, 'script');
    assert.equal(byPath.get('/api/legacy')?.resourceType, 'xhr');
    assert.equal(byPath.get('/api/data')?.resourceType, 'fetch');
    assert.equal(byPath.get('/api/data')?.response?.body, undefined);
    assert.equal(byPath.get('/stream')?.resourceType, 'eventsource');
    assert.equal(byPath.get('/style.css')?.resourceType, 'stylesheet');
    assert.deepEqual(
      capture.pages.map((p) => [p.url, p.title]),
      [['https://ff.test/', 'FF']],
    );
  });

  test('imports minimal Playwright-style HARs with missing optional fields', () => {
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'Playwright', version: '1.56.1' },
        entries: [
          {
            startedDateTime: '2026-03-03T10:00:00.000Z',
            time: 3.5,
            _frameref: 'frame@1',
            _monotonicTime: 123.4,
            request: { method: 'GET', url: 'http://localhost:3000/api/me', headers: [{ name: 'authorization', value: 'Bearer x' }] },
            response: { status: 401, content: { mimeType: 'application/json', text: '{"error":"unauthorized"}' } },
          },
          {
            startedDateTime: '2026-03-03T10:00:01.000Z',
            request: { url: 'http://localhost:3000/api/token', postData: { text: '{"a":1}' }, headers: [{ name: 'content-type', value: 'application/json' }] },
            response: { status: 200, headers: [{ name: 'content-type', value: 'application/json' }], content: { text: 'eyJ0b2tlbiI6InQifQ==', encoding: 'base64' } },
          },
        ],
      },
    };
    const capture = new HarConverter().fromHar(har as unknown as Har);
    assert.equal(capture.exchanges.length, 2);
    const [me, token] = capture.exchanges as [Exchange, Exchange];
    assert.equal(me.response?.status, 401);
    assert.equal(me.response?.statusText, '');
    assert.deepEqual(Http.bodyJson(me.response?.body), { error: 'unauthorized' });
    assert.equal(me.resourceType, 'fetch');
    assert.equal(token.request.method, 'GET');
    assert.equal(token.durationMs, 0);
    assert.equal(token.request.body?.mimeType, 'application/json');
    assert.deepEqual(Http.bodyJson(token.response?.body), { token: 't' });
    assert.equal(token.response?.body?.encoding, 'utf8');
    assert.equal(capture.startUrl, undefined);
    assert.deepEqual(capture.pages, []);
  });

  test('infers redirect chains only for entries that do not carry appii links', () => {
    const own = new HarConverter().toHar(sampleCapture());
    for (const e of own.log.entries) delete e._appiiRedirectedFrom;
    const back = new HarConverter().fromHar(own);
    assert.equal(back.exchanges.find((e) => e.id === 'e3')?.redirectedFrom, undefined);
  });

  test('rejects malformed input with BAD_INPUT', () => {
    const converter = new HarConverter();
    const bad = (err: unknown) => err instanceof AppiiError && err.code === 'BAD_INPUT';
    assert.throws(() => converter.fromHar('{not json'), bad);
    assert.throws(() => converter.fromHar({} as Har), bad);
    assert.throws(() => converter.fromHar({ log: { entries: [{}] } } as unknown as Har), (err: unknown) => bad(err) && /HAR entry 0/.test((err as Error).message));
    assert.throws(
      () => converter.fromHar({ log: { entries: [{ startedDateTime: 'yesterday', request: { url: 'https://x.test/' } }] } } as unknown as Har),
      (err: unknown) => bad(err) && /startedDateTime/.test((err as Error).message),
    );
    const empty = converter.fromHar({ log: { version: '1.2', creator: { name: 'x', version: '1' }, entries: [] } });
    assert.deepEqual(empty.exchanges, []);
    assert.equal(empty.startedAt, empty.endedAt);
  });
});

describe('ResourceTypeMapper', () => {
  test('maps browser resource type names', () => {
    assert.equal(ResourceTypeMapper.fromBrowser('Document'), 'document');
    assert.equal(ResourceTypeMapper.fromBrowser('XHR'), 'xhr');
    assert.equal(ResourceTypeMapper.fromBrowser('texttrack'), 'media');
    assert.equal(ResourceTypeMapper.fromBrowser('csp-violation-report'), 'other');
    assert.equal(ResourceTypeMapper.fromBrowser('EventSource'), 'eventsource');
    assert.equal(ResourceTypeMapper.fromBrowser('something-new'), 'other');
  });

  test('infers types from Fetch metadata, then explicit MIME rules', () => {
    const infer = (headers: Record<string, string>, mimeType = '', method = 'GET', url = 'https://x.test/a', status = 200) =>
      ResourceTypeMapper.infer({ method, url, requestHeaders: Http.recordToHeaders(headers), mimeType, status });
    assert.equal(infer({}, '', 'GET', 'wss://x.test/ws'), 'websocket');
    assert.equal(infer({ upgrade: 'websocket' }, '', 'GET', 'https://x.test/ws', 101), 'websocket');
    assert.equal(infer({ 'sec-fetch-dest': 'empty' }, 'text/event-stream'), 'eventsource');
    assert.equal(infer({ 'sec-fetch-dest': 'iframe' }, 'text/html'), 'document');
    assert.equal(infer({ 'sec-fetch-dest': 'style' }), 'stylesheet');
    assert.equal(infer({ 'sec-fetch-dest': 'video' }), 'media');
    assert.equal(infer({ 'sec-fetch-dest': 'empty', 'x-requested-with': 'XMLHttpRequest' }), 'xhr');
    assert.equal(infer({ 'sec-fetch-mode': 'navigate' }), 'document');
    assert.equal(infer({ accept: 'text/html,*/*' }, 'text/html; charset=utf-8'), 'document');
    assert.equal(infer({ accept: '*/*' }, 'text/html'), 'fetch');
    assert.equal(infer({}, 'font/woff2'), 'font');
    assert.equal(infer({}, 'image/svg+xml'), 'image');
    assert.equal(infer({}, 'application/manifest+json'), 'manifest');
    assert.equal(infer({}, 'text/javascript'), 'script');
    assert.equal(infer({}, 'application/json'), 'fetch');
    assert.equal(infer({}, '', 'POST'), 'fetch');
    assert.equal(infer({}, 'application/octet-stream'), 'other');
  });
});

describe('HarConverter pages follow navigations', () => {
  const ORIGIN = 'https://site.test';
  let clock = Date.parse('2026-04-01T10:00:00.000Z');

  function exchange(id: string, method: string, path: string, resourceType: Exchange['resourceType'], pageUrl: string | undefined, extra: Partial<Exchange> = {}, headers: Record<string, string> = {}): Exchange {
    clock += 100;
    return {
      id,
      source: 'browser',
      resourceType,
      ...(pageUrl ? { pageUrl: ORIGIN + pageUrl } : {}),
      startedAt: new Date(clock).toISOString(),
      durationMs: 20,
      request: { method, url: ORIGIN + path, headers: Object.entries(headers).map(([name, value]) => ({ name, value })) },
      response: { status: 200, statusText: 'OK', headers: [{ name: 'content-type', value: resourceType === 'document' ? 'text/html' : 'application/json' }] },
      ...extra,
    };
  }

  test('puts each navigation document in the page it loads, follows redirects and starts a new page for each visit', () => {
    const exchanges = [
      exchange('home', 'GET', '/', 'document', undefined),
      exchange('api-home', 'GET', '/api/home', 'fetch', '/'),
      exchange('b', 'GET', '/b', 'document', '/'),
      exchange('frame', 'GET', '/widget', 'document', '/b', {}, { 'Sec-Fetch-Dest': 'iframe' }),
      exchange('api-b', 'GET', '/api/b', 'fetch', '/b'),
      exchange('c', 'GET', '/c', 'document', '/b'),
      exchange('api-c', 'GET', '/api/c', 'fetch', '/c'),
      exchange('login', 'POST', '/login', 'document', '/c', { response: { status: 303, statusText: 'See Other', headers: [{ name: 'location', value: '/account' }] } }),
      exchange('account', 'GET', '/account', 'document', '/c', { redirectedFrom: 'login' }),
      exchange('api-account', 'GET', '/api/account', 'fetch', '/account'),
      exchange('home-again', 'GET', '/', 'document', '/account'),
      exchange('api-home-again', 'GET', '/api/home', 'fetch', '/'),
    ];
    const har = new HarConverter().toHar(exchanges);
    assertHar12(har);
    const refs = Object.fromEntries(har.log.entries.map((e) => [e._appiiId, e.pageref]));
    assert.deepEqual(refs, {
      home: 'page_1',
      'api-home': 'page_1',
      b: 'page_2',
      frame: 'page_2',
      'api-b': 'page_2',
      c: 'page_3',
      'api-c': 'page_3',
      login: 'page_4',
      account: 'page_4',
      'api-account': 'page_4',
      'home-again': 'page_5',
      'api-home-again': 'page_5',
    });
    assert.deepEqual(
      har.log.pages?.map((p) => [p.id, p.title, p.startedDateTime]),
      [
        ['page_1', ORIGIN + '/', exchanges[0]!.startedAt],
        ['page_2', ORIGIN + '/b', exchanges[2]!.startedAt],
        ['page_3', ORIGIN + '/c', exchanges[5]!.startedAt],
        ['page_4', ORIGIN + '/account', exchanges[7]!.startedAt],
        ['page_5', ORIGIN + '/', exchanges[10]!.startedAt],
      ],
    );
    const back = new HarConverter().fromHar(har);
    assert.deepEqual(
      back.exchanges.map((e) => e.pageUrl),
      exchanges.map((e) => e.pageUrl),
    );
  });

  test('gives entries of a Playwright HAR the URL of the document that was current when they started', () => {
    const entry = (path: string, method: string, start: string, status: number, dest: string, extra: Record<string, unknown> = {}) => ({
      pageref: 'page@1',
      startedDateTime: start,
      time: 20,
      request: {
        method,
        url: ORIGIN + path,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [
          { name: 'sec-fetch-dest', value: dest },
          { name: 'sec-fetch-mode', value: dest === 'document' ? 'navigate' : 'cors' },
        ],
        queryString: [],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status,
        statusText: '',
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [{ name: 'content-type', value: dest === 'document' ? 'text/html' : 'application/json' }, ...(status === 303 ? [{ name: 'location', value: '/app' }] : [])],
        content: { size: 0, mimeType: dest === 'document' ? 'text/html' : 'application/json' },
        redirectURL: status === 303 ? ORIGIN + '/app' : '',
        headersSize: -1,
        bodySize: -1,
      },
      cache: {},
      timings: { send: 0, wait: 20, receive: 0 },
      ...extra,
    });
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'Playwright', version: '1.56.1' },
        pages: [{ startedDateTime: '2026-04-01T09:00:00.000Z', id: 'page@1', title: 'App done', pageTimings: { onContentLoad: -1, onLoad: -1 } }],
        entries: [
          entry('/', 'GET', '2026-04-01T09:00:00.000Z', 200, 'document'),
          entry('/api/home', 'GET', '2026-04-01T09:00:00.500Z', 200, 'empty'),
          entry('/login', 'GET', '2026-04-01T09:00:01.000Z', 200, 'document'),
          entry('/login', 'POST', '2026-04-01T09:00:02.000Z', 303, 'document'),
          entry('/app', 'GET', '2026-04-01T09:00:02.030Z', 200, 'document'),
          entry('/api/items', 'GET', '2026-04-01T09:00:03.000Z', 200, 'empty'),
        ],
      },
    };
    const capture = new HarConverter().fromHar(har as unknown as Har);
    assert.deepEqual(
      capture.exchanges.map((e) => `${e.request.method} ${new URL(e.request.url).pathname} <- ${e.pageUrl ? new URL(e.pageUrl).pathname : '-'}`),
      ['GET / <- -', 'GET /api/home <- /', 'GET /login <- /', 'POST /login <- /login', 'GET /app <- /login', 'GET /api/items <- /app'],
    );
  });

  test('imports WebSocket messages with out-of-range times at the time the socket opened', () => {
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'tool', version: '1' },
        entries: [
          {
            _resourceType: 'websocket',
            startedDateTime: '2026-04-01T09:00:00.000Z',
            time: 0,
            request: { method: 'GET', url: 'wss://site.test/ws', headers: [] },
            response: { status: 101, headers: [] },
            _webSocketMessages: [
              { type: 'send', time: 1.79e15, opcode: 1, data: 'micro' },
              { type: 'receive', time: 1775034000.25, opcode: 1, data: 'ok' },
            ],
          },
        ],
      },
    };
    const capture = new HarConverter().fromHar(har as unknown as Har);
    assert.deepEqual(
      capture.websockets[0]!.messages.map((m) => [m.data, m.at]),
      [
        ['micro', '2026-04-01T09:00:00.000Z'],
        ['ok', new Date(1775034000250).toISOString()],
      ],
    );
  });

  test('imports entries whose time ends after the last representable date as entries of unknown duration (CAP-20)', () => {
    const entry = (time: unknown, url: string): Record<string, unknown> => ({
      startedDateTime: '2026-04-01T09:00:00.000Z',
      time,
      request: { method: 'GET', url, headers: [] },
      response: { status: 200, headers: [{ name: 'Content-Type', value: 'text/html' }], content: { mimeType: 'text/html', text: '<title>t</title>' } },
      timings: { send: 0, wait: 5, receive: 1 },
      _resourceType: 'document',
    });
    const har = { log: { version: '1.2', creator: { name: 'tool', version: '1' }, entries: [entry(1e16, 'https://site.test/a'), entry(1e300, 'https://site.test/b'), entry(12, 'https://site.test/c')] } };
    const capture = new HarConverter().fromHar(har as unknown as Har);
    assert.deepEqual(capture.exchanges.map((e) => e.durationMs), [6, 6, 12]);
    assert.equal(capture.startedAt, '2026-04-01T09:00:00.000Z');
    assert.equal(capture.endedAt, '2026-04-01T09:00:00.012Z');
    assert.ok(capture.pages.every((p) => !Number.isNaN(Date.parse(p.capturedAt))));
  });
});

describe('HarConverter.fromHar with Playwright cache entries (BOOKS-5)', () => {
  const FONT = 'https://books.test/static/oscar/fonts/fontawesome-webfont.woff%3Fv=3.2.1';
  const UA = [
    { name: 'sec-ch-ua-platform', value: '"Linux"' },
    { name: 'Referer', value: 'https://books.test/' },
    { name: 'User-Agent', value: 'Mozilla/5.0' },
  ];
  const at = (second: number): string => `2026-10-06T02:18:${String(30 + second).padStart(2, '0')}.000Z`;
  const entry = (second: number, url: string, request: Record<string, unknown>, response: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    pageref: 'page@1',
    startedDateTime: at(second),
    time: 1,
    request: { method: 'GET', url, httpVersion: 'HTTP/1.1', cookies: [], queryString: [], headersSize: 300, bodySize: 0, ...request },
    response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', cookies: [], redirectURL: '', headersSize: 307, ...response },
    cache: {},
    timings: { dns: -1, connect: -1, ssl: -1, send: 0, wait: 2, receive: 1 },
    ...extra,
  });
  const network = { serverIPAddress: '127.0.0.1', _serverPort: 37483 };
  const fontHeaders = [
    { name: 'Content-Type', value: 'application/octet-stream' },
    { name: 'Content-Length', value: '6' },
  ];
  const cachedFont = (second: number) =>
    entry(
      second,
      FONT,
      { headers: [{ name: 'Referer', value: '' }], headersSize: 80 },
      { headers: fontHeaders, content: { size: -1, mimeType: 'application/octet-stream', compression: 307, text: '' }, bodySize: -307, _transferSize: 0 },
      { ...network, timings: { dns: -1, connect: -1, ssl: -1, send: 0, wait: -1, receive: 1.09 } },
    );
  const page = (second: number, path: string) =>
    entry(
      second,
      `https://books.test${path}`,
      { headers: [{ name: 'Sec-Fetch-Dest', value: 'document' }, { name: 'Sec-Fetch-Mode', value: 'navigate' }, { name: 'Accept', value: 'text/html' }] },
      { headers: [{ name: 'Content-Type', value: 'text/html' }], content: { size: 20, mimeType: 'text/html', text: '<title>Books</title>' }, bodySize: 20, _transferSize: 327 },
      network,
    );
  const playwrightHar = {
    log: {
      version: '1.2',
      creator: { name: 'Playwright', version: '1.56.1' },
      pages: [{ startedDateTime: at(0), id: 'page@1', title: 'Books', pageTimings: { onContentLoad: -1, onLoad: -1 } }],
      entries: [
        page(0, '/'),
        entry(
          1,
          'https://books.test/static/oscar/css/styles.css',
          { headers: [{ name: 'Sec-Fetch-Dest', value: 'style' }, ...UA] },
          { headers: [{ name: 'Content-Type', value: 'text/css' }], content: { size: 6, mimeType: 'text/css', text: 'body{}' }, bodySize: 6, _transferSize: 313 },
          network,
        ),
        entry(
          2,
          FONT,
          { headers: [{ name: 'Sec-Fetch-Dest', value: 'font' }, { name: 'Sec-Fetch-Mode', value: 'cors' }, ...UA] },
          { headers: fontHeaders, content: { size: 6, mimeType: 'application/octet-stream', text: 'd09GRgAB', encoding: 'base64' }, bodySize: 6, _transferSize: 313 },
          network,
        ),
        entry(
          3,
          'https://books.test/api/basket',
          { headers: [{ name: 'Sec-Fetch-Dest', value: 'empty' }, ...UA] },
          { headers: [{ name: 'Content-Type', value: 'application/json' }], content: { size: 11, mimeType: 'application/json', text: '{"lines":0}' }, bodySize: -43, _transferSize: 0 },
        ),
        page(4, '/catalogue/page-2.html'),
        entry(
          5,
          'https://books.test/static/oscar/css/styles.css',
          { headers: UA },
          { headers: [{ name: 'Content-Type', value: 'text/css' }], content: { size: 6, mimeType: 'text/css', text: 'body{}' }, bodySize: -299, _transferSize: 0 },
          network,
        ),
        cachedFont(6),
        page(7, '/catalogue/travel_2/index.html'),
        cachedFont(8),
        entry(
          9,
          'https://books.test/api/mocked',
          { headers: [{ name: 'Sec-Fetch-Dest', value: 'empty' }, ...UA] },
          { headers: [{ name: 'Content-Type', value: 'application/json' }], content: { size: 2, mimeType: 'application/json', text: '{}' }, bodySize: -20, _transferSize: 0 },
          { ...network, _wasFulfilled: true },
        ),
        page(10, '/catalogue/book_3/index.html'),
        cachedFont(11),
      ],
    },
  };

  test('types memory-cache repeats of a font like the font load that preceded them, and marks them served from the cache', () => {
    const capture = new HarConverter().fromHar(playwrightHar as unknown as Har);
    const fonts = capture.exchanges.filter((e) => e.request.url === FONT);
    assert.equal(fonts.length, 4);
    assert.deepEqual(
      fonts.map((e) => e.resourceType),
      ['font', 'font', 'font', 'font'],
    );
    assert.deepEqual(
      fonts.map((e) => [e.servedBy, e.cacheKind, e.response?.remoteAddress]),
      [
        [undefined, undefined, '127.0.0.1'],
        ['cache', undefined, undefined],
        ['cache', undefined, undefined],
        ['cache', undefined, undefined],
      ],
    );
    const styles = capture.exchanges.filter((e) => e.request.url.endsWith('/styles.css'));
    assert.deepEqual(
      styles.map((e) => [e.resourceType, e.servedBy]),
      [
        ['stylesheet', undefined],
        ['stylesheet', 'cache'],
      ],
    );
    const byPath = new Map(capture.exchanges.map((e) => [new URL(e.request.url).pathname, e]));
    assert.equal(byPath.get('/api/basket')?.servedBy, undefined, 'a response without a server address came from a service worker, not from the cache');
    assert.equal(byPath.get('/api/mocked')?.servedBy, undefined, 'a response fulfilled by Playwright did not come from the cache');
  });

  test('the model lists no endpoint for the font and counts only server hits', () => {
    const capture = new HarConverter().fromHar(playwrightHar as unknown as Har);
    const model = ModelBuilder.create().build(capture);
    assert.deepEqual(
      model.endpoints.filter((e) => e.path.includes('fontawesome')).map((e) => `${e.method} ${e.path}`),
      [],
    );
    assert.equal(model.endpoints.find((e) => e.path === '/api/basket')?.count, 1);
  });

  test('keeps a type taken from the request headers and leaves entries without any evidence as other', () => {
    const har = Json.clone(playwrightHar) as typeof playwrightHar;
    const unknown = cachedFont(12);
    unknown.request.url = 'https://books.test/static/oscar/fonts/other.bin';
    har.log.entries.push(unknown);
    const capture = new HarConverter().fromHar(har as unknown as Har);
    assert.equal(capture.exchanges.find((e) => e.request.url.endsWith('/other.bin'))?.resourceType, 'other');
    assert.equal(capture.exchanges.find((e) => e.request.url.endsWith('/api/basket'))?.resourceType, 'fetch');
    assert.equal(
      ResourceTypeMapper.evident({ method: 'GET', url: FONT, requestHeaders: [{ name: 'Referer', value: '' }], status: 200, mimeType: 'application/octet-stream' }),
      undefined,
    );
  });

  test('a cache hit of unknown kind keeps no kind through an appii HAR round trip', () => {
    const capture = new HarConverter().fromHar(playwrightHar as unknown as Har);
    const back = new HarConverter().fromHar(new HarConverter().toHar(capture));
    const fonts = back.exchanges.filter((e) => e.request.url === FONT);
    assert.deepEqual(
      fonts.map((e) => [e.resourceType, e.servedBy, e.cacheKind]),
      [
        ['font', undefined, undefined],
        ['font', 'cache', undefined],
        ['font', 'cache', undefined],
        ['font', 'cache', undefined],
      ],
    );
  });
});
