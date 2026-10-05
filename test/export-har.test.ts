import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { gunzipSync, gzipSync } from 'node:zlib';
import { BodyParser, ModelBuilder } from '../src/build/index.js';
import { ExchangeSanitizer, ExporterRegistry, HarExporter } from '../src/export/index.js';
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
    const gzText = decoded(gz.request.postData?.text, gz.request.postData?._appiiEncoding === 'base64');
    assert.deepEqual(gz.request.headers.map((header) => [header.name.toLowerCase(), header.value]), [['content-type', 'application/json'], ['content-length', String(Buffer.byteLength(gzText))]]);
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

describe('HTML responses are scanned with a tokenizer, not a tree builder (EXP2-20)', () => {
  const page = (html: string, truncated = false): Exchange => ({
    id: 'p',
    source: 'browser',
    resourceType: 'fetch',
    startedAt: '2026-01-01T00:00:00.000Z',
    durationMs: 1,
    request: { method: 'GET', url: 'https://shop.example.com/part', headers: [] },
    response: {
      status: 200,
      statusText: 'OK',
      headers: [{ name: 'content-type', value: 'text/html' }],
      body: Http.toBodyData(new TextEncoder().encode(truncated ? html + 'REST-OF-PAGE' : html), 'text/html', truncated ? { maxBytes: html.length } : {}),
    },
  });
  const harOf = (exchange: Exchange): string => {
    const f = new CaptureFactory();
    f.exchanges.push(exchange);
    return exportHar(f).text;
  };

  test('1 MiB of nested elements and 30000 unclosed template tags export a HAR quickly and without a stack overflow', () => {
    for (const html of ['<div>'.repeat((1 << 20) / 5), '<template>'.repeat(30000) + `<input name="csrf_token" value="${TOKEN}">`]) {
      const started = performance.now();
      const text = harOf(page(html));
      const ms = performance.now() - started;
      assert.ok(ms < 1000, `${html.slice(0, 10)}: ${Math.round(ms)} ms`);
      assert.ok(!text.includes(TOKEN));
    }
  });

  test('many token fields are replaced in linear time', () => {
    const html = `<input type="hidden" name="csrf_token" value="${TOKEN}">`.repeat(20000);
    const started = performance.now();
    const out = Http.bodyText(ExchangeSanitizer.create().sanitize(page(html)).response?.body);
    assert.ok(performance.now() - started < 2000);
    assert.equal(out, '<input type="hidden" name="csrf_token" value="&lt;redacted&gt;">'.repeat(20000));
  });

  test('a truncated page is cut before a tag that the cut left open, also right after text', () => {
    const html = `<p>intro</p>text before <input type="hidden" name="csrf_token" value="${TOKEN.slice(0, 20)}`;
    const out = Http.bodyText(ExchangeSanitizer.create().sanitize(page(html, true)).response?.body);
    assert.equal(out, '<p>intro</p>text before ');
  });

  test('markup inside script, style, textarea and title is text; svg title and style hold markup; noscript is scanned', () => {
    const field = (name: string) => `<input name="${name}" value="${TOKEN}">`;
    const html = [
      `<script><!-- <script> ${field('csrf_token')} </script> --></script>`,
      `<style>${field('csrf_token')}</style><textarea>${field('csrf_token')}</textarea><title>${field('csrf_token')}</title>`,
      `<svg><title>${field('a_token')}</title><style>${field('b_token')}</style></svg><noscript>${field('c_token')}</noscript>`,
      `<math><mtext><style>${field('csrf_token')}</style></mtext></math><svg><p></svg><textarea>${field('csrf_token')}</textarea>`,
    ].join('');
    const out = Http.bodyText(ExchangeSanitizer.create().sanitize(page(html)).response?.body);
    const kept = out.split(TOKEN).length - 1;
    assert.equal(kept, 6, out);
    for (const name of ['a_token', 'b_token', 'c_token']) assert.ok(out.includes(`<input name="${name}" value="&lt;redacted&gt;">`), name);
  });
});

describe('HAR redaction keeps the request headers consistent with the body (REG-7)', () => {
  test('a redacted urlencoded body gets the Content-Length of the new bytes', () => {
    const f = new CaptureFactory();
    const form = `csrf_token=${TOKEN}&email=user%40example.com&password=${SECRET}&action=login`;
    f.exchange({ url: '/login', method: 'POST', resourceType: 'document', requestHeaders: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': String(form.length) }, requestBody: form, status: 302 });
    const login = entry(exportHar(f).entries, '/login').request;
    const text = login.postData?.text ?? '';
    assert.equal(text, 'csrf_token=%3Credacted%3E&email=user%40example.com&password=%3Credacted%3E&action=login');
    assert.equal(login.headers.find((header) => header.name.toLowerCase() === 'content-length')?.value, String(Buffer.byteLength(text)));
  });
});

describe('fields that a linked form proves secret, whatever their names (FB-2)', () => {
  test('GET, POST and text/plain password fields with non-English names are redacted in the model, JSON, HTML and HAR', () => {
    const secrets = ['GEHEIMWERT77', 'MOTDEPASSE88', 'KENNWORT99'];
    const f = new CaptureFactory('https://site.example.com');
    const html = CaptureFactory.page(
      'Forms',
      '<form action="/search"><input name="q"><input type="password" name="geheim"></form>' +
        '<form method="post" action="/connexion"><input name="identifiant"><input type="password" name="mot_de_passe"></form>' +
        '<form method="post" action="/notiz" enctype="text/plain"><input name="name"><input type="password" name="kennwort"></form>',
    );
    f.document('/forms', html);
    f.snapshot('/forms', 'Forms', html);
    f.document(`/search?q=hello&geheim=${secrets[0]}`, CaptureFactory.page('Results', 'ok'));
    f.exchange({ method: 'POST', url: '/connexion', resourceType: 'document', status: 302, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: `identifiant=bob&mot_de_passe=${secrets[1]}` });
    f.exchange({ method: 'POST', url: '/notiz', resourceType: 'document', status: 200, requestHeaders: { 'content-type': 'text/plain' }, requestBody: `name=bob\r\nkennwort=${secrets[2]}\r\n` });
    const capture = f.capture();
    const model = ModelBuilder.create().build(capture);
    const outputs = {
      model: JSON.stringify(model),
      json: ExporterRegistry.default().get('json').export(model, { capture }).content,
      html: ExporterRegistry.default().get('html').export(model, { capture }).content,
      har: HarExporter.create().export(model, { capture }).content,
    };
    for (const [name, text] of Object.entries(outputs)) assert.deepEqual(secrets.filter((secret) => text.includes(secret)), [], name);
    const search = model.endpoints.find((endpoint) => endpoint.path === '/search');
    assert.ok(search?.samples.some((sample) => sample.url === 'https://site.example.com/search?q=hello&geheim=%3Credacted%3E'), JSON.stringify(search?.samples));
  });
});

describe('HAR redaction of text bodies that are not form data (REG-4)', () => {
  test('code and prose in text bodies pass through unchanged', () => {
    const js = 'function check(password) {\n  if (password.length >= 8) return true;\n  const tokenKey = "app.token";\n  return false;\n}\nvar sessionTimeout = 30;\n';
    const minified = '!function(){var e={authToken:null,setToken:function(t){this.authToken=t}},n=1;window.api=e}();\n';
    const f = new CaptureFactory();
    f.exchange({ url: '/api/config', method: 'GET', status: 200, responseType: 'text/plain', responseBody: js });
    f.exchange({ url: '/api/loader', method: 'GET', status: 200, responseType: 'application/javascript', responseBody: minified });
    f.exchange({ url: '/api/env', method: 'GET', status: 200, responseType: 'text/plain', responseBody: `mode=production\napi_token=${TOKEN}\n` });
    const { entries } = exportHar(f);
    assert.equal(entry(entries, '/api/config').response.content.text, js);
    assert.equal(entry(entries, '/api/loader').response.content.text, minified);
    assert.equal(entry(entries, '/api/env').response.content.text, 'mode=production\napi_token=<redacted>\n');
  });

  test('the same text bodies keep their bytes in the model examples', () => {
    const js = 'if (password.length >= 8) return true;\nvar sessionTimeout = 30;\n';
    const f = new CaptureFactory();
    f.exchange({ url: '/api/config', method: 'GET', status: 200, responseType: 'text/plain', responseBody: js });
    const model = ModelBuilder.create().build(f.capture());
    const config = model.endpoints.find((endpoint) => endpoint.path === '/api/config');
    assert.deepEqual(config?.responses[0]?.body?.examples, [js]);
  });
});

describe('legacy-charset multipart bodies (legacy charset residuals b and c)', () => {
  const boundary = 'B0UND';
  const part = (name: string, value: string): string => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
  const latin1 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));
  const body = latin1(part('Stra\u00dfe', 'Z\u00fcrich') + part('meta', '{"city":"Z\u00fcrich","token":"T0KEN-123"}') + part('password', 'pw') + `--${boundary}--\r\n`);

  test('field names and values decode with the form charset', () => {
    const parsed = BodyParser.create().parse(Http.toBodyData(body, `multipart/form-data; boundary=${boundary}`), `multipart/form-data; boundary=${boundary}`, { formEncoding: 'windows-1252' });
    assert.deepEqual(parsed.value, { 'Stra\u00dfe': 'Z\u00fcrich', meta: '{"city":"Z\u00fcrich","token":"T0KEN-123"}', password: 'pw' });
  });

  test('redaction rewrites the changed parts and the part headers in the form charset', () => {
    const exchange: Exchange = {
      id: 'm',
      source: 'browser',
      resourceType: 'document',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      request: { method: 'POST', url: 'https://shop.example.com/send', headers: [{ name: 'content-type', value: `multipart/form-data; boundary=${boundary}` }], body: Http.toBodyData(body, `multipart/form-data; boundary=${boundary}`) },
    };
    const out = ExchangeSanitizer.create().sanitize(exchange, { formCharset: 'windows-1252' });
    const expected = latin1(part('Stra\u00dfe', 'Z\u00fcrich') + part('meta', '{"city":"Z\u00fcrich","token":"<redacted>"}') + part('password', '<redacted>') + `--${boundary}--\r\n`);
    assert.equal(Buffer.from(Http.bodyBytes(out.request.body)).toString('hex'), Buffer.from(expected).toString('hex'));
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
