import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { BodyParser, ModelBuilder, ModelValidator } from '../src/build/index.js';
import type { BodyData } from '../src/model/index.js';
import { Http, Schema } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const parser = BodyParser.create();
const JSON_TEXT = '{"name":"caf\u00e9","tags":["a","b"]}';

function encoded(bytes: Uint8Array, mimeType: string, contentEncoding: string): BodyData {
  return Http.toBodyData(bytes, mimeType, { contentEncoding });
}

describe('BodyParser decodes the content coding of request bodies (RFC 9110 8.4)', () => {
  const plain = new TextEncoder().encode(JSON_TEXT);
  const expected = { kind: 'json', mimeType: 'application/json', value: { name: 'caf\u00e9', tags: ['a', 'b'] } };

  test('gzip, deflate (zlib and raw), br and zstd', () => {
    assert.deepEqual(parser.parse(encoded(zlib.gzipSync(plain), 'application/json', 'gzip'), 'application/json', { contentEncoding: 'gzip' }), expected);
    assert.deepEqual(parser.parse(encoded(zlib.gzipSync(plain), 'application/json', 'x-gzip'), 'application/json', { contentEncoding: 'X-GZIP' }), expected);
    assert.deepEqual(parser.parse(encoded(zlib.deflateSync(plain), 'application/json', 'deflate'), 'application/json', { contentEncoding: 'deflate' }), expected);
    assert.deepEqual(parser.parse(encoded(zlib.deflateRawSync(plain), 'application/json', 'deflate'), 'application/json', { contentEncoding: 'deflate' }), expected);
    assert.deepEqual(parser.parse(encoded(zlib.brotliCompressSync(plain), 'application/json', 'br'), 'application/json', { contentEncoding: 'br' }), expected);
    const zstd = (zlib as { zstdCompressSync?: (data: Uint8Array) => Uint8Array }).zstdCompressSync;
    if (typeof zstd === 'function') assert.deepEqual(parser.parse(encoded(zstd(plain), 'application/json', 'zstd'), 'application/json', { contentEncoding: 'zstd' }), expected);
  });

  test('stacked codings are removed in reverse order of application', () => {
    const stacked = zlib.brotliCompressSync(zlib.gzipSync(plain));
    assert.deepEqual(parser.parse(encoded(stacked, 'application/json', 'gzip, br'), 'application/json', { contentEncoding: 'gzip, br' }), expected);
    assert.deepEqual(parser.parse(encoded(zlib.gzipSync(plain), 'application/json', 'identity, gzip'), 'application/json', { contentEncoding: 'identity, gzip' }), expected);
  });

  test('unknown codings and corrupt data are opaque binary and never throw', () => {
    assert.deepEqual(parser.parse(encoded(plain, 'application/json', 'compress'), 'application/json', { contentEncoding: 'compress' }), { kind: 'binary', mimeType: 'application/json' });
    assert.deepEqual(parser.parse(encoded(new Uint8Array([1, 2, 3, 4]), 'application/json', 'gzip'), 'application/json', { contentEncoding: 'gzip' }), { kind: 'binary', mimeType: 'application/json' });
    assert.deepEqual(parser.parse(encoded(zlib.gzipSync(plain), 'application/json', 'gzip, bogus'), 'application/json', { contentEncoding: 'gzip, bogus' }), { kind: 'binary', mimeType: 'application/json' });
  });

  test('a truncated gzip body keeps the decoded prefix', () => {
    const lines = Array.from({ length: 200 }, (_, i) => JSON.stringify({ i })).join('\n');
    const zipped = zlib.gzipSync(new TextEncoder().encode(lines));
    const body = { ...encoded(zipped.subarray(0, Math.floor(zipped.length / 2)), 'application/x-ndjson', 'gzip'), truncated: true };
    const parsed = parser.parse(body, 'application/x-ndjson', { contentEncoding: 'gzip' });
    assert.equal(parsed.kind, 'json');
    assert.ok(Array.isArray(parsed.value) && parsed.value.length > 0);
  });

  test('a gzip request body captured as exact bytes gets a schema in the model', () => {
    const f = new CaptureFactory();
    const exchange = f.json('POST', '/api/items', 201, { id: 1 }, { requestHeaders: { 'content-type': 'application/json', 'content-encoding': 'gzip' } });
    const capture = f.capture();
    const stored = capture.exchanges.find((candidate) => candidate.id === exchange.id);
    assert.ok(stored);
    stored.request.body = encoded(zlib.gzipSync(plain), 'application/json', 'gzip');
    const model = ModelBuilder.create({ now: new Date(0) }).build(capture);
    const items = model.endpoints.find((endpoint) => endpoint.method === 'POST');
    assert.equal(items?.requestBody?.kind, 'json');
    assert.deepEqual(Object.keys(Schema.properties(items?.requestBody?.schema)), ['name', 'tags']);
    assert.deepEqual(items?.requestBody?.examples, [{ name: 'caf\u00e9', tags: ['a', 'b'] }]);
  });
});

describe('BodyParser decodes urlencoded bytes with the submission encoding (FB-21)', () => {
  const form = (text: string): BodyData => Http.toBodyData(new TextEncoder().encode(text), 'application/x-www-form-urlencoded');

  test('the _charset_ field, a declared charset or the form encoding select the decoder', () => {
    assert.deepEqual(parser.parse(form('_charset_=windows-1252&q=caf%E9')).value, { _charset_: 'windows-1252', q: 'caf\u00e9' });
    assert.deepEqual(parser.parse(form('q=caf%E9'), 'application/x-www-form-urlencoded; charset=iso-8859-1').value, { q: 'caf\u00e9' });
    assert.deepEqual(parser.parse(form('q=caf%E9'), undefined, { formEncoding: 'windows-1252' }).value, { q: 'caf\u00e9' });
    assert.deepEqual(parser.parse(form('q=caf%C3%A9'), undefined, { formEncoding: 'bogus' }).value, { q: 'caf\u00e9' });
    assert.deepEqual(BodyParser.urlencoded('q=%82%A0', 'shift_jis'), { q: '\u3042' });
  });

  test('a form submitted from a windows-1252 page keeps its characters in the model examples', () => {
    const f = new CaptureFactory();
    const page = f.url('/search');
    f.exchange({ url: '/search', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html' }, responseBody: '<!doctype html><meta charset="windows-1252"><form method="post" action="/find"><input name="q"></form>' });
    f.exchange({ method: 'POST', url: '/find', resourceType: 'document', pageUrl: page, status: 200, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'q=caf%E9' });
    f.exchange({ method: 'POST', url: '/find', resourceType: 'fetch', pageUrl: page, status: 200, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'q=na%C3%AFve' });
    const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
    const find = model.endpoints.find((endpoint) => endpoint.method === 'POST' && endpoint.path === '/find');
    assert.deepEqual(find?.requestBody?.examples, [{ q: 'caf\u00e9' }, { q: 'na\u00efve' }]);
  });

  test('the _charset_ field of a form on a windows-1252 page is windows-1252 in the model', () => {
    const f = new CaptureFactory();
    f.exchange({ url: '/b', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html' }, responseBody: '<!doctype html><meta charset="windows-1252"><form method="post" action="/post"><input type="hidden" name="_charset_"><input name="q"></form>' });
    f.snapshot('/a', 'A', '<!doctype html><meta charset="utf-8"><form method="post" action="/other" accept-charset="ISO-8859-1"><input type="hidden" name="_charset_"></form>');
    const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
    const charset = (path: string): unknown => Schema.properties(model.endpoints.find((endpoint) => endpoint.path === path)?.requestBody?.schema)._charset_?.const;
    assert.equal(charset('/post'), 'windows-1252');
    assert.equal(charset('/other'), 'windows-1252');
  });

  test('the model records the submission encoding of each form and the validator requires it', () => {
    const f = new CaptureFactory();
    f.exchange({ url: '/b', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html; charset=windows-1252' }, responseBody: '<!doctype html><form method="post" action="/post"><input name="q"></form>' });
    f.snapshot('/a', 'A', '<!doctype html><meta charset="utf-8"><form method="post" action="/other"><input name="q"></form>');
    const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
    const endpointCharset = (path: string): unknown => model.endpoints.find((endpoint) => endpoint.path === path)?.form?.charset;
    assert.equal(endpointCharset('/post'), 'windows-1252');
    assert.equal(endpointCharset('/other'), 'UTF-8');
    assert.deepEqual(model.forms.map((item) => [new URL(item.action).pathname, item.charset]).sort(), [['/other', 'UTF-8'], ['/post', 'windows-1252']]);
    const validator = new ModelValidator();
    assert.deepEqual(validator.validate(model), []);
    const broken = JSON.parse(JSON.stringify(model)) as { forms: Record<string, unknown>[]; endpoints: { form?: Record<string, unknown> }[] };
    delete broken.forms[0]!.charset;
    const linked = broken.endpoints.find((endpoint) => endpoint.form !== undefined);
    if (linked?.form) linked.form.charset = 1;
    const problems = validator.validate(broken);
    assert.ok(problems.some((problem) => /^forms\[0\]\.charset: expected a string$/.test(problem)), problems.join('; '));
    assert.ok(problems.some((problem) => /^endpoints\[\d+\]\.form\.charset: expected a string$/.test(problem)), problems.join('; '));
  });
});
