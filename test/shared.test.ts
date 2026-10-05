import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ansi, AppiiError, EndpointIndex, Fs, Http, Json, Meta, Schema, Text } from '../src/shared/index.js';
import type { Endpoint } from '../src/model/index.js';

test('Text casing, singularize, escaping', () => {
  assert.equal(Text.camelCase('get /api/items/{itemId}'), 'getApiItemsItemId');
  assert.equal(Text.pascalCase('my-site.example'), 'MySiteExample');
  assert.equal(Text.camelCase('2fa code'), '_2faCode');
  assert.equal(Text.kebabCase('GET /api/Items'), 'get-api-items');
  assert.deepEqual(['items', 'categories', 'addresses', 'statuses', 'boxes', 'people', 'news', 'bus', 'causes', 'houses', 'campuses'].map(Text.singularize), [
    'item', 'category', 'address', 'status', 'box', 'person', 'news', 'bus', 'cause', 'house', 'campus',
  ]);
  assert.equal(Text.truncate('abcdefgh', 5), 'ab...');
  assert.equal(Text.shellQuote("it's"), `'it'\\''s'`);
  assert.equal(Text.escapeHtml('<a href="x">é</a>'), '&lt;a href=&quot;x&quot;&gt;&#233;&lt;/a&gt;');
  assert.equal(Text.escapeMarkdown('a|b`c'), 'a\\|b\\`c');
  assert.equal(Text.jsString('café \u{1F600}'), '"caf\\u00e9 \\ud83d\\ude00"');
  assert.equal(Text.propertyKey('a-b'), '"a-b"');
  assert.equal(Text.propertyKey('ab'), 'ab');
  const taken = new Set<string>();
  assert.deepEqual([Text.uniqueName('x', taken), Text.uniqueName('x', taken), Text.uniqueName('x', taken)], ['x', 'x2', 'x3']);
  assert.equal(Text.formatBytes(2048), '2.0 KiB');
  assert.equal(Text.formatDuration(65_000), '1 min 5 s');
});

test('Json helpers', () => {
  assert.equal(Json.stableStringify({ b: 1, a: { d: 1, c: 2 } }, 0), '{"a":{"c":2,"d":1},"b":1}');
  assert.equal(Json.getPath({ a: [{ b: 2 }] }, ['a', 0, 'b']), 2);
  assert.equal(Json.getPath({}, ['__proto__']), undefined);
  assert.deepEqual(Json.safeParse('{'), { ok: false, error: Json.safeParse('{').ok ? '' : (Json.safeParse('{') as { error: string }).error });
});

test('Fs atomic write keeps mode and reports missing files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'appii-shared-'));
  try {
    const file = join(dir, 'nested', 'secret.json');
    await Fs.writeJson(file, { a: 1 }, { mode: 0o600 });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { a: 1 });
    await assert.rejects(Fs.readJson(join(dir, 'missing.json')), (e: unknown) => e instanceof AppiiError && e.code === 'NOT_FOUND');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Schema helpers', () => {
  const s = {
    type: 'object',
    required: ['email'],
    properties: {
      email: { type: 'string', format: 'email' },
      age: { type: 'integer', minimum: 13, 'x-html-max': '120' },
      tags: { type: 'array', items: { type: 'string', enum: ['a', 'b'] } },
      plan: { enum: ['free', 'pro'] },
      note: { type: ['string', 'null'], 'x-html-pattern': '[a-z]+', 'x-html-maxlength': 10 },
    },
  };
  assert.equal(Schema.typeLabel(s.properties.tags), 'array<enum(2)>');
  assert.equal(Schema.typeLabel(s.properties.note), 'string|null');
  assert.deepEqual([...Schema.requiredSet(s)], ['email']);
  assert.deepEqual(Schema.constraintSummary(s.properties.note), ['pattern [a-z]+', 'length 0..10']);
  assert.deepEqual(Schema.constraintSummary(s.properties.age), ['range 13..120']);
  assert.deepEqual(Schema.sampleValue(s), { email: 'user@example.com', age: 13, tags: ['a'], plan: 'free', note: 'note' });
  const paths: string[] = [];
  Schema.walkSchema(s, (_n, p) => paths.push(p.join('.')));
  assert.ok(paths.includes('tags.[]'));
});

test('Ansi width, truncate and colors', () => {
  const c = new Ansi(true);
  const s = c.green('GET') + ' /api/items';
  assert.equal(Ansi.width(s), 14);
  const t = Ansi.truncate(s, 8);
  assert.equal(Ansi.strip(t), 'GET /...');
  assert.ok(t.endsWith('\x1b[0m'));
  assert.equal(Ansi.padEnd(c.red('x'), 3).length, c.red('x').length + 2);
  assert.equal(Ansi.plain.method('POST'), 'POST');
  assert.equal(Ansi.strip(c.status(404)), '404');
});

test('EndpointIndex resolves numbers, ids, names and keys', () => {
  const ep = (id: string, name: string, key: string) => ({ id, name, key, path: '/' + id }) as unknown as Endpoint;
  const a = ep('get-a', 'getA', 'GET http://x/a');
  const b = ep('get-b', 'getB', 'GET http://x/b');
  const idx = new EndpointIndex([a, b]);
  assert.equal(idx.get(2), b);
  assert.equal(idx.get('getA'), a);
  assert.equal(idx.get('GET http://x/b'), b);
  assert.equal(idx.get('GETB'), b);
  assert.equal(idx.numberOf(b), 2);
  assert.deepEqual(idx.select(['2', 'get-a']), [a, b]);
  assert.throws(() => idx.require('nope'), (e: unknown) => e instanceof AppiiError && e.code === 'NOT_FOUND');
});

test('Http and Meta helpers', () => {
  assert.equal(Http.reasonPhrase(422), 'Unprocessable Content');
  assert.equal(Http.reasonPhrase(299), 'Success');
  assert.deepEqual(Http.parseCookieHeader('a=1; b = 2;c'), [{ name: 'a', value: '1' }, { name: 'b', value: '2' }, { name: '', value: 'c' }]);
  assert.ok(Http.isSafeMethod('get'));
  assert.equal(Meta.appVersion(), '0.1.0');
  assert.deepEqual(Meta.creator(), { name: 'appii', version: '0.1.0' });
});
