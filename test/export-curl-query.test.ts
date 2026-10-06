import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { ModelBuilder } from '../src/build/index.js';
import { CurlExporter, HtmlExporter, MarkdownExporter } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { Curl, Samples, Text } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { ExportModel } from './helpers/export-model.js';

interface Article {
  slug: string;
  tags: string[];
  author: string;
  favoritedBy: string[];
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const ARTICLES: Article[] = [
  { slug: 'one', tags: ['ai'], author: 'mike', favoritedBy: [] },
  { slug: 'two', tags: ['backend'], author: 'sara', favoritedBy: ['mike'] },
  { slug: 'three', tags: ['ai', 'backend'], author: 'sara', favoritedBy: [] },
  { slug: 'four', tags: [], author: 'mike', favoritedBy: [] },
];

class SiteServer {
  readonly urls: string[] = [];
  #server: Server | undefined;
  origin = '';

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      this.urls.push(req.url ?? '');
      if (url.pathname === '/api/quotes') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ page: Number(url.searchParams.get('page') ?? '1'), query: [...url.searchParams] }));
        return;
      }
      if (url.pathname === '/api/articles') {
        const tag = url.searchParams.get('tag');
        const author = url.searchParams.get('author');
        const favorited = url.searchParams.get('favorited');
        const found = ARTICLES.filter((a) => (tag === null || a.tags.includes(tag)) && (author === null || a.author === author) && (favorited === null || a.favoritedBy.includes(favorited)));
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ articles: found.map((a) => a.slug), articlesCount: found.length }));
        return;
      }
      if (url.pathname === '/gzip') {
        res.writeHead(200, { 'content-type': 'application/json', 'content-encoding': 'gzip' });
        res.end(gzipSync(JSON.stringify({ gzipped: true })));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>page</title>');
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  last(): URL {
    const last = this.urls.at(-1);
    assert.ok(last !== undefined, 'no request reached the server');
    return new URL(last, this.origin);
  }
}

function run(file: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const clean: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C', ...env };
    execFile('bash', [file, ...args], { cwd: dirname(file), env: clean, timeout: 20_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

function siteModel(origin: string): ApiModel {
  const f = new CaptureFactory(origin);
  const xhr = { requestHeaders: { 'x-requested-with': 'XMLHttpRequest' } };
  f.json('GET', '/api/quotes?page=1', 200, { page: 1 }, xhr);
  f.json('GET', '/api/quotes?page=2', 200, { page: 2 }, xhr);
  for (const query of ['limit=10&offset=0', 'tag=ai&limit=10&offset=0', 'limit=10&offset=0', 'author=mike&limit=10&offset=0', 'favorited=mike&limit=10&offset=0']) {
    f.json('GET', `/api/articles?${query}`, 200, { articles: [], articlesCount: 0 });
  }
  f.document('/catalogue/the-exiled_247/index.html', '<!doctype html><title>The Exiled</title><h1>The Exiled</h1>');
  f.json('GET', '/api/items/1', 200, { id: 1 });
  f.json('GET', '/api/items/2', 200, { id: 2 });
  f.json('GET', '/api/items/3', 200, { id: 3 });
  f.exchange({ url: '/gzip', status: 200, responseHeaders: { 'content-type': 'application/json', 'content-encoding': 'gzip' }, responseBody: { json: { gzipped: true } } });
  return ModelBuilder.create().build(f.capture());
}

function find(model: ApiModel, path: string): Endpoint {
  const found = model.endpoints.find((endpoint) => endpoint.path === path);
  assert.ok(found, `${path} in ${model.endpoints.map((endpoint) => endpoint.path).join(', ')}`);
  return found;
}

describe('the curl script takes query parameters and rejects stray arguments (QTS-4, BOOKS-6, SPA-3, HTTPBIN-4)', () => {
  const site = new SiteServer();
  let dir = '';
  let model: ApiModel;
  let file = '';
  let names: Map<Endpoint, string>;

  before(async () => {
    await site.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-curl-query-'));
    model = siteModel(site.origin);
    file = join(dir, 'endpoints.sh');
    await writeFile(file, new CurlExporter().export(model).content);
    names = new CurlExporter().functionNames(model.endpoints);
  });

  after(async () => {
    await site.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function fn(path: string): string {
    const name = names.get(find(model, path));
    assert.ok(name, path);
    return name;
  }

  test('a required query parameter takes its value from APPII_<NAME> and from a name=value argument (QTS-4)', async () => {
    const quotes = fn('/api/quotes');
    const plain = await run(file, [quotes]);
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(site.last().search, '?page=1');
    assert.equal(JSON.parse(plain.stdout).page, 1);
    const env = await run(file, [quotes], { APPII_PAGE: '2' });
    assert.equal(env.code, 0, env.stderr);
    assert.equal(site.last().search, '?page=2');
    assert.equal(JSON.parse(env.stdout).page, 2);
    const arg = await run(file, [quotes, 'page=3', '-H', 'x-test: 1']);
    assert.equal(arg.code, 0, arg.stderr);
    assert.equal(site.last().search, '?page=3');
    const encoded = await run(file, [quotes, 'page=a b&c=d/\u00e9']);
    assert.equal(encoded.code, 0, encoded.stderr);
    assert.deepEqual([...site.last().searchParams], [['page', 'a b&c=d/\u00e9']]);
    const list = await run(file, []);
    assert.match(list.stdout, new RegExp(`\\n *\\d+ +GET +/api/quotes +${quotes} +\\[page=\\]\\n`));
    const usage = await run(file, ['--help']);
    assert.match(usage.stdout, /\[name=\] is a query parameter or a field of the request body\. Give it as\nname=value after the path values, or set the APPII_<NAME> variable\./);
  });

  test('the default request is an observed one, and optional filters are added only on request (SPA-3)', async () => {
    const articles = fn('/api/articles');
    const plain = await run(file, [articles]);
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(site.last().search, '?limit=10&offset=0');
    assert.equal(JSON.parse(plain.stdout).articlesCount, 4);
    const tagged = await run(file, [articles, 'tag=ai']);
    assert.equal(tagged.code, 0, tagged.stderr);
    assert.equal(site.last().search, '?limit=10&offset=0&tag=ai');
    assert.equal(JSON.parse(tagged.stdout).articlesCount, 2);
    const env = await run(file, [articles], { APPII_AUTHOR: 'sara', APPII_LIMIT: '5' });
    assert.equal(env.code, 0, env.stderr);
    assert.equal(site.last().search, '?limit=5&offset=0&author=sara');
    const sample = Samples.requestSample(find(model, '/api/articles'));
    assert.equal(sample.url.toString(), `${site.origin}/api/articles?limit=10&offset=0`);
    const literal = Curl.curlCommand(Samples.requestSample(find(model, '/api/articles')), { variables: 'shell' });
    assert.ok(new MarkdownExporter().export(model).content.includes(literal));
    assert.ok(new HtmlExporter().export(model).content.includes(Text.escapeHtml(literal)));
  });

  test('a value that no path parameter takes stops the script before any request (BOOKS-6)', async () => {
    const page = fn('/catalogue/the-exiled_247/index.html');
    const before = site.urls.length;
    const stray = await run(file, [page, 'a-light-in-the-attic_1000', '-o', join(dir, 'out.html')]);
    assert.equal(stray.code, 2);
    assert.equal(stray.stderr, `${page}: unexpected argument a-light-in-the-attic_1000. It takes no arguments. Arguments for curl start with '-'.\n`);
    assert.equal(site.urls.length, before);
    const item = fn('/api/items/{itemId}');
    const two = await run(file, [item, '2', '3']);
    assert.equal(two.code, 2);
    assert.match(two.stderr, /unexpected argument 3\. Arguments: \[ITEM_ID\]\./);
    const query = await run(file, [fn('/api/quotes'), 'size=3']);
    assert.equal(query.code, 2);
    assert.match(query.stderr, /unexpected argument size=3\. Arguments: \[page=\]\./);
    assert.equal(site.urls.length, before);
    const ok = await run(file, [item, '2', '-o', join(dir, 'item.json')]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.equal(site.last().pathname, '/api/items/2');
    const head = await run(file, [page, '-i']);
    assert.equal(head.code, 0, head.stderr);
    assert.match(head.stdout, /^HTTP\/1\.1 200 OK\r\n/);
  });

  test('a server that always compresses returns the decoded body (HTTPBIN-4)', async () => {
    const result = await run(file, [fn('/gzip')]);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { gzipped: true });
    const sample = Samples.requestSample(find(model, '/gzip'));
    for (const command of [Curl.curlCommand(sample), Curl.curlCommand(sample, { variables: 'shell' })]) assert.match(command, /\n {2}--compressed$/);
    assert.match(new MarkdownExporter().export(model).content, /\/gzip' \\\n {2}--compressed\n```/);
  });
});

describe('Markdown and HTML show the command of list --show (HTTPBIN-12)', () => {
  test('a cookie and bearer endpoint uses the same APPII_ variables everywhere', () => {
    const endpoint = ExportModel.endpoint({
      method: 'GET',
      path: '/bearer',
      headerParams: [{ name: 'authorization', in: 'header', required: true, schema: { type: 'string' }, examples: ['Bearer <redacted>'] }],
      auth: { cookies: ['session'], headers: ['authorization'], anonymous: 'untested', bearer: true, csrf: [] },
    });
    const model = ExportModel.model([endpoint]);
    const shell = Curl.curlCommand(Samples.requestSample(endpoint, { baseUrl: ExportModel.ORIGIN }), { variables: 'shell' });
    assert.match(shell, /-H "authorization: Bearer \$\{APPII_ACCESS_TOKEN\}"/);
    assert.match(shell, /-b "session=\$\{APPII_SESSION\}"/);
    const markdown = new MarkdownExporter().export(model).content;
    assert.ok(markdown.includes(`\`\`\`bash\n${shell}\n\`\`\`\n\nVariables: \`APPII_ACCESS_TOKEN\` \`APPII_SESSION\``), markdown);
    assert.ok(!markdown.includes('{{'), markdown);
    const html = new HtmlExporter().export(model).content;
    assert.ok(html.includes(Text.escapeHtml(shell)), html);
    assert.ok(html.includes('<p class="variables">Variables: <code>APPII_ACCESS_TOKEN</code> <code>APPII_SESSION</code></p>'), html);
    assert.ok(!/\{\{(?:access_token|session)\}\}/.test(html));
  });
});
