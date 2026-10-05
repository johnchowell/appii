import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import { CaptureValidator, CookieParser, HarConverter } from '../src/capture/index.js';
import type { Capture } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

describe('responses that never reached the server (CAP-13: HTTP cache hits)', () => {
  function cachedCapture(): Capture {
    const f = new CaptureFactory();
    const page = f.url('/app');
    f.exchange({ url: '/app', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html' }, responseBody: '<p>app</p>' });
    f.exchange({
      url: '/api/profile',
      pageUrl: page,
      requestHeaders: { accept: 'application/json', cookie: 'sid=s1', 'x-api-key': 'k1' },
      status: 200,
      responseHeaders: { 'content-type': 'application/json', 'cache-control': 'max-age=60', 'set-cookie': 'seen=1; Path=/' },
      responseBody: { json: { id: 1, name: 'Ann' } },
    });
    f.exchange({
      url: '/api/profile',
      pageUrl: page,
      requestHeaders: { accept: 'application/json' },
      status: 200,
      responseHeaders: { 'content-type': 'application/json', 'cache-control': 'max-age=60', 'set-cookie': 'stale=1; Path=/' },
      responseBody: { json: { id: 1, name: 'Ann', nickname: 'A' } },
      servedBy: 'cache',
      cacheKind: 'memory',
    });
    f.exchange({
      url: '/api/static-config',
      pageUrl: page,
      requestHeaders: { accept: 'application/json' },
      status: 200,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: { json: { theme: 'dark' } },
      servedBy: 'cache',
      cacheKind: 'disk',
    });
    return f.capture();
  }

  test('cache hits do not count as hits and do not feed header, cookie or auth inference', () => {
    const capture = cachedCapture();
    const model = ModelBuilder.create({ now: new Date(0) }).build(capture);
    const profile = model.endpoints.find((e) => e.path === '/api/profile');
    assert.ok(profile);
    assert.equal(profile.count, 1);
    assert.deepEqual(
      profile.responses.map((r) => [r.status, r.count]),
      [[200, 1]],
    );
    assert.deepEqual(
      profile.headerParams.map((p) => [p.name, p.required]),
      [['x-api-key', true]],
    );
    assert.deepEqual(profile.auth.cookies, ['sid']);
    assert.deepEqual(profile.samples.map((s) => s.exchangeId), [capture.exchanges[1]!.id]);
    const names = model.cookies.map((c) => c.name).sort();
    assert.ok(names.includes('seen'));
    assert.ok(!names.includes('stale'), 'a Set-Cookie header of a cached response is not a cookie the server set');
  });

  test('cache hits still describe the response body, and an endpoint seen only from the cache has no hits', () => {
    const model = ModelBuilder.create({ now: new Date(0) }).build(cachedCapture());
    const profile = model.endpoints.find((e) => e.path === '/api/profile');
    const properties = Object.keys((profile?.responses[0]?.body?.schema?.properties ?? {}) as Record<string, unknown>).sort();
    assert.deepEqual(properties, ['id', 'name', 'nickname']);
    const config = model.endpoints.find((e) => e.path === '/api/static-config');
    assert.ok(config, 'the endpoint exists: the cached response came from the server earlier');
    assert.equal(config.count, 0);
    assert.deepEqual(config.responses.map((r) => [r.status, r.count]), [[200, 0]]);
    assert.equal(config.samples.length, 1);
  });
});

describe('responses that a service worker made (CAP-5)', () => {
  test('a worker-made response is not a server endpoint and is not a CSRF source', () => {
    const f = new CaptureFactory();
    const page = f.url('/app');
    f.exchange({ url: '/app', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html' }, responseBody: '<p>app</p>' });
    f.exchange({
      url: '/api/offline-token',
      pageUrl: page,
      status: 200,
      responseHeaders: { 'content-type': 'application/json', 'set-cookie': 'worker=1; Path=/' },
      responseBody: { json: { csrfToken: 'tok-0123456789abcdef' } },
      servedBy: 'service-worker',
    });
    f.exchange({
      url: '/api/items',
      method: 'POST',
      pageUrl: page,
      requestHeaders: { 'content-type': 'application/json', cookie: 'sid=s1', 'x-csrf-token': 'tok-0123456789abcdef' },
      requestBody: { json: { name: 'x' } },
      status: 201,
      responseHeaders: { 'content-type': 'application/json' },
      responseBody: { json: { id: 7 } },
    });
    const capture = f.capture();
    const model = ModelBuilder.create({ now: new Date(0) }).build(capture);
    assert.equal(
      model.endpoints.find((e) => e.path === '/api/offline-token'),
      undefined,
    );
    const items = model.endpoints.find((e) => e.method === 'POST' && e.path === '/api/items');
    assert.ok(items);
    assert.deepEqual(
      items.auth.csrf.map((t) => [t.name, t.source]),
      [['x-csrf-token', 'unknown']],
    );
    assert.ok(!model.cookies.some((c) => c.name === 'worker'));
    assert.deepEqual(new CookieParser().replay(capture.exchanges), []);
  });
});

describe('servedBy in the capture format and in HAR files', () => {
  test('the capture validator accepts the known values and rejects others', () => {
    const f = new CaptureFactory();
    f.exchange({ url: '/a', status: 200, servedBy: 'cache', cacheKind: 'prefetch' });
    f.exchange({ url: '/b', status: 200, servedBy: 'service-worker' });
    const validator = new CaptureValidator();
    const capture = f.capture();
    assert.deepEqual(validator.validate(capture), []);
    const broken = JSON.parse(JSON.stringify(capture)) as { exchanges: Record<string, unknown>[] };
    broken.exchanges[0]!.servedBy = 'proxy';
    broken.exchanges[1]!.cacheKind = 'disk';
    const problems = validator.validate(broken);
    assert.ok(problems.some((p) => /exchanges\[0\]\.servedBy must be one of "service-worker", "cache"/.test(p)), problems.join('; '));
    assert.ok(problems.some((p) => /exchanges\[1\]\.cacheKind is allowed only when servedBy is "cache"/.test(p)), problems.join('; '));
  });

  test('HAR export writes the Chrome fields and import reads them back', () => {
    const f = new CaptureFactory();
    f.exchange({ url: '/memory', status: 200, servedBy: 'cache', cacheKind: 'memory' });
    f.exchange({ url: '/prefetch', status: 200, servedBy: 'cache', cacheKind: 'prefetch' });
    f.exchange({ url: '/worker', status: 200, servedBy: 'service-worker' });
    f.exchange({ url: '/network', status: 200 });
    const converter = HarConverter.create();
    const har = converter.toHar(f.capture());
    const entries = har.log.entries;
    assert.deepEqual(
      entries.map((e) => [new URL(e.request.url).pathname, e._fromCache, e.response._fetchedViaServiceWorker]),
      [
        ['/memory', 'memory', undefined],
        ['/prefetch', 'disk', undefined],
        ['/worker', undefined, true],
        ['/network', undefined, undefined],
      ],
    );
    const back = converter.fromHar(har);
    assert.deepEqual(
      back.exchanges.map((e) => [new URL(e.request.url).pathname, e.servedBy, e.cacheKind]),
      [
        ['/memory', 'cache', 'memory'],
        ['/prefetch', 'cache', 'prefetch'],
        ['/worker', 'service-worker', undefined],
        ['/network', undefined, undefined],
      ],
    );
    const chrome = JSON.parse(JSON.stringify(har)) as typeof har;
    for (const entry of chrome.log.entries) {
      delete entry._appiiCacheKind;
      delete entry._appiiId;
    }
    chrome.log.entries[0]!.serverIPAddress = '127.0.0.1';
    const imported = converter.fromHar(chrome);
    assert.deepEqual(
      imported.exchanges.map((e) => [e.servedBy, e.cacheKind, e.response?.remoteAddress]),
      [
        ['cache', 'memory', undefined],
        ['cache', 'disk', undefined],
        ['service-worker', undefined, undefined],
        [undefined, undefined, undefined],
      ],
    );
  });
});
