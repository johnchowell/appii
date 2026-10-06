import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { HarExporter, HtmlExporter, MarkdownExporter, OpenApiExporter, PostmanExporter, TypeScriptExporter } from '../src/export/index.js';
import type { ApiModel, Endpoint, EndpointForm, FormField, FormSubmitter } from '../src/model/index.js';
import { Curl, FormSource, Samples } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { ExportModel } from './helpers/export-model.js';

class ScriptForms {
  static readonly ORIGIN = ExportModel.ORIGIN;
  static readonly PAGE = `${ExportModel.ORIGIN}/login`;

  static field(name: string, type: string, value = '', order = 0): FormField {
    return { name, order, kind: type === 'submit' ? 'button' : 'input', type, value, hasValueAttribute: value !== '', checked: false, disabled: false, readOnly: false, required: false, multiple: false };
  }

  static form(submittedBy: FormSubmitter | undefined, over: Partial<EndpointForm> = {}): EndpointForm {
    const form: EndpointForm = {
      pageUrl: ScriptForms.PAGE,
      selector: 'form#login',
      action: ScriptForms.PAGE,
      method: 'GET',
      enctype: 'application/x-www-form-urlencoded',
      charset: 'windows-1252',
      fields: [ScriptForms.field('username', 'text', '', 0), ScriptForms.field('password', 'password', '', 1)],
      submitters: [ScriptForms.field('go', 'submit', 'Sign in', 2)],
      tokenFields: [],
      ...over,
    };
    return submittedBy === undefined ? form : { ...form, submittedBy };
  }

  static script(): Endpoint {
    return ExportModel.endpoint({
      method: 'POST',
      path: '/api/auth/login',
      name: 'postApiAuthLogin',
      form: ScriptForms.form('script'),
      requestBody: {
        mimeType: 'application/json',
        kind: 'json',
        examples: [{ username: 'u', password: '<redacted>' }],
        schema: { type: 'object', properties: { username: { type: 'string' }, password: { type: 'string' } }, required: ['username', 'password'] },
      },
    });
  }

  static native(): Endpoint {
    return ExportModel.endpoint({
      method: 'POST',
      path: '/session',
      kind: 'form',
      name: 'postSession',
      form: ScriptForms.form(undefined, { action: `${ExportModel.ORIGIN}/session`, method: 'POST' }),
      requestBody: { mimeType: 'application/x-www-form-urlencoded', kind: 'form', examples: [{ username: 'u', password: '<redacted>', go: 'Sign in' }] },
    });
  }

  static model(): ApiModel {
    return ExportModel.model([ScriptForms.script(), ScriptForms.native()]);
  }
}

describe('a request sent by a script of a form is not described as the form submission (LV2-5)', () => {
  const model = ScriptForms.model();
  const script = ScriptForms.script();
  const native = ScriptForms.native();
  const code = (value: string): string => `\`${value}\``;

  test('one wording: the exports say what FormSource.describe says, for both kinds', () => {
    const doc = JSON.parse(new OpenApiExporter().export(model).content) as { paths: Record<string, Record<string, { description: string }>> };
    assert.ok(doc.paths['/api/auth/login']?.post?.description.split('\n\n').includes(FormSource.describe(script, code) ?? ''));
    assert.ok(doc.paths['/session']?.post?.description.split('\n\n').includes(FormSource.describe(native, code) ?? ''));
    assert.equal(FormSource.describe(script), `Sent by a script of the form form#login on ${ScriptForms.PAGE} as application/json.`);
  });

  test('OpenAPI: x-appii-form and the description leave out the native enctype, action and method of a script-sent form', () => {
    const doc = JSON.parse(new OpenApiExporter().export(model).content) as { paths: Record<string, Record<string, Record<string, unknown>>> };
    const login = doc.paths['/api/auth/login']?.post ?? {};
    assert.deepEqual(login['x-appii-form'], { pageUrl: ScriptForms.PAGE, selector: 'form#login', submittedBy: 'script' });
    assert.match(String(login.description), new RegExp(`Sent by a script of the form \`form#login\` on ${ScriptForms.PAGE.replace(/[.]/g, '\\.')} as application/json\\.`));
    assert.doesNotMatch(JSON.stringify(login), /x-www-form-urlencoded|Submitted by the form|windows-1252/);
    const session = doc.paths['/session']?.post ?? {};
    assert.deepEqual(session['x-appii-form'], { pageUrl: ScriptForms.PAGE, selector: 'form#login', enctype: 'application/x-www-form-urlencoded' });
    assert.match(String(session.description), /Submitted by the form `form#login` on https:\/\/shop\.example\.com\/login \(application\/x-www-form-urlencoded\)\./);
  });

  test('Markdown and HTML describe the script-sent request with the observed content type and no submitters', () => {
    const markdown = new MarkdownExporter().export(model).content;
    assert.ok(markdown.includes(`- **Form:** Sent by a script of the form \`form#login\` on \`${ScriptForms.PAGE}\` as application/json.`), markdown);
    assert.ok(markdown.includes(`- **Form:** Submitted by the form \`form#login\` on \`${ScriptForms.PAGE}\` (application/x-www-form-urlencoded).`), markdown);
    const html = new HtmlExporter().export(model).content;
    assert.ok(html.includes(`<dt>Form</dt><dd>Sent by a script of the form <code>form#login</code> on <code>${ScriptForms.PAGE}</code> as application/json.</dd>`), 'html script form');
    assert.ok(html.includes(`<dt>Form</dt><dd>Submitted by the form <code>form#login</code> on <code>${ScriptForms.PAGE}</code> (application/x-www-form-urlencoded). Submitters: <code>go=Sign in</code>.</dd>`), 'html native form');
  });

  test('Postman: the description names the script and gives no charset note for the form it did not submit', () => {
    const collection = new PostmanExporter().export(model).content;
    assert.ok(collection.includes(`Sent by a script of the form \`form#login\` on ${ScriptForms.PAGE} as application/json.`));
    const notes = collection.match(/The website encodes this form in windows-1252/g) ?? [];
    assert.equal(notes.length, 1, 'only the native form gets the charset note');
  });

  test('TypeScript: the form spec of a script-sent request has the observed type and UTF-8, and the docs name the script', () => {
    const source = new TypeScriptExporter().export(model).content;
    const spec = /const postApiAuthLoginSpec: EndpointSpec = \{[\s\S]*?\n\};/.exec(source)?.[0] ?? '';
    assert.match(spec, /enctype: "application\/json",\n {4}charset: \{\n {6}name: "UTF-8",/);
    assert.doesNotMatch(spec, /x-www-form-urlencoded|windows-1252/);
    assert.match(source, /\* Sent by a script of the form form#login on https:\/\/shop\.example\.com\/login as application\/json\./);
    const nativeSpec = /const postSessionSpec: EndpointSpec = \{[\s\S]*?\n\};/.exec(source)?.[0] ?? '';
    assert.match(nativeSpec, /enctype: "application\/x-www-form-urlencoded",\n {4}charset: \{\n {6}name: "windows-1252",/);
  });

  test('samples treat the script-sent request as observed, not as a native submission with the form submitter', () => {
    assert.equal(Samples.formSubmission(script), undefined);
    assert.ok(Samples.formSubmission(native) !== undefined);
    const urlencoded = { ...script, requestBody: { mimeType: 'application/x-www-form-urlencoded', kind: 'form' as const, examples: [{ username: 'u', password: '<redacted>' }] } };
    const sameAction = { ...urlencoded, path: '/login', method: 'GET', form: ScriptForms.form('script', { method: 'POST' }) };
    assert.equal(Samples.formSubmission({ ...sameAction, method: 'POST' }), undefined);
    const sample = Samples.requestSample({ ...sameAction, method: 'POST' });
    assert.equal(sample.body?.charset, undefined);
    assert.deepEqual(Object.keys(Samples.plainValue(sample.body?.value) as Record<string, unknown>), ['username', 'password']);
    assert.match(Curl.curlCommand(Samples.requestSample(script)), /--data-raw '\{"username":"u","password":"\{\{password\}\}"\}'/);
  });

  test('HAR: the post data of a script-sent request is read as UTF-8, not in the charset of the form', () => {
    const f = new CaptureFactory(ScriptForms.ORIGIN);
    const exchange = f.exchange({ method: 'POST', url: '/api/auth/login', resourceType: 'fetch', pageUrl: ScriptForms.PAGE, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' }, requestBody: 'username=caf%C3%A9', status: 200 });
    const endpoint = { ...ScriptForms.script(), requestBody: { mimeType: 'application/x-www-form-urlencoded', kind: 'form' as const, examples: [] }, samples: [{ exchangeId: exchange.id, url: exchange.request.url, status: 200, startedAt: exchange.startedAt }] };
    const har = JSON.parse(HarExporter.create().export(ExportModel.model([endpoint]), { capture: f.capture(), redact: false }).content) as { log: { entries: { request: { postData?: { params?: { name: string; value: string }[] } } }[] } };
    assert.deepEqual(har.log.entries[0]?.request.postData?.params, [{ name: 'username', value: 'caf\u00e9' }]);
  });
});
