import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BodyParser, GraphqlDocument, MultipartParser } from '../src/build/index.js';
import type { BodyData } from '../src/model/index.js';
import { Http } from '../src/shared/index.js';

const parser = new BodyParser();

function body(text: string | Uint8Array, mimeType: string, extra: Partial<BodyData> = {}): BodyData {
  const bytes = typeof text === 'string' ? new TextEncoder().encode(text) : text;
  return { ...Http.toBodyData(bytes, mimeType), ...extra };
}

async function formData(entries: [string, string | Blob, string?][]): Promise<{ data: BodyData; contentType: string }> {
  const form = new FormData();
  for (const [name, value, filename] of entries) {
    if (typeof value === 'string') form.append(name, value);
    else form.append(name, value, filename);
  }
  const request = new Request('http://x/', { method: 'POST', body: form });
  const contentType = request.headers.get('content-type') ?? '';
  const bytes = new Uint8Array(await request.arrayBuffer());
  return { data: Http.toBodyData(bytes, contentType), contentType };
}

describe('BodyParser basics', () => {
  test('missing and zero-length bodies are empty and keep the declared mime essence', () => {
    assert.deepEqual(parser.parse(undefined, 'application/json; charset=utf-8'), { kind: 'empty', mimeType: 'application/json' });
    assert.deepEqual(parser.parse(body('', 'text/plain')), { kind: 'empty', mimeType: 'text/plain' });
    assert.deepEqual(parser.parse(undefined), { kind: 'empty', mimeType: '' });
  });

  test('json with a declared json mime, including +json and a BOM', () => {
    assert.deepEqual(parser.parse(body('{"a":1,"b":[true,null]}', 'application/json; charset=utf-8')), {
      kind: 'json',
      mimeType: 'application/json',
      value: { a: 1, b: [true, null] },
    });
    assert.deepEqual(parser.parse(body('\ufeff[1,2]', 'application/problem+json')).value, [1, 2]);
    assert.deepEqual(parser.parse(body('"just a string"', 'application/json')), { kind: 'json', mimeType: 'application/json', value: 'just a string' });
  });

  test('json is sniffed for missing or odd mime types only when the text is an object or array', () => {
    assert.deepEqual(parser.parse(body('{"x":1}', 'text/plain;charset=UTF-8')), { kind: 'json', mimeType: 'text/plain', value: { x: 1 } });
    assert.deepEqual(parser.parse(body('  [1]', '')), { kind: 'json', mimeType: 'application/json', value: [1] });
    assert.deepEqual(parser.parse(body('{"x":1}', 'application/octet-stream')).kind, 'json');
    assert.deepEqual(parser.parse(body('{"x":1}', 'application/x-www-form-urlencoded')).kind, 'json');
    assert.deepEqual(parser.parse(body('42', 'text/plain')), { kind: 'text', mimeType: 'text/plain', value: '42' });
    assert.deepEqual(parser.parse(body('{broken', 'text/plain')), { kind: 'text', mimeType: 'text/plain', value: '{broken' });
  });

  test('a declared json body that does not parse is text, unless it was truncated', () => {
    assert.deepEqual(parser.parse(body('{"a":', 'application/json')), { kind: 'text', mimeType: 'application/json', value: '{"a":' });
    assert.deepEqual(parser.parse(body('{"a":', 'application/json', { truncated: true })), { kind: 'json', mimeType: 'application/json' });
  });

  test('newline-delimited json becomes an array of values', () => {
    assert.deepEqual(parser.parse(body('{"a":1}\n{"a":2}\n', 'application/x-ndjson')), { kind: 'json', mimeType: 'application/x-ndjson', value: [{ a: 1 }, { a: 2 }] });
    assert.equal(parser.parse(body('{"a":1}\nnope', 'application/x-ndjson')).kind, 'text');
    assert.deepEqual(parser.parse(body('{"a":1}\n{"a"', 'application/x-ndjson', { truncated: true })).value, [{ a: 1 }]);
  });

  test('html, text, svg and binary bodies', () => {
    assert.deepEqual(parser.parse(body('<p>x</p>', 'text/html; charset=utf-8')), { kind: 'html', mimeType: 'text/html', value: '<p>x</p>' });
    assert.equal(parser.parse(body('<html/>', 'application/xhtml+xml')).kind, 'html');
    assert.deepEqual(parser.parse(body('hello', 'text/plain')), { kind: 'text', mimeType: 'text/plain', value: 'hello' });
    assert.deepEqual(parser.parse(body('hello', '')), { kind: 'text', mimeType: 'text/plain', value: 'hello' });
    assert.equal(parser.parse(body('<svg/>', 'image/svg+xml')).kind, 'text');
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
    assert.deepEqual(parser.parse(body(png, 'image/png')), { kind: 'binary', mimeType: 'image/png' });
    assert.deepEqual(parser.parse(body(png, '')), { kind: 'binary', mimeType: 'application/octet-stream' });
    assert.deepEqual(parser.parse(body('plain text', 'application/octet-stream')), { kind: 'binary', mimeType: 'application/octet-stream' });
  });

  test('base64 bodies are decoded with their declared charset', () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]);
    const data: BodyData = { mimeType: 'application/x-custom; charset=iso-8859-1', encoding: 'base64', data: Buffer.from(latin1).toString('base64'), size: 4 };
    assert.deepEqual(parser.parse(data, 'text/plain; charset=iso-8859-1'), { kind: 'text', mimeType: 'text/plain', value: 'caf\u00e9' });
  });

  test('kindOf maps media types to body kinds', () => {
    assert.equal(BodyParser.kindOf('application/json; charset=utf-8'), 'json');
    assert.equal(BodyParser.kindOf('application/vnd.api+json'), 'json');
    assert.equal(BodyParser.kindOf('text/html'), 'html');
    assert.equal(BodyParser.kindOf('multipart/form-data; boundary=x'), 'multipart');
    assert.equal(BodyParser.kindOf('application/x-www-form-urlencoded'), 'form');
    assert.equal(BodyParser.kindOf('application/graphql'), 'graphql');
    assert.equal(BodyParser.kindOf('text/csv'), 'text');
    assert.equal(BodyParser.kindOf('image/png'), 'binary');
    assert.equal(BodyParser.kindOf(''), 'empty');
  });
});

describe('BodyParser urlencoded', () => {
  test('parses per the WHATWG urlencoded parser with repeated keys as arrays', () => {
    const parsed = parser.parse(body('a=1&b=x+y&a=2&c=%E2%9C%93&d&=e&&f=%zz%2', 'application/x-www-form-urlencoded'));
    assert.equal(parsed.kind, 'form');
    assert.equal(parsed.mimeType, 'application/x-www-form-urlencoded');
    assert.deepEqual(parsed.value, { a: ['1', '2'], b: 'x y', c: '\u2713', d: '', '': 'e', f: '%zz%2' });
  });

  test('keeps a leading question mark and prototype-like names as plain own properties', () => {
    const value = BodyParser.urlencoded('?a=1&__proto__=x&constructor=y') as Record<string, unknown>;
    assert.equal(value['?a'], '1');
    assert.ok(Object.hasOwn(value, '__proto__'));
    assert.equal(Object.getOwnPropertyDescriptor(value, '__proto__')?.value, 'x');
    assert.equal(Object.getPrototypeOf(value), Object.prototype);
  });
});

describe('BodyParser multipart', () => {
  test('parses fields, repeated fields and files from a browser-style body', async () => {
    const { data, contentType } = await formData([
      ['username', 'alice'],
      ['tags', 'a'],
      ['tags', 'b'],
      ['avatar', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' }), 'me.png'],
      ['note', 'line1\r\nline2 \u00fc'],
    ]);
    const parsed = parser.parse(data, contentType);
    assert.equal(parsed.kind, 'multipart');
    assert.equal(parsed.mimeType, 'multipart/form-data');
    assert.deepEqual(parsed.value, {
      username: 'alice',
      tags: ['a', 'b'],
      avatar: { filename: 'me.png', contentType: 'image/png', size: 4 },
      note: 'line1\r\nline2 \u00fc',
    });
    assert.ok(BodyParser.isUploadedFile((parsed.value as Record<string, unknown>).avatar));
  });

  test('an empty file input (filename="") is an uploaded file of size 0', () => {
    const raw =
      '--b\r\nContent-Disposition: form-data; name="avatar"; filename=""\r\nContent-Type: application/octet-stream\r\n\r\n\r\n--b\r\nContent-Disposition: form-data; name="plain"\r\n\r\n\r\n--b--\r\n';
    assert.deepEqual(parser.parse(body(raw, 'multipart/form-data; boundary=b')).value, {
      avatar: { filename: '', contentType: 'application/octet-stream', size: 0 },
      plain: '',
    });
  });

  test('decodes the HTML escapes of quotes and newlines in names and filenames', async () => {
    const { data, contentType } = await formData([
      ['a"b', '1'],
      ['up', new Blob(['x'], { type: 'text/plain' }), 'we"ird\nname.txt'],
    ]);
    assert.ok(Http.bodyText(data).includes('name="a%22b"'));
    assert.deepEqual(parser.parse(data, contentType).value, { 'a"b': '1', up: { filename: 'we"ird\nname.txt', contentType: 'text/plain', size: 1 } });
  });

  test('finds the boundary in the body when the content type lost it, and tolerates truncation', () => {
    const raw = '--XyZ\r\nContent-Disposition: form-data; name="a"\r\n\r\n1\r\n--XyZ\r\nContent-Disposition: form-data; name="f"; filename="f.bin"\r\nContent-Type: application/octet-stream\r\n\r\nabcdef';
    const parsed = parser.parse(body(raw, 'multipart/form-data'), 'multipart/form-data');
    assert.deepEqual(parsed.value, { a: '1', f: { filename: 'f.bin', contentType: 'application/octet-stream', size: 6 } });
    assert.deepEqual(parser.parse(body('no boundary here', 'multipart/form-data')), { kind: 'multipart', mimeType: 'multipart/form-data' });
  });

  test('MultipartParser handles preamble, epilogue, missing headers and folded headers', () => {
    const raw =
      'preamble text\r\n--b\r\nContent-Disposition: form-data;\r\n name="folded"\r\n\r\nv1\r\n--b\r\n\r\nheaderless\r\n--b  \r\ncontent-disposition: form-data; name=token\r\n\r\nv2\r\n--b--\r\nepilogue';
    const parts = new MultipartParser().parse(new TextEncoder().encode(raw), 'b');
    assert.equal(parts.length, 3);
    assert.equal(parts[0]?.name, 'folded');
    assert.equal(new TextDecoder().decode(parts[0]?.data), 'v1');
    assert.equal(parts[1]?.name, undefined);
    assert.equal(new TextDecoder().decode(parts[1]?.data), 'headerless');
    assert.equal(parts[2]?.name, 'token');
    assert.ok(parts.every((part) => part.complete));
    assert.deepEqual(new MultipartParser().parse(new TextEncoder().encode('nothing'), 'b'), []);
  });

  test('boundary and parameter parsing follows RFC quoting for content types', () => {
    assert.equal(MultipartParser.boundary('multipart/form-data; boundary="a b\\"c"'), 'a b"c');
    assert.equal(MultipartParser.boundary('multipart/form-data;boundary=simple;charset=utf-8'), 'simple');
    assert.equal(MultipartParser.boundary('multipart/form-data; BOUNDARY=up'), 'up');
    assert.equal(MultipartParser.boundary('multipart/form-data'), undefined);
    assert.equal(MultipartParser.boundary(undefined), undefined);
    const disposition = MultipartParser.disposition('form-data; name="x%22y"; filename="a\\b.txt"');
    assert.equal(disposition.type, 'form-data');
    assert.equal(disposition.params.get('name'), 'x"y');
    assert.equal(disposition.params.get('filename'), 'a\\b.txt');
  });
});

describe('BodyParser GraphQL', () => {
  test('json with a query document is graphql with the given operation name', () => {
    const parsed = parser.parse(
      body(JSON.stringify({ operationName: 'GetItem', query: 'query GetItem($id: ID!) { item(id: $id) { id } }', variables: { id: '1' } }), 'application/json'),
    );
    assert.equal(parsed.kind, 'graphql');
    assert.equal(parsed.operationName, 'GetItem');
    assert.equal(parsed.mimeType, 'application/json');
  });

  test('the operation name is derived from a single named operation, not from anonymous or ambiguous documents', () => {
    assert.equal(parser.parse(body(JSON.stringify({ query: 'mutation AddItem { add { id } }' }), 'application/json')).operationName, 'AddItem');
    assert.equal(parser.parse(body(JSON.stringify({ query: '{ items { id } }' }), 'application/json')).operationName, undefined);
    assert.equal(parser.parse(body(JSON.stringify({ query: 'query A { a } query B { b }' }), 'application/json')).operationName, undefined);
  });

  test('batched requests, persisted queries and application/graphql bodies', () => {
    const batch = parser.parse(body(JSON.stringify([{ query: 'query A { a }' }, { query: 'query B { b }' }]), 'application/json'));
    assert.equal(batch.kind, 'graphql');
    assert.equal(batch.operationName, 'A,B');
    const persisted = parser.parse(
      body(JSON.stringify({ operationName: 'Feed', variables: {}, extensions: { persistedQuery: { version: 1, sha256Hash: 'abc' } } }), 'application/json'),
    );
    assert.equal(persisted.kind, 'graphql');
    assert.equal(persisted.operationName, 'Feed');
    assert.deepEqual(parser.parse(body('query Me { me { id } }', 'application/graphql')), {
      kind: 'graphql',
      mimeType: 'application/graphql',
      value: { query: 'query Me { me { id } }' },
      operationName: 'Me',
    });
  });

  test('a json body whose query is not a GraphQL document stays json', () => {
    assert.equal(parser.parse(body(JSON.stringify({ query: 'shoes', page: 1 }), 'application/json')).kind, 'json');
    assert.equal(parser.parse(body(JSON.stringify([]), 'application/json')).kind, 'json');
    assert.equal(parser.parse(body(JSON.stringify([{ query: 'query A { a }' }, { x: 1 }]), 'application/json')).kind, 'json');
  });

  test('GraphqlDocument ignores comments, strings, fragments and nested braces', () => {
    const source = `# query Fake { x }
      fragment F on Item { id }
      query List($filter: In = {tags: ["{"]}) @live { items(filter: $filter) { ...F name(arg: """ } mutation X """) } }
      mutation Save { save { ok } }
      subscription { ticks }`;
    assert.deepEqual(GraphqlDocument.operations(source), [
      { type: 'query', name: 'List' },
      { type: 'mutation', name: 'Save' },
      { type: 'subscription' },
    ]);
    assert.equal(GraphqlDocument.operationName(source), undefined);
    assert.equal(GraphqlDocument.operationName(source, 'Save'), 'Save');
    assert.equal(GraphqlDocument.operationName('{ a }', ''), undefined);
    assert.ok(GraphqlDocument.looksLikeDocument('  # c\n  query { a }'));
    assert.ok(GraphqlDocument.looksLikeDocument('{ a }'));
    assert.ok(!GraphqlDocument.looksLikeDocument('queryable'));
    assert.ok(!GraphqlDocument.looksLikeDocument('red shoes'));
    assert.ok(GraphqlDocument.looksLikeDocument('\ufeff,fragment F on X { a }'));
    assert.ok(!GraphqlDocument.looksLikeDocument('query_x { a }'));
    assert.ok(!GraphqlDocument.looksLikeDocument(''));
    assert.ok(!GraphqlDocument.looksLikeDocument('# only a comment'));
  });

  test('document detection is linear on hostile input', () => {
    const started = Date.now();
    assert.equal(GraphqlDocument.looksLikeDocument('#'.repeat(50000) + '!'), false);
    assert.equal(GraphqlDocument.looksLikeDocument(' '.repeat(50000) + '#'.repeat(50000) + '\n!'), false);
    assert.ok(Date.now() - started < 1000);
  });
});
