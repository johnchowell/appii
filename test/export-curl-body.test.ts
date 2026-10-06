import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelBuilder } from '../src/build/index.js';
import { CurlExporter, PostmanExporter } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { Samples } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const FORM = 'application/x-www-form-urlencoded';
const AUTHORS = ['Albert Einstein', 'Jane Austen', 'Mark Twain'];

class EchoSite {
  readonly received: Received[] = [];
  origin = '';
  #server: Server | undefined;

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        this.received.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ body }));
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  last(): Received {
    const last = this.received.at(-1);
    assert.ok(last, 'no request reached the server');
    return last;
  }
}

function run(file: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const clean: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C', ...env };
    execFile('bash', [file, ...args], { env: clean, timeout: 20_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

function filterForm(tags: readonly string[], selected?: string): string {
  const options = (values: readonly string[], chosen?: string): string => ['----------', ...values].map((value) => `<option${value === chosen ? ' selected' : ''}>${value}</option>`).join('');
  return CaptureFactory.page(
    'Search',
    `<form name="filterform" method="post" action="/filter.aspx"><select name="author" onchange="this.form.submit()">${options(AUTHORS, selected)}</select><select name="tag">${options(tags)}</select><input type="hidden" name="__VIEWSTATE" value="vs-1234567890abcdef"><input type="submit" name="submit_button" value="Search"></form>`,
  );
}

const LOGIN = CaptureFactory.page(
  'Login',
  '<form action="/login" method="post"><input type="hidden" name="csrf_token" value="tok-1234567890abcdef"><input type="text" name="username"><input type="password" name="password"><input type="submit" value="Login"></form>',
);

function quotesModel(origin: string): ApiModel {
  const f = new CaptureFactory(origin);
  const post = (page: string, body: string): void => {
    f.exchange({ method: 'POST', url: '/filter.aspx', resourceType: 'document', pageUrl: f.url(page), requestHeaders: { 'content-type': FORM }, requestBody: body, status: 200, responseHeaders: { 'content-type': 'text/html' }, responseBody: '<p>results</p>' });
  };
  f.document('/search.aspx', filterForm([]));
  f.snapshot('/search.aspx', 'Search', filterForm([]));
  post('/search.aspx', 'author=Jane+Austen&tag=----------&__VIEWSTATE=vs-1234567890abcdef');
  f.snapshot('/filter.aspx', 'Search', filterForm(['aliteracy', 'books'], 'Jane Austen'));
  post('/filter.aspx', 'author=Jane+Austen&tag=books&submit_button=Search&__VIEWSTATE=vs-1234567890abcdef');
  f.document('/login', LOGIN);
  f.snapshot('/login', 'Login', LOGIN);
  f.exchange({
    method: 'POST',
    url: '/login',
    resourceType: 'document',
    pageUrl: f.url('/login'),
    requestHeaders: { 'content-type': FORM },
    requestBody: 'csrf_token=tok-1234567890abcdef&username=verifier&password=correct-horse-battery',
    status: 302,
    responseHeaders: { location: '/' },
  });
  f.exchange({ method: 'POST', url: '/notes', requestHeaders: { 'content-type': 'text/plain' }, requestBody: 'token=txt-Secret-Plain-662\nnote=hello', status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: { json: { ok: true } } });
  f.exchange({ method: 'POST', url: '/search', requestHeaders: { 'content-type': FORM }, requestBody: 'q=one', status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: { json: { ok: true } } });
  return ModelBuilder.create().build(f.capture());
}

function find(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((endpoint) => endpoint.method === method && endpoint.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).join(', ')}`);
  return found;
}

function pairs(body: string): [string, string][] {
  return [...new URLSearchParams(body)];
}

describe('curl functions take body fields as arguments and default to an observed request (QTS-R1)', () => {
  const site = new EchoSite();
  let dir = '';
  let file = '';
  let model: ApiModel;
  let names: Map<Endpoint, string>;

  before(async () => {
    await site.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-curl-body-'));
    model = quotesModel(site.origin);
    file = join(dir, 'endpoints.sh');
    await writeFile(file, new CurlExporter().export(model).content);
    names = new CurlExporter().functionNames(model.endpoints);
  });

  after(async () => {
    await site.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  function fn(method: string, path: string): string {
    const name = names.get(find(model, method, path));
    assert.ok(name);
    return name;
  }

  test('the default body is the observed submission of the chosen submitter, byte for byte', async () => {
    const filter = find(model, 'POST', '/filter.aspx');
    const sample = Samples.requestSample(filter);
    assert.deepEqual(Samples.plainValue(sample.body?.value), { author: 'Jane Austen', tag: 'books', submit_button: 'Search', __VIEWSTATE: '{{viewstate}}' });
    const result = await run(file, [fn('POST', '/filter.aspx')], { APPII_VIEWSTATE: 'VS' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(site.last().body, 'author=Jane+Austen&tag=books&submit_button=Search&__VIEWSTATE=VS');
  });

  test('name=value arguments and APPII_ variables replace body fields instead of adding duplicates', async () => {
    const filter = fn('POST', '/filter.aspx');
    const args = await run(file, [filter, 'author=Mark Twain', 'tag=a b&c=d/\u00e9*~', '-o', join(dir, 'f.json')], { APPII_VIEWSTATE: 'VS' });
    assert.equal(args.code, 0, args.stderr);
    assert.deepEqual(pairs(site.last().body), [['author', 'Mark Twain'], ['tag', 'a b&c=d/\u00e9*~'], ['submit_button', 'Search'], ['__VIEWSTATE', 'VS']]);
    assert.equal(site.last().body, 'author=Mark+Twain&tag=a+b%26c%3Dd%2F%C3%A9*%7E&submit_button=Search&__VIEWSTATE=VS');
    const env = await run(file, [filter], { APPII_AUTHOR: 'Albert Einstein', APPII_VIEWSTATE: 'VS' });
    assert.equal(env.code, 0, env.stderr);
    assert.deepEqual(pairs(site.last().body), [['author', 'Albert Einstein'], ['tag', 'books'], ['submit_button', 'Search'], ['__VIEWSTATE', 'VS']]);
    const token = await run(file, [filter, '__VIEWSTATE=from-arg']);
    assert.equal(token.code, 0, token.stderr);
    assert.equal(new URLSearchParams(site.last().body).get('__VIEWSTATE'), 'from-arg');
    const list = await run(file, []);
    assert.match(list.stdout, new RegExp(`POST +/filter\\.aspx +${filter} +\\[author=\\] \\[tag=\\] \\[submit_button=\\] \\[__VIEWSTATE=\\]\\n`));
  });

  test('a login form takes the user name and password as arguments', async () => {
    const login = await run(file, [fn('POST', '/login'), 'username=x', 'password=p&q'], { APPII_CSRF_TOKEN: 'T' });
    assert.equal(login.code, 0, login.stderr);
    assert.deepEqual(pairs(site.last().body), [['csrf_token', 'T'], ['username', 'x'], ['password', 'p&q']]);
    const plain = await run(file, [fn('POST', '/login')], { APPII_CSRF_TOKEN: 'T', APPII_PASSWORD: 'pw' });
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal(site.last().body, 'csrf_token=T&username=verifier&password=pw');
  });

  test('a body field with the same name as a query parameter is body.name=, the query parameter query.name=', async () => {
    const endpoint = find(model, 'POST', '/search');
    const exporter = new CurlExporter();
    const query = { ...endpoint, path: '/search', queryParams: [{ name: 'q', in: 'query' as const, required: true, schema: { type: 'string' }, examples: ['top'] }] };
    const clash = { ...model, endpoints: [query] };
    const text = exporter.export(clash).content;
    const own = join(dir, 'clash.sh');
    await writeFile(own, text);
    const name = exporter.functionNames(clash.endpoints).get(query) ?? '';
    const result = await run(own, [name, 'query.q=in-url', 'body.q=in-body']);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(site.last().url, '/search?q=in-url');
    assert.equal(site.last().body, 'q=in-body');
    assert.match(text, /\[query\.q=\] \[body\.q=\]/);
  });

  test('a text/plain body keeps its non-secret lines and names the secret after its key (NEW-2)', async () => {
    const notes = find(model, 'POST', '/notes');
    assert.deepEqual(notes.requestBody?.examples, ['token=<redacted>\nnote=hello']);
    const result = await run(file, [fn('POST', '/notes')], { APPII_TOKEN: 'replay-text-token' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(site.last().body, 'token=replay-text-token\nnote=hello');
    const postman = new PostmanExporter().collection(model, [notes]);
    const items = (postman.item as { item: { request: { body?: { raw?: string } } }[] }[]).flatMap((folder) => folder.item);
    assert.equal(items[0]?.request.body?.raw, 'token={{token}}\nnote=hello');
    assert.ok((postman.variable as { key: string }[]).some((variable) => variable.key === 'token'));
  });
});
