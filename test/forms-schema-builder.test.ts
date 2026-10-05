import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import type { FormDescriptor, FormField, JsonSchema } from '../src/model/index.js';
import { EntrySlotFactory, FormExtractor, FormSchemaBuilder, HtmlDocument, TokenDetector } from '../src/forms/index.js';
import { AppiiError, Schema } from '../src/shared/index.js';
import { startFixtureSite } from './fixtures/site.js';
import { SchemaCheck } from './fixtures/build-schema-check.js';
import { PageServer } from './forms-harness.js';
import type { SubmittedValue } from './forms-harness.js';

const PAGE = 'https://example.com/app/page?x=1#top';
const extractor = new FormExtractor();
const builder = FormSchemaBuilder.create();

function form(html: string, index = 0, url = PAGE): FormDescriptor {
  const found = extractor.extract(html, url)[index];
  assert.ok(found, `form ${index}`);
  return found;
}

function props(schema: JsonSchema): Record<string, JsonSchema> {
  return Schema.properties(schema);
}

function prop(schema: JsonSchema, name: string): JsonSchema {
  const found = props(schema)[name];
  assert.ok(found, `property ${name}`);
  return found;
}

function submitter(descriptor: FormDescriptor, name: string, value?: string): FormField {
  const found = descriptor.submitters.find((s) => s.name === name && (value === undefined || s.value === value));
  assert.ok(found, `submitter ${name}`);
  return found;
}

describe('FormSchemaBuilder on fixture forms', () => {
  test('login form: token, email, password, checkbox and submitter', async () => {
    const site = await startFixtureSite();
    try {
      const url = site.origin + '/login';
      const forms = extractor.extract(await (await fetch(url)).text(), url);
      const login = forms[0];
      assert.ok(login);
      const result = builder.build(login);
      const csrf = login.fields[0]?.value;
      assert.equal(result.method, 'POST');
      assert.equal(result.action, site.origin + '/login');
      assert.equal(result.mimeType, 'application/x-www-form-urlencoded');
      assert.deepEqual(result.tokenFields, ['csrf_token']);
      assert.deepEqual(result.schema, {
        type: 'object',
        properties: {
          csrf_token: { type: 'string', readOnly: true, 'x-appii-token': true, 'x-appii-token-example': csrf, 'x-html-type': 'hidden' },
          email: {
            type: 'string',
            title: 'Email',
            pattern: EntrySlotFactory.PATTERNS.email,
            minLength: 1,
            'x-html-type': 'email',
            'x-html-required': true,
            'x-html-autocomplete': 'username',
          },
          password: { type: 'string', title: 'Password', minLength: 4, 'x-html-minlength': 8, 'x-html-type': 'password', 'x-html-required': true },
          remember: { type: 'string', title: 'Remember me', const: 'yes', 'x-html-type': 'checkbox' },
          action: { type: 'string', title: 'Sign in', const: 'login', 'x-html-type': 'submit' },
        },
        required: ['email', 'password', 'action'],
      });
      assert.ok(Schema.isTokenSchema(prop(result.schema, 'csrf_token')));
      const search = forms[1];
      assert.ok(search);
      const query = builder.build(search);
      assert.equal(query.method, 'GET');
      assert.equal(query.action, site.origin + '/search');
      assert.deepEqual(query.schema, {
        type: 'object',
        properties: { q: { type: 'string', minLength: 1, 'x-html-type': 'search', 'x-html-required': true, 'x-html-placeholder': 'Search' } },
        required: ['q'],
      });
    } finally {
      await site.close();
    }
  });

  test('signup form: validated default submitter and novalidate draft submitter', async () => {
    const site = await startFixtureSite();
    try {
      const url = site.origin + '/signup';
      const signup = form(await (await fetch(url)).text(), 0, url);
      const create = builder.build(signup);
      assert.equal(create.mimeType, 'multipart/form-data');
      assert.equal(create.action, url);
      assert.deepEqual(Object.keys(props(create.schema)), [
        'username', 'email', 'age', 'website', 'birthday', 'country', 'plan', 'interests', 'bio', 'terms', 'avatar', 'readonly_field', 'intent',
      ]);
      assert.deepEqual(create.schema.required, ['username', 'email', 'country', 'terms', 'intent']);
      assert.equal(create.schema['x-html-novalidate'], undefined);
      assert.deepEqual(prop(create.schema, 'username'), {
        type: 'string',
        title: '3-16 lowercase letters, digits or underscore',
        pattern: '^(?:[a-z0-9_]{3,16})?$',
        minLength: 1,
        'x-html-pattern': '[a-z0-9_]{3,16}',
        'x-html-type': 'text',
        'x-html-required': true,
      });
      assert.deepEqual(prop(create.schema, 'age'), {
        type: ['integer', 'string'],
        maxLength: 0,
        minimum: 13,
        maximum: 120,
        'x-html-min': '13',
        'x-html-max': '120',
        'x-html-step': '1',
        'x-html-type': 'number',
      });
      assert.deepEqual(prop(create.schema, 'website'), { type: 'string', 'x-html-type': 'url' });
      assert.deepEqual(prop(create.schema, 'birthday'), {
        type: 'string',
        pattern: EntrySlotFactory.PATTERNS.date,
        'x-html-min': '1900-01-01',
        'x-html-max': '2026-12-31',
        'x-html-type': 'date',
      });
      assert.deepEqual(prop(create.schema, 'country'), {
        type: 'string',
        enum: ['us', 'ca'],
        'x-html-labels': ['United States', 'Canada'],
        'x-html-placeholder': 'Choose...',
        'x-html-type': 'select-one',
        'x-html-required': true,
      });
      assert.deepEqual(prop(create.schema, 'plan'), {
        type: 'string',
        enum: ['free', 'pro'],
        'x-html-type': 'radio',
        'x-html-labels': ['Free', 'Pro'],
        default: 'free',
      });
      assert.deepEqual(prop(create.schema, 'interests'), {
        type: 'array',
        items: { type: 'string', enum: ['a', 'b', 'c'], 'x-html-labels': ['A', 'B', 'C'], 'x-html-type': 'select-multiple' },
        uniqueItems: true,
        'x-html-type': 'select-multiple',
        default: ['a', 'c'],
      });
      assert.deepEqual(prop(create.schema, 'bio'), {
        type: 'string',
        maxLength: 400,
        'x-html-maxlength': 200,
        'x-html-type': 'textarea',
        default: 'Hello\nworld',
      });
      assert.deepEqual(prop(create.schema, 'terms'), { type: 'string', const: 'on', 'x-html-type': 'checkbox', 'x-html-required': true });
      assert.deepEqual(prop(create.schema, 'avatar'), { type: 'string', format: 'binary', 'x-html-accept': 'image/*', 'x-html-type': 'file' });
      assert.deepEqual(prop(create.schema, 'readonly_field'), {
        type: 'string',
        'x-html-type': 'text',
        readOnly: true,
        'x-html-readonly': true,
        default: 'ro',
      });
      assert.deepEqual(prop(create.schema, 'intent'), { type: 'string', title: 'Create', const: 'create', 'x-html-type': 'submit' });
      const draftButton = submitter(signup, 'intent', 'draft');
      assert.deepEqual(builder.target(signup, draftButton), { method: 'POST', url: url + '?draft=1', enctype: 'multipart/form-data' });
      const draft = builder.build(signup, draftButton);
      assert.equal(draft.action, url + '?draft=1');
      assert.equal(draft.schema['x-html-novalidate'], true);
      assert.deepEqual(draft.schema.required, ['intent']);
      assert.deepEqual(prop(draft.schema, 'intent').const, 'draft');
      assert.deepEqual(prop(draft.schema, 'username'), {
        type: 'string',
        title: '3-16 lowercase letters, digits or underscore',
        'x-html-pattern': '[a-z0-9_]{3,16}',
        'x-html-type': 'text',
        'x-html-required': true,
      });
      assert.deepEqual(prop(draft.schema, 'age').type, ['number', 'string']);
      assert.equal(prop(draft.schema, 'age').maxLength, 0);
      assert.equal(prop(draft.schema, 'age').minimum, undefined);
      assert.deepEqual(prop(draft.schema, 'country').enum, ['', 'us', 'ca']);
      assert.equal(prop(draft.schema, 'country').default, '');
    } finally {
      await site.close();
    }
  });
});

describe('FormSchemaBuilder entry-list semantics', () => {
  test('targets: submitter overrides, invalid formmethod, GET query replacement and fragments', () => {
    const descriptor = form(`<form action="/post?keep=1#frag" method="post" enctype="multipart/form-data">
      <button name="a">A</button><button name="b" formmethod="bogus" formaction="/get?drop=1#f">B</button>
      <button name="c" formenctype="text/plain">C</button><button name="d" formmethod="dialog">D</button></form>`);
    assert.deepEqual(builder.target(descriptor), { method: 'POST', url: 'https://example.com/post?keep=1', enctype: 'multipart/form-data' });
    assert.deepEqual(builder.target(descriptor, submitter(descriptor, 'b')), {
      method: 'GET',
      url: 'https://example.com/get',
      enctype: 'application/x-www-form-urlencoded',
    });
    assert.deepEqual(builder.target(descriptor, submitter(descriptor, 'c')).enctype, 'text/plain');
    assert.deepEqual(builder.target(descriptor, submitter(descriptor, 'd')), {
      method: 'DIALOG',
      url: 'https://example.com/post?keep=1#frag',
      enctype: 'multipart/form-data',
    });
    assert.throws(
      () => builder.build(descriptor, submitter(descriptor, 'd')),
      (err: unknown) => err instanceof AppiiError && err.code === 'UNSUPPORTED',
    );
    const get = builder.build(descriptor, submitter(descriptor, 'b'));
    assert.equal(get.method, 'GET');
    assert.equal(get.mimeType, 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.keys(props(get.schema)), ['b']);
  });

  test('default submitter is the first enabled one; disabled and unnamed submitters add no entry', () => {
    const descriptor = form(`<form method="post"><input name="a"><button name="off" value="x" disabled formaction="/off">Off</button>
      <button>Unnamed</button><button name="later" value="l">Later</button></form>`);
    assert.equal(builder.submitter(descriptor)?.label, 'Unnamed');
    assert.deepEqual(Object.keys(props(builder.build(descriptor).schema)), ['a']);
    const off = submitter(descriptor, 'off');
    const viaDisabled = builder.build(descriptor, off);
    assert.deepEqual(Object.keys(props(viaDisabled.schema)), ['a']);
    assert.equal(viaDisabled.action, 'https://example.com/off');
    const none = form('<form><input name="a"></form>');
    assert.equal(builder.submitter(none), undefined);
    assert.equal(builder.build(none).method, 'GET');
  });

  test('image and default-label submitters', () => {
    const named = form('<form method="post"><input name="a"><input type="image" name="pic" alt="Go" value="ignored"></form>');
    const schema = builder.build(named).schema;
    assert.deepEqual(Object.keys(props(schema)), ['a', 'pic.x', 'pic.y']);
    assert.deepEqual(prop(schema, 'pic.x'), {
      type: 'integer',
      title: 'Go',
      description: 'x coordinate of the activation point on the image button',
      'x-html-type': 'image',
    });
    assert.deepEqual(schema.required, ['pic.x', 'pic.y']);
    const unnamed = builder.build(form('<form method="post"><input type="image" src="i.png"></form>')).schema;
    assert.deepEqual(Object.keys(props(unnamed)), ['x', 'y']);
    const label = builder.build(form('<form method="post"><input type="submit" name="s"></form>')).schema;
    assert.equal(prop(label, 's').const, 'Submit');
    const empty = builder.build(form('<form method="post"><input type="submit" name="s" value=""><button name="b">B</button></form>')).schema;
    assert.equal(prop(empty, 's').const, '');
  });

  test('disabled, unnamed, datalist and inert controls are not part of the entry list', () => {
    const schema = builder.build(form(`<form method="post"><input name="kept"><input name="" value="x"><input value="y"><input name="off" disabled>
      <fieldset disabled><input name="fs"></fieldset><datalist><input name="dl"></datalist><button type="reset" name="r">R</button>
      <button type="button" name="b">B</button><input type="reset" name="ir"><input type="button" name="ib"></form>`)).schema;
    assert.deepEqual(Object.keys(props(schema)), ['kept']);
  });

  test('checkbox groups, mixed hidden/checkbox groups and repeated text inputs become arrays', () => {
    const schema = builder.build(form(`<form method="post">
      <label><input type="checkbox" name="tags" value="a" checked> Alpha</label>
      <label><input type="checkbox" name="tags" value="b" required> Beta</label>
      <label><input type="checkbox" name="tags" value="c" checked> Gamma</label>
      <input type="hidden" name="flag" value="0"><input type="checkbox" name="flag" value="1">
      <input name="line" value="one"><input name="line" value="two">
      <input name="mixed" value=""><input name="mixed" value="x">
      <input type="checkbox" name="dup" value="v"><input type="checkbox" name="dup" value="v">
    </form>`)).schema;
    assert.deepEqual(prop(schema, 'tags'), {
      type: 'array',
      items: { type: 'string', enum: ['a', 'b', 'c'], 'x-html-type': 'checkbox', 'x-html-labels': ['Alpha', 'Beta', 'Gamma'] },
      minItems: 1,
      maxItems: 3,
      uniqueItems: true,
      contains: { const: 'b' },
      'x-html-type': 'checkbox',
      'x-html-required': true,
      default: ['a', 'c'],
    });
    assert.deepEqual(prop(schema, 'flag'), {
      type: 'array',
      items: { anyOf: [{ type: 'string', 'x-html-type': 'hidden' }, { type: 'string', const: '1', 'x-html-type': 'checkbox' }] },
      minItems: 1,
      maxItems: 2,
      default: ['0'],
    });
    assert.deepEqual(prop(schema, 'line'), {
      type: 'array',
      items: { type: 'string', 'x-html-type': 'text' },
      minItems: 2,
      maxItems: 2,
      'x-html-type': 'text',
      default: ['one', 'two'],
    });
    assert.equal(prop(schema, 'mixed').default, undefined);
    assert.equal(prop(schema, 'dup').uniqueItems, undefined);
    assert.deepEqual(schema.required, ['tags']);
  });

  test('radio groups: enum of enabled values, required when any radio is required, checked default', () => {
    const schema = builder.build(form(`<form method="post">
      <label><input type="radio" name="size" value="s" title="Pick a size"> Small</label>
      <label><input type="radio" name="size" value="m" required checked title="Pick a size"> Medium</label>
      <input type="radio" name="size" value="l" disabled><label><input type="radio" name="size" value="s" title="Pick a size"> Small again</label>
      <input type="radio" name="none" value="x" disabled>
    </form>`)).schema;
    assert.deepEqual(prop(schema, 'size'), {
      type: 'string',
      description: 'Pick a size',
      enum: ['s', 'm'],
      'x-html-type': 'radio',
      'x-html-labels': ['Small', 'Medium'],
      'x-html-required': true,
      default: 'm',
    });
    assert.deepEqual(schema.required, ['size']);
    assert.equal(props(schema).none, undefined);
  });

  test('select elements: placeholder label option, disabled options, multiple, empty selects', () => {
    const schema = builder.build(form(`<form method="post">
      <select name="req" required><option value="">Choose</option><option value="a">A</option><option value="b" disabled>B</option></select>
      <select name="opt"><option value="">Choose</option><option value="a" selected>A</option></select>
      <select name="grouped" required><optgroup label="g"><option value="">In group</option></optgroup><option value="z">Z</option></select>
      <select name="multi" multiple required><option value="a" selected>A</option><option value="a">A again</option><option value="b" disabled selected>B</option></select>
      <select name="nothing"><option disabled>x</option></select>
    </form>`)).schema;
    assert.deepEqual(prop(schema, 'req').enum, ['a']);
    assert.equal(prop(schema, 'req').default, undefined);
    assert.deepEqual([prop(schema, 'opt').enum, prop(schema, 'opt').default], [['', 'a'], 'a']);
    assert.deepEqual(prop(schema, 'grouped').enum, ['', 'z']);
    assert.deepEqual(prop(schema, 'multi'), {
      type: 'array',
      items: { type: 'string', enum: ['a'], 'x-html-labels': ['A'], 'x-html-type': 'select-multiple', 'x-html-required': true },
      minItems: 1,
      maxItems: 2,
      'x-html-type': 'select-multiple',
      'x-html-required': true,
      default: ['a'],
    });
    assert.equal(props(schema).nothing, undefined);
    assert.deepEqual(schema.required, ['req', 'grouped', 'multi']);
  });

  test('number and range: integer vs number, multipleOf only for aligned step bases, range defaults', () => {
    const schema = builder.build(form(`<form method="post">
      <input type="number" name="plain"><input type="number" name="any" step="any" min="0"><input type="number" name="cents" step="0.01" value="1.50">
      <input type="number" name="half" min="0.5"><input type="number" name="fives" min="10" step="5"><input type="number" name="odd" min="1" step="2" value="3">
      <input type="number" name="frac" value="2.5"><input type="number" name="frac0" min="0" value="2.5"><input type="number" name="bad" min="x" max="y" step="z" required value="nope">
      <input type="range" name="vol"><input type="range" name="steps" min="0" max="10" step="3"><input type="range" name="tiny" min="0" max="1" step="0.1" value="0.3">
      <input type="range" name="free" step="any" min="1" max="2">
    </form>`)).schema;
    const empty = (type: string): JsonSchema => ({ type: [type, 'string'], maxLength: 0 });
    assert.deepEqual(prop(schema, 'plain'), { ...empty('integer'), 'x-html-type': 'number' });
    assert.deepEqual(prop(schema, 'any'), { ...empty('number'), minimum: 0, 'x-html-min': '0', 'x-html-step': 'any', 'x-html-type': 'number' });
    assert.deepEqual(prop(schema, 'cents'), { ...empty('number'), multipleOf: 0.01, 'x-html-step': '0.01', 'x-html-type': 'number', default: 1.5 });
    assert.deepEqual(prop(schema, 'half'), { ...empty('number'), minimum: 0.5, 'x-html-min': '0.5', 'x-html-type': 'number' });
    assert.deepEqual(prop(schema, 'fives'), { ...empty('integer'), minimum: 10, multipleOf: 5, 'x-html-min': '10', 'x-html-step': '5', 'x-html-type': 'number' });
    assert.deepEqual(prop(schema, 'odd'), { ...empty('integer'), minimum: 1, 'x-html-min': '1', 'x-html-step': '2', 'x-html-type': 'number', default: 3 });
    assert.deepEqual(prop(schema, 'frac'), { ...empty('number'), 'x-html-type': 'number', default: 2.5 });
    assert.deepEqual(prop(schema, 'frac0'), { ...empty('integer'), minimum: 0, 'x-html-min': '0', 'x-html-type': 'number' });
    assert.deepEqual(prop(schema, 'bad'), {
      type: 'integer',
      'x-html-min': 'x',
      'x-html-max': 'y',
      'x-html-step': 'z',
      'x-html-type': 'number',
      'x-html-required': true,
    });
    assert.deepEqual(prop(schema, 'vol'), { type: 'integer', minimum: 0, maximum: 100, 'x-html-type': 'range', default: 50 });
    assert.deepEqual(prop(schema, 'steps'), {
      type: 'integer',
      minimum: 0,
      maximum: 10,
      multipleOf: 3,
      'x-html-min': '0',
      'x-html-max': '10',
      'x-html-step': '3',
      'x-html-type': 'range',
      default: 6,
    });
    assert.deepEqual(prop(schema, 'tiny'), {
      type: 'number',
      minimum: 0,
      maximum: 1,
      multipleOf: 0.1,
      'x-html-min': '0',
      'x-html-max': '1',
      'x-html-step': '0.1',
      'x-html-type': 'range',
      default: 0.3,
    });
    assert.deepEqual(prop(schema, 'free'), {
      type: 'number',
      minimum: 1,
      maximum: 2,
      'x-html-min': '1',
      'x-html-max': '2',
      'x-html-step': 'any',
      'x-html-type': 'range',
      default: 1.5,
    });
    assert.deepEqual(schema.required, ['bad']);
  });

  test('patterns follow the v-flag validity rules of the HTML pattern attribute', () => {
    assert.deepEqual(EntrySlotFactory.pattern('[a-z]+'), { html: '[a-z]+', json: '^(?:[a-z]+)$' });
    assert.deepEqual(EntrySlotFactory.pattern('['), {});
    assert.deepEqual(EntrySlotFactory.pattern('[(]'), {});
    assert.deepEqual(EntrySlotFactory.pattern('a)|(b'), {});
    assert.deepEqual(EntrySlotFactory.pattern('[\\w--\\d]+'), { html: '[\\w--\\d]+' });
    assert.deepEqual(EntrySlotFactory.pattern(undefined), {});
    const schema = builder.build(form(`<form method="post"><input name="ok" pattern="\\d{3}"><input name="broken" pattern="(" required>
      <input name="vonly" pattern="[\\w--\\d]+"><input type="number" name="num" pattern="\\d"></form>`)).schema;
    assert.equal(prop(schema, 'ok').pattern, '^(?:\\d{3})?$');
    assert.equal(prop(schema, 'broken').pattern, undefined);
    assert.equal(prop(schema, 'broken')['x-html-pattern'], undefined);
    assert.equal(prop(schema, 'vonly').pattern, undefined);
    assert.equal(prop(schema, 'vonly')['x-html-pattern'], '[\\w--\\d]+');
    assert.equal(prop(schema, 'num')['x-html-pattern'], undefined);
  });

  test('text-like types: email lists, url, temporal microsyntaxes, color, lengths', () => {
    const schema = builder.build(form(`<form method="post">
      <input type="email" name="many" multiple pattern=".+@example\\.com" required value=" a@b.c , d@e.f ">
      <input type="url" name="site" value=" https://x.y/ "><input type="time" name="at" required><input type="month" name="mo" value="2024-02">
      <input type="week" name="wk" min="2024-W01"><input type="datetime-local" name="dt" value="2024-01-02 03:04:05.600"><input type="color" name="tint" value="#FF0000">
      <input name="len" minlength="2" maxlength="5"><textarea name="area" maxlength="3" required>abcd</textarea>
    </form>`)).schema;
    assert.deepEqual(prop(schema, 'many'), {
      type: 'string',
      pattern: EntrySlotFactory.PATTERNS['email-list'],
      minLength: 1,
      'x-html-pattern': '.+@example\\.com',
      'x-html-multiple': true,
      'x-html-type': 'email',
      'x-html-required': true,
      default: 'a@b.c,d@e.f',
    });
    assert.match('a@b.c,d@e.f', new RegExp(String(prop(schema, 'many').pattern), 'u'));
    assert.match('', new RegExp(String(prop(schema, 'many').pattern), 'u'));
    assert.doesNotMatch('a@b.c,,d@e.f', new RegExp(String(prop(schema, 'many').pattern), 'u'));
    assert.deepEqual(prop(schema, 'site'), { type: 'string', 'x-html-type': 'url', default: 'https://x.y/' });
    assert.deepEqual(prop(schema, 'at'), {
      type: 'string',
      pattern: EntrySlotFactory.PATTERNS.time,
      minLength: 1,
      'x-html-type': 'time',
      'x-html-required': true,
    });
    assert.deepEqual(prop(schema, 'mo'), { type: 'string', pattern: '^(?:\\d{4,}-(?:0[1-9]|1[0-2]))?$', 'x-html-type': 'month', default: '2024-02' });
    assert.equal(prop(schema, 'wk')['x-html-min'], '2024-W01');
    assert.equal(prop(schema, 'dt').default, '2024-01-02T03:04:05.6');
    assert.match('2024-01-02T03:04:05.6', new RegExp(String(prop(schema, 'dt').pattern), 'u'));
    assert.deepEqual(prop(schema, 'tint'), { type: 'string', pattern: '^(?:#[0-9a-f]{6})$', 'x-html-type': 'color', default: '#ff0000' });
    assert.deepEqual(prop(schema, 'len'), { type: 'string', maxLength: 5, 'x-html-minlength': 2, 'x-html-maxlength': 5, 'x-html-type': 'text' });
    assert.deepEqual(prop(schema, 'area'), {
      type: 'string',
      minLength: 1,
      maxLength: 6,
      'x-html-maxlength': 3,
      'x-html-type': 'textarea',
      'x-html-required': true,
      default: 'abcd',
    });
    for (const [name, value] of [['at', '23:59:59.999'], ['wk', '2024-W53'], ['tint', '#00ff7f']] as const) {
      assert.match(value, new RegExp(String(prop(schema, name).pattern), 'u'), name);
    }
  });

  test('files: binary parts for multipart, filenames otherwise, arrays when multiple', () => {
    const html = `<form method="post" enctype="multipart/form-data"><input type="file" name="png" accept=" IMAGE/PNG "><input type="file" name="imgs" accept="image/*" multiple required>
      <input type="file" name="doc" accept=".pdf"><input type="file" name="two" accept="image/png,image/jpeg"><input type="file" name="req" required>
      <button>Send</button><button name="plain" formenctype="application/x-www-form-urlencoded">Plain</button></form>`;
    const descriptor = form(html);
    const multipart = builder.build(descriptor).schema;
    assert.deepEqual(prop(multipart, 'png'), {
      type: 'string',
      format: 'binary',
      contentMediaType: 'image/png',
      'x-html-accept': ' IMAGE/PNG ',
      'x-html-type': 'file',
    });
    assert.deepEqual(prop(multipart, 'imgs'), {
      type: 'array',
      items: { type: 'string', format: 'binary', 'x-html-accept': 'image/*', 'x-html-type': 'file', 'x-html-required': true },
      minItems: 1,
      'x-html-type': 'file',
      'x-html-required': true,
    });
    assert.equal(prop(multipart, 'doc').contentMediaType, undefined);
    assert.equal(prop(multipart, 'two').contentMediaType, undefined);
    assert.deepEqual(multipart.required, ['imgs', 'req']);
    const urlencoded = builder.build(descriptor, submitter(descriptor, 'plain')).schema;
    assert.deepEqual(prop(urlencoded, 'png'), { type: 'string', 'x-html-accept': ' IMAGE/PNG ', 'x-html-type': 'file' });
    assert.deepEqual(prop(urlencoded, 'req'), { type: 'string', minLength: 1, 'x-html-type': 'file', 'x-html-required': true });
    assert.equal(EntrySlotFactory.mediaType('application/vnd.api+json'), 'application/vnd.api+json');
    assert.equal(EntrySlotFactory.mediaType('text/html;charset=utf-8'), 'text/html');
    assert.equal(EntrySlotFactory.mediaType(''), undefined);
  });

  test('hidden fields, tokens, _charset_, dirname, readonly, password and barred constraints', () => {
    const html = `<form method="post">
      <input type="hidden" name="return" value=""><input type="hidden" name="_CHARSET_" value="x"><input type="hidden" name="nonce" value="n1">
      <input type="hidden" name="authenticity_token"><input type="hidden" name="csrf" value="c" disabled>
      <input name="q" dirname="q.dir" value="v"><textarea name="msg" dirname="msg.dir"></textarea><input name="" dirname="lost.dir">
      <input name="ro" readonly required pattern="x" minlength="3" maxlength="4" value="val"><input type="password" name="pw" value="secret" required>
      <input type="hidden" name="req_hidden" required value="h">
    </form>`;
    const result = builder.build(form(html));
    const schema = result.schema;
    assert.deepEqual(Object.keys(props(schema)), [
      'return', '_CHARSET_', 'nonce', 'authenticity_token', 'q', 'q.dir', 'msg', 'msg.dir', 'ro', 'pw', 'req_hidden',
    ]);
    assert.deepEqual(prop(schema, 'return'), { type: 'string', 'x-html-type': 'hidden', default: '' });
    assert.deepEqual(prop(schema, '_CHARSET_'), { type: 'string', const: 'windows-1252', 'x-html-type': 'hidden' });
    assert.deepEqual(prop(schema, 'nonce'), { type: 'string', readOnly: true, 'x-appii-token': true, 'x-appii-token-example': 'n1', 'x-html-type': 'hidden' });
    assert.deepEqual(prop(schema, 'authenticity_token'), { type: 'string', readOnly: true, 'x-appii-token': true, 'x-html-type': 'hidden' });
    assert.deepEqual(result.tokenFields, ['nonce', 'authenticity_token']);
    assert.deepEqual(prop(schema, 'q.dir'), {
      type: 'string',
      description: 'Text direction of the q field',
      enum: ['ltr', 'rtl'],
      'x-html-dirname-for': 'q',
    });
    assert.deepEqual(prop(schema, 'ro'), {
      type: 'string',
      'x-html-pattern': 'x',
      'x-html-minlength': 3,
      'x-html-maxlength': 4,
      'x-html-type': 'text',
      'x-html-required': true,
      readOnly: true,
      'x-html-readonly': true,
      default: 'val',
    });
    assert.equal(prop(schema, 'pw').default, undefined);
    assert.ok(!JSON.stringify(schema).includes('secret'));
    assert.deepEqual(prop(schema, 'req_hidden'), { type: 'string', 'x-html-type': 'hidden', default: 'h' });
    assert.deepEqual(schema.required, ['pw']);
  });

  test('tokens are detected even when the descriptor did not list them, and the detector is injectable', () => {
    const descriptor = { ...form('<form method="post"><input type="hidden" name="_csrf" value="z"></form>'), tokenFields: [] };
    assert.deepEqual(builder.build(descriptor).tokenFields, ['_csrf']);
    class NoTokens extends TokenDetector {
      override isTokenField(): boolean {
        return false;
      }
    }
    const custom = new FormSchemaBuilder({ tokens: new NoTokens() });
    assert.deepEqual(custom.build(descriptor).tokenFields, []);
    assert.equal(prop(custom.build(descriptor).schema, '_csrf').default, 'z');
  });

  test('field() describes one name group directly', () => {
    const descriptor = form(`<form method="post"><input type="radio" name="r" value="a" checked><input type="radio" name="r" value="b">
      <input type="radio" name="r" value="c" disabled><input type="file" name="f" multiple><input name="t" required>
      <button name="go" value="1">Go</button><input type="image" name="img"></form>`);
    const radios = descriptor.fields.filter((f) => f.name === 'r');
    const first = radios[0];
    assert.ok(first);
    assert.deepEqual(builder.field(first, radios), { type: 'string', enum: ['a', 'b'], 'x-html-type': 'radio', default: 'a' });
    const file = descriptor.fields.find((f) => f.name === 'f');
    assert.ok(file);
    assert.equal(Schema.items(builder.field(file, []))?.format, 'binary');
    assert.deepEqual(builder.field(file, [], { multipart: false }).items, { type: 'string', 'x-html-type': 'file' });
    const text = descriptor.fields.find((f) => f.name === 't');
    assert.ok(text);
    assert.equal(builder.field(text, []).minLength, 1);
    assert.equal(builder.field(text, [], { validate: false }).minLength, undefined);
    assert.deepEqual(builder.field(submitter(descriptor, 'go'), []), { type: 'string', title: 'Go', const: '1', 'x-html-type': 'submit' });
    assert.equal(builder.field(submitter(descriptor, 'img'), []).type, 'integer');
  });

  test('form-level novalidate drops validation keywords but keeps value shapes', () => {
    const schema = builder.build(form(`<form method="post" novalidate><input type="email" name="e" required multiple minlength="3" maxlength="9">
      <select name="s" required><option value="">Pick</option><option>x</option></select><input type="range" name="r" min="1" max="3"></form>`)).schema;
    assert.equal(schema['x-html-novalidate'], true);
    assert.equal(schema.required, undefined);
    assert.deepEqual(prop(schema, 'e'), {
      type: 'string',
      maxLength: 9,
      'x-html-minlength': 3,
      'x-html-maxlength': 9,
      'x-html-multiple': true,
      'x-html-type': 'email',
      'x-html-required': true,
    });
    assert.deepEqual(prop(schema, 's').enum, ['', 'x']);
    assert.deepEqual([prop(schema, 'r').minimum, prop(schema, 'r').maximum, prop(schema, 'r').type], [1, 3, 'integer']);
  });

  test('property names that collide with Object.prototype members are kept as own properties', () => {
    const schema = builder.build(form('<form method="post"><input name="__proto__" value="p"><input name="constructor" value="c"></form>')).schema;
    const properties = schema.properties as Record<string, unknown>;
    assert.deepEqual(Object.keys(properties), ['__proto__', 'constructor']);
    assert.ok(Object.hasOwn(properties, '__proto__'));
    assert.equal(Object.getPrototypeOf(properties), Object.prototype);
  });
});

function count(entries: [string, SubmittedValue][]): Map<string, SubmittedValue[]> {
  const out = new Map<string, SubmittedValue[]>();
  for (const [name, value] of entries) out.set(name, [...(out.get(name) ?? []), value]);
  return out;
}

const HTML_FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

function typed(schema: JsonSchema, value: string): unknown {
  const types = Schema.schemaTypes(schema);
  const numeric = types.includes('integer') || types.includes('number');
  return numeric && HTML_FLOAT.test(value) ? Number(value) : value;
}

function checkValue(schema: JsonSchema, value: SubmittedValue, where: string): void {
  if (typeof value !== 'string') {
    assert.equal(schema.format, 'binary', where);
    if (typeof schema.contentMediaType === 'string') assert.equal(value.type, schema.contentMediaType, where);
    return;
  }
  assert.deepEqual(SchemaCheck.errors(schema, typed(schema, value), where), [], `${where}: ${JSON.stringify(value)} is valid`);
}

function checkSubmission(schema: JsonSchema, entries: [string, SubmittedValue][], expectedMissing: string[]): void {
  const properties = props(schema);
  const sent = count(entries);
  for (const name of sent.keys()) assert.ok(name in properties, `sent name ${name} is a schema property`);
  const missing = Object.keys(properties).filter((name) => !sent.has(name));
  assert.deepEqual(missing.sort(), [...expectedMissing].sort(), 'schema properties not sent');
  const required = Schema.requiredSet(schema);
  for (const name of required) assert.ok(sent.has(name), `required ${name} was sent`);
  for (const [name, values] of sent) {
    const property = properties[name];
    assert.ok(property);
    if (property.type === 'array') {
      const minItems = typeof property.minItems === 'number' ? property.minItems : 0;
      const maxItems = typeof property.maxItems === 'number' ? property.maxItems : Number.POSITIVE_INFINITY;
      assert.ok(values.length >= minItems && values.length <= maxItems, `${name}: ${values.length} entries within ${minItems}..${maxItems}`);
      const inner = Schema.items(property);
      assert.ok(inner);
      values.forEach((value, i) => checkValue(inner, value, `${name}[${i}]`));
    } else {
      assert.equal(values.length, 1, `${name} is sent once`);
      checkValue(property, values[0] as SubmittedValue, name);
    }
  }
}

const TRICKY = `<!doctype html><html><body>
<form id="t" action="/submit/tricky" method="post">
  <input name="text1" value="x" dirname="text1.dir">
  <input name="" value="unnamed"><input value="noname"><input name="dis" disabled value="d">
  <fieldset disabled><legend><input name="leg_on" value="1"></legend><input name="fs_off" value="1"></fieldset>
  <input type="checkbox" name="cbs" value="a" checked><input type="checkbox" name="cbs" value="b"><input type="checkbox" name="cbs" value="c" checked>
  <input type="hidden" name="flag" value="0"><input type="checkbox" name="flag" value="1">
  <input name="tags" value="t1"><input name="tags" value="t2">
  <select name="multi" multiple><option selected>m1</option><option>m2</option><option selected>m3</option></select>
  <textarea name="notes" dirname="notes.dir">hello</textarea>
  <input type="hidden" name="_charset_" value="ignored"><input type="hidden" name="csrf_token" value="tok">
  <input name="ro" readonly value="r"><input type="bogus" name="unknown" value="u">
  <input type="radio" name="choice" value="x"><input type="radio" name="choice" value="y" checked>
  <input type="number" name="qty" value="3" min="1" max="9"><input type="range" name="vol" min="0" max="10" step="5">
  <input type="color" name="tint"><input type="date" name="when" value="2024-02-29"><input type="datetime-local" name="dt" value="2024-01-02 03:04">
  <input type="email" name="mails" multiple value="a@b.c, d@e.f"><input type="url" name="site" value="https://example.com/">
  <button type="reset" name="rs">R</button><button type="button" name="bt">B</button><button name="other" value="o">Other</button>
  <input type="image" name="pic" alt="Pic" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20">
</form>
<input name="outside" form="t" value="o">
<form id="u" action="/submit/unnamed" method="post"><input name="a" value="1"><input type="image" alt="Go" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20"></form>
<form id="g" action="/submit/get?drop=1#frag" method="get"><input name="q" value="hello"><select name="sort"><option>new</option><option>old</option></select><button name="go" value="1">Go</button></form>
<form id="p" action="/submit/plain" method="post" enctype="text/plain"><input name="a" value="1"><input name="b" value="two words"><input type="submit" name="s" value="S"></form>
<form id="m" action="/submit/multi" method="post" enctype="multipart/form-data"><input type="file" name="files" multiple><input type="file" name="single" accept="image/png"><input type="file" name="empty"><input name="t" value="x"><button>Send</button></form>
<form id="o" action="/submit/post" method="post"><input name="a" value="1"><button name="b" value="2" formmethod="get" formaction="/submit/override?z=1">Get</button></form>
<form id="d" action="/submit/defaultlabel" method="post"><input name="a" value="1"><input type="submit" name="s" dirname="s.dir"></form>
<form id="r" action="/submit/rails"><input type="hidden" name="flag" value="0"><input type="checkbox" name="flag" value="1"><button>Go</button></form>
</body></html>`;

const REQUIRED = `<!doctype html><html><body>
<form id="req" action="/submit/req" method="post">
  <input name="t" required><input name="ro" required readonly><input type="hidden" name="h" required><input type="range" name="rg" required>
  <input type="color" name="col" required><input type="checkbox" name="cb" required>
  <input type="radio" name="rad" value="a"><input type="radio" name="rad" value="b" required>
  <select name="sel" required><option value="">Pick</option><option>x</option></select><select name="sel2" required><option>x</option></select>
  <select name="multi" multiple required><option>x</option></select><input type="file" name="f" required><textarea name="ta" required></textarea>
  <input type="number" name="num" required><input type="date" name="d" required><input name="dis" required disabled>
  <datalist><input name="dl" required></datalist><input name="tt" required pattern="x" minlength="2">
  <button name="go" value="1">Go</button><button name="draft" value="1" formnovalidate>Draft</button>
</form></body></html>`;

describe('FormSchemaBuilder matches what Chromium submits', () => {
  let browser: Browser | undefined;
  let server: PageServer | undefined;

  before(async () => {
    server = await PageServer.start();
    browser = await PageServer.launchBrowser();
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  async function submit(
    path: string,
    html: string,
    formIndex: number,
    pick: [string, string?] | undefined,
    clickSelector: string,
    fill: (page: Page) => Promise<void>,
    expectedMissing: string[],
  ): Promise<void> {
    assert.ok(browser && server);
    const srv = server;
    const url = srv.page(path, html);
    const descriptor = extractor.extractDocument(HtmlDocument.parse(html, url, { encoding: PageServer.CHARSET }))[formIndex];
    assert.ok(descriptor, `form ${formIndex}`);
    const active = pick === undefined ? undefined : submitter(descriptor, pick[0], pick[1]);
    const built = builder.build(descriptor, active);
    const page = await browser.newPage();
    try {
      await page.goto(url);
      await fill(page);
      const target = new URL(built.action);
      const waiting = srv.waitFor((request) => new URL(request.url).pathname === target.pathname);
      await page.click(clickSelector);
      const request = await waiting;
      assert.equal(request.method, built.method);
      if (built.method === 'POST') {
        assert.equal(new URL(request.url).href, built.action);
        assert.equal((request.contentType.split(';')[0] ?? '').trim(), built.mimeType);
      } else {
        const sentUrl = new URL(request.url);
        sentUrl.search = '';
        assert.equal(sentUrl.href, built.action);
      }
      checkSubmission(built.schema, await PageServer.entries(request), expectedMissing);
    } finally {
      await page.close();
    }
  }

  test('fixture login form', async () => {
    const site = await startFixtureSite();
    try {
      const html = await (await fetch(site.origin + '/login')).text();
      await submit('/fx/login', html, 0, ['action'], 'button[name=action]', async (page) => {
        await page.fill('#email', 'user@example.com');
        await page.fill('#password', 'correct-horse');
        await page.check('input[name=remember]');
      }, []);
    } finally {
      await site.close();
    }
  });

  test('fixture signup form with the default submitter and with the formnovalidate draft submitter', async () => {
    const site = await startFixtureSite();
    try {
      const html = await (await fetch(site.origin + '/signup')).text();
      await submit('/fx/signup', html, 0, undefined, 'button[value=create]', async (page) => {
        await page.fill('input[name=username]', 'alice_1');
        await page.fill('input[name=email]', 'alice@example.com');
        await page.fill('input[name=age]', '30');
        await page.fill('input[name=website]', 'https://example.com/');
        await page.fill('input[name=birthday]', '2000-01-02');
        await page.selectOption('select[name=country]', 'ca');
        await page.check('input[name=plan][value=pro]');
        await page.fill('textarea[name=bio]', 'Hi there');
        await page.check('input[name=terms]');
        await page.setInputFiles('input[name=avatar]', { name: 'me.png', mimeType: 'image/png', buffer: Buffer.from('png') });
      }, []);
      await submit('/fx/signup-draft', html, 0, ['intent', 'draft'], 'button[value=draft]', async () => {}, ['terms']);
    } finally {
      await site.close();
    }
  });

  test('tricky urlencoded form submitted with a named image button', async () => {
    await submit('/tricky', TRICKY, 0, ['pic'], 'input[name=pic]', async (page) => {
      await page.check('input[name=cbs][value=b]');
      await page.check('input[name=flag][value="1"]');
    }, []);
    await submit('/tricky-partial', TRICKY, 0, ['pic'], 'input[name=pic]', async (page) => {
      await page.uncheck('input[name=cbs][value=a]');
      await page.uncheck('input[name=cbs][value=c]');
      await page.selectOption('select[name=multi]', []);
    }, ['cbs', 'multi']);
  });

  test('unnamed image button, GET, text/plain, multipart files, overrides, default label and hidden+checkbox', async () => {
    await submit('/unnamed', TRICKY, 1, [''], '#u input[type=image]', async () => {}, []);
    await submit('/get', TRICKY, 2, ['go'], '#g button', async () => {}, []);
    await submit('/plain', TRICKY, 3, ['s'], '#p input[type=submit]', async () => {}, []);
    await submit('/multi', TRICKY, 4, undefined, '#m button', async (page) => {
      await page.setInputFiles('input[name=files]', [
        { name: 'a.txt', mimeType: 'text/plain', buffer: Buffer.from('a') },
        { name: 'b.txt', mimeType: 'text/plain', buffer: Buffer.from('b') },
      ]);
      await page.setInputFiles('input[name=single]', { name: 'p.png', mimeType: 'image/png', buffer: Buffer.from('p') });
    }, []);
    await submit('/override', TRICKY, 5, ['b'], '#o button', async () => {}, []);
    await submit('/defaultlabel', TRICKY, 6, ['s'], '#d input[type=submit]', async () => {}, []);
    await submit('/rails', TRICKY, 7, undefined, '#r button', async () => {}, []);
    await submit('/rails-checked', TRICKY, 7, undefined, '#r button', async (page) => page.check('#r input[type=checkbox]'), []);
  });

  test('required properties match the controls Chromium reports as valueMissing', async () => {
    assert.ok(browser && server);
    const url = server.page('/required', REQUIRED);
    const descriptor = form(REQUIRED, 0, url);
    const required = Schema.requiredSet(builder.build(descriptor).schema);
    const draftRequired = Schema.requiredSet(builder.build(descriptor, submitter(descriptor, 'draft')).schema);
    const page = await browser.newPage();
    try {
      await page.goto(url);
      const state = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#req input, #req select, #req textarea')).map((el) => {
          const control = el as HTMLInputElement;
          return { name: control.name, missing: control.validity.valueMissing && control.willValidate, required: control.required && control.willValidate };
        }),
      );
      const missing = new Set(state.filter((s) => s.missing).map((s) => s.name));
      const flagged = new Set(state.filter((s) => s.required).map((s) => s.name));
      const fields = new Set([...required].filter((name) => name !== 'go'));
      assert.deepEqual([...missing].filter((name) => !fields.has(name)), []);
      assert.deepEqual([...fields].filter((name) => !flagged.has(name)), []);
      assert.deepEqual([...flagged].filter((name) => !fields.has(name)).sort(), ['col', 'rg']);
      assert.deepEqual([...fields].filter((name) => !missing.has(name)), ['sel2']);
      assert.deepEqual([...draftRequired], ['draft']);
      assert.equal(await page.evaluate(() => (document.getElementById('req') as HTMLFormElement).checkValidity()), false);
    } finally {
      await page.close();
    }
  });
});
