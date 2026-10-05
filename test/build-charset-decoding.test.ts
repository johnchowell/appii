import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BodyParser, ModelBuilder } from '../src/build/index.js';
import { ControlRules } from '../src/forms/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { CharsetEncoder, HtmlEncodingSniffer, Http, Schema, SingleByteIndexes } from '../src/shared/index.js';
import { TsClientHarness } from './fixtures/export-ts-harness.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const EURO = String.fromCharCode(0x20ac);
const C1 = String.fromCharCode(0x80);

function latin1(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, 'latin1'));
}

function find(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((endpoint) => endpoint.method === method && endpoint.path === path);
  assert.ok(found, `${method} ${path}`);
  return found;
}

describe('Shared CharsetEncoder.decode follows the WHATWG single-byte indexes (BUILD-1252)', () => {
  test('windows-1252 and its labels decode 0x80 to 0x9F with the windows-1252 index, not as C1 controls', () => {
    const bytes = Uint8Array.of(0x41, 0x80, 0x82, 0x9f, 0x81, 0xe9);
    const expected = 'A' + String.fromCharCode(0x20ac, 0x201a, 0x0178, 0x0081, 0x00e9);
    for (const label of ['windows-1252', 'latin1', 'ISO-8859-1', ' ascii ', 'us-ascii', 'cp1252', 'x-cp1252']) assert.equal(CharsetEncoder.decode(bytes, label), expected, label);
  });

  test('the indexes where ICU differs from the Encoding Standard and the encoding that Node.js does not have', () => {
    const decode = (label: string, byte: number) => CharsetEncoder.decode(Uint8Array.of(byte), label).charCodeAt(0);
    assert.equal(decode('koi8-u', 0xae), 0x045e);
    assert.equal(decode('koi8-u', 0xbe), 0x040e);
    assert.equal(decode('windows-1255', 0xca), 0x05ba);
    assert.equal(decode('windows-1253', 0xaa), 0xfffd);
    assert.equal(decode('windows-874', 0xdb), 0xfffd);
    assert.equal(decode('iso-8859-16', 0xa1), 0x0104);
    assert.equal(CharsetEncoder.canonical(' ISO-8859-16 '), 'iso-8859-16');
    assert.equal(CharsetEncoder.canonical('logical'), 'iso-8859-8-i');
    assert.equal(decode('iso-8859-8-i', 0xe0), 0x05d0);
    assert.equal(decode('x-user-defined', 0x80), 0xf780);
    assert.equal(decode('x-user-defined', 0xff), 0xf7ff);
    assert.deepEqual([...CharsetEncoder.for('x-user-defined').encode(String.fromCharCode(0x41, 0xf7a0))], [0x41, 0xa0]);
    assert.throws(() => CharsetEncoder.decode(Uint8Array.of(0xaa), 'windows-1253', { fatal: true }), TypeError);
    assert.throws(() => CharsetEncoder.decode(Uint8Array.of(0x41), 'no-such-encoding'), RangeError);
    assert.equal(CharsetEncoder.decode(new TextEncoder().encode(EURO), 'utf-8'), EURO);
    assert.equal(ControlRules.encodingName('latin1'), 'windows-1252');
    assert.equal(ControlRules.encodingName('iso-8859-16'), 'ISO-8859-16');
  });

  test('every single-byte index decodes and encodes the same bytes back', () => {
    for (const name of SingleByteIndexes.names()) {
      const points = SingleByteIndexes.codePoints(name) ?? [];
      assert.equal(points.length, 0x80, name);
      const bytes = Uint8Array.from(points.flatMap((cp, i) => (cp === undefined ? [] : [0x80 + i])));
      const text = CharsetEncoder.decode(bytes, name, { fatal: true });
      assert.deepEqual([...CharsetEncoder.for(name).encode(text)], [...bytes], name);
    }
    assert.equal(CharsetEncoder.for('iso-8859-16').exact, true);
  });

  test('a long body decodes in parts', () => {
    const bytes = new Uint8Array(100_000).fill(0x80);
    assert.equal(CharsetEncoder.decode(bytes, 'windows-1252'), EURO.repeat(100_000));
  });
});

describe('Build decodes windows-1252 pages and form submissions with the WHATWG index (BUILD-1252)', () => {
  const f = new CaptureFactory('https://shop.example.com');
  const html = `<!doctype html><html><head><title>Order</title></head><body><form id="order" action="/order" method="post"><input name="price" value="10 ${C1}"><textarea name="note"></textarea><button>Go</button></form><form id="upload" action="/upload" method="post" enctype="multipart/form-data"><input name="memo"><button>Send</button></form></body></html>`;
  f.exchange({ url: '/form', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html; charset=windows-1252' }, responseBody: latin1(html) });
  f.exchange({
    url: '/order',
    method: 'POST',
    resourceType: 'document',
    pageUrl: f.url('/form'),
    requestType: 'application/x-www-form-urlencoded',
    requestBody: 'price=10+%80&note=caf%E9',
    status: 200,
    responseType: 'text/plain',
    responseBody: 'ok',
  });
  const boundary = 'XyZ';
  const multipart = `--${boundary}\r\nContent-Disposition: form-data; name="memo"\r\n\r\n5 ${C1}\r\n--${boundary}--\r\n`;
  f.exchange({
    url: '/upload',
    method: 'POST',
    resourceType: 'document',
    pageUrl: f.url('/form'),
    requestType: `multipart/form-data; boundary=${boundary}`,
    requestBody: latin1(multipart),
    status: 200,
    responseType: 'text/plain',
    responseBody: 'ok',
  });
  const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());

  test('the form default with byte 0x80 is the euro sign in the model', () => {
    const form = model.forms.find((item) => item.selector === 'form#order');
    assert.equal(form?.charset, 'windows-1252');
    assert.equal(form?.fields.find((field) => field.name === 'price')?.value, `10 ${EURO}`);
    const order = find(model, 'POST', '/order');
    assert.equal(order.form?.fields.find((field) => field.name === 'price')?.value, `10 ${EURO}`);
    assert.equal(Schema.properties(order.requestBody?.schema).price?.default, `10 ${EURO}`);
  });

  test('urlencoded and multipart submissions of the page decode their bytes with the windows-1252 index', () => {
    assert.deepEqual(find(model, 'POST', '/order').requestBody?.examples, [{ price: `10 ${EURO}`, note: 'caf' + String.fromCharCode(0xe9) }]);
    assert.deepEqual(find(model, 'POST', '/upload').requestBody?.examples, [{ memo: `5 ${EURO}` }]);
  });

  test('a multipart body names its own encoding with the _charset_ field', () => {
    const body = `--${boundary}\r\nContent-Disposition: form-data; name="_charset_"\r\n\r\nwindows-1252\r\n--${boundary}\r\nContent-Disposition: form-data; name="memo"\r\n\r\n${C1}\r\n--${boundary}--\r\n`;
    const parsed = BodyParser.create().parse(Http.toBodyData(latin1(body), `multipart/form-data; boundary=${boundary}`), `multipart/form-data; boundary=${boundary}`);
    assert.deepEqual(parsed.value, { _charset_: 'windows-1252', memo: EURO });
  });
});

describe('HTML encoding sniffing of stored document bytes (legacy charset residual a)', () => {
  const bytes = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, 'latin1'));
  test('the BOM, then the transport charset, then the meta prescan, then windows-1252', () => {
    assert.equal(HtmlEncodingSniffer.sniff(new Uint8Array([0xef, 0xbb, 0xbf, 0x3c]), 'windows-1252'), 'utf-8');
    assert.equal(HtmlEncodingSniffer.sniff(new Uint8Array([0xff, 0xfe, 0x3c, 0x00])), 'utf-16le');
    assert.equal(HtmlEncodingSniffer.sniff(bytes('<meta charset="koi8-r">'), 'iso-8859-2'), 'iso-8859-2');
    assert.equal(HtmlEncodingSniffer.sniff(bytes('<!doctype html><META CHARSET=koi8-r>')), 'koi8-r');
    assert.equal(HtmlEncodingSniffer.sniff(bytes('<meta http-equiv="Content-Type" content="text/html; charset=shift_jis">')), 'shift_jis');
    assert.equal(HtmlEncodingSniffer.sniff(bytes('<meta content="text/html; charset=shift_jis">')), 'windows-1252');
    assert.equal(HtmlEncodingSniffer.sniff(bytes('<!-- <meta charset="koi8-r"> --><meta charset="iso-8859-7">')), 'iso-8859-7');
    assert.equal(HtmlEncodingSniffer.sniff(bytes('<p title="<meta charset=koi8-r>">x</p>')), 'windows-1252');
    assert.equal(HtmlEncodingSniffer.sniff(bytes('<meta charset="utf-16">')), 'utf-8');
    assert.equal(HtmlEncodingSniffer.sniff(bytes('<p>caf\u00e9</p>')), 'windows-1252');
  });

  test('an unlabeled windows-1252 page stored as bytes yields its text and its forms', () => {
    const f = new CaptureFactory('https://shop.example.com');
    const html = '<!doctype html><title>Caf\u00e9</title><form action="/order" method="post"><input name="item" value="caf\u00e9"><button>Go</button></form>';
    f.exchange({ url: '/menu', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html' }, responseBody: bytes(html) });
    const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
    const form = model.forms.find((item) => new URL(item.action).pathname === '/order');
    assert.equal(form?.charset, 'windows-1252');
    assert.equal(form?.fields.find((field) => field.name === 'item')?.value, 'caf\u00e9');
  });
});

describe('a byte order mark decides the document encoding before any declaration (FB-21)', () => {
  const utf8 = (text: string): Uint8Array => new Uint8Array(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]));
  const page = (meta: string): string => `<!doctype html><html><head>${meta}<title>Search</title></head><body><form action="/search"><input type="hidden" name="_charset_"><input name="q" value="caf\u00e9"></form></body></html>`;
  const build = (contentType: string, meta: string, characterSet?: string): ApiModel => {
    const f = new CaptureFactory('https://shop.example.com');
    const html = page(meta);
    f.exchange({ url: '/page', resourceType: 'document', status: 200, responseHeaders: { 'content-type': contentType }, responseBody: utf8(html) });
    const snapshot = f.snapshot('/page', 'Search', html);
    if (characterSet !== undefined) snapshot.characterSet = characterSet;
    f.exchange({ url: '/search?_charset_=UTF-8&q=caf%C3%A9', resourceType: 'document', status: 200, responseType: 'text/html', responseBody: '<p>ok</p>' });
    return ModelBuilder.create({ now: new Date(0) }).build(f.capture());
  };

  for (const [label, contentType, meta] of [
    ['a windows-1252 Content-Type header', 'text/html; charset=windows-1252', ''],
    ['a windows-1252 meta charset', 'text/html', '<meta charset="windows-1252">'],
  ] as const) {
    test(`a UTF-8 page with a BOM and ${label} submits its forms as UTF-8`, () => {
      const model = build(contentType, meta);
      const search = find(model, 'GET', '/search');
      assert.equal(search.form?.charset, 'UTF-8');
      assert.equal(search.queryParams.find((param) => param.name === '_charset_')?.schema.const, 'UTF-8');
      assert.deepEqual(search.queryParams.find((param) => param.name === 'q')?.examples, ['caf\u00e9']);
    });
  }

  test('the document encoding that the browser reported for a snapshot wins over the response headers', () => {
    const model = build('text/html; charset=windows-1252', '', 'UTF-8');
    assert.equal(find(model, 'GET', '/search').form?.charset, 'UTF-8');
  });
});

describe('the generated client decodes windows-1252 pages with the WHATWG index (BUILD-1252)', () => {
  let harness: TsClientHarness;

  before(async () => {
    harness = await TsClientHarness.open();
  });

  after(async () => {
    await harness?.close();
  });

  test('a token with byte 0x80 from a windows-1252 page is sent back as the same byte', async () => {
    const f = new CaptureFactory('https://tok.example.com');
    const page = (token: string) => `<!doctype html><form action="/send" method="post"><input type="hidden" name="csrf_token" value="${token}"><input name="q"><button>Go</button></form>`;
    f.exchange({ url: '/form', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html; charset=windows-1252' }, responseBody: latin1(page('tok-0000000000000000')) });
    f.exchange({ url: '/send', method: 'POST', resourceType: 'document', pageUrl: f.url('/form'), requestType: 'application/x-www-form-urlencoded', requestBody: 'csrf_token=tok-0000000000000000&q=x', status: 200, responseType: 'text/plain', responseBody: 'ok' });
    const model = TsClientHarness.build(f);
    const endpoint = find(model, 'POST', '/send');
    const { mod, source } = await harness.load(model);
    assert.match(source, /const SINGLE_BYTE_INDEXES: Record<string, string> = \{\n? *"windows-1252": "\\u20ac\\u0081\\u201a/);
    const recorder = TsClientHarness.recorder(async (request) =>
      request.method === 'GET' ? new Response(Buffer.from(page(`T${C1}1`), 'latin1'), { status: 200, headers: { 'content-type': 'text/html; charset=windows-1252' } }) : new Response('ok'),
    );
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    await TsClientHarness.call(client, endpoint.name, { body: { q: 'x' } });
    assert.equal(await TsClientHarness.text(recorder.sent[1]?.body), 'csrf_token=T%801&q=x');
  });
});
