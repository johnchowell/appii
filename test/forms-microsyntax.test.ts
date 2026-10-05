import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { ControlRules, HtmlDecimal, HtmlDocument, HtmlMicrosyntax, SelectorBuilder, StepRange, ValueSanitizer } from '../src/forms/index.js';
import { AppiiError } from '../src/shared/index.js';

test('HtmlMicrosyntax parses non-negative integers with the lenient HTML rules', () => {
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger('10'), 10);
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger(' 3'), 3);
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger('+7'), 7);
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger('10abc'), 10);
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger('-0'), 0);
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger('007'), 7);
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger('-1'), undefined);
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger('abc'), undefined);
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger(''), undefined);
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger(undefined), undefined);
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger('99999999999'), undefined);
  assert.equal(HtmlMicrosyntax.parseNonNegativeInteger('2147483647'), 2147483647);
});

test('HtmlMicrosyntax accepts only valid floating-point numbers', () => {
  for (const ok of ['0', '-0', '5', '.5', '-.5', '1.25', '1e3', '1E-3', '2.5e+2']) assert.ok(HtmlMicrosyntax.isValidFloat(ok), ok);
  for (const bad of ['', ' 5', '5 ', '+5', '5.', '1e', 'abc', '1e400', '0x10', 'Infinity', '1,5']) assert.ok(!HtmlMicrosyntax.isValidFloat(bad), bad);
  assert.equal(HtmlMicrosyntax.parseFloat('-0'), 0);
  assert.equal(Object.is(HtmlMicrosyntax.parseFloat('-0'), -0), false);
  assert.equal(HtmlMicrosyntax.parseFloat('x'), undefined);
});

test('HtmlMicrosyntax validates dates, months, weeks and times', () => {
  assert.ok(HtmlMicrosyntax.isValidDate('2024-02-29'));
  assert.ok(!HtmlMicrosyntax.isValidDate('2023-02-29'));
  assert.ok(!HtmlMicrosyntax.isValidDate('2020-02-30'));
  assert.ok(!HtmlMicrosyntax.isValidDate('+2020-02-03'));
  assert.ok(HtmlMicrosyntax.isValidDate('20200-02-03'));
  assert.ok(!HtmlMicrosyntax.isValidDate('0000-01-01'));
  assert.ok(!HtmlMicrosyntax.isValidDate('2020-1-01'));
  assert.ok(HtmlMicrosyntax.isValidMonth('2020-12'));
  assert.ok(!HtmlMicrosyntax.isValidMonth('2020-13'));
  assert.ok(HtmlMicrosyntax.isValidWeek('2020-W53'));
  assert.ok(HtmlMicrosyntax.isValidWeek('2015-W53'));
  assert.ok(!HtmlMicrosyntax.isValidWeek('2021-W53'));
  assert.ok(!HtmlMicrosyntax.isValidWeek('2021-W00'));
  assert.equal(HtmlMicrosyntax.weeksInYear(2026), 53);
  assert.equal(HtmlMicrosyntax.weeksInYear(2027), 52);
  assert.ok(HtmlMicrosyntax.isValidTime('23:59'));
  assert.ok(HtmlMicrosyntax.isValidTime('10:00:00.000'));
  assert.ok(!HtmlMicrosyntax.isValidTime('10:00:00.1234'));
  assert.ok(!HtmlMicrosyntax.isValidTime('24:00'));
  assert.ok(!HtmlMicrosyntax.isValidTime('10:60'));
  assert.ok(!HtmlMicrosyntax.isValidTime('10:00:00.'));
});

test('HtmlMicrosyntax normalizes local date and time strings like Chromium', () => {
  assert.equal(HtmlMicrosyntax.normalizeLocalDateTime('2020-01-01 10:00:00'), '2020-01-01T10:00');
  assert.equal(HtmlMicrosyntax.normalizeLocalDateTime('2020-01-01T10:00:00.500'), '2020-01-01T10:00:00.5');
  assert.equal(HtmlMicrosyntax.normalizeLocalDateTime('2020-01-01T10:00:00.000'), '2020-01-01T10:00');
  assert.equal(HtmlMicrosyntax.normalizeLocalDateTime('2020-01-01T10:00:07'), '2020-01-01T10:00:07');
  assert.equal(HtmlMicrosyntax.normalizeLocalDateTime('2020-01-01t10:00'), undefined);
  assert.equal(HtmlMicrosyntax.normalizeLocalDateTime('2020-02-30T10:00'), undefined);
  assert.equal(HtmlMicrosyntax.normalizeLocalDateTime('2020-01-01T25:00'), undefined);
});

test('HtmlMicrosyntax whitespace helpers use ASCII whitespace only', () => {
  assert.equal(HtmlMicrosyntax.collapse('  a \t\n b\f\r c  '), 'a b c');
  assert.equal(HtmlMicrosyntax.collapse('\u00a0a\u00a0'), '\u00a0a\u00a0');
  assert.equal(HtmlMicrosyntax.trim('\n x \t'), 'x');
  assert.equal(HtmlMicrosyntax.stripNewlines('a\r\nb\nc'), 'abc');
  assert.equal(HtmlMicrosyntax.normalizeNewlines('a\r\nb\rc'), 'a\nb\nc');
  assert.deepEqual(HtmlMicrosyntax.splitWhitespace(' a  b\tc '), ['a', 'b', 'c']);
  assert.equal(HtmlMicrosyntax.asciiLower('EMAIL\u0130'), 'email\u0130');
  assert.ok(HtmlMicrosyntax.isValidEmail('a@b'));
  assert.ok(!HtmlMicrosyntax.isValidEmail('a@-b.com'));
});

test('HtmlDecimal performs exact decimal arithmetic', () => {
  const tenth = HtmlDecimal.parse('0.1');
  const third = HtmlDecimal.parse('0.3');
  assert.ok(tenth && third);
  assert.equal(third.sub(tenth).sub(tenth).sub(tenth).toString(), '0');
  assert.equal(tenth.add(HtmlDecimal.parse('0.2') as HtmlDecimal).toString(), '0.3');
  assert.equal(third.roundedQuotient(tenth), 3n);
  assert.equal(HtmlDecimal.parse('2.5')?.roundedQuotient(HtmlDecimal.ONE), 3n);
  assert.equal(HtmlDecimal.parse('-2.5')?.roundedQuotient(HtmlDecimal.ONE), -2n);
  assert.equal(HtmlDecimal.parse('-2.6')?.roundedQuotient(HtmlDecimal.ONE), -3n);
  assert.equal(HtmlDecimal.parse('1e2')?.toString(), '100');
  assert.equal(HtmlDecimal.parse('1.50')?.toString(), '1.5');
  assert.equal(HtmlDecimal.parse('-0.000123')?.toString(), '-0.000123');
  assert.equal(HtmlDecimal.parse('1e30')?.toString(), '1e+30');
  assert.equal(HtmlDecimal.parse('-0')?.toString(), '0');
  assert.equal(HtmlDecimal.parse('1e-400')?.toString(), '0');
  assert.equal(HtmlDecimal.parse('5.'), undefined);
  assert.ok(HtmlDecimal.parse('1.0')?.isInteger());
  assert.ok(!HtmlDecimal.parse('0.5')?.isInteger());
  assert.ok(HtmlDecimal.parse('10')?.isMultipleOf(HtmlDecimal.parse('2.5') as HtmlDecimal));
  assert.ok(!HtmlDecimal.parse('10')?.isMultipleOf(HtmlDecimal.parse('3') as HtmlDecimal));
  assert.equal(HtmlDecimal.parse('7')?.half().toString(), '3.5');
  assert.equal(HtmlDecimal.of(0.25).toNumber(), 0.25);
  assert.throws(() => HtmlDecimal.of(Number.NaN), RangeError);
  assert.throws(() => HtmlDecimal.ONE.roundedQuotient(HtmlDecimal.ZERO), RangeError);
});

test('StepRange derives limits, step and step base per input type', () => {
  const range = StepRange.of({ type: 'range' });
  assert.equal(range.minimum?.toString(), '0');
  assert.equal(range.maximum?.toString(), '100');
  assert.equal(range.defaultValue().toString(), '50');
  assert.ok(range.integral && range.aligned);
  const inverted = StepRange.of({ type: 'range', min: '10', max: '5' });
  assert.equal(inverted.maximum?.toString(), '10');
  const number = StepRange.of({ type: 'number', min: 'oops', max: '9' });
  assert.equal(number.minimum, undefined);
  assert.equal(number.maximum?.toString(), '9');
  assert.equal(StepRange.of({ type: 'number', step: 'ANY' }).step, null);
  assert.equal(StepRange.of({ type: 'number', step: '0' }).step?.toString(), '1');
  assert.equal(StepRange.of({ type: 'number', step: '-2' }).step?.toString(), '1');
  assert.equal(StepRange.of({ type: 'number', step: ' 2' }).step?.toString(), '1');
  assert.equal(StepRange.of({ type: 'number', min: '1.5', value: '3' }).base.toString(), '1.5');
  assert.equal(StepRange.of({ type: 'number', value: '3' }).base.toString(), '3');
  assert.ok(!StepRange.of({ type: 'number', min: '0.5' }).integral);
  assert.ok(StepRange.of({ type: 'number', min: '10', step: '5' }).aligned);
  assert.ok(!StepRange.of({ type: 'number', min: '1', step: '5' }).aligned);
});

test('ValueSanitizer applies the WHATWG value sanitization algorithms', () => {
  const s = new ValueSanitizer();
  assert.equal(s.sanitize({ type: 'text', value: 'a\r\nb' }), 'ab');
  assert.equal(s.sanitize({ type: 'text' }), '');
  assert.equal(s.sanitize({ type: 'url', value: ' http://x.y/ \n' }), 'http://x.y/');
  assert.equal(s.sanitize({ type: 'email', value: ' a@b.c ' }), 'a@b.c');
  assert.equal(s.sanitize({ type: 'email', value: ' a@b.c , ,d@e.f ', multiple: true }), 'a@b.c,,d@e.f');
  assert.equal(s.sanitize({ type: 'number', value: ' 5' }), '');
  assert.equal(s.sanitize({ type: 'number', value: '-0' }), '-0');
  assert.equal(s.sanitize({ type: 'number', value: '.5' }), '.5');
  assert.equal(s.sanitize({ type: 'date', value: '2020-02-30' }), '');
  assert.equal(s.sanitize({ type: 'month', value: '2020-12' }), '2020-12');
  assert.equal(s.sanitize({ type: 'week', value: '2021-W53' }), '');
  assert.equal(s.sanitize({ type: 'time', value: '10:00:00.1234' }), '');
  assert.equal(s.sanitize({ type: 'datetime-local', value: '2020-01-01 10:00:00' }), '2020-01-01T10:00');
  assert.equal(s.sanitize({ type: 'color', value: '#ABCDEF' }), '#abcdef');
  assert.equal(s.sanitize({ type: 'color', value: 'red' }), '#000000');
  assert.equal(s.sanitize({ type: 'color' }), '#000000');
  assert.equal(s.sanitize({ type: 'checkbox' }), 'on');
  assert.equal(s.sanitize({ type: 'radio', value: '' }), '');
  assert.equal(s.sanitize({ type: 'file', value: 'C:\\x' }), '');
  assert.equal(s.sanitize({ type: 'hidden', value: ' keep\n ' }), ' keep\n ');
  assert.equal(s.sanitize({ type: 'range' }), '50');
  assert.equal(s.sanitize({ type: 'range', min: '0', max: '1', step: '0.1', value: '0.3' }), '0.3');
  assert.equal(s.sanitize({ type: 'range', min: '-5', max: '5', step: '2' }), '1');
  assert.equal(s.sanitize({ type: 'range', min: '10', max: '5' }), '10');
  assert.equal(s.sanitize({ type: 'range', min: '0', max: '10', step: '3', value: '10' }), '9');
  assert.equal(s.sanitize({ type: 'range', min: '0', max: '10', step: '4', value: '6' }), '8');
  assert.equal(s.sanitize({ type: 'range', min: '-10', max: '10', step: '4', value: '-5' }), '-6');
  assert.equal(s.sanitize({ type: 'range', min: '1', max: '2', step: 'any', value: 'abc' }), '1.5');
  assert.equal(s.sanitize({ type: 'range', min: '0', max: '100', step: '0.3333' }), '49.995');
  assert.equal(s.sanitize({ type: 'range', step: '7', value: '-50' }), '6');
});

test('ControlRules normalizes enumerated attributes', () => {
  assert.equal(ControlRules.inputType('EMAIL'), 'email');
  assert.equal(ControlRules.inputType('datetime'), 'text');
  assert.equal(ControlRules.inputType(' email'), 'text');
  assert.equal(ControlRules.inputType(undefined), 'text');
  assert.equal(ControlRules.buttonType(undefined, false), 'submit');
  assert.equal(ControlRules.buttonType('bogus', false), 'submit');
  assert.equal(ControlRules.buttonType(undefined, true), 'button');
  assert.equal(ControlRules.buttonType('Submit', true), 'submit');
  assert.equal(ControlRules.buttonType('RESET', false), 'reset');
  assert.equal(ControlRules.method('Post'), 'POST');
  assert.equal(ControlRules.method('dialog'), 'DIALOG');
  assert.equal(ControlRules.method('put'), 'GET');
  assert.equal(ControlRules.method('constructor'), 'GET');
  assert.equal(ControlRules.enctype('MULTIPART/FORM-DATA'), 'multipart/form-data');
  assert.equal(ControlRules.enctype('text/plain'), 'text/plain');
  assert.equal(ControlRules.enctype('application/json'), 'application/x-www-form-urlencoded');
  assert.ok(ControlRules.applies('required', 'checkbox'));
  assert.ok(!ControlRules.applies('required', 'range'));
  assert.ok(!ControlRules.applies('readonly', 'checkbox'));
  assert.ok(ControlRules.applies('dirname', 'hidden'));
});

test('SelectorBuilder escapes identifiers and strings per CSSOM with ASCII-only output', () => {
  assert.equal(SelectorBuilder.escapeIdentifier('login'), 'login');
  assert.equal(SelectorBuilder.escapeIdentifier('123'), '\\31 23');
  assert.equal(SelectorBuilder.escapeIdentifier('-1a'), '-\\31 a');
  assert.equal(SelectorBuilder.escapeIdentifier('-'), '\\-');
  assert.equal(SelectorBuilder.escapeIdentifier('a b.c'), 'a\\ b\\.c');
  assert.equal(SelectorBuilder.escapeIdentifier('caf\u00e9'), 'caf\\e9 ');
  assert.equal(SelectorBuilder.escapeIdentifier('a\u0000b'), 'a\\fffd b');
  assert.equal(SelectorBuilder.escapeString('say "hi" \\ ok'), '"say \\"hi\\" \\\\ ok"');
  assert.equal(SelectorBuilder.escapeString('line\nbreak'), '"line\\a break"');
  const ids = ['123', 'a b.c', 'caf\u00e9', 'x"y', 'q[1]'];
  const html = ids.map((id, i) => `<form id="${id.replace(/"/g, '&quot;')}" data-i="${i}"></form>`).join('');
  const $ = load(html);
  ids.forEach((id, i) => {
    const found = $(`form#${SelectorBuilder.escapeIdentifier(id)}`);
    assert.equal(found.length, 1, id);
    assert.equal(found.attr('data-i'), String(i));
    assert.ok(SelectorBuilder.escapeIdentifier(id).split('').every((ch) => ch.charCodeAt(0) < 0x80));
  });
  assert.equal($(`form[id=${SelectorBuilder.escapeString('x"y')}]`).attr('data-i'), '3');
});

test('HtmlDocument resolves the frozen base URL and rejects invalid page URLs', () => {
  const doc = HtmlDocument.parse('<base target="_top"><base href="../app/"><base href="/ignored/">', 'https://example.com/a/b/page?x=1#f');
  assert.equal(doc.url, 'https://example.com/a/b/page?x=1#f');
  assert.equal(doc.baseUrl, 'https://example.com/a/app/');
  assert.equal(doc.actionUrl(' next '), 'https://example.com/a/app/next');
  assert.equal(doc.actionUrl(''), 'https://example.com/a/b/page?x=1#f');
  assert.equal(doc.actionUrl(' \n'), 'https://example.com/a/b/page?x=1#f');
  assert.equal(doc.actionUrl(undefined), 'https://example.com/a/b/page?x=1#f');
  assert.equal(doc.actionUrl('http://[bad'), 'http://[bad');
  assert.equal(HtmlDocument.parse('<base href="data:text/html,x">', 'https://example.com/p').baseUrl, 'https://example.com/p');
  assert.equal(HtmlDocument.parse('<base href="javascript:void(0)">', 'https://example.com/p').baseUrl, 'https://example.com/p');
  assert.equal(HtmlDocument.parse('<template><base href="/t/"></template>', 'https://example.com/p').baseUrl, 'https://example.com/p');
  assert.throws(() => HtmlDocument.parse('<p>', 'not a url'), (err: unknown) => err instanceof AppiiError && err.code === 'BAD_INPUT');
});

test('HtmlDocument skips template contents but keeps foreign-content integration points', () => {
  const doc = HtmlDocument.parse(
    '<template><form id="t"></form></template><svg><foreignObject><form id="f"></form></foreignObject><input name="svg"></svg>',
    'https://example.com/',
  );
  assert.deepEqual(doc.forms().map((form) => form.attribs.id), ['f']);
  assert.equal(doc.allElements.filter((element) => element.name === 'form').length, 2);
  const svgInput = doc.elements.find((element) => element.name === 'input');
  assert.ok(svgInput && !doc.isHtml(svgInput));
});
