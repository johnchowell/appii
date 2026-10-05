import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { parse as parseYaml } from 'yaml';
import { OpenApiExporter, OpenApiYamlExporter, YamlWriter } from '../src/export/index.js';
import { ExportModel } from './helpers/export-model.js';

const AMBIGUOUS = ['<<', '0o17', '0x1F', '017', 'yes', 'No', 'on', 'y', 'n', '~', 'null', '1e3', '.inf', '12:30', '1_000', '2026-01-01', '', ' lead', 'a #b', 'a: b', '- x', '@x', 'del\u007f', 'c1\u0085', 'esc\u001b', 'caf\u00e9', '\u{1f600}'];

describe('YamlWriter writes scalars that every YAML version reads back unchanged', () => {
  test('ambiguous strings round-trip as keys and values through YAML 1.1 and 1.2', () => {
    const value = {
      keys: Object.fromEntries(AMBIGUOUS.map((item, i) => [item, i])),
      values: AMBIGUOUS,
      merge: { '<<': { admin: true }, name: 'x' },
      numbers: [0, -1, 0.5, 12, 1000],
      flags: [true, false, null],
    };
    const text = new YamlWriter().stringify(value);
    assert.ok(/^[\x20-\x7e\n]*$/.test(text), JSON.stringify(text.match(/[^\x20-\x7e\n]/g)));
    assert.deepEqual(parseYaml(text), value);
    assert.deepEqual(parseYaml(text, { version: '1.1' }), value);
    assert.match(text, /\n {2}"<<":\n/);
  });

  test('the YAML 1.1 value key "=" is quoted for PyYAML, and the quoting probe prints no warnings (EXP2-13)', () => {
    const value = { options: ['=', '<', '>=', '!tag', '!=', '%x', '%', '{{x}}', '*ref', '&anchor'], '=': 'eq', default: '=' };
    const warnings: string[] = [];
    const listener = (warning: Error): void => {
      warnings.push(warning.message);
    };
    process.on('warning', listener);
    const emit = process.emitWarning;
    process.emitWarning = ((warning: string | Error) => {
      warnings.push(String(warning));
    }) as typeof process.emitWarning;
    let text: string;
    try {
      text = new YamlWriter().stringify(value);
    } finally {
      process.emitWarning = emit;
      process.off('warning', listener);
    }
    assert.deepEqual(warnings, []);
    assert.match(text, /^ {2}- "="$/m);
    assert.match(text, /^"=": eq$/m);
    assert.match(text, /^default: "="$/m);
    assert.deepEqual(parseYaml(text), value);
    assert.deepEqual(parseYaml(text, { version: '1.1' }), value);
  });

  test('the YAML export is the JSON export of a model with hostile strings', () => {
    const endpoint = ExportModel.endpoint({
      method: 'POST',
      path: '/x',
      requestBody: { mimeType: 'application/json', kind: 'json', schema: { type: 'object', properties: { '<<': { type: 'string', const: '0o17' }, yes: { type: 'string', enum: ['on', '~', 'a\u007fb'] } } }, examples: [{ '<<': '0o17', yes: 'a\u007fb' }] },
    });
    const model = ExportModel.model([endpoint], { name: 'yes' });
    const json = JSON.parse(new OpenApiExporter().export(model).content) as unknown;
    const yaml = new OpenApiYamlExporter().export(model).content;
    assert.deepEqual(parseYaml(yaml), json);
    assert.deepEqual(parseYaml(yaml, { version: '1.1' }), json);
  });
});
