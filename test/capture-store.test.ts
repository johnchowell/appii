import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureStore, CaptureValidator, HarConverter } from '../src/capture/index.js';
import type { Har } from '../src/capture/index.js';
import { AppiiError, Http, Json } from '../src/shared/index.js';
import type { Capture } from '../src/model/index.js';

let dir: string;

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'appii-capture-store-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

function capture(): Capture {
  return {
    version: 1,
    tool: { name: 'appii', version: '0.1.0' },
    startUrl: 'https://example.com/',
    startedAt: '2026-05-01T10:00:00.000Z',
    endedAt: '2026-05-01T10:00:10.000Z',
    exchanges: [
      {
        id: 'x1',
        source: 'browser',
        resourceType: 'fetch',
        pageUrl: 'https://example.com/',
        startedAt: '2026-05-01T10:00:01.000Z',
        durationMs: 10,
        request: { method: 'POST', url: 'https://example.com/api/items', headers: [{ name: 'content-type', value: 'application/json' }], body: Http.toBodyData(Buffer.from('{"a":1}'), 'application/json') },
        response: { status: 201, statusText: 'Created', headers: [{ name: 'content-type', value: 'application/json' }], body: Http.toBodyData(Buffer.from('{"id":1}'), 'application/json') },
      },
    ],
    websockets: [{ id: 'w1', url: 'wss://example.com/ws', openedAt: '2026-05-01T10:00:02.000Z', messages: [{ direction: 'sent', at: '2026-05-01T10:00:02.100Z', opcode: 'text', data: 'hi' }] }],
    cookies: [{ name: 'sid', value: 's', domain: 'example.com', path: '/', expires: null, httpOnly: true, secure: true, sameSite: 'Lax', hostOnly: true }],
    storage: [{ origin: 'https://example.com', localStorage: { a: '1' }, sessionStorage: { b: '2' } }],
    pages: [{ url: 'https://example.com/', title: 'Home', capturedAt: '2026-05-01T10:00:00.500Z', html: '<html></html>' }],
  };
}

const badInput = (pattern?: RegExp) => (err: unknown) => err instanceof AppiiError && err.code === 'BAD_INPUT' && (!pattern || pattern.test(err.message));

describe('CaptureStore', () => {
  test('saves with owner-only permissions and loads the same capture back', async () => {
    const store = new CaptureStore();
    const path = join(dir, 'nested', 'capture.json');
    await store.save(path, capture());
    const info = await stat(path);
    assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(await store.load(path), capture());
    assert.equal(CaptureStore.VERSION, 1);
  });

  test('writes ASCII-only JSON that restores non-ASCII content exactly', async () => {
    const store = new CaptureStore();
    const original = capture();
    original.pages[0]!.html = '<p>caf\u00e9 \u2713 \ud83d\ude00</p>';
    original.pages[0]!.title = '\u65e5\u672c';
    const path = join(dir, 'unicode.json');
    await store.save(path, original);
    const text = await readFile(path, 'utf8');
    assert.ok(/^[\x00-\x7f]*$/.test(text));
    assert.deepEqual(await store.load(path), original);
  });

  test('refuses to save an invalid capture', async () => {
    const broken = { ...capture(), exchanges: [{ id: 1 }] } as unknown as Capture;
    await assert.rejects(new CaptureStore().save(join(dir, 'never.json'), broken), badInput(/invalid capture/));
  });

  test('detects HAR files by log.entries and converts them', async () => {
    const har = new HarConverter().toHar(capture().exchanges);
    const path = join(dir, 'traffic.har');
    await writeFile(path, JSON.stringify(har));
    const loaded = await new CaptureStore().load(path);
    assert.equal(loaded.exchanges.length, 1);
    assert.equal(loaded.exchanges[0]?.source, 'har');
    assert.deepEqual(Http.bodyJson(loaded.exchanges[0]?.response?.body), { id: 1 });
  });

  test('inlines Playwright attach-mode HAR content files and ignores paths outside the HAR folder', async () => {
    const folder = join(dir, 'attached');
    await mkdir(folder, { recursive: true });
    await writeFile(join(folder, 'abc123.json'), '{"ok":true}');
    await writeFile(join(folder, 'req456.dat'), Buffer.from([0, 1, 2, 255]));
    await writeFile(join(dir, 'secret.txt'), 'top secret');
    const entry = (url: string, content: Record<string, unknown>, postData?: Record<string, unknown>) => ({
      startedDateTime: '2026-05-01T10:00:00.000Z',
      time: 1,
      request: { method: postData ? 'POST' : 'GET', url, headers: [], ...(postData ? { postData } : {}) },
      response: { status: 200, headers: [], content },
    });
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'Playwright', version: '1.56.1' },
        entries: [
          entry('https://example.com/a', { mimeType: 'application/json', size: 11, _file: 'abc123.json' }, { mimeType: 'application/octet-stream', _file: 'req456.dat' }),
          entry('https://example.com/b', { mimeType: 'text/plain', size: 10, _file: '../secret.txt' }),
          entry('https://example.com/c', { mimeType: 'text/plain', size: 10, _file: 'missing.txt' }),
        ],
      },
    };
    const path = join(folder, 'pw.har');
    await writeFile(path, JSON.stringify(har));
    const loaded = await new CaptureStore().load(path);
    const [a, b, c] = loaded.exchanges;
    assert.deepEqual(Http.bodyJson(a?.response?.body), { ok: true });
    assert.deepEqual([...Http.bodyBytes(a?.request.body)], [0, 1, 2, 255]);
    assert.equal(b?.response?.body, undefined);
    assert.equal(c?.response?.body, undefined);
  });

  test('uses the injected HAR converter', async () => {
    let calls = 0;
    class CountingConverter extends HarConverter {
      override fromHar(input: Har | string): Capture {
        calls++;
        return super.fromHar(input);
      }
    }
    const path = join(dir, 'counted.har');
    await writeFile(path, JSON.stringify({ log: { version: '1.2', creator: { name: 'x', version: '1' }, entries: [] } }));
    const loaded = await new CaptureStore({ har: new CountingConverter() }).load(path);
    assert.equal(calls, 1);
    assert.deepEqual(loaded.exchanges, []);
  });

  test('reports bad input clearly', async () => {
    const store = new CaptureStore();
    await assert.rejects(store.load(join(dir, 'does-not-exist.json')), (err: unknown) => err instanceof AppiiError && err.code === 'NOT_FOUND');
    const write = async (name: string, text: string) => {
      const path = join(dir, name);
      await writeFile(path, text);
      return path;
    };
    await assert.rejects(store.load(await write('broken.json', '{"version":')), badInput(/not valid JSON/));
    await assert.rejects(store.load(await write('v2.json', JSON.stringify({ ...capture(), version: 2 }))), badInput(/unsupported capture version 2/));
    await assert.rejects(store.load(await write('api.json', JSON.stringify({ version: 1, name: 'x', endpoints: [], cookies: [] }))), badInput(/API model/));
    await assert.rejects(store.load(await write('array.json', '[]')), badInput(/capture must be a JSON object/));
    await assert.rejects(store.load(await write('bad-har.har', JSON.stringify({ log: { entries: [{ request: {} }] } }))), badInput(/bad-har\.har: HAR entry 0 has no request URL/));
    const broken = Json.clone(capture()) as unknown as { exchanges: { request: { url?: unknown } }[] };
    delete broken.exchanges[0]!.request.url;
    await assert.rejects(store.load(await write('missing-url.json', JSON.stringify(broken))), (err: unknown) => {
      assert.ok(badInput(/exchanges\[0\]\.request\.url must be a string/)(err));
      assert.deepEqual((err as AppiiError).details, { problems: ['exchanges[0].request.url must be a string'] });
      return true;
    });
  });
});

describe('CaptureStore.isCapture and CaptureValidator', () => {
  test('accepts valid captures', () => {
    assert.equal(CaptureStore.isCapture(capture()), true);
    const minimal: Capture = { ...capture(), exchanges: [], websockets: [], cookies: [], storage: [], pages: [] };
    delete minimal.startUrl;
    assert.equal(CaptureStore.isCapture(minimal), true);
  });

  test('rejects structural problems with precise paths', () => {
    const validator = new CaptureValidator();
    const mutate = (fn: (c: Record<string, any>) => void): string[] => {
      const c = Json.clone(capture()) as Record<string, any>;
      fn(c);
      return validator.validate(c);
    };
    assert.deepEqual(mutate((c) => delete c.exchanges), ['exchanges must be an array']);
    assert.deepEqual(mutate((c) => (c.cookies[0].sameSite = 'lax')), ['cookies[0].sameSite must be "Strict", "Lax", "None" or null']);
    assert.deepEqual(mutate((c) => (c.exchanges[0].response.body.encoding = 'hex')), ['exchanges[0].response.body.encoding must be "utf8" or "base64"']);
    assert.deepEqual(mutate((c) => (c.exchanges[0].resourceType = 'ajax')), ['exchanges[0].resourceType is not a known resource type']);
    assert.deepEqual(mutate((c) => (c.exchanges[0].startedAt = 'soon')), ['exchanges[0].startedAt must be an ISO date string']);
    assert.deepEqual(mutate((c) => (c.websockets[0].messages[0].direction = 'up')), ['websockets[0].messages[0].direction must be "sent" or "received"']);
    assert.deepEqual(mutate((c) => (c.storage[0].localStorage.a = 1)), ['storage[0].localStorage must map strings to strings']);
    assert.deepEqual(mutate((c) => (c.pages[0].html = null)), ['pages[0].html must be a string']);
    assert.deepEqual(mutate((c) => (c.exchanges[0].request.headers = [{ name: 'a' }])), ['exchanges[0].request.headers[0] must be { name, value } strings']);
    assert.deepEqual(mutate((c) => (c.tool = 'appii')), ['tool must be { name, version }']);
    assert.equal(CaptureStore.isCapture(null), false);
    assert.equal(CaptureStore.isCapture({ ...capture(), version: 2 }), false);
    const many = { ...capture(), exchanges: Array.from({ length: 100 }, () => ({})) };
    assert.equal(validator.validate(many).length, CaptureValidator.MAX_PROBLEMS);
  });
});
