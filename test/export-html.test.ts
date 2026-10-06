import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { HtmlChartRenderer, HtmlExporter, SchemaFieldList } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { Text } from '../src/shared/index.js';
import { ExportModel } from './helpers/export-model.js';
import type { ExportFixture } from './helpers/export-model.js';

function maliciousModel(): ApiModel {
  const evil = ExportModel.endpoint({
    method: 'POST',
    path: '/x/<script>alert(1)</script>/{id}',
    id: 'evil',
    name: '"><img src=x onerror=alert(2)>',
    pathParams: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', pattern: '<script>alert(3)</script>' }, examples: ["'><svg onload=alert(4)>"] }],
    requestBody: {
      mimeType: 'application/json',
      kind: 'json',
      schema: { type: 'object', properties: { '<b>field</b>': { type: 'string', title: '</td><script>alert(5)</script>' } } },
      examples: [{ '<b>field</b>': '</pre><script>alert(6)</script>' }],
    },
    responses: [{ status: 200, count: 1, headers: ['x-<i>'], body: { mimeType: 'text/html', kind: 'html', examples: ['<script>alert(7)</script>'] } }],
    auth: { cookies: ['sid'], headers: [], anonymous: 'untested', bearer: false, csrf: [{ location: 'header', name: 'x-<csrf>', source: 'cookie', sourceName: '<c>' }] },
  });
  return ExportModel.model([evil], {
    name: '<script>alert(8)</script> Caf\u00e9',
    cookies: [
      {
        name: 'sid',
        domain: 'shop.example.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        session: true,
        expires: null,
        role: 'session',
        setBy: ['evil'],
        usedBy: ['evil'],
        valueExample: '<script>alert(9)</script>',
      },
    ],
    websockets: [{ url: 'wss://shop.example.com/<ws>', messages: 2, examples: ['<script>alert(10)</script>'] }],
  });
}

describe('HtmlExporter', () => {
  let fixture: ExportFixture;
  let model: ApiModel;
  let html: string;
  let browser: Browser;
  let dir: string;
  const exporter = new HtmlExporter();

  before(async () => {
    fixture = await ExportModel.fixture();
    model = fixture.model;
    html = exporter.export(model).content;
    browser = await chromium.launch({ headless: true });
    dir = await mkdtemp(join(tmpdir(), 'appii-html-'));
  });

  after(async () => {
    await browser?.close();
    await fixture?.site.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('a self-contained ASCII document with inline CSS and script', () => {
    const result = exporter.export(model);
    assert.equal(result.filename, 'report.html');
    assert.equal(result.format, 'html');
    assert.equal(result.mimeType, 'text/html');
    assert.ok(Text.isAscii(html));
    assert.match(html, /^<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport"/);
    assert.doesNotMatch(html, /<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)=/i);
    assert.doesNotMatch(html, /@import|url\(/);
    assert.match(html, /@media \(prefers-color-scheme: dark\)/);
    assert.match(html, /@media \(max-width: 640px\)/);
    assert.equal(html.match(/<script>/g)?.length, 1);
  });

  test('header, charts, endpoint list, details, cookies and forms', () => {
    assert.match(html, new RegExp(`<h1>${model.name.replace(/\./g, '\\.')}</h1>`));
    assert.match(html, /<span class="value">14<\/span><span class="label">endpoints<\/span>/);
    assert.equal(html.match(/<figure class="chart">/g)?.length, 3);
    assert.match(html, /<figcaption>Hits per endpoint \(top 15\)<\/figcaption><ul class="bars"><li class="bar-row" title="getItem: 4 hits">/);
    assert.match(html, /<span class="bar tone-2xx" style="width:100\.0%"><\/span><\/span><span class="bar-value">13<\/span>/);
    assert.equal(html.match(/<li class="endpoint" /g)?.length, model.endpoints.length);
    assert.match(html, /<li class="endpoint" id="endpoint-5" data-method="GET" data-kind="json" data-search="get http:\/\/127\.0\.0\.1:\d+\/api\/items\/\{itemid\} getitem get-api-items-itemid json">/);
    assert.match(html, /<span class="path">\/api\/items\/<span class="param">\{itemId\}<\/span><\/span>/);
    assert.match(html, /<span class="method post">POST<\/span>/);
    assert.match(html, /<span class="badge csrf">csrf<\/span>/);
    assert.match(html, /<dt>CSRF<\/dt><dd><code>x-csrf-token<\/code> in the header, from cookie <code>csrf<\/code><\/dd>/);
    assert.match(html, /<td><code>password<\/code><\/td><td>string<\/td><td>yes<\/td><td>html password; length 8\.\.<\/td><td>Password<\/td>/);
    assert.match(html, /<pre id="curl-4">\ncurl -sS -X POST &#39;http:\/\/127\.0\.0\.1:\d+\/api\/items&#39; \\\n {2}-H &quot;x-csrf-token: \$\{APPII_CSRF:\?the cookie csrf; bash endpoints\.sh \w+ reads it from its cookie jar\}&quot;/);
    assert.match(html, /<pre id="curl-4">[^<]*<\/pre><\/div><p class="variables">Variables: (?:<code>APPII_[A-Z0-9_]+<\/code> )*<code>APPII_CSRF<\/code>/);
    assert.match(html, /<button type="button" class="copy" data-target="curl-4">Copy<\/button>/);
    assert.match(html, /<td><code>sid<\/code><\/td><td><code>127\.0\.0\.1<\/code><\/td><td><code>\/<\/code><\/td><td>session<\/td><td>yes<\/td>/);
    assert.match(html, /<td><code>form#login<\/code><\/td><td>POST<\/td>/);
    assert.match(html, /No WebSocket connections were captured\./);
  });

  test('filtering, details and layout work in a real browser without network access', async () => {
    const file = join(dir, 'report.html');
    await writeFile(file, html);
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    const requests: string[] = [];
    const errors: string[] = [];
    page.on('request', (request) => {
      if (!request.url().startsWith('file:')) requests.push(request.url());
    });
    page.on('pageerror', (err) => errors.push(String(err)));
    await page.goto(pathToFileURL(file).href);
    assert.equal(await page.textContent('#count'), '14 of 14 endpoints');
    await page.fill('#q', 'api/items');
    assert.equal(await page.textContent('#count'), '3 of 14 endpoints');
    await page.selectOption('#method', 'POST');
    assert.equal(await page.textContent('#count'), '1 of 14 endpoints');
    assert.equal(await page.isVisible('#endpoint-4'), true);
    assert.equal(await page.isVisible('#endpoint-3'), false);
    await page.fill('#q', '');
    await page.selectOption('#method', '');
    await page.selectOption('#kind', 'form');
    assert.equal(await page.textContent('#count'), '3 of 14 endpoints');
    await page.click('#endpoint-10 summary');
    assert.equal(await page.isVisible('#curl-10'), true);
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);
    assert.deepEqual(requests, []);
    assert.deepEqual(errors, []);
    await page.close();
  });

  test('every captured value is escaped', async () => {
    const evil = exporter.export(maliciousModel()).content;
    assert.ok(Text.isAscii(evil));
    assert.equal(evil.match(/<script>/g)?.length, 1);
    assert.doesNotMatch(evil, /<img|<svg|<b>|<i>|<ws>|<csrf>|<c>/);
    assert.match(evil, /<h1>&lt;script&gt;alert\(8\)&lt;\/script&gt; Caf&#233;<\/h1>/);
    assert.match(evil, /<span class="path">\/x\/&lt;script&gt;alert\(1\)&lt;\/script&gt;\/<span class="param">\{id\}<\/span><\/span>/);
    assert.match(evil, /&lt;\/pre&gt;&lt;script&gt;alert\(6\)&lt;\/script&gt;/);
    const file = join(dir, 'evil.html');
    await writeFile(file, evil);
    const page = await browser.newPage();
    const dialogs: string[] = [];
    page.on('dialog', async (dialog) => {
      dialogs.push(dialog.message());
      await dialog.dismiss();
    });
    await page.goto(pathToFileURL(file).href);
    await page.click('#endpoint-1 summary');
    await page.click('details.raw summary');
    assert.deepEqual(dialogs, []);
    assert.equal(await page.locator('img, svg, b').count(), 0);
    assert.equal(await page.title(), '<script>alert(8)</script> Caf\u00e9 - API report');
    await page.close();
  });

  test('empty models and selections render', () => {
    const empty = exporter.export(ExportModel.model([], { primaryOrigin: '', origins: [] })).content;
    assert.match(empty, /The model has no endpoints\./);
    assert.match(empty, /No endpoints selected\./);
    assert.match(empty, /<p class="empty">No data<\/p>/);
    const one = exporter.export(model, { endpoints: ['getMe'], title: 'Me only' });
    assert.equal(one.endpointCount, 1);
    assert.match(one.content, /<h1>Me only<\/h1>/);
    assert.match(one.content, /<span class="value">1<\/span><span class="label">of 14 endpoints<\/span>/);
  });
});

describe('HTML building blocks', () => {
  test('HtmlChartRenderer scales bars to the largest value and rejects unknown tones', () => {
    const html = new HtmlChartRenderer().bars('Caption', [
      { label: 'a', value: 4 },
      { label: 'b', value: 1, tone: '4xx' },
      { label: 'c', value: 0, tone: 'x" onclick="y' },
    ]);
    assert.match(html, /^<figure class="chart"><figcaption>Caption<\/figcaption><ul class="bars">/);
    assert.match(html, /title="a: 4"><span class="bar-label">a<\/span><span class="bar-track"><span class="bar" style="width:100\.0%">/);
    assert.match(html, /<span class="bar tone-4xx" style="width:25\.0%">/);
    assert.match(html, /<span class="bar" style="width:0\.0%">/);
    assert.doesNotMatch(html, /onclick/);
  });

  test('SchemaFieldList flattens nested objects and arrays with constraints', () => {
    const rows = new SchemaFieldList().rows({
      type: 'object',
      properties: {
        user: { type: 'object', properties: { email: { type: 'string', format: 'email', title: 'Email' } }, required: ['email'] },
        tags: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer', minimum: 1 } } } },
      },
      required: ['user'],
    });
    assert.deepEqual(rows, [
      { path: 'user', type: 'object', required: true, constraints: [] },
      { path: 'user.email', type: 'string(email)', required: true, constraints: ['format email'], description: 'Email' },
      { path: 'tags', type: 'array<object>', required: false, constraints: [] },
      { path: 'tags[].id', type: 'integer', required: false, constraints: ['range 1..'] },
    ]);
    assert.deepEqual(new SchemaFieldList().rows({ type: 'string' }), [{ path: '(body)', type: 'string', required: true, constraints: [] }]);
    assert.deepEqual(new SchemaFieldList().rows(undefined), []);
    assert.equal(new SchemaFieldList({ maxRows: 1 }).rows({ type: 'object', properties: { a: {}, b: {} } }).length, 1);
  });
});

describe('HTML report at phone width (BOOKS-7)', () => {
  let browser: Browser;
  let dir: string;

  before(async () => {
    browser = await chromium.launch({ headless: true });
    dir = await mkdtemp(join(tmpdir(), 'appii-html-phone-'));
  });

  after(async () => {
    await browser?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('long endpoint names, paths and variable names wrap instead of widening the page', async () => {
    const name = 'getCatalogueTheNo1LadiesDetectiveAgencyNo1LadiesDetectiveAgency1176IndexHtml';
    assert.ok(name.length >= 76);
    const endpoint = ExportModel.endpoint({
      method: 'GET',
      path: '/catalogue/the-no-1-ladies-detective-agency-no-1-ladies-detective-agency-1_176/index.html',
      name,
      auth: { cookies: ['a_very_long_session_cookie_name_that_does_not_fit_on_a_phone'], headers: [], anonymous: 'untested', bearer: false, csrf: [] },
    });
    const file = join(dir, 'report.html');
    await writeFile(file, new HtmlExporter().export(ExportModel.model([endpoint])).content);
    const page = await browser.newPage({ viewport: { width: 390, height: 800 } });
    await page.goto(pathToFileURL(file).href);
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);
    await page.click('#endpoint-1 summary');
    assert.equal(await page.isVisible('#curl-1'), true);
    assert.ok((await page.evaluate(() => document.documentElement.scrollWidth)) <= 390);
    await page.close();
  });
});
