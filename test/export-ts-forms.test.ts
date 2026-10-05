import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TsEndpointWriter } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { TsClientHarness } from './fixtures/export-ts-harness.js';
import type { Module } from './fixtures/export-ts-harness.js';
import { CaptureFactory } from './helpers/capture-factory.js';

function find(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((endpoint) => endpoint.method === method && endpoint.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

function validatorName(endpoint: Endpoint): string {
  return `validate${TsEndpointWriter.pascal(endpoint.name)}`;
}

function codes(errors: { field: string; code: string; message: string }[]): string[][] {
  return errors.map((error) => [error.field, error.code, error.message]);
}

const ok = (): Response => new Response('ok', { status: 200, headers: { 'content-type': 'text/plain' } });

describe('generated validators and bodies for several forms on one endpoint (EXP2-3)', () => {
  let harness: TsClientHarness;
  let comments: ApiModel;
  let cart: ApiModel;
  let admin: ApiModel;
  let commentsMod: Module;
  let cartMod: Module;
  let adminMod: Module;

  before(async () => {
    harness = await TsClientHarness.open();
    const f = new CaptureFactory('https://var.example.com');
    f.document('/long', CaptureFactory.page('Long', '<form id="long" action="/comments" method="post"><textarea name="body" required minlength="10"></textarea><button name="action" value="post">Post</button></form>'));
    f.exchange({ url: '/comments', method: 'POST', pageUrl: f.url('/long'), requestType: 'application/x-www-form-urlencoded', requestBody: 'body=hello+world+long&action=post', status: 200, responseType: 'text/plain', responseBody: 'ok' });
    f.document('/quick', CaptureFactory.page('Quick', '<form id="quick" action="/comments" method="post"><input name="body" maxlength="5"><button name="action" value="quick">Quick</button></form>'));
    f.exchange({ url: '/comments', method: 'POST', pageUrl: f.url('/quick'), requestType: 'application/x-www-form-urlencoded', requestBody: 'body=hi&action=quick', status: 200, responseType: 'text/plain', responseBody: 'ok' });
    comments = TsClientHarness.build(f);
    commentsMod = (await harness.load(comments)).mod;
    const c = new CaptureFactory();
    c.snapshot(
      '/cart',
      'Cart',
      `<form method="post" action="/cart"><input type="number" name="quantity" required value="1"><button name="update" value="1">Update</button></form>
       <form method="post" action="/cart"><input name="discount" required><input type="hidden" name="source" value="coupon"><button name="apply" value="1">Apply</button></form>`,
    );
    cart = TsClientHarness.build(c);
    cartMod = (await harness.load(cart)).mod;
    const a = new CaptureFactory();
    a.snapshot('/add', 'Add', '<form method="post" action="/add"><input name="title" required maxlength="20"><input type="submit" name="_save" value="Save"><input type="submit" name="_more" value="More" formnovalidate></form>');
    admin = TsClientHarness.build(a);
    adminMod = (await harness.load(admin)).mod;
  });

  after(async () => {
    await harness?.close();
  });

  test('each form accepts its own valid input and reports the Chromium validity code of its own rules', () => {
    const validate = TsClientHarness.validator(commentsMod, validatorName(find(comments, 'POST', '/comments')));
    assert.deepEqual(validate({ body: 'hello world!', action: 'post' }), []);
    assert.deepEqual(validate({ body: 'abc', action: 'quick' }), []);
    assert.deepEqual(validate({ body: '', action: 'quick' }), []);
    assert.deepEqual(validate({ body: 'hello world!' }), []);
    assert.deepEqual(codes(validate({ body: 'short', action: 'post' })), [
      ['body', 'tooShort', 'Please lengthen this text to 10 characters or more (you are currently using 5 characters).'],
    ]);
    assert.deepEqual(codes(validate({ body: 'toolong', action: 'quick' })), [
      ['body', 'tooLong', 'Please shorten this text to 5 characters or less (you are currently using 7 characters).'],
    ]);
    assert.deepEqual(codes(validate({ body: '', action: 'post' })), [['body', 'valueMissing', 'Please fill out this field.']]);
  });

  test('a form does not check or send the fields of another form', async () => {
    const endpoint = find(cart, 'POST', '/cart');
    const validate = TsClientHarness.validator(cartMod, validatorName(endpoint));
    assert.deepEqual(validate({ quantity: 2, update: '1' }), []);
    assert.deepEqual(codes(validate({ apply: '1' })), [['discount', 'valueMissing', 'Please fill out this field.']]);
    const recorder = TsClientHarness.recorder(ok);
    const client = TsClientHarness.client(cartMod, cart, { fetch: recorder.fetch });
    await TsClientHarness.call(client, endpoint.name, { body: { quantity: 2 } });
    await TsClientHarness.call(client, endpoint.name, { body: { discount: 'SUMMER', apply: '1' } });
    assert.deepEqual(await Promise.all(recorder.sent.map((request) => TsClientHarness.text(request.body))), [
      'quantity=2&update=1',
      'discount=SUMMER&source=coupon&apply=1',
    ]);
  });

  test('only the chosen submitter is sent, and formnovalidate skips the rules', async () => {
    const endpoint = find(admin, 'POST', '/add');
    const validate = TsClientHarness.validator(adminMod, validatorName(endpoint));
    assert.deepEqual(codes(validate({ title: '' })), [['title', 'valueMissing', 'Please fill out this field.']]);
    assert.deepEqual(validate({ title: '', _more: 'More' }), []);
    const recorder = TsClientHarness.recorder(ok);
    const client = TsClientHarness.client(adminMod, admin, { fetch: recorder.fetch });
    await TsClientHarness.call(client, endpoint.name, { body: { title: 'Hello' } });
    await TsClientHarness.call(client, endpoint.name, { body: { title: '', _more: 'More' } });
    assert.deepEqual(await Promise.all(recorder.sent.map((request) => TsClientHarness.text(request.body))), ['title=Hello&_save=Save', 'title=&_more=More']);
  });
});

describe('form encodings of the generated client', () => {
  let harness: TsClientHarness;

  before(async () => {
    harness = await TsClientHarness.open();
  });

  after(async () => {
    await harness?.close();
  });

  test('a text/plain form sends name=value lines with CRLF and types the body as the form record (EXP2-7)', async () => {
    const f = new CaptureFactory('https://tp.example.com');
    f.document('/f', CaptureFactory.page('F', '<form id="t" action="/t" method="post" enctype="text/plain"><input name="a" value="1"><input name="b" value="x y"><textarea name="c">l1\nl2</textarea><button>Go</button></form>'));
    const model = TsClientHarness.build(f);
    const endpoint = find(model, 'POST', '/t');
    const { mod, source } = await harness.load(model);
    assert.match(source, new RegExp(`\\nexport interface ${TsEndpointWriter.pascal(endpoint.name)}Body \\{\\n`));
    const recorder = TsClientHarness.recorder(ok);
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    await TsClientHarness.call(client, endpoint.name, { body: { b: 'x=y\rz' } });
    const sent = recorder.sent[0];
    assert.equal(sent?.headers.get('content-type'), 'text/plain');
    assert.equal(await TsClientHarness.text(sent?.body), 'a=1\r\nb=x=y\r\nz\r\nc=l1\r\nl2\r\n');
  });

  test('a windows-1252 form sends its text in windows-1252 and unmappable characters as character references (EXP2-11)', async () => {
    const f = new CaptureFactory('https://cs.example.com');
    const html = '<!doctype html><form id="c" action="/c" method="post"><input name="city" value="Bern"><textarea name="note"></textarea><button>Go</button></form>';
    f.exchange({ url: '/f', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html; charset=windows-1252' }, responseBody: new Uint8Array(Buffer.from(html, 'latin1')) });
    f.exchange({ url: '/c', method: 'POST', resourceType: 'document', pageUrl: f.url('/f'), requestType: 'application/x-www-form-urlencoded', requestBody: 'city=Z%FCrich&note=', status: 200, responseType: 'text/plain', responseBody: 'ok' });
    const model = TsClientHarness.build(f);
    const endpoint = find(model, 'POST', '/c');
    assert.equal(endpoint.form?.charset, 'windows-1252');
    const { mod } = await harness.load(model);
    const recorder = TsClientHarness.recorder(ok);
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    const city = 'Z' + String.fromCharCode(0xfc) + 'rich';
    await TsClientHarness.call(client, endpoint.name, { body: { city, note: 'Omega ' + String.fromCharCode(0x3a9) + ' Euro ' + String.fromCharCode(0x20ac) } });
    assert.equal(await TsClientHarness.text(recorder.sent[0]?.body), 'city=Z%FCrich&note=Omega+%26%23937%3B+Euro+%80');
  });

  test('a form in a multi-byte legacy encoding needs an encoder from the caller (EXP2-11)', async () => {
    const f = new CaptureFactory('https://sj.example.com');
    const html = '<!doctype html><form id="s" action="/s" method="post"><input name="q"><button>Go</button></form>';
    f.exchange({ url: '/f', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html; charset=shift_jis' }, responseBody: new Uint8Array(Buffer.from(html, 'latin1')) });
    const model = TsClientHarness.build(f);
    const endpoint = find(model, 'POST', '/s');
    assert.equal(endpoint.form?.charset, 'Shift_JIS');
    const { mod } = await harness.load(model);
    const recorder = TsClientHarness.recorder(ok);
    const plain = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    await assert.rejects(TsClientHarness.call(plain, endpoint.name, { body: { q: 'x' } }), /Shift_JIS.*options\.encoders\["Shift_JIS"\]/);
    assert.equal(recorder.sent.length, 0);
    const encoded = TsClientHarness.client(mod, model, { fetch: recorder.fetch, encoders: { shift_jis: (text: string) => [...text].map((ch) => (ch === 'x' ? 0x82 : ch.charCodeAt(0))) } });
    await TsClientHarness.call(encoded, endpoint.name, { body: { q: 'x' } });
    assert.equal(await TsClientHarness.text(recorder.sent[0]?.body), 'q=%82');
  });

  test('only HTML form submissions convert line breaks to CRLF (EXP2-12)', async () => {
    const f = new CaptureFactory('https://nl.example.com');
    f.json('POST', '/notes', 200, { ok: 1 }, { requestType: 'application/x-www-form-urlencoded', requestBody: 'note=a%0Ab' });
    f.document('/form', CaptureFactory.page('Form', '<form action="/memo" method="post"><textarea name="memo"></textarea><button>Go</button></form>'));
    const model = TsClientHarness.build(f);
    const { mod } = await harness.load(model);
    const recorder = TsClientHarness.recorder(() => TsClientHarness.json({ ok: 1 }));
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    await TsClientHarness.call(client, find(model, 'POST', '/notes').name, { body: { note: 'a\nb' } });
    await TsClientHarness.call(client, find(model, 'POST', '/memo').name, { body: { memo: 'a\nb\rc' } });
    assert.deepEqual(await Promise.all(recorder.sent.map((request) => TsClientHarness.text(request.body))), ['note=a%0Ab', 'memo=a%0D%0Ab%0D%0Ac']);
  });
});

describe('site patterns with super-linear backtracking (EXP2-19)', () => {
  let harness: TsClientHarness;
  let model: ApiModel;
  let mod: Module;

  before(async () => {
    harness = await TsClientHarness.open();
    const f = new CaptureFactory('https://re.example.com');
    f.snapshot('/f', 'F', '<form action="/s" method="post"><input name="slow" pattern="(a+)+b"><input name="code" pattern="[a-z]+"><button>Go</button></form>');
    model = TsClientHarness.build(f);
    mod = (await harness.load(model)).mod;
  });

  after(async () => {
    await harness?.close();
  });

  test('an exponential pattern is skipped by default, so validation ends quickly, and safe patterns still apply', () => {
    const validate = TsClientHarness.validator(mod, validatorName(find(model, 'POST', '/s')));
    const started = performance.now();
    assert.deepEqual(validate({ slow: 'a'.repeat(40) + '!' }), []);
    assert.ok(performance.now() - started < 500, 'validation took too long');
    assert.deepEqual(codes(validate({ code: 'ABC' })), [['code', 'patternMismatch', 'Please match the requested format.']]);
    assert.deepEqual(codes(validate({ slow: 'aaa!' }, { unsafePatterns: true })), [['slow', 'patternMismatch', 'Please match the requested format.']]);
    assert.deepEqual(validate({ slow: 'aaab' }, { unsafePatterns: true }), []);
  });
});
