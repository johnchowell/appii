import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownExporter } from '../src/export/index.js';
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

  test('the terminal summary stays short', () => {
    const summary = Schema.constraintSummary(author).join('; ');
    assert.ok(!summary.includes('Martin Luther King Jr.'), summary);
    assert.match(Schema.constraintSummary(tag).join('; '), /\+8 more/);
  });
});
