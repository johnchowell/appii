import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import { JsonExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { EndpointIndex } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

describe('JSON export of an endpoint subset', () => {
  const model = ModelBuilder.create().build(CaptureFactory.fixture().capture);

  test('every endpoint id in the file refers to an endpoint in the file', () => {
    for (const ref of model.endpoints.map((_endpoint, i) => i + 1)) {
      const subset = JSON.parse(new JsonExporter().export(model, { endpoints: [String(ref)] }).content) as ApiModel;
      const ids = new Set(subset.endpoints.map((endpoint) => endpoint.id));
      assert.equal(subset.endpoints.length, 1);
      for (const cookie of subset.cookies) {
        for (const id of [...cookie.setBy, ...cookie.usedBy]) assert.ok(ids.has(id), `${ref}: cookie ${cookie.name} refers to ${id}`);
      }
      const endpoint = subset.endpoints[0];
      for (const name of endpoint?.auth.cookies ?? []) assert.ok(subset.cookies.some((cookie) => cookie.name === name), `${ref}: cookie ${name} is missing`);
      for (const form of subset.forms) assert.ok(endpoint?.form?.pageUrl === form.pageUrl && endpoint.form.selector === form.selector, `${ref}: form ${form.selector}`);
      for (const form of subset.forms) for (const id of form.endpoints ?? []) assert.ok(ids.has(id), `${ref}: form ${form.selector} refers to ${id}`);
    }
  });

  test('a subset keeps every form that sends to a chosen endpoint and only the chosen endpoint ids', () => {
    const flow = CaptureFactory.fixture();
    flow.factory.snapshot(
      '/other',
      'Other',
      '<form id="quick" method="post" action="/login"><input name="email"><button>Login</button><button formaction="/search" formmethod="get">Search</button></form>',
    );
    const built = ModelBuilder.create().build(flow.factory.capture({ startUrl: flow.factory.url('/') }));
    const login = built.endpoints.find((endpoint) => endpoint.key === `POST ${CaptureFactory.ORIGIN}/login`)!;
    const subset = EndpointIndex.subset(built, [login]);
    assert.deepEqual(
      subset.forms.map((form) => [new URL(form.pageUrl).pathname, form.selector, form.endpoints]),
      [
        ['/login', 'form#login', [login.id]],
        ['/other', 'form#quick', [login.id]],
      ],
    );
    const old = { ...built, forms: built.forms.map(({ endpoints: _ids, ...form }) => form) };
    assert.deepEqual(EndpointIndex.subset(old, [login]).forms.map((form) => form.selector), ['form#login']);
  });

  test('the full selection is the model itself', () => {
    assert.equal(EndpointIndex.subset(model, model.endpoints), model);
    assert.deepEqual(JSON.parse(new JsonExporter().export(model).content), model);
  });
});
