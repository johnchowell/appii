import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFragment } from 'parse5';
import { Json, Text } from '../src/shared/index.js';

const CONTROLS = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join('') + '\x7f' + Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(0x80 + i)).join('');

interface TextNode {
  nodeName: string;
  value?: string;
  childNodes?: TextNode[];
}

function textOf(node: TextNode): string {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(textOf).join('');
}

function shown(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/g, Text.controlEscape);
}

describe('Text.escapeHtml', () => {
  test('keeps CR, shows other controls as visible escapes, and writes non-ASCII as references', () => {
    const value = '\nid,name\r\n1,W\u00e9\r\nnul\x00 esc\x1b c1\x80 del\x7f tab\t ff\x0c';
    const html = Text.escapeHtml(value);
    assert.ok(/^[\x20-\x7e\n\t]*$/.test(html), JSON.stringify(html));
    const parsed = textOf(parseFragment(`<pre>\n${html}</pre>`) as unknown as TextNode);
    assert.equal(parsed, shown(value));
    assert.ok(parsed.includes('\r\n'));
  });

  test('every control character is visible or kept as TAB, LF or CR', () => {
    const html = Text.escapeHtml(CONTROLS);
    assert.ok(/^[\x20-\x7e\n\t]*$/.test(html), JSON.stringify(html));
    assert.equal(textOf(parseFragment(`<p>${html}</p>`) as unknown as TextNode), shown(CONTROLS));
  });
});

describe('Text.escapeMarkdown', () => {
  test('replaces every line break, shows controls and writes non-ASCII as numeric references', () => {
    assert.equal(Text.escapeMarkdown('a\r\nb\rc\nd'), 'a b c d');
    assert.equal(Text.escapeMarkdown('Pr\u00e9nom \u{1f600}'), 'Pr&#233;nom &#128512;');
    assert.equal(Text.escapeMarkdown('n\x00ul\x1b[1m\x7f\x85'), 'n\\x00ul\\x1b\\[1m\\x7f\\x85');
    assert.equal(Text.escapeMarkdown('&#233; *x* <b> a|b `c`'), '\\&\\#233; \\*x\\* \\<b\\> a\\|b \\`c\\`');
    const out = Text.escapeMarkdown(CONTROLS);
    assert.ok(/^[\x20-\x7e\t]*$/.test(out), JSON.stringify(out));
  });
});

describe('Json.asciiJson and Json.printableJson', () => {
  test('escape DEL and C1 controls so that the text has no raw control character and parses back', () => {
    const value = { k: `a${CONTROLS}\u00e9` };
    const ascii = Json.asciiJson(value);
    assert.ok(/^[\x20-\x7e\n]*$/.test(ascii), ascii);
    assert.deepEqual(JSON.parse(ascii), value);
    const printable = Json.printableJson(value);
    assert.ok(!/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(printable), printable);
    assert.ok(printable.includes('\u00e9'));
    assert.deepEqual(JSON.parse(printable), value);
  });
});
