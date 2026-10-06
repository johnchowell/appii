import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CaptureMerger, CaptureStore, CaptureValidator, HarConverter } from '../src/capture/index.js';
import type { Capture, Cookie } from '../src/model/index.js';
import { AppiiError } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const HOUR = 3_600_000;

function shifted(capture: Capture, ms: number, tag: string): Capture {
  const move = (iso: string): string => new Date(Date.parse(iso) + ms).toISOString();
  const ids = new Map(capture.exchanges.map((exchange) => [exchange.id, `${tag}-${exchange.id}`]));
  return {
    ...capture,
    startedAt: move(capture.startedAt),
    endedAt: move(capture.endedAt),
    exchanges: capture.exchanges.map((exchange) => ({
      ...exchange,
      id: ids.get(exchange.id) ?? exchange.id,
      startedAt: move(exchange.startedAt),
      ...(exchange.redirectedFrom === undefined ? {} : { redirectedFrom: ids.get(exchange.redirectedFrom) ?? exchange.redirectedFrom }),
    })),
    pages: capture.pages.map((page) => ({ ...page, capturedAt: move(page.capturedAt) })),
    websockets: capture.websockets.map((socket) => ({ ...socket, id: `${tag}-${socket.id}`, openedAt: move(socket.openedAt) })),
  };
}

function anonymous(): Capture {
  const f = new CaptureFactory();
  f.document('/login', CaptureFactory.loginHtml('anon-csrf-0123456789abcdef'), { responseHeaders: { 'set-cookie': 'session=anon; Path=/; HttpOnly' } });
  f.snapshot('/login', 'Login', CaptureFactory.loginHtml('anon-csrf-0123456789abcdef'));
  f.document('/', CaptureFactory.page('Home', '<a href="/login">Login</a>'));
  f.cookie('session', 'anon-value', { httpOnly: true });
  f.cookie('theme', 'light');
  const capture = f.capture({ startUrl: `${f.origin}/login` });
  capture.storage = [{ origin: f.origin, localStorage: { seen: '1' }, sessionStorage: {} }];
  return capture;
}

function authenticated(): Capture {
  const f = new CaptureFactory();
  const login = f.exchange({ method: 'POST', url: '/login', resourceType: 'document', status: 302, responseHeaders: { location: '/', 'set-cookie': 'session=authed; Path=/; HttpOnly' } });
  f.document('/', CaptureFactory.page('Home', '<a href="/logout">Logout</a>'), { redirectedFrom: login.id });
  f.document('/account', CaptureFactory.page('Account', '<h1>Me</h1>'));
  f.websocket('wss://shop.example.com/live', [{ direction: 'received', at: new Date(CaptureFactory.EPOCH).toISOString(), opcode: 'text', data: 'hi' }]);
  f.cookie('session', 'authed-value', { httpOnly: true });
  return shifted(f.capture({ startUrl: `${f.origin}/account` }), HOUR, 'authed');
}

function cookie(capture: Capture, name: string): Cookie[] {
  return capture.cookies.filter((entry) => entry.name === name);
}

describe('CaptureMerger', () => {
  test('merges an anonymous and a later logged-in capture in time order and lists each input', () => {
    const anon = anonymous();
    const authed = authenticated();
    const { capture, sources } = CaptureMerger.create().merge([
      { capture: authed, file: 'authed.json' },
      { capture: anon, file: 'anon.json' },
    ]);
    assert.deepEqual(new CaptureValidator().validate(capture), []);
    assert.deepEqual(
      capture.exchanges.map((exchange) => exchange.id),
      [...anon.exchanges, ...authed.exchanges].map((exchange) => exchange.id),
    );
    assert.equal(capture.startUrl, anon.startUrl);
    assert.equal(capture.startedAt, anon.startedAt);
    assert.equal(capture.endedAt, authed.endedAt);
    assert.equal(capture.pages.length, anon.pages.length + authed.pages.length);
    assert.equal(capture.websockets.length, 1);
    assert.deepEqual(capture.storage, anon.storage);
    assert.equal(capture.version, CaptureStore.VERSION);
    const redirect = capture.exchanges.find((exchange) => exchange.redirectedFrom !== undefined);
    assert.ok(redirect && capture.exchanges.some((exchange) => exchange.id === redirect.redirectedFrom));
    assert.deepEqual(sources, [
      { file: 'authed.json', startUrl: authed.startUrl, capturedFrom: authed.startedAt, capturedTo: authed.endedAt, exchanges: authed.exchanges.length },
      { file: 'anon.json', startUrl: anon.startUrl, capturedFrom: anon.startedAt, capturedTo: anon.endedAt, exchanges: anon.exchanges.length },
    ]);
  });

  test('the same capture given twice keeps every exchange, page, socket and storage entry once', () => {
    const authed = authenticated();
    const twice = CaptureMerger.create().merge([{ capture: authed, file: 'a.json' }, { capture: structuredClone(authed), file: 'a.json' }]);
    assert.deepEqual(
      twice.capture.exchanges.map((exchange) => exchange.id),
      authed.exchanges.map((exchange) => exchange.id),
    );
    assert.equal(twice.capture.pages.length, authed.pages.length);
    assert.equal(twice.capture.websockets.length, authed.websockets.length);
    assert.equal(twice.capture.cookies.length, authed.cookies.length);
    assert.equal(twice.sources.length, 2);
  });

  test('cookies are unioned by name, domain, host-only flag, path and partition key, and the capture that ended last wins', () => {
    const anon = anonymous();
    const authed = authenticated();
    const host = new URL(CaptureFactory.ORIGIN).hostname;
    anon.cookies.push(
      { name: 'session', value: 'scoped', domain: host, path: '/api', expires: null, httpOnly: true, secure: false, sameSite: null, hostOnly: true },
      { name: 'session', value: 'partitioned', domain: host, path: '/', expires: null, httpOnly: true, secure: true, sameSite: 'None', hostOnly: true, partitionKey: 'https://example.org' },
      { name: 'session', value: 'domain-wide', domain: host, path: '/', expires: null, httpOnly: true, secure: false, sameSite: null, hostOnly: false },
    );
    for (const order of [
      [anon, authed],
      [authed, anon],
    ]) {
      const { capture } = CaptureMerger.create().merge(order.map((entry) => ({ capture: entry })));
      const sessions = cookie(capture, 'session');
      assert.deepEqual(sessions.map((entry) => entry.value).sort(), ['authed-value', 'domain-wide', 'partitioned', 'scoped']);
      assert.deepEqual(
        cookie(capture, 'theme').map((entry) => entry.value),
        ['light'],
      );
    }
  });

  test('the later capture wins a cookie even when it started earlier but ended last', () => {
    const early = anonymous();
    const late = authenticated();
    const long = { ...early, endedAt: new Date(Date.parse(late.endedAt) + HOUR).toISOString() };
    const { capture } = CaptureMerger.create().merge([{ capture: late }, { capture: long }]);
    assert.deepEqual(
      cookie(capture, 'session').map((entry) => entry.value),
      ['anon-value'],
    );
    assert.equal(capture.endedAt, long.endedAt);
    assert.equal(capture.startedAt, early.startedAt);
  });

  test('a single input is returned unchanged and no input is an error', () => {
    const anon = anonymous();
    const one = CaptureMerger.create().merge([{ capture: anon, file: 'anon.json' }]);
    assert.equal(one.capture, anon);
    assert.equal(one.sources.length, 1);
    assert.throws(() => CaptureMerger.create().merge([]), (err: unknown) => err instanceof AppiiError && err.code === 'BAD_INPUT' && /at least one/.test(err.message));
  });

  test('a HAR file converted twice gives the same exchange ids, so merging the same HAR twice keeps each entry once', () => {
    const entry = (url: string) => ({
      startedDateTime: '2026-03-01T10:00:00.000Z',
      time: 12,
      request: { method: 'GET', url, httpVersion: 'HTTP/1.1', headers: [], queryString: [], cookies: [], headersSize: -1, bodySize: 0 },
      response: { status: 200, statusText: 'OK', httpVersion: 'HTTP/1.1', headers: [{ name: 'content-type', value: 'application/json' }], cookies: [], content: { size: 2, mimeType: 'application/json', text: '{}' }, redirectURL: '', headersSize: -1, bodySize: 2 },
      cache: {},
      timings: { send: 0, wait: 12, receive: 0 },
    });
    const har = { log: { version: '1.2', creator: { name: 'devtools', version: '1' }, entries: [entry('https://shop.example.com/api/a'), entry('https://shop.example.com/api/a'), entry('https://shop.example.com/api/b')] } };
    const first = new HarConverter().fromHar(structuredClone(har));
    const second = new HarConverter().fromHar(structuredClone(har));
    const ids = first.exchanges.map((exchange) => exchange.id);
    assert.equal(new Set(ids).size, 3, 'identical entries at different positions keep distinct ids');
    assert.deepEqual(
      second.exchanges.map((exchange) => exchange.id),
      ids,
    );
    const { capture } = CaptureMerger.create().merge([{ capture: first }, { capture: second }]);
    assert.equal(capture.exchanges.length, 3);
  });
});
