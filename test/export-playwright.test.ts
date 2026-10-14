import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExporterRegistry, PlaywrightExporter } from '../src/export/index.js';
import type { ApiModel, EndpointForm, FormField } from '../src/model/index.js';
import { Text } from '../src/shared/index.js';
import { ExportModel } from './helpers/export-model.js';
import type { ExportFixture } from './helpers/export-model.js';

function checkSyntax(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdtemp(join(tmpdir(), 'appii-pw-')).then((dir) => {
      const file = join(dir, 'client.mjs');
      writeFile(file, source)
        .then(() => execFile(process.execPath, ['--check', file], (error) => {
          rm(dir, { recursive: true, force: true }).finally(() => (error ? reject(error) : resolve()));
        }))
        .catch(reject);
    }, reject);
  });
}

function render(model: ApiModel): string {
  return PlaywrightExporter.create().export(model).content;
}

describe('playwright exporter metadata', () => {
  test('registers under its format and aliases', () => {
    const registry = ExporterRegistry.default();
    for (const name of ['playwright', 'pw', 'browser']) assert.equal(registry.get(name).format, 'playwright');
  });

  test('declares a runnable module', () => {
    const exporter = PlaywrightExporter.create();
    assert.equal(exporter.format, 'playwright');
    assert.equal(exporter.extension, 'pw.mjs');
    assert.equal(exporter.mimeType, 'text/javascript');
  });
});

describe('playwright exporter from constructed endpoints', () => {
  const model = ExportModel.model([
    ExportModel.endpoint({ method: 'GET', path: '/', kind: 'document', name: 'home' }),
    ExportModel.endpoint({
      method: 'GET',
      path: '/thing/{id}/',
      kind: 'document',
      name: 'thing',
      pathParams: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }, examples: ['7'] }],
    }),
    ExportModel.endpoint({
      method: 'GET',
      path: '/api/items',
      kind: 'json',
      name: 'items',
      queryParams: [{ name: 'page', in: 'query', required: true, schema: { type: 'integer' }, examples: ['1'] }],
      headerParams: [{ name: 'x-requested-with', in: 'header', required: true, schema: { type: 'string' }, examples: ['XMLHttpRequest'] }],
      samples: [{ exchangeId: 'e1', url: 'https://shop.example.com/api/items?page=1', pageUrl: 'https://shop.example.com/feed', status: 200, startedAt: ExportModel.NOW.toISOString() }],
    }),
    ExportModel.endpoint({ method: 'GET', path: '/asset', kind: 'document', name: 'asset', origin: 'https://cdn.example.com' }),
  ]);
  const code = render(model);

  test('is ASCII and valid JavaScript', async () => {
    assert.ok(Text.isAscii(code));
    await checkSyntax(code);
  });

  test('navigates for a document endpoint', () => {
    assert.match(code, /async home\(vars = \{\}\) \{\n\s+const response = await this\.page\.goto\("\/", \{ waitUntil: 'load' \}\);\n\s+return toResult\(response\);/);
  });

  test('builds a templated path from a variable with the recorded example as the fallback', () => {
    assert.match(code, /"\/thing\/" \+ encodeURIComponent\(String\(readVar\(vars, "id", "7"\)\)\) \+ "\/"/);
  });

  test('sends a script-only endpoint from the page context with credentials and its header', () => {
    assert.match(code, /await this\.page\.goto\("\/feed", \{ waitUntil: 'load' \}\);/);
    assert.match(code, /return pageFetch\(this\.page, "\/api\/items" \+ "\?" \+ \["page=" \+ encodeURIComponent\(String\(readVar\(vars, "page", "1"\)\)\)\]\.join\("&"\),/);
    assert.match(code, /credentials: "include"/);
    assert.match(code, /"x-requested-with": "XMLHttpRequest"/);
  });

  test('drives a cross-origin endpoint against its own absolute host, not the base origin', () => {
    assert.match(code, /async asset\(vars = \{\}\) \{\n\s+const response = await this\.page\.goto\("https:\/\/cdn\.example\.com" \+ "\/asset", \{ waitUntil: 'load' \}\);/);
  });

  test('lists every endpoint for the command line', () => {
    assert.match(code, /const ENDPOINTS = \["home", "thing", "items", "asset"\];/);
  });

  test('has no login flow when no login endpoint exists', () => {
    assert.doesNotMatch(code, /async login\(vars = \{\}\)/);
    assert.doesNotMatch(code, /APPII_LOGIN/);
  });
});

function field(partial: Partial<FormField> & { name: string; type: string }): FormField {
  return { order: 0, kind: 'input', value: '', hasValueAttribute: false, checked: false, disabled: false, readOnly: false, required: false, multiple: false, ...partial };
}

describe('playwright exporter form gestures', () => {
  const form: EndpointForm = {
    pageUrl: 'https://shop.example.com/signup',
    selector: 'form#signup',
    action: '/signup',
    method: 'POST',
    enctype: 'application/x-www-form-urlencoded',
    charset: 'UTF-8',
    tokenFields: ['csrf_token'],
    submitters: [field({ name: 'intent', type: 'submit', value: 'create', hasValueAttribute: true })],
    fields: [
      field({ name: 'csrf_token', type: 'hidden', value: 'TKN', hasValueAttribute: true }),
      field({ name: 'username', type: 'text', value: 'joe', hasValueAttribute: true, required: true }),
      field({ name: 'password', type: 'password', required: true }),
      field({ name: 'plan', type: 'radio', value: 'free', hasValueAttribute: true, checked: true }),
      field({ name: 'plan', type: 'radio', value: 'pro', hasValueAttribute: true }),
      field({ name: 'remember', type: 'checkbox', value: 'yes', hasValueAttribute: true, checked: true }),
      field({ name: 'terms', type: 'checkbox', required: true }),
      field({ name: 'country', kind: 'select', type: 'select-one', value: 'us' }),
      field({
        name: 'interests',
        kind: 'select',
        type: 'select-multiple',
        multiple: true,
        value: 'a',
        options: [
          { value: 'a', label: 'A', selected: true, disabled: false },
          { value: 'b', label: 'B', selected: false, disabled: false },
          { value: 'c', label: 'C', selected: true, disabled: false },
        ],
      }),
      field({ name: 'locked', type: 'text', value: 'nope', disabled: true }),
      field({ name: 'intent', type: 'submit', value: 'create', hasValueAttribute: true }),
    ],
  };
  const model = ExportModel.model([ExportModel.endpoint({ method: 'POST', path: '/signup', kind: 'form', name: 'signup', form })]);
  const code = render(model);

  test('is valid JavaScript', () => checkSyntax(code));

  test('checks the selected radio by name and value, and skips the unselected one', () => {
    assert.match(code, /form\.locator\("\[name=\\"plan\\"\]\[value=\\"free\\"\]"\)\.check\(\);/);
    assert.doesNotMatch(code, /value=\\"pro\\"/);
    assert.doesNotMatch(code, /\[name=\\"plan\\"\]"\)\.setChecked/);
  });

  test('sets checkboxes by their recorded state, scoping a value-less box with first()', () => {
    assert.match(code, /form\.locator\("\[name=\\"remember\\"\]\[value=\\"yes\\"\]"\)\.setChecked\(true\);/);
    assert.match(code, /form\.locator\("\[name=\\"terms\\"\]"\)\.first\(\)\.setChecked\(false\);/);
  });

  test('reproduces every selected option of a multi-select without comma splitting', () => {
    assert.match(code, /form\.locator\("\[name=\\"interests\\"\]"\)\.selectOption\(readVar\(vars, "interests", \["a", "c"\]\)\);/);
  });

  test('fills text, keeps the recorded username, and never bakes the password', () => {
    assert.match(code, /form\.locator\("\[name=\\"username\\"\]"\)\.fill\(String\(readVar\(vars, "username", "joe"\)\)\);/);
    assert.match(code, /form\.locator\("\[name=\\"password\\"\]"\)\.fill\(String\(readVar\(vars, "password", ""\)\)\);/);
  });

  test('selects an option and submits by clicking the submit button', () => {
    assert.match(code, /form\.locator\("\[name=\\"country\\"\]"\)\.selectOption\(/);
    assert.match(code, /return this\.capture\("POST", "\^\/signup\$", async \(\) => \{ await form\.locator\("\[name=\\"intent\\"\]"\)\.first\(\)\.click\(\); \}\);/);
  });

  test('never fills a hidden token field or a disabled field', () => {
    assert.doesNotMatch(code, /csrf_token\\"\]/);
    assert.doesNotMatch(code, /name=\\"locked\\"/);
  });
});

describe('playwright exporter from a live capture', () => {
  let fixture: ExportFixture;
  let code: string;

  before(async () => {
    fixture = await ExportModel.fixture();
    code = render(fixture.model);
  });

  after(async () => {
    await fixture.site.close();
  });

  test('is ASCII and valid JavaScript', async () => {
    assert.ok(Text.isAscii(code));
    await checkSyntax(code);
  });

  test('drives the login form and exposes login() that reuses it', () => {
    assert.match(code, /const form = this\.page\.locator\(/);
    assert.match(code, /\.locator\("\[name=\\"email\\"\]"\)\.fill\(String\(readVar\(vars, "email", ""\)\)\)/);
    assert.match(code, /\.locator\("\[name=\\"password\\"\]"\)\.fill\(String\(readVar\(vars, "password", ""\)\)\)/);
    assert.match(code, /return this\.capture\("POST", "\^\/login\$", async \(\) => \{ await form\.locator\(/);
    assert.match(code, /async login\(vars = \{\}\) \{\n\s+return this\.\w+\(vars\);\n\s+\}/);
  });

  test('bakes no credential value and never fills a hidden token field', () => {
    assert.ok(!code.includes(fixture.site === undefined ? 'x' : 'correct-horse'));
    assert.doesNotMatch(code, /csrf_token\\"\]\)\.(fill|setChecked|selectOption)/);
  });

  test('uses the right gesture for choice fields', () => {
    assert.match(code, /\.selectOption\(/);
    assert.match(code, /\.setChecked\(/);
  });

  test('sends api requests from the page so they carry the session', () => {
    assert.match(code, /return pageFetch\(this\.page,/);
    assert.match(code, /credentials: "include"/);
  });
});
