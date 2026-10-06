import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownExporter, MarkdownWriter } from '../src/export/index.js';
import { ExportModel } from './helpers/export-model.js';

const HOSTILE = 'pat\rret n\x00ul esc\x1b[31m del\x7f c1\x85 Pr\u00e9nom';

function lines(markdown: string): string[] {
  return markdown.split(/\r\n|\r|\n/);
}

function cells(row: string): number {
  let count = 0;
  for (let i = 0; i < row.length; i++) {
    if (row[i] === '\\') i++;
    else if (row[i] === '|') count++;
  }
  return count - 1;
}

function tables(markdown: string): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  for (const line of lines(markdown)) {
    if (line.startsWith('|')) current.push(line);
    else if (current.length > 0) {
      out.push(current);
      current = [];
    }
  }
  if (current.length > 0) out.push(current);
  return out;
}

describe('MarkdownExporter keeps captured text intact', () => {
  test('CR, NUL, ESC, DEL and C1 characters never split rows or reach the file raw', () => {
    const endpoint = ExportModel.endpoint({
      method: 'POST',
      path: '/x',
      id: 'post-x',
      name: 'postX',
      kind: 'form',
      queryParams: [{ name: HOSTILE, in: 'query', required: true, schema: { type: 'string', title: HOSTILE }, examples: [HOSTILE] }],
      requestBody: {
        mimeType: 'application/json',
        kind: 'json',
        schema: { type: 'object', properties: { note: { type: 'string', title: HOSTILE } } },
        examples: [{ note: HOSTILE }],
      },
    });
    const model = ExportModel.model([endpoint], { name: HOSTILE, websockets: [{ url: 'wss://shop.example.com/ws', messages: 1, examples: [HOSTILE] }] });
    const markdown = new MarkdownExporter().export(model).content;
    assert.ok(/^[\x20-\x7e\n]*$/.test(markdown), JSON.stringify(markdown.match(/[^\x20-\x7e\n]/g)));
    for (const table of tables(markdown)) {
      const width = cells(table[0] ?? '');
      for (const row of table) assert.equal(cells(row), width, row);
    }
    assert.ok(markdown.startsWith('# pat ret n\\x00ul esc\\x1b\\[31m del\\x7f c1\\x85 Pr&#233;nom\n'), markdown.slice(0, 80));
    const json = [...markdown.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1] ?? '') as unknown);
    assert.deepEqual(json, [{ type: 'object', properties: { note: { type: 'string', title: HOSTILE } } }, { note: HOSTILE }]);
    assert.ok(markdown.includes('`pat ret n\\x00ul esc\\x1b[31m del\\x7f c1\\x85 Pr\\u00e9nom`'), markdown);
    assert.match(markdown, /\\xNN/);
  });

  test('MarkdownWriter.text writes non-ASCII as numeric character references', () => {
    const md = new MarkdownWriter();
    assert.equal(md.text('Pr\u00e9nom'), 'Pr&#233;nom');
    assert.equal(md.text('a\rb'), 'a b');
    assert.equal(md.code('a\rb\x1bc\u00e9'), '`a b\\x1bc\\u00e9`');
    assert.equal(md.block('a\r\nb\rc\x00d\te'), '```\na\nb\nc\\x00d\te\n```');
  });
});
