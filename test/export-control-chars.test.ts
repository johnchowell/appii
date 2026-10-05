import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { ModelBuilder } from '../src/build/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const HOSTILE = 'a\u0000b\u0007c\u0008d\u000be\u000cf\rg\u001b[2Jh\u007fi\u0085j\u009bk\u00e9';

describe('exporters never write raw control characters from captured strings', () => {
  const f = new CaptureFactory();
  f.document('/', CaptureFactory.page(HOSTILE, `<form action="/send" method="post"><input name="note" value="${HOSTILE}"><button>Go</button></form>`));
  f.json('POST', '/api/x', 200, { echo: HOSTILE }, {
    requestHeaders: { 'content-type': 'application/json', 'x-note': 'n\u001bv' },
    requestBody: { json: { [`k${HOSTILE}`]: HOSTILE } },
  });
  f.websockets.push({ id: 'ws1', url: 'wss://shop.example.com/ws', openedAt: '2026-01-01T00:00:00.000Z', messages: [{ direction: 'sent', at: '2026-01-01T00:00:01.000Z', opcode: 'text', data: HOSTILE }] });
  const capture = f.capture();
  const model = { ...ModelBuilder.create().build(capture), name: HOSTILE };
  const registry = ExporterRegistry.default();

  for (const format of ['markdown', 'html', 'curl', 'postman', 'openapi', 'openapi-yaml', 'json', 'har']) {
    test(`${format}`, () => {
      const content = registry.export(model, format, { capture }).content;
      const raw = content.match(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g);
      assert.equal(raw, null, `${format}: ${JSON.stringify(raw)}`);
      if (['postman', 'openapi', 'json'].includes(format)) assert.ok(JSON.stringify(JSON.parse(content)).includes(JSON.stringify(HOSTILE).slice(1, -1)), format);
      if (format === 'har') {
        const entries = (JSON.parse(content) as { log: { entries: { response: { content: { text?: string; encoding?: string } } }[] } }).log.entries;
        const texts = entries.map((entry) => Buffer.from(entry.response.content.text ?? '', entry.response.content.encoding === 'base64' ? 'base64' : 'utf8').toString('utf8'));
        assert.ok(texts.some((text) => text.includes(HOSTILE)), 'har');
      }
      if (format === 'openapi-yaml') assert.deepEqual(parseYaml(content), JSON.parse(registry.export(model, 'openapi').content));
    });
  }
});
