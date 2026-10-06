import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { Build, Capture, Export } from '../src/index.js';
import type { Model } from '../src/index.js';
import { Schema } from '../src/shared/index.js';
import { ARTICLES, BOOKS, CATEGORIES, TITLES, startBooksSite, startConduitSite, startEchoSite, startQuotesSite, startWikiSite } from './fixtures/real-patterns.js';
import type { PatternSite } from './fixtures/real-patterns.js';

interface Captured {
  model: Model.ApiModel;
  close(): Promise<void>;
}

async function captureSite(start: () => Promise<PatternSite>, script: (page: Page, origin: string) => Promise<void>): Promise<Captured> {
  const site = await start();
  try {
    const capture = await Capture.CaptureSession.create({ url: `${site.origin}/`, headless: true, idleMs: 300, script: (page) => script(page, site.origin) }).run();
    return { model: Build.ModelBuilder.create({ now: new Date(0) }).build(capture), close: () => site.close() };
  } catch (err) {
    await site.close();
    throw err;
  }
}

function endpoint(model: Model.ApiModel, method: string, path: string): Model.Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

function paths(model: Model.ApiModel): string[] {
  return model.endpoints.map((e) => `${e.method} ${e.path}`);
}

function openapi(model: Model.ApiModel): { paths: Record<string, Record<string, { parameters?: { name: string; in: string }[]; responses: Record<string, { content?: Record<string, { schema?: Model.JsonSchema }> }> }>> } {
  return JSON.parse(Export.ExporterRegistry.default().export(model, 'openapi').content) as ReturnType<typeof openapi>;
}

async function visit(page: Page, url: string): Promise<void> {
  await page.goto(url, { waitUntil: 'load' });
}

describe('real-site patterns on local servers: path identity from evidence', () => {
  let quotes: Captured;
  let books: Captured;
  let wiki: Captured;
  let conduit: Captured;

  before(async () => {
    quotes = await captureSite(startQuotesSite, async (page, origin) => {
      for (const path of ['/tag/love/', '/tag/inspirational/', '/tag/life/', '/tag/inspirational/page/1/', '/author/Jane-Austen/', '/author/J-K-Rowling/', '/login']) await visit(page, origin + path);
    });
    books = await captureSite(startBooksSite, async (page, origin) => {
      await visit(page, `${origin}/index.html`);
      for (const book of [...BOOKS.slice(0, 3), 'no-such-book_99999']) await visit(page, `${origin}/catalogue/${book}/index.html`);
      for (const path of ['/catalogue/page-2.html', '/catalogue/page-3.html', `/catalogue/category/books/${CATEGORIES[0]}/index.html`, `/catalogue/category/books/${CATEGORIES[1]}/index.html`, `/catalogue/category/books/${CATEGORIES[1]}/page-2.html`]) {
        await visit(page, origin + path);
      }
    });
    wiki = await captureSite(startWikiSite, async (page, origin) => {
      for (const title of ['Main_Page', 'Ada_Lovelace', 'Charles_Babbage', 'Computer']) {
        await visit(page, `${origin}/wiki/${title}`);
        await page.waitForLoadState('networkidle');
      }
    });
    conduit = await captureSite(startConduitSite, async (page) => {
      await page.evaluate(`(async () => {
        await window.api('/articles?limit=10&offset=0');
        await window.api('/tags');
        for (const slug of ['${ARTICLES[0]?.slug}', '${ARTICLES[1]?.slug}']) {
          await window.api('/articles/' + slug);
          await window.api('/articles/' + slug + '/comments');
        }
        await window.api('/profiles/${ARTICLES[2]?.author}');
        await fetch('/api/articles/feed?limit=10&offset=0');
      })()`);
    });
  });

  after(async () => {
    for (const site of [quotes, books, wiki, conduit]) await site?.close();
  });

  test('singular collection parents become parameters when the pages share a skeleton (QTS-1)', () => {
    const { model } = quotes;
    assert.equal(endpoint(model, 'GET', '/tag/{tag}/').count, 3);
    assert.deepEqual(endpoint(model, 'GET', '/tag/{tag}/').pathParams.map((param) => [param.name, param.examples]), [['tag', ['love', 'inspirational', 'life']]]);
    assert.equal(endpoint(model, 'GET', '/author/{author}/').count, 2);
    endpoint(model, 'GET', '/tag/{tag}/page/{page}/');
    endpoint(model, 'GET', '/login');
    assert.equal(paths(model).filter((path) => /\/tag\/[a-z]/.test(path)).length, 0);
    assert.equal(endpoint(model, 'GET', '/tag/{tag}/').name, 'getTagPage');
  });

  test('slug-with-id detail pages and numbered pages are templated, missing ids join as 404 (BOOKS-1, BOOKS-2)', () => {
    const { model } = books;
    const detail = endpoint(model, 'GET', '/catalogue/{catalogue}/index.html');
    assert.deepEqual(detail.responses.map((response) => response.status), [200, 404]);
    assert.deepEqual(detail.pathParams.map((param) => param.name), ['catalogue']);
    assert.equal(endpoint(model, 'GET', '/catalogue/page-{page}.html').count, 2);
    assert.deepEqual(endpoint(model, 'GET', '/catalogue/page-{page}.html').pathParams.map((param) => [param.name, param.schema]), [['page', { type: 'integer' }]]);
    assert.equal(endpoint(model, 'GET', '/catalogue/category/books/{book}/index.html').count, 2);
    endpoint(model, 'GET', '/catalogue/category/books/{book}/page-{page}.html');
    assert.equal(paths(model).filter((path) => /_[0-9]+|page-[0-9]/.test(path)).length, 0, paths(model).join(', '));
    const doc = openapi(model);
    assert.deepEqual(doc.paths['/catalogue/{catalogue}/index.html']?.get?.parameters?.filter((param) => param.in === 'path').map((param) => param.name), ['catalogue']);
    assert.ok(doc.paths['/catalogue/page-{page}.html']);
    for (const e of model.endpoints) assert.ok(!/Html|Page[0-9]/.test(e.name), e.name);
  });

  test('page previews under a singular parent share one endpoint named after the response field (WIKI-1)', () => {
    const { model } = wiki;
    const summary = endpoint(model, 'GET', '/api/rest_v1/page/summary/{title}');
    assert.ok(summary.count >= 4, String(summary.count));
    assert.deepEqual([...(summary.pathParams[0]?.examples ?? [])].sort(), [...summary.pathParams[0]!.examples].sort());
    for (const title of TITLES) assert.ok(!paths(model).includes(`GET /api/rest_v1/page/summary/${title}`), title);
    const article = endpoint(model, 'GET', '/wiki/{wiki}');
    assert.equal(article.count, 3);
    endpoint(model, 'GET', '/wiki/Main_Page');
  });

  test('fields seen only as null accept any value in the model, OpenAPI and TypeScript (WIKI-6)', () => {
    const { model } = wiki;
    const search = endpoint(model, 'GET', '/w/rest.php/v1/search/title');
    const page = Schema.items(Schema.asSchema(Schema.properties(search.responses[0]?.body?.schema).pages));
    const anchor = Schema.asSchema(Schema.properties(page).anchor);
    assert.deepEqual(anchor, { 'x-appii-observed': 'null' });
    assert.ok(!Schema.schemaTypes(anchor).includes('null'));
    const client = Export.ExporterRegistry.default().export(model, 'typescript').content;
    assert.match(client, /anchor: unknown;/);
    assert.doesNotMatch(client, /anchor: null;/);
  });

  test('SPA resources are templated from listed identifiers; a collection sibling stays literal (SPA-1, SPA-2, SPA-5)', () => {
    const { model } = conduit;
    const article = endpoint(model, 'GET', '/api/articles/{slug}');
    assert.equal(article.count, 2);
    assert.deepEqual(article.queryParams, []);
    assert.equal(article.name, 'getArticle');
    assert.equal(endpoint(model, 'GET', '/api/articles/{slug}/comments').name, 'listComments');
    const profile = endpoint(model, 'GET', '/api/profiles/{username}');
    assert.equal(profile.count, 1);
    assert.equal(profile.name, 'getProfile');
    const feed = endpoint(model, 'GET', '/api/articles/feed');
    assert.deepEqual(feed.queryParams.map((param) => param.name), ['limit', 'offset']);
    assert.deepEqual(feed.responses.map((response) => response.status), [401]);
    assert.ok(!article.pathParams[0]?.examples.includes('feed'));
    const names = model.endpoints.map((e) => e.name);
    assert.equal(new Set(names).size, names.length);
    assert.ok(!names.some((name) => /^list.*Practices$/.test(name)), names.join(', '));
  });
});

describe('real-site patterns on local servers: content of script requests (HTTPBIN-2, HTTPBIN-5, HTTPBIN-7, HTTPBIN-10)', () => {
  let echo: Captured;

  before(async () => {
    echo = await captureSite(startEchoSite, async (page) => {
      await page.evaluate(`(async () => {
        await fetch('/image/png').then((r) => r.blob());
        await fetch('/range/64', { headers: { Range: 'bytes=0-15' } }).then((r) => r.arrayBuffer());
        await fetch('/etag/abc', { headers: { 'If-None-Match': '"abc"' } });
        await fetch('/stream/3').then((r) => r.text());
        await fetch('/bytes/16').then((r) => r.arrayBuffer());
        await fetch('/status/418');
        await fetch('/post', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'n', qty: 2, tags: ['a'] }) });
        const form = new FormData();
        form.append('title', 't');
        form.append('upload', new Blob(['hello'], { type: 'text/plain' }), 'a.txt');
        await fetch('/post', { method: 'POST', body: form });
        const img = new Image();
        img.src = '/logo.png';
        await img.decode().catch(() => undefined);
      })()`);
      await Promise.all([page.waitForURL('**/post'), page.click('#order button')]);
    });
  });

  after(async () => {
    await echo?.close();
  });

  test('a fetch that returns an image is an endpoint; an image element is not', () => {
    const image = endpoint(echo.model, 'GET', '/image/png');
    assert.deepEqual(image.responses.map((response) => [response.status, response.body?.mimeType, response.body?.kind]), [[200, 'image/png', 'binary']]);
    assert.ok(!paths(echo.model).includes('GET /logo.png'));
  });

  test('Range and If-None-Match set by the page are documented header parameters', () => {
    const range = endpoint(echo.model, 'GET', '/range/{range}');
    assert.deepEqual(range.headerParams.map((param) => [param.name, param.examples]), [['range', ['bytes=0-15']]]);
    assert.deepEqual(range.responses.map((response) => response.status), [206]);
    assert.deepEqual(endpoint(echo.model, 'GET', '/etag/abc').headerParams.map((param) => [param.name, param.examples]), [['if-none-match', ['"abc"']]]);
    const doc = openapi(echo.model);
    assert.deepEqual(doc.paths['/range/{range}']?.get?.parameters?.map((param) => `${param.in}:${param.name}`), ['path:range', 'header:range']);
  });

  test('newline-delimited JSON served as application/json is described per line', () => {
    const body = endpoint(echo.model, 'GET', '/stream/{stream}').responses[0]?.body;
    assert.equal(body?.jsonLines, true);
    assert.equal(body?.kind, 'json');
    assert.deepEqual(Object.keys(Schema.properties(body?.schema)), ['id', 'url', 'args']);
    assert.equal(endpoint(echo.model, 'GET', '/bytes/{bytes}').pathParams[0]?.name, 'bytes');
    assert.equal(endpoint(echo.model, 'GET', '/status/{status}').name, 'getStatus');
  });

  test('form, JSON and multipart posts to one endpoint keep all three request bodies', () => {
    const post = endpoint(echo.model, 'POST', '/post');
    assert.equal(post.count, 3);
    const kinds = [post.requestBody, ...(post.otherRequestBodies ?? [])].map((body) => body?.kind).sort();
    assert.deepEqual(kinds, ['form', 'json', 'multipart']);
    const bodies = [post.requestBody, ...(post.otherRequestBodies ?? [])];
    assert.deepEqual(bodies.map((body) => body?.mimeType).sort(), ['application/json', 'application/x-www-form-urlencoded', 'multipart/form-data']);
    assert.deepEqual(Object.keys(Schema.properties(bodies.find((body) => body?.kind === 'json')?.schema)), ['name', 'qty', 'tags']);
    assert.deepEqual(new Build.ModelValidator().validate(echo.model), []);
  });
});
