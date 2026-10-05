import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { FormDescriptor, JsonSchema } from '../src/model/index.js';
import { ControlRules, FormExtractor, FormSchemaBuilder, HtmlDocument } from '../src/forms/index.js';
import { Schema } from '../src/shared/index.js';
import { SchemaCheck } from './fixtures/build-schema-check.js';

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

  test('the document encoding comes from the transport, then the meta prescan, then UTF-8', () => {
    assert.equal(HtmlDocument.parse('<meta charset="iso-8859-1"><p>x', PAGE).encoding, 'windows-1252');
    assert.equal(HtmlDocument.parse('<meta http-equiv="Content-Type" content="text/html; charset=\'euc-jp\'">', PAGE).encoding, 'EUC-JP');
    assert.equal(HtmlDocument.parse('<meta charset="utf-16le">', PAGE).encoding, 'UTF-8');
    assert.equal(HtmlDocument.parse('<meta charset="windows-1251">', PAGE, { encoding: 'utf-8' }).encoding, 'UTF-8');
    assert.equal(HtmlDocument.parse('<p>x', PAGE).encoding, 'UTF-8');
  });

  test('the _charset_ field holds the name of the submission encoding', () => {
    const html = '<form method="post" accept-charset="ISO-8859-1"><input type="hidden" name="_charset_"><input name="q"></form>';
    assert.equal(prop(builder.build(form(html)).schema, '_charset_').const, 'windows-1252');
    const page = '<meta charset="windows-1252"><form method="post"><input type="hidden" name="_charset_"><input name="q"></form>';
    const built = builder.build(form(page), undefined, { documentEncoding: HtmlDocument.parse(page, PAGE).encoding });
    assert.equal(built.charset, 'windows-1252');
    assert.equal(prop(built.schema, '_charset_').const, 'windows-1252');
    assert.equal(prop(builder.build(form('<form method="post"><input type="hidden" name="_charset_"></form>')).schema, '_charset_').const, 'UTF-8');
  });
});
