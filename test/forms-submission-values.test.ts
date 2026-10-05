import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import type { FormDescriptor, JsonSchema } from '../src/model/index.js';
import { ControlRules, FormExtractor, FormSchemaBuilder, HtmlDocument } from '../src/forms/index.js';
import { Schema } from '../src/shared/index.js';
import { SchemaCheck } from './fixtures/build-schema-check.js';
import { PageServer } from './forms-harness.js';

const PAGE = 'https://example.com/form';
const extractor = FormExtractor.create();
const builder = FormSchemaBuilder.create();

function form(html: string): FormDescriptor {
  const [found] = extractor.extract(html, PAGE);
  assert.ok(found);
  return found;
}

function prop(schema: JsonSchema, name: string): JsonSchema {
  const found = Schema.properties(schema)[name];
  assert.ok(found, name);
  return found;
}

describe('values the browser submits are valid under the schema (FB-19)', () => {
  test('time, url and date inputs carry no JSON Schema format that rejects browser values', () => {
    const schema = builder.build(form('<form method="post"><input type="time" name="at" required><input type="url" name="site" required><input type="date" name="day" required></form>')).schema;
    assert.equal(prop(schema, 'at').format, undefined);
    assert.equal(prop(schema, 'site').format, undefined);
    assert.equal(prop(schema, 'day').format, undefined);
    assert.equal(prop(schema, 'site')['x-html-type'], 'url');
    for (const value of ['14:30', '23:59:59.999']) assert.ok(SchemaCheck.valid(prop(schema, 'at'), value), value);
    assert.ok(!SchemaCheck.valid(prop(schema, 'at'), '24:00'));
    assert.ok(SchemaCheck.valid(prop(schema, 'site'), 'https://b\u00fccher.example/caf\u00e9'));
    for (const value of ['2024-02-29', '12345-01-01']) assert.ok(SchemaCheck.valid(prop(schema, 'day'), value), value);
    assert.ok(!SchemaCheck.valid(prop(schema, 'day'), '2024-13-01'));
  });
});

describe('length limits count what reaches the wire (FB-20)', () => {
  test('a textarea counts each line break once in the browser and twice on the wire', () => {
    const schema = builder.build(form('<form method="post"><textarea name="t" maxlength="10"></textarea></form>')).schema;
    assert.ok(SchemaCheck.valid(prop(schema, 't'), 'abcd\r\nefg\r\nh'));
    assert.equal(prop(schema, 't')['x-html-maxlength'], 10);
  });

  test('minlength and maxlength count UTF-16 code units, JSON Schema counts code points', () => {
    const schema = builder.build(form('<form method="post"><input name="e" minlength="2" maxlength="4"></form>')).schema;
    const emoji = '\u{1F600}';
    assert.ok(SchemaCheck.valid(prop(schema, 'e'), emoji), 'one astral character has length 2 in the browser');
    assert.ok(SchemaCheck.valid(prop(schema, 'e'), 'abcd'));
    assert.ok(!SchemaCheck.valid(prop(schema, 'e'), 'abcde'));
    assert.deepEqual([prop(schema, 'e')['x-html-minlength'], prop(schema, 'e')['x-html-maxlength']], [2, 4]);
  });
});

describe('form submission encoding (FB-21)', () => {
  test('ControlRules picks the encoding like the WHATWG algorithm', () => {
    assert.equal(ControlRules.submissionEncoding('ISO-8859-1', 'UTF-8'), 'windows-1252');
    assert.equal(ControlRules.submissionEncoding(undefined, 'windows-1252'), 'windows-1252');
    assert.equal(ControlRules.submissionEncoding('bogus  shift_jis utf-8', 'UTF-8'), 'Shift_JIS');
    assert.equal(ControlRules.submissionEncoding('bogus', 'koi8-r'), 'KOI8-R');
    assert.equal(ControlRules.submissionEncoding('utf-16', 'UTF-8'), 'UTF-8');
    assert.equal(ControlRules.submissionEncoding('iso-2022-kr', 'windows-1252'), 'UTF-8');
    assert.equal(ControlRules.submissionEncoding(undefined, 'not-an-encoding'), 'UTF-8');
  });

  test('the document encoding comes from the transport, then the meta prescan, then windows-1252 as in Chromium', () => {
    assert.equal(HtmlDocument.parse('<meta charset="iso-8859-1"><p>x', PAGE).encoding, 'windows-1252');
    assert.equal(HtmlDocument.parse('<meta http-equiv="Content-Type" content="text/html; charset=\'euc-jp\'">', PAGE).encoding, 'EUC-JP');
    assert.equal(HtmlDocument.parse('<meta charset="utf-16le">', PAGE).encoding, 'UTF-8');
    assert.equal(HtmlDocument.parse('<meta charset="windows-1251">', PAGE, { encoding: 'utf-8' }).encoding, 'UTF-8');
    assert.equal(HtmlDocument.parse('<p>x', PAGE).encoding, 'windows-1252');
    assert.equal(HtmlDocument.parse('<p>caf\u00e9', PAGE).encoding, 'windows-1252');
  });

  test('the _charset_ field holds the name of the submission encoding', () => {
    const html = '<form method="post" accept-charset="ISO-8859-1"><input type="hidden" name="_charset_"><input name="q"></form>';
    assert.equal(prop(builder.build(form(html)).schema, '_charset_').const, 'windows-1252');
    const page = '<meta charset="windows-1252"><form method="post"><input type="hidden" name="_charset_"><input name="q"></form>';
    const built = builder.build(form(page), undefined, { documentEncoding: HtmlDocument.parse(page, PAGE).encoding });
    assert.equal(built.charset, 'windows-1252');
    assert.equal(prop(built.schema, '_charset_').const, 'windows-1252');
    assert.equal(prop(builder.build(form('<form method="post"><input type="hidden" name="_charset_"></form>')).schema, '_charset_').const, 'windows-1252');
    assert.equal(prop(builder.build(form('<meta charset="utf-8"><form method="post"><input type="hidden" name="_charset_"></form>')).schema, '_charset_').const, 'UTF-8');
  });

  test('the form descriptor carries the submission encoding and the schema builder uses it by default', () => {
    const page = '<meta charset="windows-1252"><form method="post"><input type="hidden" name="_charset_"><input name="q"></form>';
    const descriptor = form(page);
    assert.equal(descriptor.charset, 'windows-1252');
    assert.equal(form('<form accept-charset="ISO-8859-1"></form>').charset, 'windows-1252');
    assert.equal(form('<meta charset="shift_jis"><form accept-charset="utf-16"></form>').charset, 'UTF-8');
    assert.equal(form('<form></form>').charset, 'windows-1252');
    assert.equal(extractor.extractDocument(HtmlDocument.parse('<form></form>', PAGE, { encoding: 'koi8-r' }))[0]?.charset, 'KOI8-R');
    const built = builder.build(descriptor);
    assert.equal(built.charset, 'windows-1252');
    assert.equal(prop(built.schema, '_charset_').const, 'windows-1252');
    assert.equal(builder.build(descriptor, undefined, { documentEncoding: 'utf-8' }).charset, 'UTF-8');
  });
});

const OPTIONAL = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<form id="opt" action="/submit/optional" method="post">
  <input name="text" pattern="[a-z]+" minlength="4" maxlength="8"><input type="search" name="search" minlength="6"><input type="tel" name="tel" pattern="\\d{3}">
  <input type="password" name="pw" minlength="10"><input type="email" name="mail" pattern=".+@example\\.com"><input type="email" name="mails" multiple>
  <input type="url" name="site"><input type="number" name="num" min="1" max="9" step="2"><input type="number" name="real" step="any">
  <input type="date" name="day" min="2000-01-01"><input type="time" name="at"><input type="month" name="mo"><input type="week" name="wk">
  <input type="datetime-local" name="dt"><textarea name="note" minlength="5"></textarea>
  <button name="go" value="1">Go</button>
</form></body></html>`;

describe('optional controls left empty are sent as empty strings and are valid (FORM-EMPTY, FORM-EMAIL)', () => {
  let browser: Browser | undefined;
  let server: PageServer | undefined;
  const NUMBER = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

  before(async () => {
    server = await PageServer.start();
    browser = await PageServer.launchBrowser();
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  function typed(schema: JsonSchema, value: string): unknown {
    const types = Schema.schemaTypes(schema);
    return (types.includes('integer') || types.includes('number')) && NUMBER.test(value) ? Number(value) : value;
  }

  async function submitted(path: string, html: string, fill: (page: Page) => Promise<void>): Promise<[string, string][]> {
    assert.ok(browser && server);
    const url = server.page(path, html);
    const page = await browser.newPage();
    try {
      await page.goto(url);
      await fill(page);
      const waiting = server.waitFor((request) => new URL(request.url).pathname === '/submit/optional');
      await page.click('button[name=go]');
      const request = await waiting;
      return (await PageServer.entries(request)).map(([name, value]) => [name, typeof value === 'string' ? value : value.filename]);
    } finally {
      await page.close();
    }
  }

  test('the schema accepts exactly the empty values that Chromium sends', async () => {
    assert.ok(server);
    const descriptor = extractor.extract(OPTIONAL, server.origin + '/optional')[0];
    assert.ok(descriptor);
    const built = builder.build(descriptor);
    const entries = await submitted('/optional', OPTIONAL, async () => {});
    const names = entries.map(([name]) => name);
    assert.deepEqual(names, ['text', 'search', 'tel', 'pw', 'mail', 'mails', 'site', 'num', 'real', 'day', 'at', 'mo', 'wk', 'dt', 'note', 'go']);
    const body = Object.fromEntries(entries.map(([name, value]) => [name, typed(prop(built.schema, name), value)]));
    for (const [name, value] of entries) if (name !== 'go') assert.equal(value, '', name);
    assert.deepEqual(SchemaCheck.errors(built.schema, body), []);
    assert.deepEqual(built.schema.required, ['go']);
  });

  test('the schema accepts the filled values that Chromium sends and rejects what it blocks', async () => {
    assert.ok(server);
    const descriptor = extractor.extract(OPTIONAL, server.origin + '/optional')[0];
    assert.ok(descriptor);
    const built = builder.build(descriptor);
    const entries = await submitted('/optional-filled', OPTIONAL, async (page) => {
      await page.fill('input[name=text]', 'abcde');
      await page.fill('input[name=search]', 'search me');
      await page.fill('input[name=tel]', '123');
      await page.fill('input[name=pw]', 'correct-horse');
      await page.fill('input[name=mail]', 'first..last@example.com');
      await page.fill('input[name=mails]', ' a@b , c.@localhost ');
      await page.fill('input[name=num]', '7');
      await page.fill('input[name=real]', '2.5e1');
      await page.fill('input[name=day]', '2024-02-29');
      await page.fill('textarea[name=note]', 'hello world');
    });
    const values = Object.fromEntries(entries);
    assert.equal(values.mail, 'first..last@example.com');
    assert.equal(values.mails, 'a@b,c.@localhost');
    const body = Object.fromEntries(entries.map(([name, value]) => [name, typed(prop(built.schema, name), value)]));
    assert.deepEqual(SchemaCheck.errors(built.schema, body), []);
    const mail = prop(built.schema, 'mail');
    assert.equal(mail.format, undefined, 'RFC 5321 rejects first..last@, the HTML email grammar accepts it');
    assert.equal(mail['x-html-type'], 'email');
    assert.ok(!SchemaCheck.valid(mail, 'first.last@example.org'), 'the author pattern applies too');
    assert.ok(!SchemaCheck.valid(mail, 'not-an-email@'), 'the HTML email grammar applies');
    assert.ok(!SchemaCheck.valid(prop(built.schema, 'mails'), 'a@b,,c@d'));
    assert.ok(!SchemaCheck.valid(prop(built.schema, 'text'), 'a'), 'minlength applies to non-empty values');
    assert.ok(!SchemaCheck.valid(prop(built.schema, 'text'), 'ABCDE'), 'pattern applies to non-empty values');
    assert.ok(!SchemaCheck.valid(prop(built.schema, 'num'), 11), 'the range applies to numbers');
    assert.ok(!SchemaCheck.valid(prop(built.schema, 'num'), 'x'), 'only the empty string is allowed besides numbers');
    assert.ok(!SchemaCheck.valid(prop(built.schema, 'day'), '2024-13-01'));
  });

  test('required controls reject the empty value', () => {
    const schema = builder.build(form('<form method="post"><input type="email" name="mail" required><input type="number" name="n" required><input type="date" name="d" required><input name="t" required minlength="6"></form>')).schema;
    for (const name of ['mail', 'n', 'd', 't']) assert.ok(!SchemaCheck.valid(prop(schema, name), ''), name);
    assert.ok(SchemaCheck.valid(prop(schema, 'mail'), 'a@b'));
    assert.ok(SchemaCheck.valid(prop(schema, 'n'), 3));
    assert.ok(!SchemaCheck.valid(prop(schema, 't'), 'ab'));
    assert.ok(SchemaCheck.valid(prop(schema, 't'), 'abcdef'));
    const novalidate = builder.build(form('<form method="post" novalidate><input type="email" name="mail" required pattern="x"><input name="t" minlength="9"></form>')).schema;
    assert.ok(SchemaCheck.valid(prop(novalidate, 'mail'), 'anything at all'));
    assert.ok(SchemaCheck.valid(prop(novalidate, 't'), 'ab'));
  });
});
