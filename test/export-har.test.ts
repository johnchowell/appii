import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { ModelBuilder } from '../src/build/index.js';
import { ExchangeSanitizer, HarExporter } from '../src/export/index.js';
import type { Exchange } from '../src/model/index.js';
import { Http } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const SECRET = 'S3cr3t-XYZZY';
const TOKEN = 'TOKEN-abcdefghijklmnopqrstuvwxyz012345';

interface HarEntry {
  request: { url: string; headers: { name: string; value: string }[]; postData?: { text?: string; _appiiEncoding?: string; _appiiTruncated?: boolean } };
  response: { content: { text?: string; encoding?: string; size: number; _appiiTruncated?: boolean } };
}

function decoded(text: string | undefined, base64: boolean): string {
  if (text === undefined) return '';
  return base64 ? Buffer.from(text, 'base64').toString('latin1') : text;
}

function exportHar(factory: CaptureFactory): { text: string; entries: HarEntry[] } {
  const capture = factory.capture();
  const model = ModelBuilder.create().build(capture);
  const text = HarExporter.create().export(model, { capture }).content;
  return { text, entries: (JSON.parse(text) as { log: { entries: HarEntry[] } }).log.entries };
}

function entry(entries: HarEntry[], path: string): HarEntry {
  const found = entries.find((item) => new URL(item.request.url).pathname === path);
  assert.ok(found, path);
  return found;
}

describe('HAR export redacts every request body that api.json redacts', () => {
  test('text/plain, content-encoded and truncated request bodies never keep the secret', () => {
    const f = new CaptureFactory();
    f.exchange({ url: '/tp', method: 'POST', requestType: 'text/plain', requestBody: `user=bob\r\npassword=${SECRET}\r\n`, status: 200, responseType: 'text/plain', responseBody: 'ok' });
    f.exchange({
      url: '/gz',
      method: 'POST',
      requestHeaders: { 'content-type': 'application/json', 'content-encoding': 'gzip', 'content-length': '99' },
      requestBody: new Uint8Array(gzipSync(JSON.stringify({ user: 'bob', password: SECRET }))),
      status: 200,
      responseType: 'application/json',
      responseBody: { json: { ok: 1 } },
    });
    const b = 'BOUND';
    const multipart = `--${b}\r\nContent-Disposition: form-data; name="user"\r\n\r\nbob\r\n--${b}\r\nContent-Disposition: form-data; name="password"\r\n\r\n${SECRET}\r\n--${b}\r\nContent-Disposition: form-data; name="f"; filename="x.bin"\r\nContent-Type: application/octet-stream\r\n\r\n${'Z'.repeat(5000)}\r\n--${b}--\r\n`;
    const mp = f.exchange({ url: '/mp', method: 'POST', requestType: `multipart/form-data; boundary=${b}`, requestBody: multipart, status: 200, responseType: 'application/json', responseBody: { json: { ok: 1 } } });
    mp.request.body = Http.toBodyData(new TextEncoder().encode(multipart), `multipart/form-data; boundary=${b}`, { maxBytes: 600 });
    const form = `user=bob&password=${SECRET}&pad=${'q'.repeat(3000)}`;
    const ue = f.exchange({ url: '/form', method: 'POST', requestType: 'application/x-www-form-urlencoded', requestBody: form, status: 200, responseType: 'text/plain', responseBody: 'ok' });
    ue.request.body = Http.toBodyData(new TextEncoder().encode(form), 'application/x-www-form-urlencoded', { maxBytes: 300 });
    const { text, entries } = exportHar(f);
    assert.ok(!text.includes(SECRET));
    for (const item of entries) {
      const post = item.request.postData;
      const raw = decoded(post?.text, post?._appiiEncoding === 'base64');
      assert.ok(!raw.includes(SECRET), item.request.url);
      const coding = item.request.headers.find((header) => header.name.toLowerCase() === 'content-encoding');
      if (coding) assert.ok(!gunzipSync(Buffer.from(raw, 'latin1')).toString('utf8').includes(SECRET), item.request.url);
    }
    assert.equal(decoded(entry(entries, '/tp').request.postData?.text, false), 'user=bob\r\npassword=<redacted>\r\n');
    const gz = entry(entries, '/gz');
    assert.deepEqual(JSON.parse(decoded(gz.request.postData?.text, gz.request.postData?._appiiEncoding === 'base64')), { user: 'bob', password: '<redacted>' });
    assert.deepEqual(gz.request.headers.map((header) => header.name.toLowerCase()), ['content-type']);
    const mpEntry = entry(entries, '/mp').request.postData;
    assert.equal(mpEntry?._appiiTruncated, true);
    assert.match(decoded(mpEntry?.text, mpEntry?._appiiEncoding === 'base64'), /name="user"\r\n\r\nbob\r\n--BOUND\r\nContent-Disposition: form-data; name="password"\r\n\r\n<redacted>\r\n--BOUND\r\nContent-Disposition: form-data; name="f"; filename="x.bin"/);
    assert.equal(entry(entries, '/form').request.postData?.text, 'user=bob&password=%3Credacted%3E');
  });

  test('truncated HTML and JSON responses keep no token', () => {
    const f = new CaptureFactory();
    const html = `<!doctype html><form action="/login" method="post"><input type="hidden" name="csrf_token" value="${TOKEN}"><input name="email"></form><p>${'x'.repeat(4000)}</p><input type="hidden" name="other_token" value="${TOKEN}`;
    const page = f.document('/login', html);
    page.response!.body = Http.toBodyData(new TextEncoder().encode(html + '"></body>'), 'text/html', { maxBytes: html.length });
    const api = f.json('GET', '/api/me', 200, { token: TOKEN, pad: 'p'.repeat(3000) });
    api.response!.body = Http.toBodyData(new TextEncoder().encode(JSON.stringify({ token: TOKEN, pad: 'p'.repeat(3000) })), 'application/json', { maxBytes: 200 });
    const { text, entries } = exportHar(f);
    assert.ok(!text.includes(TOKEN));
    const content = entry(entries, '/login').response.content;
    assert.equal(content._appiiTruncated, true);
    assert.match(content.text ?? '', /name="csrf_token" value="&lt;redacted&gt;"/);
    assert.ok((content.text ?? '').endsWith('</p>'), (content.text ?? '').slice(-40));
    const json = entry(entries, '/api/me').response.content;
    assert.deepEqual([json.text, json._appiiTruncated], ['', true]);
    assert.ok(json.size > 3000);
  });

  test('HTML pages are scanned in linear time', () => {
    const sanitizer = ExchangeSanitizer.create();
    const exchange = (html: string): Exchange => ({
      id: 'p',
      source: 'browser',
      resourceType: 'document',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      request: { method: 'GET', url: 'https://shop.example.com/', headers: [] },
      response: { status: 200, statusText: 'OK', headers: [{ name: 'content-type', value: 'text/html' }], body: Http.toBodyData(new TextEncoder().encode(html), 'text/html') },
    });
    const time = (html: string): number => {
      const started = performance.now();
      sanitizer.sanitize(exchange(html));
      return performance.now() - started;
    };
    const size = 1 << 20;
    for (const unit of ['<input ', '<input a="', '<meta name=csrf-token content="']) {
      const ms = time(unit.repeat(Math.ceil(size / unit.length)));
      assert.ok(ms < 4000, `${JSON.stringify(unit)}: ${Math.round(ms)} ms`);
    }
  });
});

describe('HAR redaction keeps the other bytes of a body', () => {
  test('a windows-1252 page keeps its bytes when a token is redacted', () => {
    const page = Buffer.from('<!doctype html><p>Z\u00fcrich</p><input type="hidden" name="csrf_token" value="' + TOKEN + '">', 'latin1');
    const exchange: Exchange = {
      id: 'p',
      source: 'browser',
      resourceType: 'document',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      request: { method: 'GET', url: 'https://shop.example.com/', headers: [] },
      response: { status: 200, statusText: 'OK', headers: [{ name: 'content-type', value: 'text/html; charset=windows-1252' }], body: Http.toBodyData(new Uint8Array(page), 'text/html; charset=windows-1252') },
    };
    const out = ExchangeSanitizer.create().sanitize(exchange);
    const bytes = Buffer.from(Http.bodyBytes(out.response?.body));
    assert.equal(bytes.toString('latin1'), '<!doctype html><p>Z\u00fcrich</p><input type="hidden" name="csrf_token" value="&lt;redacted&gt;">');
  });
});
