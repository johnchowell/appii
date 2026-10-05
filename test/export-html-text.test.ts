import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parse } from 'parse5';
import { HtmlExporter } from '../src/export/index.js';
import { Text } from '../src/shared/index.js';
import { ExportModel } from './helpers/export-model.js';

interface Node {
  nodeName: string;
  value?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: Node[];
  content?: Node;
}

function textOf(node: Node): string {
  if (node.nodeName === '#text') return node.value ?? '';
  return (node.childNodes ?? []).map(textOf).join('');
}

function elements(node: Node, name: string, out: Node[] = []): Node[] {
  if (node.nodeName === name) out.push(node);
  for (const child of node.childNodes ?? []) elements(child, name, out);
  if (node.content) elements(node.content, name, out);
  return out;
}

function id(node: Node): string {
  return node.attrs?.find((attr) => attr.name === 'id')?.value ?? '';
}

function shown(value: string): string {
  return value.replace(/[\x00-\x08\x0b-\x0c\x0e-\x1f\x7f-\x9f]/g, Text.controlEscape);
}

const TEXT = '\nid,name\r\n1,W\u00e9\r\nnul\x00 esc\x1b c1\x80 del\x7f\n';

describe('HtmlExporter keeps captured text intact', () => {
  test('pre blocks keep a leading LF and CR, and show the other controls as visible escapes', () => {
    const endpoint = ExportModel.endpoint({
      method: 'POST',
      path: '/upload',
      id: 'post-upload',
      name: 'postUpload',
      requestBody: { mimeType: 'text/csv', kind: 'text', examples: [TEXT] },
      responses: [{ status: 200, count: 1, headers: [], body: { mimeType: 'application/json', kind: 'json', examples: [{ note: TEXT }] } }],
    });
    const model = ExportModel.model([endpoint], { websockets: [{ url: 'wss://shop.example.com/ws', messages: 1, examples: [TEXT] }] });
    const html = new HtmlExporter().export(model).content;
    assert.ok(!/[\x00-\x08\x0b-\x1f\x7f]/.test(html), JSON.stringify(html.match(/[\x00-\x08\x0b-\x1f\x7f]/g)));
    const doc = parse(html) as unknown as Node;
    const pres = elements(doc, 'pre');
    const example = pres.find((pre) => id(pre) === 'request-1-example-1');
    assert.ok(example);
    assert.equal(textOf(example), shown(TEXT));
    const response = pres.find((pre) => id(pre) === 'response-1-0-example-1');
    assert.ok(response);
    assert.deepEqual(JSON.parse(textOf(response)), { note: TEXT });
    const socket = pres.find((pre) => id(pre) === '' && textOf(pre).startsWith('\nid,name'));
    assert.ok(socket, 'websocket example');
    assert.equal(textOf(socket), shown(TEXT));
    const curl = pres.find((pre) => id(pre) === 'curl-1');
    assert.ok(curl);
    assert.ok(textOf(curl).startsWith('curl -sS -X POST'));
  });
});
