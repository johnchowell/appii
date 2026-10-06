import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelBuilder } from '../src/build/index.js';
import { CaptureSession } from '../src/capture/index.js';
import { CurlExporter, HtmlExporter, MarkdownExporter, OpenApiExporter, PostmanExporter, TypeScriptExporter } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { PresenterFactory } from '../src/present/index.js';
import { Credentials } from '../src/shared/index.js';

type Operation = { security?: unknown; description?: string; 'x-appii-auth'?: string };
type Doc = { paths: Record<string, Record<string, Operation>>; security?: unknown };

function section(text: string, heading: string): string[] {
  const lines = text.split('\n');
  const start = lines.indexOf(heading);
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start && line !== '' && !line.startsWith(' ') && /^[A-Z][a-z ]+$/.test(line) && line !== heading);
  return lines.slice(start, end < 0 ? undefined : end);
}

describe('an endpoint that only refused a request without credentials (NEW-SPA-3) and endpoints never proven anonymous (WIKI-N2)', () => {
  let server: Server;
  let origin = '';
  let model: ApiModel;

  before(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const json = (status: number, value: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (url.pathname === '/api/articles/feed') return json(401, { errors: { token: ['is missing'] } });
      if (url.pathname === '/api/articles') return json(200, { articles: [{ slug: 'how-to-train-your-dragon', title: 'How to train your dragon' }], articlesCount: 1 });
      if (url.pathname === '/w/api.php') return json(429, { error: { code: 'ratelimited' } });
      if (url.pathname === '/w/index.php') {
        res.writeHead(302, { location: `/wiki/${(url.searchParams.get('search') ?? '').replace(/ /g, '_')}` });
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(
        `<!doctype html><html><head><meta charset="utf-8"><title>Conduit</title></head><body><form id="searchform" action="/w/index.php" method="get"><input name="search"><button id="go">Search</button></form><script>
fetch('/api/articles?limit=10&offset=0').then(() => fetch('/api/articles/feed?limit=10&offset=0')).then(() => fetch('/w/api.php?action=query&format=json'));
</script></body></html>`,
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const capture = await CaptureSession.create({
      url: `${origin}/`,
      headless: true,
      idleMs: 300,
      script: async (page) => {
        await page.waitForResponse(/\/w\/api\.php/);
        await page.fill('input[name=search]', 'Hedy Lamarr');
        await Promise.all([page.waitForURL(/Hedy_Lamarr/), page.click('#go')]);
      },
    }).run();
    model = ModelBuilder.create({ now: new Date(0) }).build(capture);
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  const find = (path: string): Endpoint => {
    const endpoint = model.endpoints.find((candidate) => candidate.method === 'GET' && candidate.path === path);
    assert.ok(endpoint, model.endpoints.map((candidate) => `${candidate.method} ${candidate.path}`).join(', '));
    return endpoint;
  };

  test('the model keeps the evidence: no credential sets, anonymous access refused, a 401', () => {
    const feed = find('/api/articles/feed');
    assert.deepEqual(feed.auth.sets, []);
    assert.equal(feed.auth.anonymous, 'refused');
    assert.equal(find('/api/articles').auth.anonymous, 'allowed');
    assert.deepEqual(feed.responses.map((response) => response.status), [401]);
    assert.deepEqual(Credentials.refusals(feed), [401]);
    assert.deepEqual(Credentials.refusals(find('/api/articles')), []);
    assert.deepEqual(Credentials.refusals(find('/w/api.php')), []);
  });

  test('OpenAPI does not declare the refused endpoint public and says why', () => {
    const doc = JSON.parse(new OpenApiExporter().export(model).content) as Doc;
    const feed = doc.paths['/api/articles/feed']?.get;
    assert.ok(feed);
    assert.equal(Object.hasOwn(feed, 'security'), false);
    assert.equal(feed['x-appii-auth'], 'required-unobserved');
    assert.match(feed.description ?? '', /Answered 401 to requests without credentials; the credential this endpoint expects was not captured\./);
    assert.deepEqual(doc.paths['/api/articles']?.get?.security, []);
    assert.deepEqual(doc.paths['/w/api.php']?.get?.security, []);
    assert.equal(doc.security, undefined);
  });

  test('list shows 401? in the AUTH column and list --show says the credential was not captured', () => {
    const presenters = new PresenterFactory({ width: 160 });
    const list = presenters.list().render(model).split('\n');
    const row = list.find((line) => line.includes('/api/articles/feed'));
    assert.match(row ?? '', /\s401\?\s/);
    assert.doesNotMatch(list.find((line) => /\/api\/articles\s/.test(line)) ?? '', /401\?/);
    const feed = section(presenters.detail().render({ model, ref: find('/api/articles/feed').id }), 'Auth');
    assert.ok(feed.includes('Credentials:        required, not captured (answered 401 without credentials)'), feed.join('\n'));
    assert.ok(feed.includes('Anonymous:          refused, every request without credentials was refused (401)'), feed.join('\n'));
  });

  test('list --show never says that anonymous access was refused for an endpoint that answered a redirect to another page or 429 without credentials (WIKI-N2, L6)', () => {
    const presenters = new PresenterFactory({ width: 160 });
    for (const path of ['/w/index.php', '/w/api.php', '/api/articles']) {
      assert.equal(find(path).auth.anonymous, 'allowed', path);
      const auth = section(presenters.detail().render({ model, ref: find(path).id }), 'Auth');
      assert.ok(auth.includes('Credentials:        none'), `${path}: ${auth.join('\n')}`);
      assert.ok(auth.includes('Anonymous:          allowed, a request without credentials was not refused'), `${path}: ${auth.join('\n')}`);
    }
  });

  test('Markdown, HTML, Postman and the TypeScript client say that the endpoint needs a credential that was not captured', () => {
    const markdown = new MarkdownExporter().export(model).content;
    const row = markdown.split('\n').find((line) => line.includes('`/api/articles/feed`') || (line.includes('/api/articles/feed') && line.startsWith('|')));
    assert.match(row ?? '', /required, not captured \(answered 401 without credentials\)/);
    assert.match(markdown, /- \*\*Credentials:\*\* required, not captured \(answered 401 without credentials\)/);
    const html = new HtmlExporter().export(model).content;
    assert.match(html, /<span class="badge auth" title="answered 401 without credentials; the credential was not captured">401\?<\/span>/);
    const postman = JSON.parse(new PostmanExporter().export(model).content) as { item: { item?: { name: string; request: { description?: string; url: { raw: string } } }[] }[] };
    const requests = postman.item.flatMap((folder) => folder.item ?? []);
    const feedRequest = requests.find((item) => item.request.url.raw.includes('/api/articles/feed'));
    assert.match(feedRequest?.request.description ?? '', /Credentials: required, not captured \(answered 401 without credentials\)\./);
    const script = new CurlExporter().export(model).content;
    assert.match(script, /\n# getArticlesFeed: without credentials the server answered 401; the credential it expects was not captured\. Add it as a curl argument \(-H or -b\)\.\ngetArticlesFeed\(\) \{/);
    assert.equal((script.match(/the credential it expects was not captured/g) ?? []).length, 1);
    const example = section(new PresenterFactory({ width: 200 }).detail().render({ model, ref: find('/api/articles/feed').id }), 'Example request (curl)').join('\n');
    assert.match(example, /Without credentials the server answered 401\. The credential it expects was not captured: add it with -H or -b\./);
    const client = new TypeScriptExporter().export(model).content;
    assert.match(client, /The server answered 401 to a request without credentials; the credential it expects was not captured\. Pass it in the headers or cookies option\./);
  });
});
