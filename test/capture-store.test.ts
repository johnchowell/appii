import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
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

  test('ignores a UTF-8 byte order mark at the start of a HAR file and of a HAR string (HAR 1.2)', async () => {
    const har = new HarConverter().toHar(capture().exchanges);
    const path = join(dir, 'bom.har');
    await writeFile(path, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(har))]));
    const loaded = await CaptureStore.create().load(path);
    assert.equal(loaded.exchanges.length, 1);
    assert.deepEqual(Http.bodyJson(loaded.exchanges[0]?.response?.body), { id: 1 });
    assert.equal(HarConverter.create().fromHar('\ufeff' + JSON.stringify(har)).exchanges.length, 1);
    const saved = join(dir, 'bom-capture.json');
    await writeFile(saved, '\ufeff' + JSON.stringify(capture()));
    assert.deepEqual(await CaptureStore.create().load(saved), capture());
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

  test('does not follow symbolic links out of the HAR folder and reads only regular files', async () => {
    const folder = join(dir, 'links');
    const outside = join(dir, 'outside');
    await mkdir(join(folder, 'inner'), { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'SECRET-OUTSIDE');
    await writeFile(join(folder, 'inner', 'inside.txt'), 'inside');
    await symlink(join(outside, 'secret.txt'), join(folder, 'file-link'));
    await symlink(outside, join(folder, 'dir-link'));
    await symlink(join(folder, 'inner', 'inside.txt'), join(folder, 'inner-link'));
    execFileSync('mkfifo', [join(folder, 'pipe')]);
    const entry = (url: string, file: string) => ({
      startedDateTime: '2026-05-01T10:00:00.000Z',
      time: 1,
      request: { method: 'GET', url, headers: [] },
      response: { status: 200, headers: [], content: { mimeType: 'text/plain', size: 10, _file: file } },
    });
    const har = {
      log: {
        version: '1.2',
        creator: { name: 'Playwright', version: '1.56.1' },
        entries: [
          entry('https://example.com/a', 'file-link'),
          entry('https://example.com/b', 'dir-link/secret.txt'),
          entry('https://example.com/c', 'inner'),
          entry('https://example.com/d', 'pipe'),
          entry('https://example.com/e', 'inner-link'),
        ],
      },
    };
    const path = join(folder, 'links.har');
    await writeFile(path, JSON.stringify(har));
    const loaded = await CaptureStore.create().load(path);
    assert.deepEqual(
      loaded.exchanges.map((e) => Http.bodyText(e.response?.body)),
      ['', '', '', '', 'inside'],
    );
    assert.ok(!JSON.stringify(loaded).includes('SECRET-OUTSIDE'));
  });

  test('streams a capture to disk in parts, so captures larger than the longest JavaScript string can be saved', async () => {
    const big = 'A'.repeat(64 * 1024 * 1024);
    const body = { mimeType: 'application/octet-stream', encoding: 'base64' as const, data: big, size: (big.length / 4) * 3 };
    const base = capture();
    const template = base.exchanges[0]!;
    const large: Capture = {
      ...base,
      exchanges: Array.from({ length: 9 }, (_, i) => ({ ...template, id: `big${i}`, response: { ...template.response!, body } })),
    };
    const path = join(dir, 'big', 'capture.json');
    await new CaptureStore().save(path, large);
    const info = await stat(path);
    assert.ok(info.size > 2 ** 29, `wrote ${info.size} bytes`);
    assert.equal(info.mode & 0o777, 0o600);
    assert.deepEqual(await readdir(join(dir, 'big')), ['capture.json']);
    const parts = [...CaptureStore.chunks(large)];
    assert.ok(parts.length > large.exchanges.length);
    assert.ok(Math.max(...parts.map((part) => part.length)) < big.length + 4096);
    await rm(path);
  });

  test('serializes in parts to exactly the same ASCII JSON text', () => {
    const value = capture();
    value.pages[0]!.title = 'Caf\u00e9 \ud83d\ude00';
    assert.equal([...CaptureStore.chunks(value)].join('') + '\n', Json.asciiJson(value) + '\n');
    assert.equal(CaptureStore.serialize(value), Json.asciiJson(value) + '\n');
    const empty: Capture = { ...value, exchanges: [], websockets: [], cookies: [], storage: [], pages: [] };
    assert.equal(CaptureStore.serialize(empty), Json.asciiJson(empty) + '\n');
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
