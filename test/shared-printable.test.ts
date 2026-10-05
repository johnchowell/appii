import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Ansi, Text } from '../src/shared/index.js';

const CONTROLS = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join('') + '\x7f' + Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(0x80 + i)).join('');

function visible(text: string): boolean {
  return /^[\x20-\x7e\n]*$/.test(text);
}

describe('Text.printable', () => {
  test('renders C0 controls, DEL and C1 controls as visible \\xNN escapes on one line', () => {
    assert.equal(Text.printable('a\x1b[31mb\x07c\x08d\x00e\x7ff\x9bg'), 'a\\x1b[31mb\\x07c\\x08d\\x00e\\x7ff\\x9bg');
    assert.equal(Text.printable('\x85\x9f\x80'), '\\x85\\x9f\\x80');
    const out = Text.printable(CONTROLS);
    assert.ok(visible(out), out);
    assert.ok(!out.includes('\n'));
  });

  test('turns line breaks and tabs into spaces by default and keeps line feeds in block mode', () => {
    assert.equal(Text.printable('a\r\nb\rc\nd\te'), 'a b c d e');
    assert.equal(Text.printable('a\r\nb\rc\nd\te\x1b', { lineBreaks: 'normalize' }), 'a\nb\nc\nd\\x09e\\x1b');
    assert.ok(visible(Text.printable(CONTROLS, { lineBreaks: 'normalize' })));
    assert.equal(Text.printable('a\r\nb\rc\nd\te', { lineBreaks: 'lf' }), 'a\\x0d\nb\\x0dc\nd\\x09e');
  });

  test('escapes the other non-ASCII characters as JavaScript escapes', () => {
    assert.equal(Text.printable('caf\u00e9 \u2028 \u{1f600}'), 'caf\\u00e9 \\u2028 \\ud83d\\ude00');
    assert.equal(Text.printable('plain text'), 'plain text');
    assert.equal(Text.printable(Text.printable('x\x1by\u00e9')), Text.printable('x\x1by\u00e9'));
  });
});

describe('Ansi.printable', () => {
  test('keeps the SGR styles that Ansi makes and escapes every other control sequence', () => {
    const styled = Ansi.color.red('red') + ' \x1b]0;title\x07 \x1b[2J \r\x08' + Ansi.color.bold('b');
    const out = Ansi.printable(styled);
    assert.equal(out, '\x1b[31mred\x1b[39m \\x1b]0;title\\x07 \\x1b[2J \\x0d\\x08\x1b[1mb\x1b[22m');
    assert.equal(Ansi.strip(out), 'red \\x1b]0;title\\x07 \\x1b[2J \\x0d\\x08b');
    assert.ok(visible(Ansi.strip(out)));
  });

  test('keeps line feeds, and without styles escapes SGR sequences too', () => {
    assert.equal(Ansi.printable('a\nb\r\nc'), 'a\nb\\x0d\nc');
    assert.equal(Ansi.printable('\x1b[31mx\x1b[0m', false), '\\x1b[31mx\\x1b[0m');
    assert.equal(Ansi.plain.printable('\x1b[31mx\x1b[0m'), '\\x1b[31mx\\x1b[0m');
    assert.equal(Ansi.color.printable('\x1b[31mx\x1b[0m'), '\x1b[31mx\x1b[0m');
    assert.equal(Ansi.printable('\x1b[5mblink\x1b[8mhidden\x1b[38;5;196mred'), '\\x1b[5mblink\\x1b[8mhidden\\x1b[38;5;196mred');
    assert.equal(Ansi.printable(Ansi.color.gray('g') + Ansi.color.dim('d') + Ansi.truncate(Ansi.color.cyan('abcdef'), 4)), Ansi.color.gray('g') + Ansi.color.dim('d') + Ansi.truncate(Ansi.color.cyan('abcdef'), 4));
  });

  test('statusLine is the only place that builds the carriage return and erase-line sequence', () => {
    assert.equal(Ansi.statusLine('busy'), '\rbusy\x1b[K');
    assert.equal(Ansi.statusLine(''), '\r\x1b[K');
  });
});
