import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { HtmlExporter, MarkdownExporter } from '../src/export/index.js';
import { PresenterFactory } from '../src/present/index.js';
import { Schema } from '../src/shared/index.js';
import { ExportModel } from './helpers/export-model.js';

const AUTHORS = ['Albert Einstein', 'Martin Luther King Jr.', "Madeleine L'Engle", 'Eleanor Roosevelt', 'Friedrich Nietzsche'];
const TAGS = Array.from({ length: 13 }, (_value, i) => `observed-tag-number-${i + 1}`);

describe('the Markdown export documents every valid value of a request body field (QTS-R5)', () => {
  const author = { type: 'string', enum: AUTHORS };
  const tag = { type: 'string', [Schema.DYNAMIC_OPTIONS]: true, examples: TAGS };
  const filter = ExportModel.endpoint({
    method: 'POST',
    path: '/filter.aspx',
    kind: 'form',
    requestBody: {
      mimeType: 'application/x-www-form-urlencoded',
      kind: 'form',
      schema: { type: 'object', properties: { author, tag }, required: ['author'] },
      examples: [{ author: 'Martin Luther King Jr.', tag: TAGS[0] }],
    },
  });
  const content = new MarkdownExporter().export(ExportModel.model([filter])).content;

  test('the request body has a JSON Schema block with the full enum values and observed options', () => {
    const block = /<details><summary>JSON Schema<\/summary>\n\n```json\n([\s\S]*?)\n```\n\n<\/details>/.exec(content);
    assert.ok(block, content);
    const schema = JSON.parse(block[1] ?? '') as { properties: { author: { enum: string[] }; tag: { examples: string[] } } };
    assert.deepEqual(schema.properties.author.enum, AUTHORS);
    assert.deepEqual(schema.properties.tag.examples, TAGS);
    for (const value of [...AUTHORS, ...TAGS]) assert.ok(content.includes(JSON.stringify(value)), value);
  });

  test('the Constraints cells of the Markdown and HTML tables list every value unabridged', () => {
    const row = (name: string): string => content.split('\n').find((line) => line.startsWith(`| \`${name}\``)) ?? '';
    assert.ok(row('author').includes(`one of ${AUTHORS.join('|')}`.replace(/\|/g, '\\|')), row('author'));
    assert.doesNotMatch(row('author'), /\.\.\./);
    for (const value of TAGS) assert.ok(row('tag').includes(value), value);
    assert.doesNotMatch(row('tag'), /more\)/);
    const query = ExportModel.endpoint({ method: 'GET', path: '/search', queryParams: [{ name: 'author', in: 'query', required: false, schema: author, examples: [] }] });
    const searchMd = new MarkdownExporter().export(ExportModel.model([query])).content;
    assert.ok(searchMd.includes('Martin Luther King Jr.'), searchMd);
    const html = new HtmlExporter().export(ExportModel.model([filter, query])).content;
    for (const value of ['Martin Luther King Jr.', 'Friedrich Nietzsche', ...TAGS]) assert.ok(html.split('<td>').some((cell) => cell.startsWith('one of') || cell.includes('observed:') ? cell.includes(value.replace(/'/g, '&#39;')) : false), value);
    assert.ok(!html.split('<td>').some((cell) => /^(?:one of|options vary)[^<]*\.\.\./.test(cell)));
  });

  test('the terminal summary stays short', () => {
    const detail = new PresenterFactory({ width: 200 }).detail().render({ model: ExportModel.model([filter]), ref: 1 });
    assert.ok(!detail.includes('Martin Luther King Jr.|'), detail);
    assert.match(detail, /\+8 more/);
    const summary = Schema.constraintSummary(author).join('; ');
    assert.ok(!summary.includes('Martin Luther King Jr.'), summary);
    assert.match(Schema.constraintSummary(tag).join('; '), /\+8 more/);
  });
});
