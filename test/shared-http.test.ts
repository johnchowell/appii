import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyBytes, bodyJson, bodyText, decodeComponent, getHeader, isIpAddress, isLoopbackHost, isPotentiallyTrustworthy, isSameSite, isTextMime, mimeEssence, parseUrl, toBodyData, utf8Prefix } from '../src/shared/http.js';

test('header helpers', () => {
  const h = [
    { name: 'Set-Cookie', value: 'a=1' },
    { name: 'set-cookie', value: 'b=2' },
    { name: 'Accept', value: 'x' },
  ];
  assert.equal(getHeader(h, 'set-cookie'), 'a=1\nb=2');
  assert.equal(getHeader(h, 'ACCEPT'), 'x');
  assert.equal(getHeader(h, 'missing'), undefined);
});

test('body data keeps text and binary', () => {
  const t = toBodyData(new TextEncoder().encode('{"a":1}'), 'application/json; charset=utf-8');
  assert.equal(t.encoding, 'utf8');
  assert.deepEqual(bodyJson(t), { a: 1 });
  const b = toBodyData(new Uint8Array([0, 255, 1]), 'image/png');
  assert.equal(b.encoding, 'base64');
  const cut = toBodyData(new TextEncoder().encode('abcdef'), 'text/plain', { maxBytes: 3 });
  assert.equal(cut.truncated, true);
  assert.equal(bodyText(cut), 'abc');
  assert.equal(cut.size, 6);
});

test('mime and site helpers', () => {
  assert.equal(mimeEssence('Text/HTML; charset=utf-8'), 'text/html');
  assert.ok(isTextMime('application/vnd.api+json'));
  assert.ok(!isTextMime('image/png'));
  assert.ok(isSameSite('https://a.example.com/x', 'https://b.example.com/y'));
  assert.ok(!isSameSite('https://a.example.com/x', 'https://example.org/y'));
  assert.ok(isSameSite('https://a.example.co.uk/', 'https://b.example.co.uk/'));
  assert.ok(!isSameSite('https://alice.github.io/', 'https://bob.github.io/'));
  assert.ok(isSameSite('http://127.0.0.1:1/', 'http://127.0.0.1:2/'));
});

test('body data keeps the exact bytes of non-UTF-8 text and content-encoded bodies', async () => {
  const { gzipSync } = await import('node:zlib');
  const latin1 = Buffer.from('caf\xe9', 'latin1');
  const html = toBodyData(latin1, 'text/html; charset=windows-1252');
  assert.equal(html.encoding, 'base64');
  assert.equal(Buffer.from(bodyBytes(html)).toString('hex'), '636166e9');
  const gzip = gzipSync(Buffer.from('{"event":"view","user":42}'));
  const compressed = toBodyData(gzip, 'text/plain;charset=UTF-8', { contentEncoding: 'gzip' });
  assert.equal(compressed.encoding, 'base64');
  assert.deepEqual(Buffer.from(bodyBytes(compressed)), gzip);
  const utf8 = toBodyData(Buffer.from('caf\u00e9 \u{1F600}', 'utf8'), 'text/plain', { contentEncoding: 'identity' });
  assert.equal(utf8.encoding, 'utf8');
  assert.equal(utf8.data, 'caf\u00e9 \u{1F600}');
  const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x61]);
  assert.deepEqual(Buffer.from(bodyBytes(toBodyData(bom, 'text/plain'))), bom);
  const cut = toBodyData(Buffer.from('\u00e9\u00e9', 'utf8'), 'text/plain', { maxBytes: 3 });
  assert.equal(cut.encoding, 'utf8');
  assert.equal(cut.data, '\u00e9');
  assert.equal(cut.truncated, true);
  assert.equal(utf8Prefix('a\u00e9b', 2), 'a');
  assert.equal(utf8Prefix('a\u0000b', 10), 'a\u0000b');
});

test('potentially trustworthy URLs follow the WHATWG secure context rules', () => {
  const trusted = ['https://example.com/', 'wss://example.com/', 'http://localhost/', 'http://localhost./', 'http://app.localhost/', 'http://a.localhost./', 'http://127.0.0.1/', 'http://127.8.0.1:8080/', 'ws://[::1]:9/', 'http://[0::1]/'];
  for (const url of trusted) assert.equal(isPotentiallyTrustworthy(new URL(url)), true, url);
  const untrusted = ['http://example.com/', 'ftp://localhost/', 'http://128.0.0.1/', 'http://[::2]/', 'http://localhost.example.com/', 'ws://example.com/'];
  for (const url of untrusted) assert.equal(isPotentiallyTrustworthy(new URL(url)), false, url);
  assert.equal(isLoopbackHost('0:0:0:0:0:0:0:1'), true);
  assert.equal(isLoopbackHost('[::1]'), true);
  assert.equal(isIpAddress('[2001:db8::1]'), true);
  assert.equal(isIpAddress('example.com'), false);
});

test('safe URL parsing and percent decoding', () => {
  assert.equal(parseUrl('https://example.com/a')?.pathname, '/a');
  assert.equal(parseUrl('not a url'), undefined);
  assert.equal(parseUrl(undefined), undefined);
  assert.equal(decodeComponent('caf%C3%A9'), 'caf\u00e9');
  assert.equal(decodeComponent('%E0%A4%A'), '%E0%A4%A');
});
