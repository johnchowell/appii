import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { TypeScriptExporter } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { Fs } from '../src/shared/index.js';
import { TsClientHarness } from './fixtures/export-ts-harness.js';
import type { Module, SentRequest } from './fixtures/export-ts-harness.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { ExportModel } from './helpers/export-model.js';

function find(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((endpoint) => endpoint.method === method && endpoint.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

function headers(request: SentRequest | undefined): [string | null, string | null] {
  return [request?.headers.get('origin') ?? null, request?.headers.get('referer') ?? null];
}

const PAGE = 'https://shop.example.com/app?tab=1#top';

describe('Origin and Referer of requests that are not HTML forms (EXP2-9)', () => {
  let harness: TsClientHarness;
  let model: ApiModel;
  let mod: Module;

  before(async () => {
    harness = await TsClientHarness.open();
    const sample = (path: string, origin = ExportModel.ORIGIN) => [{ exchangeId: `x-${path}`, url: origin + path, pageUrl: PAGE, status: 200, startedAt: ExportModel.NOW.toISOString() }];
    model = ExportModel.model([
      ExportModel.endpoint({ method: 'POST', path: '/api/items', resourceTypes: ['fetch'], samples: sample('/api/items') }),
      ExportModel.endpoint({ method: 'GET', path: '/api/list', resourceTypes: ['xhr'], samples: sample('/api/list') }),
      ExportModel.endpoint({ method: 'GET', path: '/v1/me', origin: 'https://api.example.com', resourceTypes: ['fetch'], samples: sample('/v1/me', 'https://api.example.com') }),
      ExportModel.endpoint({ method: 'POST', path: '/beacon', origin: 'http://tracker.example.org', resourceTypes: ['fetch'], samples: sample('/beacon', 'http://tracker.example.org') }),
      ExportModel.endpoint({ method: 'POST', path: '/checkout', resourceTypes: ['document'], samples: sample('/checkout') }),
    ]);
    mod = (await harness.load(model)).mod;
  });

  after(async () => {
    await harness?.close();
  });

  test('the client sends Origin and Referer like fetch() on the page that made the request', async () => {
    const recorder = TsClientHarness.recorder(() => TsClientHarness.json({ ok: true }));
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    for (const endpoint of model.endpoints) await TsClientHarness.call(client, endpoint.name, {});
    await TsClientHarness.call(client, find(model, 'POST', '/api/items').name, { headers: { origin: 'https://caller.example' } });
    assert.deepEqual(recorder.sent.map(headers), [
      ['https://shop.example.com', 'https://shop.example.com/app?tab=1'],
      [null, 'https://shop.example.com/app?tab=1'],
      ['https://shop.example.com', 'https://shop.example.com/'],
      ['https://shop.example.com', null],
      [null, null],
      ['https://caller.example', 'https://shop.example.com/app?tab=1'],
    ]);
  });
});

describe('redirects of the generated client (EXP2-18)', () => {
  let harness: TsClientHarness;
  let model: ApiModel;
  let mod: Module;
  let login: Endpoint;

  before(async () => {
    harness = await TsClientHarness.open();
    const f = new CaptureFactory();
    f.snapshot('/login', 'Login', '<form action="/login" method="post"><input name="user"><button>Go</button></form>');
    model = TsClientHarness.build(f);
    login = find(model, 'POST', '/login');
    mod = (await harness.load(model)).mod;
  });

  after(async () => {
    await harness?.close();
  });

  function hops(locations: Record<string, [number, string, Record<string, string>?]>): ReturnType<typeof TsClientHarness.recorder> {
    return TsClientHarness.recorder((request) => {
      const hop = locations[request.url];
      if (!hop) return new Response('done', { status: 200 });
      return new Response(null, { status: hop[0], headers: { location: hop[1], ...(hop[2] ?? {}) } });
    });
  }

  test('a redirect to a data: URL is a network error', async () => {
    const recorder = hops({
      'https://shop.example.com/login': [307, 'https://other.example.net/collect'],
      'https://other.example.net/collect': [302, 'data:text/plain,owned'],
    });
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    await assert.rejects(TsClientHarness.call(client, login.name, { body: { user: 'a' } }), /not an http or https URL/);
    assert.deepEqual(recorder.sent.map((request) => request.url), ['https://shop.example.com/login', 'https://other.example.net/collect']);
    assert.deepEqual(recorder.sent.map(headers), [
      ['https://shop.example.com', 'https://shop.example.com/login'],
      ['https://shop.example.com', 'https://shop.example.com/'],
    ]);
  });

  test('Origin becomes null after a redirect back from another origin, and Referer follows the referrer policy on each hop', async () => {
    const recorder = hops({
      'https://shop.example.com/login': [307, 'https://other.example.net/collect'],
      'https://other.example.net/collect': [307, 'https://shop.example.com/done'],
    });
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    assert.equal((await TsClientHarness.call(client, login.name, { body: { user: 'a' } })).status, 200);
    assert.deepEqual(recorder.sent.map(headers), [
      ['https://shop.example.com', 'https://shop.example.com/login'],
      ['https://shop.example.com', 'https://shop.example.com/'],
      ['null', 'https://shop.example.com/login'],
    ]);
    const policy = hops({ 'https://shop.example.com/login': [307, 'https://shop.example.com/next', { 'referrer-policy': 'unknown, no-referrer' }] });
    const strict = TsClientHarness.client(mod, model, { fetch: policy.fetch });
    await TsClientHarness.call(strict, login.name, { body: { user: 'a' } });
    assert.deepEqual(policy.sent.map(headers), [
      ['https://shop.example.com', 'https://shop.example.com/login'],
      ['null', null],
    ]);
    const see = hops({ 'https://shop.example.com/login': [303, 'https://shop.example.com/account'] });
    const other = TsClientHarness.client(mod, model, { fetch: see.fetch });
    await TsClientHarness.call(other, login.name, { body: { user: 'a' } });
    assert.deepEqual(see.sent.map((request) => [request.method, ...headers(request)]), [
      ['POST', 'https://shop.example.com', 'https://shop.example.com/login'],
      ['GET', null, 'https://shop.example.com/login'],
    ]);
  });
});

describe('cookie jar of the generated client (EXP2-17)', () => {
  let harness: TsClientHarness;
  let mod: Module;
  let model: ApiModel;
  const NOW = Date.parse('2026-06-01T00:00:00Z');

  interface Jar {
    set(line: string, url: string, now?: number): boolean;
    header(url: string, now?: number): string;
  }

  before(async () => {
    harness = await TsClientHarness.open();
    model = ExportModel.model([
      ExportModel.endpoint({ method: 'GET', path: '/a', origin: 'https://shop.example.co.uk' }),
      ExportModel.endpoint({ method: 'GET', path: '/b', origin: 'https://alice.github.io' }),
    ]);
    mod = (await harness.load(model)).mod;
  });

  after(async () => {
    await harness?.close();
  });

  test('a Domain attribute that is a public suffix is rejected', () => {
    const jar = new (mod.CookieJar as new () => Jar)();
    assert.equal(jar.set('a=1; Domain=co.uk', 'https://shop.example.co.uk/', NOW), false);
    assert.equal(jar.set('w=1; Domain=example.co.uk', 'https://shop.example.co.uk/', NOW), true);
    assert.equal(jar.header('https://other.co.uk/', NOW), '');
    assert.equal(jar.header('https://www.example.co.uk/', NOW), 'w=1');
    assert.equal(jar.set('b=1; Domain=github.io', 'https://alice.github.io/', NOW), false);
    assert.equal(jar.set('own=1; Domain=alice.github.io', 'https://alice.github.io/', NOW), true);
    assert.equal(jar.header('https://bob.github.io/', NOW), '');
    assert.equal(jar.header('https://alice.github.io/', NOW), 'own=1');
  });

  test('for a host that the export does not know, a Domain attribute is accepted only as the host itself', () => {
    const jar = new (mod.CookieJar as new () => Jar)();
    assert.equal(jar.set('d=1; Domain=unknown.test', 'https://unknown.test/', NOW), true);
    assert.equal(jar.set('e=1; Domain=test', 'https://unknown.test/', NOW), false);
    assert.equal(jar.header('https://sub.unknown.test/', NOW), '');
    assert.equal(jar.header('https://unknown.test/', NOW), 'd=1');
    const client = TsClientHarness.client(mod, model, { registrableDomain: (host: string) => (host.endsWith('unknown.test') ? 'unknown.test' : undefined) });
    const own = client.cookies as unknown as Jar;
    assert.equal(own.set('d=1; Domain=unknown.test', 'https://unknown.test/', NOW), true);
    assert.equal(own.header('https://sub.unknown.test/', NOW), 'd=1');
  });

  test('a __Host- cookie needs an explicit Path attribute', () => {
    const jar = new (mod.CookieJar as new () => Jar)();
    assert.equal(jar.set('__Host-sid=1; Secure', 'https://shop.example.co.uk/login', NOW), false);
    assert.equal(jar.set('__Host-sid=1; Secure; Path=/login', 'https://shop.example.co.uk/login', NOW), false);
    assert.equal(jar.set('__Host-sid=1; Secure; Path=/', 'https://shop.example.co.uk/login', NOW), true);
  });
});

describe('generated file name and text', () => {
  let harness: TsClientHarness;

  before(async () => {
    harness = await TsClientHarness.open();
  });

  after(async () => {
    await harness?.close();
  });

  test('a 253-character host gives a file name that the file system accepts (EXP2-21)', async () => {
    const host = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example.com`.slice(-253);
    const model = ExportModel.model([ExportModel.endpoint({ method: 'GET', path: '/x', origin: `https://${host}` })], { name: host });
    const result = TypeScriptExporter.create().export(model);
    assert.match(result.filename, /^a+-b+-c+-d+-[0-9a-f]{8}-client\.ts$/);
    assert.ok(Buffer.byteLength(result.filename) <= 255 - 18, result.filename);
    assert.equal(TypeScriptExporter.create().export({ ...model, name: 'shop.example.com' }).filename, 'shop-example-com-client.ts');
    await Fs.writeFileAtomic(join(harness.dir, result.filename), result.content);
  });

  test('captured control characters appear only as escapes in the generated TypeScript (CLIENT-CTRL)', async () => {
    const value = ['a', 1, 'b', 0x7f, 'c', 0x9b, 'd', 0x2028, 'e', 0x1b, 'f'].map((part) => (typeof part === 'number' ? String.fromCharCode(part) : part)).join('');
    const f = new CaptureFactory();
    f.snapshot('/form', 'Form', `<form action="/submit" method="post"><input type="hidden" name="h" value="${value}"><input name="q" title="${value}"><button>Go</button></form>`);
    const built = TsClientHarness.build(f);
    const model: ApiModel = { ...built, name: `host${String.fromCharCode(0x1b)}]0;pwned${String.fromCharCode(7)}` };
    const { mod, source, file } = await harness.load(model);
    assert.deepEqual([...source].filter((ch) => ch !== '\n' && (ch < ' ' || ch > '~')).map((ch) => ch.charCodeAt(0)), []);
    const compiled = await harness.compile([file], true);
    assert.equal(compiled.output, '');
    const recorder = TsClientHarness.recorder(() => new Response('ok'));
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    const errors = TsClientHarness.validator(mod, 'validatePostSubmit')({ q: '' });
    assert.deepEqual(errors, []);
    await TsClientHarness.call(client, find(model, 'POST', '/submit').name, { body: { q: 'x' } });
    assert.equal(new URLSearchParams(await TsClientHarness.text(recorder.sent[0]?.body)).get('h'), value);
  });
});
