import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FormSchemaCombiner, ModelBuilder, PathTemplater } from '../src/build/index.js';
import type { ApiModel, Endpoint, JsonSchema } from '../src/model/index.js';
import { Schema } from '../src/shared/index.js';
import { SchemaCheck } from './fixtures/build-schema-check.js';
import { CaptureFactory } from './helpers/capture-factory.js';

function build(f: CaptureFactory): ApiModel {
  return ModelBuilder.create({ now: new Date(0) }).build(f.capture());
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

describe('several forms or submitters posting to one endpoint (FB-14)', () => {
  test('Django admin: each differently named submitter is a valid submission on its own, never together', () => {
    const f = new CaptureFactory();
    f.snapshot(
      '/admin/blog/post/add/',
      'Add post',
      `<form method="post" action="/admin/blog/post/add/"><input name="title" required maxlength="50">
       <input type="submit" name="_save" value="Save"><input type="submit" name="_addanother" value="Save and add another"><input type="submit" name="_continue" value="Save and continue editing"></form>`,
    );
    const schema = endpoint(build(f), 'POST', '/admin/blog/post/add/').requestBody?.schema;
    for (const button of ['_save', '_addanother', '_continue']) {
      const value = { _save: 'Save', _addanother: 'Save and add another', _continue: 'Save and continue editing' }[button];
      assert.deepEqual(SchemaCheck.errors(schema, { title: 'Hello', [button]: value }), [], button);
      assert.ok(!SchemaCheck.valid(schema, { [button]: value }), `${button} without the required title`);
    }
    assert.ok(!SchemaCheck.valid(schema, { title: 'Hello', _save: 'Save', _addanother: 'Save and add another' }));
    assert.deepEqual(schema?.required, ['title']);
    assert.deepEqual(Object.keys(Schema.properties(schema)), ['title', '_save', '_addanother', '_continue']);
  });

  test('two different forms posting to one URL keep their own required fields', () => {
    const f = new CaptureFactory();
    f.snapshot(
      '/cart',
      'Cart',
      `<form method="post" action="/cart"><input type="number" name="quantity" required value="1"><button name="update" value="1">Update</button></form>
       <form method="post" action="/cart"><input name="discount" required><button name="apply" value="1">Apply</button></form>`,
    );
    const schema = endpoint(build(f), 'POST', '/cart').requestBody?.schema;
    assert.deepEqual(SchemaCheck.errors(schema, { quantity: 2, update: '1' }), []);
    assert.deepEqual(SchemaCheck.errors(schema, { discount: 'SUMMER', apply: '1' }), []);
    assert.ok(!SchemaCheck.valid(schema, { apply: '1' }), 'the coupon form requires discount');
    assert.ok(!SchemaCheck.valid(schema, { update: '1' }), 'the cart form requires quantity');
    assert.equal(schema?.required, undefined);
  });

  test('forms whose submissions overlap are combined without rejecting either one', () => {
    const combiner = new FormSchemaCombiner();
    const a: JsonSchema = { type: 'object', properties: { q: { type: 'string', minLength: 1 } }, required: ['q'] };
    const b: JsonSchema = { type: 'object', properties: { q: { type: 'string', minLength: 3 }, page: { type: 'string' } }, required: ['q'] };
    const combined = combiner.combine([a, b]);
    assert.deepEqual(SchemaCheck.errors(combined, { q: 'x' }), []);
    assert.deepEqual(SchemaCheck.errors(combined, { q: 'xyz', page: '2' }), []);
    assert.deepEqual(Schema.properties(combined).q, { type: 'string', minLength: 1 });
    assert.equal(combiner.combine([a, a]).if, undefined);
  });
});

describe('distinct actions under a plural parent (FB-15)', () => {
  test('django-allauth login, signup and logout stay three endpoints with their own forms', () => {
    const f = new CaptureFactory();
    const token = '<input type="hidden" name="csrfmiddlewaretoken" value="tok123456789">';
    const pages: Record<string, string> = {
      login: `<form method="post" action="/accounts/login/">${token}<input name="login" required><input type="password" name="password" required><button>Sign in</button></form>`,
      signup: `<form method="post" action="/accounts/signup/">${token}<input type="email" name="email"><input name="username" required><input type="password" name="password1" required><input type="password" name="password2" required><button>Sign up</button></form>`,
      logout: `<form method="post" action="/accounts/logout/">${token}<button>Sign out</button></form>`,
    };
    for (const [name, html] of Object.entries(pages)) {
      f.document(`/accounts/${name}/`, CaptureFactory.page(name, html));
      f.exchange({ method: 'POST', url: `/accounts/${name}/`, resourceType: 'document', status: 302, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'csrfmiddlewaretoken=tok123456789' });
    }
    const model = build(f);
    for (const name of Object.keys(pages)) {
      endpoint(model, 'GET', `/accounts/${name}/`);
      endpoint(model, 'POST', `/accounts/${name}/`);
    }
    assert.deepEqual(Schema.requiredSet(endpoint(model, 'POST', '/accounts/login/').requestBody?.schema), new Set(['login', 'password']));
    assert.deepEqual(Schema.requiredSet(endpoint(model, 'POST', '/accounts/signup/').requestBody?.schema), new Set(['username', 'password1', 'password2']));
    assert.deepEqual(Schema.requiredSet(endpoint(model, 'POST', '/accounts/logout/').requestBody?.schema), new Set());
  });

  test('profile pages without conflicting evidence still become one templated endpoint', () => {
    const f = new CaptureFactory();
    for (const user of ['alice', 'bob', 'carol']) f.document(`/users/${user}`, CaptureFactory.page(user, `<h1>${user}</h1>`));
    const model = build(f);
    assert.equal(endpoint(model, 'GET', '/users/{user}').count, 3);
  });

  test('the templater keeps rows with conflicting operation evidence literal', () => {
    const paths = ['/accounts/login/', '/accounts/signup/', '/accounts/logout/', '/accounts/alice/', '/accounts/bob/', '/accounts/carol/'];
    const evidence = new Map([
      ['/accounts/login/', { forms: new Set(['["login","password"]']), names: new Set(['login', 'password']) }],
      ['/accounts/signup/', { forms: new Set(['["email","password1"]']), names: new Set(['email', 'password1']) }],
      ['/accounts/logout/', { forms: new Set(['[]']), names: new Set<string>() }],
    ]);
    const templates = new PathTemplater().template(paths, evidence);
    assert.deepEqual(paths.map((path) => templates.get(path)?.template), [
      '/accounts/login/',
      '/accounts/signup/',
      '/accounts/logout/',
      '/accounts/{account}/',
      '/accounts/{account}/',
      '/accounts/{account}/',
    ]);
    const forum = new PathTemplater().template(['/forums/a/post', '/forums/b/post', '/forums/c/post'], new Map(['/forums/a/post', '/forums/b/post', '/forums/c/post'].map((path) => [path, { forms: new Set(['["body","subject"]']), names: new Set(['body', 'subject']) }])));
    assert.equal(forum.get('/forums/a/post')?.template, '/forums/{forum}/post');
  });
});

describe('forms whose submission a script re-encodes (FB-16)', () => {
  test('an observed JSON body keeps its JSON types and gains only HTML annotations', () => {
    const f = new CaptureFactory();
    f.snapshot(
      '/subscribe',
      'Subscribe',
      `<form method="post" action="/api/subscribe"><input type="email" name="email" required><input type="checkbox" name="remember"><select name="plan"><option value="1">Basic</option><option value="2">Pro</option></select></form>`,
    );
    for (const remember of [true, false]) {
      f.json('POST', '/api/subscribe', 200, { ok: true }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { email: 'a@example.com', remember, plan: 2 } } });
    }
    const body = endpoint(build(f), 'POST', '/api/subscribe').requestBody;
    assert.equal(body?.kind, 'json');
    const props = Schema.properties(body?.schema);
    assert.equal(props.remember?.type, 'boolean');
    assert.equal(props.plan?.type, 'integer');
    assert.equal(props.remember?.const, undefined);
    assert.equal(props.email?.['x-html-type'], 'email');
    for (const example of body?.examples ?? []) assert.deepEqual(SchemaCheck.errors(body?.schema, example), []);
  });

  test('an observed urlencoded body still receives the full form overlay', () => {
    const f = new CaptureFactory();
    f.snapshot('/s', 'S', `<form method="post" action="/s"><input type="checkbox" name="remember"><input name="q" required></form>`);
    f.exchange({ method: 'POST', url: '/s', resourceType: 'document', status: 200, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'remember=on&q=x' });
    const schema = endpoint(build(f), 'POST', '/s').requestBody?.schema;
    assert.equal(Schema.properties(schema).remember?.const, 'on');
    assert.deepEqual(schema?.required, ['q']);
  });
});

describe('form actions and templated endpoints of another kind (FB-17)', () => {
  test('a preview form gets its own endpoint instead of joining the integer comment endpoint', () => {
    const f = new CaptureFactory();
    for (const id of ['101', '102']) {
      f.exchange({ method: 'POST', url: `/comments/${id}`, resourceType: 'fetch', status: 200, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'body=hello' });
    }
    f.snapshot('/comments/101/edit', 'Edit', '<form method="post" action="/comments/preview"><textarea name="markdown" required></textarea><button>Preview</button></form>');
    const model = build(f);
    const preview = endpoint(model, 'POST', '/comments/preview');
    assert.deepEqual(preview.requestBody?.schema?.required, ['markdown']);
    const edit = endpoint(model, 'POST', '/comments/{commentId}');
    assert.deepEqual(edit.requestBody?.schema?.required, ['body']);
    assert.equal(edit.form, undefined);
  });
});
