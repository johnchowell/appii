import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as Root from '../src/index.js';
import { ModelStore, ModelValidator } from '../src/build/index.js';
import { CaptureValidator } from '../src/capture/index.js';
import { HtmlExporter } from '../src/export/index.js';
import { ListCommand } from '../src/cli/index.js';
import { SummaryPresenter } from '../src/present/index.js';
import {
  BODY_KINDS,
  CAPTURE_SOURCES,
  COOKIE_ROLES,
  CSRF_LOCATIONS,
  ENDPOINT_KINDS,
  FIELD_KINDS,
  FORM_ENCTYPES,
  FORM_METHODS,
  PARAM_LOCATIONS,
  RESOURCE_TYPES,
  SAME_SITE_VALUES,
  TOKEN_SOURCES,
} from '../src/model/index.js';
import type { ApiModel } from '../src/model/index.js';
import { AppiiError, Json, Text } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { PresentModels } from './helpers/present-models.js';

describe('Model constants', () => {
  test('every validator and display order uses the Model constants', () => {
    const same = (set: ReadonlySet<string>, values: readonly string[]) => assert.deepEqual([...set], [...values]);
    same(ModelValidator.ENDPOINT_KINDS, ENDPOINT_KINDS);
    same(ModelValidator.BODY_KINDS, BODY_KINDS);
    same(ModelValidator.PARAM_LOCATIONS, PARAM_LOCATIONS);
    same(ModelValidator.CSRF_LOCATIONS, CSRF_LOCATIONS);
    same(ModelValidator.TOKEN_SOURCES, TOKEN_SOURCES);
    same(ModelValidator.COOKIE_ROLES, COOKIE_ROLES);
    same(ModelValidator.SAME_SITE, SAME_SITE_VALUES);
    same(ModelValidator.FORM_METHODS, FORM_METHODS);
    same(ModelValidator.FORM_ENCTYPES, FORM_ENCTYPES);
    same(ModelValidator.FIELD_KINDS, FIELD_KINDS);
    same(ModelValidator.RESOURCE_TYPES, RESOURCE_TYPES);
    same(CaptureValidator.SOURCES, CAPTURE_SOURCES);
    same(CaptureValidator.RESOURCE_TYPES, RESOURCE_TYPES);
    same(CaptureValidator.SAME_SITE, SAME_SITE_VALUES);
    assert.equal(ListCommand.KINDS, ENDPOINT_KINDS);
    assert.equal(HtmlExporter.KINDS, ENDPOINT_KINDS);
    assert.equal(SummaryPresenter.KIND_ORDER, ENDPOINT_KINDS);
    assert.equal(SummaryPresenter.ROLE_ORDER, COOKIE_ROLES);
    assert.ok(Object.isFrozen(ENDPOINT_KINDS));
  });

  test('the root barrel exposes Model values and the moved classes in their namespaces', () => {
    assert.equal(Root.Model.ENDPOINT_KINDS, ENDPOINT_KINDS);
    assert.equal(Root.Build.ModelStore, ModelStore);
    assert.equal(Root.Build.ModelValidator, ModelValidator);
    assert.equal(typeof Root.Present.CaptureSummaryPresenter, 'function');
    assert.equal(typeof new Root.Present.PresenterFactory().captureSummary().render, 'function');
    assert.equal(typeof Root.Shared.SampleText, 'function');
    assert.equal(typeof Root.Shared.ShellScript, 'function');
    for (const name of ['ModelStore', 'ModelValidator', 'CaptureSummaryPresenter']) assert.ok(!(name in Root.Cli), name);
    assert.ok(!('ShellScript' in Root.Export));
  });
});

describe('ModelValidator and ModelStore', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-model-store-'));
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('form action and method and the CSRF source method are part of the model', () => {
    const validator = new ModelValidator();
    const model = Json.clone(PresentModels.fixture()) as unknown as Record<string, any>;
    const formEndpoint = (model.endpoints as Record<string, any>[]).find((endpoint) => endpoint.form !== undefined);
    assert.ok(formEndpoint);
    assert.equal(typeof formEndpoint.form.action, 'string');
    assert.ok(FORM_METHODS.includes(formEndpoint.form.method));
    formEndpoint.auth.csrf = [{ location: 'header', name: 'x-csrf', source: 'response', sourceUrl: 'https://example.com/token', sourceMethod: 'POST' }];
    assert.deepEqual(validator.validate(model), []);
    formEndpoint.auth.csrf[0].sourceMethod = 1;
    delete formEndpoint.form.action;
    formEndpoint.form.method = 'PUT';
    const index = (model.endpoints as unknown[]).indexOf(formEndpoint);
    assert.deepEqual(validator.validate(model), [
      `endpoints[${index}].auth.csrf[0].sourceMethod: expected a string`,
      `endpoints[${index}].form.action: expected a string`,
      `endpoints[${index}].form.method: expected one of GET, POST, DIALOG`,
    ]);
  });

  test('ModelValidator accepts built models and pinpoints broken ones', () => {
    const validator = new ModelValidator();
    const model = PresentModels.fixture();
    assert.deepEqual(validator.validate(model), []);
    assert.equal(validator.isModel(model), true);
    assert.deepEqual(validator.validate(PresentModels.mixed()), []);
    assert.deepEqual(validator.validate(PresentModels.empty()), []);
    const broken = Json.clone(model) as unknown as Record<string, any>;
    broken.version = 2;
    broken.endpoints[0].kind = 'rest';
    broken.endpoints[1].auth.csrf = [{ location: 'cookie', name: 1, source: 'cookie' }];
    delete broken.endpoints[2].responses;
    broken.cookies[0].sameSite = 'lax';
    broken.forms[0].fields[0].kind = 'div';
    broken.websockets = {};
    assert.deepEqual(validator.validate(broken), [
      'version: expected 1, got 2',
      'endpoints[0].kind: expected one of json, form, graphql, document, other',
      'endpoints[1].auth.csrf[0].location: expected one of header, body, query',
      'endpoints[1].auth.csrf[0].name: expected a string',
      'endpoints[2].responses: expected an array',
      'cookies[0].sameSite: expected one of Strict, Lax, None',
      'forms[0].fields[0].kind: expected one of input, select, textarea, button',
      'websockets: expected an array',
    ]);
    assert.deepEqual(validator.validate([]), ['(root): expected an object']);
    const many = { ...model, endpoints: Array.from({ length: 40 }, () => ({})) };
    assert.equal(validator.validate(many).length, ModelValidator.MAX_PROBLEMS);
    assert.equal(ModelValidator.looksLikeModel(model), true);
    assert.equal(ModelValidator.looksLikeModel(CaptureFactory.fixture().capture), false);
    assert.equal(ModelValidator.looksLikeModel({ log: { entries: [] }, endpoints: [] }), false);
  });

  test('ModelStore saves ASCII JSON with the right file mode and loads it back', async () => {
    const store = ModelStore.create();
    const model = PresentModels.mixed();
    const path = join(dir, 'mixed.json');
    await store.save(path, model);
    const text = await readFile(path, 'utf8');
    assert.ok(Text.isAscii(text));
    assert.ok(text.endsWith('}\n'));
    assert.deepEqual(await store.load(path), JSON.parse(JSON.stringify(model)));
    const { stat } = await import('node:fs/promises');
    assert.equal((await stat(path)).mode & 0o777, 0o644 & ~process.umask());
    const secret = join(dir, 'secret.json');
    await store.save(secret, model, { private: true });
    assert.equal((await stat(secret)).mode & 0o777, 0o600);
    await assert.rejects(store.save(join(dir, 'bad.json'), { ...model, endpoints: 'x' } as unknown as ApiModel), (err: unknown) => err instanceof AppiiError && err.code === 'INTERNAL');
    await writeFile(join(dir, 'v2.json'), JSON.stringify({ ...model, version: 2 }));
    await assert.rejects(store.load(join(dir, 'v2.json')), /unsupported API model version 2/);
    await writeFile(join(dir, 'broken.json'), JSON.stringify({ ...model, endpoints: [{}] }));
    await assert.rejects(store.load(join(dir, 'broken.json')), (err: unknown) => err instanceof AppiiError && err.code === 'BAD_INPUT' && /is not a valid API model \(api\.json\): endpoints\[0\]\.id: expected a string; .* and \d+ more$/.test(err.message));
  });
});
