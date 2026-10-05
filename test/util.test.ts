import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bodyJson, bodyText, getHeader, isSameSite, isTextMime, mimeEssence, toBodyData } from '../src/util/http.js';

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
  const cut = toBodyData(new TextEncoder().encode('abcdef'), 'text/plain', 3);
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
