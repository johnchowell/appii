import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeMultipart, encodeRequestBody, encodeTextPlain, urlencodeEntries } from '../src/util/encoding.js';
import { AppiiError } from '../src/util/errors.js';

test('urlencoded serializer matches WHATWG rules', () => {
  const s = urlencodeEntries([
    { name: 'a b', value: 'x+y&z=1' },
    { name: 'u', value: 'café *-._~' },
    { name: 'nl', value: 'a\nb' },
    { name: 'f', value: { filename: 'x.txt', dataBase64: '' } },
  ]);
  assert.equal(s, 'a+b=x%2By%26z%3D1&u=caf%C3%A9+*-._%7E&nl=a%0D%0Ab&f=x.txt');
  assert.equal(s, new URLSearchParams([['a b', 'x+y&z=1'], ['u', 'café *-._~'], ['nl', 'a\r\nb'], ['f', 'x.txt']]).toString());
});

test('multipart encoding escapes names and normalizes newlines', async () => {
  const { body, contentType } = encodeMultipart(
    [
      { name: 'q"x', value: 'line1\nline2' },
      { name: 'file', value: { filename: 'a.txt', contentType: 'text/plain', dataBase64: Buffer.from('hi').toString('base64') } },
      { name: 'empty', value: { filename: '', dataBase64: '' } },
    ],
    'BOUNDARY',
  );
  assert.equal(contentType, 'multipart/form-data; boundary=BOUNDARY');
  const text = Buffer.from(body).toString('utf8');
  assert.ok(text.includes('name="q%22x"\r\n\r\nline1\r\nline2\r\n'));
  assert.ok(text.includes('filename="a.txt"\r\nContent-Type: text/plain\r\n\r\nhi\r\n'));
  assert.ok(text.includes('name="empty"; filename=""\r\nContent-Type: application/octet-stream'));
  const fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': contentType }, body }).formData();
  assert.equal(fd.get('q"x'), 'line1\r\nline2');
  const f = fd.get('file') as File;
  assert.equal(await f.text(), 'hi');
});

test('text/plain and request body helpers', () => {
  assert.equal(encodeTextPlain([{ name: 'a', value: 'b' }, { name: 'c', value: 'd\ne' }]), 'a=b\r\nc=d\r\ne\r\n');
  const j = encodeRequestBody({ json: { a: 1 } });
  assert.equal(j.contentType, 'application/json');
  const f = encodeRequestBody({ form: { a: ['1', '2'], b: 'x y' } });
  assert.equal(Buffer.from(f.bytes!).toString(), 'a=1&a=2&b=x+y');
  const e = new AppiiError('TIMEOUT', 'slow');
  assert.equal(e.status, 504);
  assert.deepEqual(e.toJSON(), { error: 'TIMEOUT', message: 'slow' });
});
