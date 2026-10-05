import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureStore } from '../src/capture/index.js';
import { Fs, JsonStreamParser } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

function chunked(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const DOCUMENTS = [
  '{"a":1,"b":[true,false,null],"c":{"d":"e"}}',
  ' [ 0 , -0 , 1.5e3 , -2E-2 , 123456789012 , "" , [] , {} , [[[]]] ] ',
  '{"esc":"q\\"b\\\\s\\/ \\b\\f\\n\\r\\t \\u00e9 \\ud83d\\ude00 \\u20ac","raw":"caf\u00e9 \u4e2d \ud83d\ude00"}',
  '{"__proto__":{"polluted":true},"constructor":1,"x":{"__proto__":[1]}}',
  '"just a string with \\\\\\" escapes"',
  '{"dup":1,"dup":2}',
  '\n\t{"long":"' + 'x\\n'.repeat(3000) + '","tail":"\\\\"}\r\n',
];

const INVALID = ['{"a":1,}', '[1,]', '{"a" 1}', '[01]', '["a\u0001"]', '["\\x"]', '[1] 2', '{"a":tru}', '[', '"open', '{"a":1]', '[1}', ''];

describe('JsonStreamParser (CAP-3a)', () => {
  test('gives the same value as JSON.parse for every way of cutting the input into chunks', () => {
    for (const doc of DOCUMENTS) {
      const expected: unknown = JSON.parse(doc);
      for (const size of [1, 2, 3, 5, 7, 64, doc.length]) {
        const value = JsonStreamParser.parse(chunked(doc, size));
        assert.deepEqual(value, expected, `${doc.slice(0, 30)} in chunks of ${size}`);
      }
    }
    const proto = JsonStreamParser.parse(chunked(DOCUMENTS[3] ?? '', 4)) as Record<string, unknown>;
    assert.ok(Object.hasOwn(proto, '__proto__'));
    assert.equal(Object.getPrototypeOf(proto), Object.prototype);
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });

  test('rejects what JSON.parse rejects', () => {
    for (const doc of INVALID) {
      assert.throws(() => JSON.parse(doc), SyntaxError, doc);
      for (const size of [1, 3, doc.length || 1]) assert.throws(() => JsonStreamParser.parse(chunked(doc, size)), SyntaxError, `${doc} in chunks of ${size}`);
    }
  });
});

describe('Fs.readJson streams files that are too large for one string (CAP-3a)', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-json-stream-'));
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the streaming path reads a saved capture exactly like the one-string path', async () => {
    const path = join(dir, 'capture.json');
    const capture = CaptureFactory.fixture().capture;
    await new CaptureStore().save(path, capture);
    const whole = await Fs.readJson(path);
    const streamed = await Fs.readJson(path, { streamAbove: 0 });
    assert.deepEqual(streamed, whole);
    const store = new CaptureStore({ reader: (file) => Fs.readJson(file, { streamAbove: 0 }) });
    assert.deepEqual(await store.load(path), await new CaptureStore().load(path));
  });

  test('a BOM is skipped and errors name the file', async () => {
    const bom = join(dir, 'bom.json');
    await writeFile(bom, '\ufeff{"a":[1,2]}');
    assert.deepEqual(await Fs.readJson(bom, { streamAbove: 0 }), { a: [1, 2] });
    const bad = join(dir, 'bad.json');
    await writeFile(bad, '{"a":');
    await assert.rejects(Fs.readJson(bad, { streamAbove: 0 }), (err: Error) => err.message.startsWith(`${bad} is not valid JSON`));
    await assert.rejects(Fs.readJson(join(dir, 'missing.json'), { streamAbove: 0 }), /File not found/);
  });
});
