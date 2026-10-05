import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { BarChart, TableRenderer, TextLayout } from '../src/present/index.js';
import type { TableColumn } from '../src/present/index.js';
import { Ansi, isAppiiError } from '../src/shared/index.js';

const plain = (width: number) => new TableRenderer({ ansi: Ansi.plain, width });
const color = (width: number) => new TableRenderer({ ansi: Ansi.color, width });
const lines = (text: string) => text.split('\n');
const maxWidth = (text: string) => Math.max(...lines(text).map((line) => Ansi.width(line)));
const badInput = (err: unknown) => isAppiiError(err) && err.code === 'BAD_INPUT';
const ascii = (text: string) => [...text].every((ch) => ch.charCodeAt(0) < 128);

const COLUMNS: TableColumn[] = [
  { header: '#', align: 'right' },
  { header: 'NAME' },
  { header: 'DESCRIPTION', flex: true, minWidth: 8 },
  { header: 'NOTES', flex: true, minWidth: 6, optional: true },
];
const ROWS = [
  ['1', 'alpha', 'the first letter of the greek alphabet', 'common'],
  ['22', 'beta', 'second', 'used in software releases'],
  ['333', 'gamma', 'third letter', ''],
];

describe('TableRenderer layout and borders', () => {
  test('renders ASCII borders, a bold-free header in plain mode and padded cells', () => {
    const out = plain(200).render(COLUMNS, ROWS);
    const rows = lines(out);
    assert.equal(rows.length, 7);
    assert.match(rows[0]!, /^\+-+(\+-+)+\+$/);
    assert.equal(rows[0], rows[2]);
    assert.equal(rows[0], rows[6]);
    assert.match(rows[1]!, /^\|   # \| NAME  \| DESCRIPTION +\| NOTES +\|$/);
    assert.match(rows[3]!, /^\|   1 \| alpha \| the first letter of the greek alphabet \| common +\|$/);
    assert.match(rows[5]!, /^\| 333 \| gamma \|/);
    assert.ok(rows.every((row) => row.length === rows[0]!.length));
    assert.ok(ascii(out));
  });

  test('natural widths are used when the table fits and the overhead is 3 per column plus 1', () => {
    const layout = plain(200).layout(COLUMNS, ROWS);
    assert.deepEqual(layout.visible, [0, 1, 2, 3]);
    assert.deepEqual(layout.hidden, []);
    assert.deepEqual(layout.widths, [3, 5, 38, 25]);
    assert.equal(TableRenderer.overhead(4), 13);
    assert.equal(TableRenderer.overhead(0), 0);
    assert.equal(lines(plain(200).render(COLUMNS, ROWS))[0]!.length, 3 + 5 + 38 + 25 + 13);
  });

  test('flex columns shrink widest first, ties shrink the rightmost column first, floors hold', () => {
    const columns: TableColumn[] = [
      { header: 'A', flex: true, minWidth: 4 },
      { header: 'B', flex: true, minWidth: 4 },
      { header: 'C' },
    ];
    const rows = [['x'.repeat(20), 'y'.repeat(20), 'fixed-col']];
    const t = plain(10 + 10 + 9 + 10 - 1);
    assert.deepEqual(t.layout(columns, rows).widths, [10, 9, 9]);
    assert.deepEqual(plain(4 + 4 + 9 + 10).layout(columns, rows).widths, [4, 4, 9]);
    assert.deepEqual(plain(30 + 10 + 9 + 10).layout(columns, [['x'.repeat(30), 'y'.repeat(5), 'fixed-col']]).widths, [30, 5, 9]);
    assert.deepEqual(plain(20 + 5 + 9 + 10).layout(columns, [['x'.repeat(30), 'y'.repeat(5), 'fixed-col']]).widths, [20, 5, 9]);
  });

  test('non-flex columns keep their width until flex columns reach their floors', () => {
    const columns: TableColumn[] = [{ header: 'ID' }, { header: 'TEXT', flex: true, minWidth: 5 }];
    const rows = [['identifier-01', 'some long text value here']];
    const layout = plain(13 + 5 + 7).layout(columns, rows);
    assert.deepEqual(layout.widths, [13, 5]);
    const tighter = plain(12 + 5 + 7 - 4).layout(columns, rows);
    assert.equal(tighter.widths.reduce((a, b) => a + b, 0) + TableRenderer.overhead(2), 12 + 5 + 7 - 4);
  });

  test('optional columns are dropped by priority before any floor is violated', () => {
    const columns: TableColumn[] = [
      { header: 'KEEP' },
      { header: 'LOW', flex: true, minWidth: 10, optional: true, priority: 1 },
      { header: 'MID', flex: true, minWidth: 10, optional: true, priority: 2 },
      { header: 'TAIL', flex: true, minWidth: 10, optional: true, priority: 2 },
    ];
    const rows = [['k', 'l'.repeat(12), 'm'.repeat(12), 't'.repeat(12)]];
    const all = plain(200).layout(columns, rows);
    assert.deepEqual(all.hidden, []);
    const one = plain(4 + 10 + 10 + 3 * 3 + 1 + 1).layout(columns, rows);
    assert.deepEqual(one.hidden, [1]);
    assert.deepEqual(one.visible, [0, 2, 3]);
    const two = plain(4 + 10 + 2 * 3 + 1).layout(columns, rows);
    assert.deepEqual(two.hidden, [1, 3]);
    const out = plain(4 + 10 + 2 * 3 + 1).render(columns, rows);
    assert.match(out, /KEEP/);
    assert.match(out, /MID/);
    assert.doesNotMatch(out, /LOW|TAIL/);
  });

  test('maxWidth clamps a column and minWidth only acts as a shrink floor, never as padding', () => {
    const columns: TableColumn[] = [
      { header: 'A', maxWidth: 6 },
      { header: 'B', flex: true, minWidth: 30 },
    ];
    const layout = plain(100).layout(columns, [['abcdefghij', 'short']]);
    assert.deepEqual(layout.widths, [6, 5]);
    const out = plain(100).render(columns, [['abcdefghij', 'short']]);
    assert.match(out, /\| abc\.\.\. \| short \|/);
  });

  test('styled cells are measured by visible width and truncated with a reset code', () => {
    const ansi = Ansi.color;
    const rows = [[ansi.green('GET'), ansi.cyan('/api/items/{itemId}/details/more')]];
    const columns: TableColumn[] = [{ header: 'METHOD' }, { header: 'PATH', flex: true, minWidth: 8 }];
    const wide = color(100).render(columns, rows);
    assert.match(wide, /\x1b\[32mGET\x1b\[39m/);
    assert.match(wide, /\x1b\[1mMETHOD\x1b\[22m/);
    const narrow = color(25).render(columns, rows);
    assert.ok(maxWidth(narrow) <= 25);
    assert.match(narrow, /\.\.\.\x1b\[0m/);
    assert.equal(Ansi.strip(color(60).render(columns, rows)), plain(60).render(columns, rows.map((row) => row.map((cell) => Ansi.strip(cell)))));
  });

  test('line breaks and tabs inside cells become spaces', () => {
    const out = plain(80).render([{ header: 'X' }], [['a\nb\tc\r\nd']]);
    assert.match(out, /\| a b c d \|/);
    assert.equal(lines(out).length, 5);
  });

  test('wrapping columns split plain cells into several lines and shrink before other flex columns', () => {
    const columns: TableColumn[] = [
      { header: 'NAME', flex: true, minWidth: 6 },
      { header: 'CONSTRAINTS', flex: true, wrap: true, minWidth: 10 },
    ];
    const rows = [['username', 'pattern [a-z0-9_]{3,16}, length 1..16, html text']];
    const out = plain(40).render(columns, rows);
    const body = lines(out).slice(3, -1);
    assert.ok(body.length > 1);
    assert.match(body[0]!, /^\| username \|/);
    assert.match(body[1]!, /^\| +\| /);
    assert.ok(maxWidth(out) <= 40);
    assert.equal(
      body
        .map((line) => line.split('|')[2]!.trim())
        .join(' ')
        .replace(/\s+/g, ' '),
      'pattern [a-z0-9_]{3,16}, length 1..16, html text',
    );
    const layout = plain(40).layout(columns, rows);
    assert.equal(layout.widths[0], 8);
  });

  test('wrapped cells are capped at MAX_CELL_LINES and styled cells fall back to truncation', () => {
    const long = Array.from({ length: 80 }, (_, i) => `w${i}`).join(' ');
    const wrapped = TableRenderer.wrapCell(long, 10);
    assert.equal(wrapped.length, TableRenderer.MAX_CELL_LINES);
    assert.match(wrapped[wrapped.length - 1]!, /\.\.\.$/);
    assert.ok(wrapped.every((line) => line.length <= 10));
    const styled = Ansi.color.red('a long styled cell value');
    assert.deepEqual(TableRenderer.wrapCell(styled, 10), [Ansi.truncate(styled, 10)]);
    assert.deepEqual(TableRenderer.wrapCell('short', 10), ['short']);
  });

  test('a precomputed layout is reused so several tables share column widths', () => {
    const columns: TableColumn[] = [{ header: 'A' }, { header: 'B', flex: true }];
    const all = [['1', 'short'], ['2', 'a much longer value']];
    const t = plain(100);
    const layout = t.layout(columns, all);
    const first = t.render(columns, [all[0]!], layout);
    const second = t.render(columns, [all[1]!], layout);
    assert.equal(lines(first)[0], lines(second)[0]);
    assert.notEqual(lines(t.render(columns, [all[0]!]))[0], lines(first)[0]);
  });

  test('empty rows render the header only; no columns render nothing', () => {
    assert.equal(lines(plain(50).render(COLUMNS, [])).length, 4);
    assert.equal(plain(50).render([], []), '');
    const missing = plain(80).render(COLUMNS, [['1']]);
    assert.equal(lines(missing).length, 5);
  });

  test('never exceeds the width, even far below the table overhead', () => {
    for (let width = 1; width <= 160; width++) {
      for (const t of [plain(width), color(width)]) {
        const out = t.render(COLUMNS, ROWS);
        assert.ok(maxWidth(out) <= width, `width ${width}`);
      }
    }
  });

  test('rejects rows with extra cells, bad widths and bad column bounds', () => {
    assert.throws(() => plain(80).render(COLUMNS, [['1', '2', '3', '4', '5']]), badInput);
    assert.throws(() => plain(80).layout([{ header: 'A', minWidth: 0 }], []), badInput);
    assert.throws(() => plain(80).layout([{ header: 'A', maxWidth: 2.5 }], []), badInput);
    assert.throws(() => plain(0), badInput);
    assert.throws(() => plain(Number.NaN), badInput);
    assert.equal(plain(80.9).width, 80);
  });
});

describe('TextLayout', () => {
  test('clean escapes non-ASCII and control characters and flattens line breaks', () => {
    assert.equal(TextLayout.clean('caf\u00e9'), 'caf\\u00e9');
    assert.equal(TextLayout.clean('a\nb\r\nc\td'), 'a b c d');
    assert.equal(TextLayout.clean('\x1b[31mred\x1b[0m'), '\\x1b[31mred\\x1b[0m');
    assert.equal(TextLayout.clean('\x7f\x00'), '\\x7f\\x00');
    assert.equal(TextLayout.clean('\u{1f600}'), '\\ud83d\\ude00');
    assert.ok(ascii(TextLayout.clean('\u2028 \u0085 \u00a0')));
  });

  test('cleanBlock keeps newlines but escapes other controls', () => {
    assert.equal(TextLayout.cleanBlock('a\r\nb\rc\nd\te\x1b'), 'a\nb\nc\nd\\x09e\\x1b');
  });

  test('wrap breaks on spaces and hard-splits long words', () => {
    assert.deepEqual(TextLayout.wrap('the quick brown fox', 9), ['the quick', 'brown fox']);
    assert.deepEqual(TextLayout.wrap('abcdefghijkl mn', 5), ['abcde', 'fghij', 'kl mn']);
    assert.deepEqual(TextLayout.wrap('', 5), ['']);
    assert.deepEqual(TextLayout.wrap('  spaced   out  ', 20), ['spaced out']);
    assert.deepEqual(TextLayout.wrap('abc', 0), ['a', 'b', 'c']);
  });

  test('flow places atomic styled items on lines with a hanging indent', () => {
    const items = ['200 x8', '201 x1', '303 x1', '400 x1', '404 x1'];
    const out = TextLayout.flow(items, 24, { prefix: 'Statuses: ' });
    assert.deepEqual(out, ['Statuses: 200 x8  201 x1', '          303 x1  400 x1', '          404 x1']);
    const styled = TextLayout.flow(items.map((item) => Ansi.color.green(item)), 24, { prefix: 'Statuses: ' });
    assert.deepEqual(styled.map((line) => Ansi.strip(line)), out);
    const truncated = TextLayout.flow(['a-very-long-item-that-cannot-fit'], 10);
    assert.deepEqual(truncated, ['a-very-...']);
    assert.deepEqual(TextLayout.flow([], 10, { prefix: 'X: ' }), ['X: ']);
    assert.ok(TextLayout.flow(['abc', 'def'], 4, { prefix: 'Long prefix: ' }).every((line) => Ansi.width(line) <= 4));
  });

  test('definitions align labels, wrap values and fall back to stacked layout when narrow', () => {
    const out = TextLayout.definitions(
      [
        ['Page', 'https://example.com/a/very/long/path/that/wraps'],
        ['Selector', 'form#login'],
      ],
      40,
    );
    assert.equal(out[0], 'Page:     https://example.com/a/very/lon');
    assert.equal(out[1], '          g/path/that/wraps');
    assert.equal(out[2], 'Selector: form#login');
    const narrow = TextLayout.definitions([['A long label here', 'value text']], 20);
    assert.deepEqual(narrow, ['A long label here:', '  value text']);
    const indented = TextLayout.definitions([['K', 'v']], 20, { indent: 4, label: (label) => `<${label}>` });
    assert.deepEqual(indented, ['    <K:> v']);
    assert.deepEqual(TextLayout.definitions([], 20), []);
  });

  test('checkWidth validates and floors', () => {
    assert.equal(TextLayout.checkWidth(72.7), 72);
    assert.throws(() => TextLayout.checkWidth(0), badInput);
    assert.throws(() => TextLayout.checkWidth(-5), badInput);
    assert.throws(() => TextLayout.checkWidth(Number.POSITIVE_INFINITY), badInput);
    assert.throws(() => TextLayout.checkWidth('80' as unknown as number), badInput);
  });

  test('fit truncates by visible width', () => {
    assert.equal(TextLayout.fit('abcdef', 4), 'a...');
    assert.equal(TextLayout.fit('abc', 4), 'abc');
    assert.equal(Ansi.width(TextLayout.fit(Ansi.color.red('abcdef'), 4)), 4);
  });
});

describe('BarChart', () => {
  const items = [
    { label: 'GET /a', value: 10 },
    { label: 'POST /b', value: 5 },
    { label: 'GET /c', value: 1 },
    { label: 'GET /zero', value: 0 },
  ];

  test('draws proportional bars with counts after the bar', () => {
    const out = lines(new BarChart({ ansi: Ansi.plain, width: 40 }).render(items));
    assert.equal(out.length, 4);
    const bars = out.map((line) => (/#+/.exec(line)?.[0] ?? '').length);
    assert.ok(bars[0]! > bars[1]! && bars[1]! > bars[2]! && bars[2]! >= 1);
    assert.equal(bars[3], 0);
    assert.match(out[0]!, /^GET \/a +#+ 10$/);
    assert.match(out[3]!, /^GET \/zero +0$/);
    assert.ok(Math.abs(bars[1]! * 2 - bars[0]!) <= 1);
  });

  test('caps the bar length, truncates labels and never exceeds the width', () => {
    const capped = new BarChart({ ansi: Ansi.plain, width: 200, maxBar: 12 }).render(items);
    assert.equal(/#+/.exec(capped)?.[0].length, 12);
    for (let width = 1; width <= 120; width++) {
      const out = new BarChart({ ansi: Ansi.plain, width }).render([{ label: 'x'.repeat(80), value: 3 }, ...items]);
      assert.ok(maxWidth(out) <= width, `width ${width}`);
    }
    const narrow = new BarChart({ ansi: Ansi.plain, width: 20 }).render([{ label: 'a-very-long-endpoint-label', value: 2 }]);
    assert.match(narrow, /^a-very\.\.\. #+ 2$/);
  });

  test('colors bars only when ANSI is enabled', () => {
    assert.match(new BarChart({ ansi: Ansi.color, width: 40 }).render(items), /\x1b\[36m#+\x1b\[39m/);
    assert.doesNotMatch(new BarChart({ ansi: Ansi.plain, width: 40 }).render(items), /\x1b/);
    assert.equal(new BarChart({ ansi: Ansi.plain, width: 40 }).render([]), '');
  });

  test('custom bar character and fractional values', () => {
    const out = new BarChart({ ansi: Ansi.plain, width: 30, bar: '=' }).render([{ label: 'a', value: 2.5 }]);
    assert.match(out, /^a =+ 2\.5$/);
  });

  test('rejects invalid values and options', () => {
    const chart = new BarChart({ ansi: Ansi.plain, width: 40 });
    assert.throws(() => chart.render([{ label: 'a', value: -1 }]), badInput);
    assert.throws(() => chart.render([{ label: 'a', value: Number.NaN }]), badInput);
    assert.throws(() => new BarChart({ ansi: Ansi.plain, width: 40, bar: '##' }), badInput);
    assert.throws(() => new BarChart({ ansi: Ansi.plain, width: 40, bar: '\u2588' }), badInput);
    assert.throws(() => new BarChart({ ansi: Ansi.plain, width: 40, labelShare: 1 }), badInput);
    assert.throws(() => new BarChart({ ansi: Ansi.plain, width: 0 }), badInput);
    assert.throws(() => new BarChart({ ansi: Ansi.plain, width: 40, maxBar: 0 }), badInput);
  });
});
