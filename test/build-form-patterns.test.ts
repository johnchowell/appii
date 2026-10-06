import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { Build, Capture, Export, Present } from '../src/index.js';
import type { Model } from '../src/index.js';
import { Schema } from '../src/shared/index.js';
import { SchemaCheck } from './fixtures/build-schema-check.js';
import { TsClientHarness } from './fixtures/export-ts-harness.js';
import { AUTHORS, startPostbackSite, startRoutesSite, startShopSite, startWikiFormsSite } from './fixtures/form-patterns.js';
import type { FormSite } from './fixtures/form-patterns.js';

interface Captured {
  capture: Model.Capture;
  model: Model.ApiModel;
}

async function record(start: () => Promise<FormSite>, path: string, script: (page: Page, origin: string) => Promise<void>, options: Build.BuildOptions = {}): Promise<Captured> {
  const site = await start();
  try {
    const capture = await Capture.CaptureSession.create({ url: site.origin + path, headless: true, idleMs: 300, script: (page) => script(page, site.origin) }).run();
    return { capture, model: Build.ModelBuilder.create({ now: new Date(0), ...options }).build(capture) };
  } finally {
    await site.close();
  }
}

function endpoint(model: Model.ApiModel, method: string, path: string): Model.Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

function prop(schema: Model.JsonSchema | undefined, name: string): Model.JsonSchema {
  const found = Schema.properties(schema)[name];
  assert.ok(found, name);
  return found;
}

function openapi(model: Model.ApiModel): string {
  return Export.ExporterRegistry.default().export(model, 'openapi').content;
}

describe('real form patterns captured in Chromium', () => {
  let postback: Captured;
  let shop: Captured;
  let wiki: Captured;
  let routes: Captured;
  let harness: TsClientHarness;

  before(async () => {
    harness = await TsClientHarness.open('appii-form-patterns-');
    postback = await record(startPostbackSite, '/search.aspx', async (page) => {
      await Promise.all([page.waitForURL('**/filter.aspx'), page.selectOption('#author', 'Albert Einstein')]);
      await page.selectOption('#tag', 'change');
      await Promise.all([page.waitForLoadState('load'), page.click('input[name="submit_button"]')]);
      await page.waitForSelector('.quote');
    });
    shop = await record(startShopSite, '/index.html', async (page, origin) => {
      await page.goto(`${origin}/catalogue/page-2.html`, { waitUntil: 'load' });
      await Promise.all([page.waitForURL('**/page-2.html?'), page.click('li:nth-child(3) form button')]);
      await page.goto(`${origin}/index.html`, { waitUntil: 'load' });
    });
    wiki = await record(startWikiFormsSite, '/wiki/Main_Page', async (page, origin) => {
      await page.fill('#searchInput', 'Ada Lovelace');
      await Promise.all([page.waitForURL('**/wiki/Ada_Lovelace'), page.press('#searchInput', 'Enter')]);
      await page.goto(`${origin}/wiki/Main_Page`, { waitUntil: 'load' });
      await page.click('#frb-form button[value="card"]');
      await Promise.all([page.waitForURL('**/wiki/Mech_engineering'), page.click('a[href="/wiki/Mech_engineer"]')]);
      await page.waitForLoadState('load');
    });
    routes = await record(startRoutesSite, '/', async (page) => {
      await page.click('a[href="/login"]');
      await page.fill('input[name="email"]', 'u@example.com');
      await page.fill('input[name="password"]', 'correct-horse-battery');
      await Promise.all([page.waitForResponse('**/api/users/login'), page.click('form button')]);
      await page.waitForURL((url) => url.pathname === '/');
      await page.click('a[href="/register"]');
      await page.waitForSelector('input[name="username"]');
      await page.waitForTimeout(600);
      await page.click('a[href="/"]');
    }, { allOrigins: true });
  });

  after(async () => {
    await harness?.close();
  });

  test('an ASP.NET postback fills a dependent select: its options are examples, every author tag is accepted, and the scripted postback needs no submitter (QTS-2, QTS-3)', async () => {
    const filter = endpoint(postback.model, 'POST', '/filter.aspx');
    const body = filter.requestBody;
    const tag = prop(body?.schema, 'tag');
    assert.equal(tag.enum, undefined);
    assert.deepEqual(tag.examples, ['----------', ...(AUTHORS['Albert Einstein'] ?? [])]);
    assert.deepEqual(prop(body?.schema, 'author').enum, ['----------', ...Object.keys(AUTHORS)]);
    assert.ok(!Schema.requiredSet(body?.schema).has('submit_button'));
    assert.equal(body?.examples.length, 2);
    for (const example of body?.examples ?? []) assert.deepEqual(SchemaCheck.errors(body?.schema, example), [], JSON.stringify(example));
    const { mod } = await harness.load(postback.model);
    const validate = TsClientHarness.validator(mod, `validate${Export.TsEndpointWriter.pascal(filter.name)}`);
    assert.deepEqual(validate({ author: 'Jane Austen', tag: 'aliteracy', submit_button: 'Search' }), []);
    assert.deepEqual(validate({ author: 'Jane Austen', tag: 'aliteracy' }), []);
  });

  test('listing pages with an empty sort form and button-only basket forms stay documents, and the inventory groups the forms (BOOKS-3, BOOKS-4)', () => {
    const { model } = shop;
    assert.deepEqual(
      model.endpoints.map((e) => [e.method, e.kind, e.form === undefined, e.queryParams.length]),
      model.endpoints.map((e) => [e.method, 'document', true, 0]),
    );
    for (const e of model.endpoints) assert.match(e.name, /Page$/, e.name);
    assert.ok(!openapi(model).includes('Submitted by the form'));
    const basket = model.forms.filter((form) => form.submitters.length === 1);
    const empty = model.forms.filter((form) => form.submitters.length === 0);
    assert.equal(empty.length, 1);
    assert.deepEqual(empty[0]?.endpoints, []);
    assert.ok(basket.length >= 1 && basket.length <= model.endpoints.length, String(basket.length));
    assert.equal(basket.reduce((sum, form) => sum + (form.instances ?? 1), 0), 60);
    assert.ok(basket.every((form) => (form.endpoints?.length ?? 0) === 1));
    assert.ok(model.forms.length < 10, String(model.forms.length));
    assert.match(Present.SummaryPresenter.forms(model.forms), /^\d+ distinct, 63 on pages \(\d+ linked to endpoints\)$/);
  });

  test('radio-only preference forms, an intercepted banner form and a replaced URL leave page loads unchanged; the search submission is a form endpoint (WIKI-3)', () => {
    const { model, capture } = wiki;
    assert.ok(!model.endpoints.some((e) => e.path.includes('Mech_engineering')), model.endpoints.map((e) => e.path).join(', '));
    for (const e of model.endpoints.filter((candidate) => candidate.path.startsWith('/wiki/'))) {
      assert.equal(e.kind, 'document', e.path);
      assert.deepEqual(e.queryParams, [], e.path);
      assert.equal(e.form, undefined, e.path);
      assert.ok(e.count > 0, e.path);
    }
    const search = endpoint(model, 'GET', '/w/index.php');
    assert.equal(search.kind, 'form');
    assert.equal(search.count, 1);
    assert.deepEqual(search.queryParams.map((param) => param.name).sort(), ['search', 'title']);
    const preferences = model.forms.filter((form) => form.fields.every((field) => field.type === 'radio'));
    assert.ok(preferences.length > 0);
    assert.ok(preferences.every((form) => form.endpoints?.length === 0));
    const submitted = Build.FormLinker.create().submitted(capture);
    const navigations = capture.exchanges.filter((exchange) => exchange.resourceType === 'document');
    assert.deepEqual(
      navigations.filter(submitted).map((exchange) => new URL(exchange.request.url).pathname),
      ['/w/index.php'],
    );
  });

  test('forms on client-side routes get no query-string endpoint; the login form describes the JSON request its submit sent (SPA-4)', () => {
    const { model } = routes;
    const paths = model.endpoints.map((e) => `${e.method} ${e.path}`);
    assert.ok(!paths.includes('GET /login') && !paths.includes('GET /register'), paths.join(', '));
    assert.ok(!model.endpoints.some((e) => e.queryParams.some((param) => param.name === 'password')));
    const login = endpoint(model, 'POST', '/api/users/login');
    assert.equal(login.kind, 'json');
    assert.equal(new URL(login.form?.pageUrl ?? '').pathname, '/login');
    const user = prop(login.requestBody?.schema, 'user');
    assert.equal(prop(user, 'password')['x-html-type'], 'password');
    assert.equal(prop(user, 'password')['x-html-minlength'], 8);
    const byRoute = new Map(model.forms.map((form) => [new URL(form.pageUrl).pathname, form]));
    assert.deepEqual(byRoute.get('/login')?.endpoints, [login.id]);
    assert.equal(byRoute.get('/login')?.explicitAction, false);
    assert.deepEqual(byRoute.get('/register')?.endpoints, []);
  });
});
