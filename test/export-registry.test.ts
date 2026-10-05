import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor } from '../src/build/index.js';
import { HarConverter } from '../src/capture/index.js';
import { BaseExporter, ExchangeSanitizer, ExporterRegistry, HarExporter, JsonExporter } from '../src/export/index.js';
import type { ExportFormat, ExportOptions } from '../src/export/index.js';
import type { ApiModel, Endpoint, Exchange } from '../src/model/index.js';
import { AppiiError, Http, Text } from '../src/shared/index.js';
import { FIXTURE_USER } from './fixtures/site.js';
import { ExportModel } from './helpers/export-model.js';
import type { ExportFixture } from './helpers/export-model.js';

function isCode(code: string) {
  return (err: unknown): boolean => err instanceof AppiiError && err.code === code;
}

class EchoExporter extends BaseExporter {
  readonly format: ExportFormat = 'json';
  readonly extension = 'txt';
  readonly mimeType = 'text/plain';
  readonly description = 'test exporter';
  readonly seen: { endpoints: string[]; options: ExportOptions }[] = [];

  constructor(readonly output = 'ok') {
    super();
  }

  protected render(_model: ApiModel, endpoints: Endpoint[], options: ExportOptions): string {
    this.seen.push({ endpoints: endpoints.map((e) => e.name), options });
    return this.output;
  }
}

describe('ExporterRegistry and BaseExporter', () => {
  const model = ExportModel.model([
    ExportModel.endpoint({ method: 'GET', path: '/a', name: 'getA', id: 'get-a' }),
    ExportModel.endpoint({ method: 'GET', path: '/b', name: 'getB', id: 'get-b' }),
    ExportModel.endpoint({ method: 'GET', path: '/c', name: 'getC', id: 'get-c' }),
  ]);

  test('default() registers all nine formats in a stable order', () => {
    const registry = ExporterRegistry.default();
    assert.deepEqual(
      registry.list().map((e) => [e.format, e.extension]),
      [
        ['openapi', 'json'],
        ['openapi-yaml', 'yaml'],
        ['postman', 'json'],
        ['curl', 'sh'],
        ['typescript', 'ts'],
        ['har', 'har'],
        ['html', 'html'],
        ['markdown', 'md'],
        ['json', 'json'],
      ],
    );
    for (const exporter of registry.list()) assert.ok(exporter.description.length > 10 && exporter.mimeType.includes('/'));
  });

  test('lookup is case-insensitive, supports aliases and lists the formats on errors', () => {
    const registry = ExporterRegistry.default();
    assert.equal(registry.has('OpenAPI'), true);
    assert.equal(registry.get('yaml').format, 'openapi-yaml');
    assert.equal(registry.get(' TS ').format, 'typescript');
    assert.equal(registry.get('md').format, 'markdown');
    assert.equal(registry.get('sh').format, 'curl');
    assert.equal(registry.has('pdf'), false);
    assert.throws(
      () => registry.get('pdf'),
      (err: unknown) =>
        isCode('BAD_INPUT')(err) && /Unknown export format 'pdf'\. Available formats: openapi, openapi-yaml, postman, curl, typescript, har, html, markdown, json/.test((err as Error).message),
    );
    assert.throws(() => registry.export(model, 'nope'), isCode('BAD_INPUT'));
  });

  test('register replaces an exporter for the same format and export delegates to it', () => {
    const echo = new EchoExporter('echo');
    const registry = ExporterRegistry.default().register(echo);
    assert.equal(registry.get('json'), echo);
    assert.equal(registry.list().length, 9);
    const result = registry.export(model, 'model', { endpoints: ['getC', '1'], title: '  ' });
    assert.deepEqual(result, { format: 'json', filename: 'shop-example-com.txt', mimeType: 'text/plain', content: 'echo', endpointCount: 2 });
    assert.deepEqual(echo.seen[0], { endpoints: ['getA', 'getC'], options: { endpoints: ['getC', '1'] } });
  });

  test('the template method validates options, selects endpoints and enforces ASCII output', () => {
    const echo = new EchoExporter();
    assert.equal(echo.export(model).endpointCount, 3);
    assert.throws(() => echo.export(model, { endpoints: ['missing'] }), isCode('NOT_FOUND'));
    assert.throws(() => echo.export(model, { baseUrl: 'mailto:x' }), isCode('BAD_INPUT'));
    assert.throws(() => echo.export(model, { baseUrl: 'https://x.test/?q=1' }), isCode('BAD_INPUT'));
    echo.export(model, { baseUrl: 'https://x.test/api/' });
    assert.equal(echo.seen.at(-1)?.options.baseUrl, 'https://x.test/api');
    assert.throws(() => new EchoExporter('caf\u00e9').export(model), isCode('INTERNAL'));
  });

  test('every default exporter produces ASCII output for an empty model', () => {
    const empty = ExportModel.model([], { primaryOrigin: '', origins: [] });
    for (const exporter of ExporterRegistry.default().list()) {
      const options = exporter.format === 'har' ? { capture: new HarConverter().fromHar({ log: { version: '1.2', creator: { name: 'x', version: '1' }, entries: [] } }) } : {};
      const result = exporter.export(empty, options);
      assert.ok(Text.isAscii(result.content), exporter.format);
      assert.equal(result.endpointCount, 0);
    }
  });
});

describe('HarExporter and JsonExporter on a real capture', () => {
  let fixture: ExportFixture;
  let model: ApiModel;

  before(async () => {
    fixture = await ExportModel.fixture();
    model = fixture.model;
  });

  after(async () => {
    await fixture?.site.close();
  });

  test('the HAR export needs the capture', () => {
    assert.throws(() => new HarExporter().export(model), isCode('BAD_INPUT'));
  });

  test('only sample exchanges of the selected endpoints are written, sanitized by default', () => {
    const exporter = new HarExporter();
    const result = exporter.export(model, { capture: fixture.capture, endpoints: ['postLogin', 'getItem'] });
    assert.equal(result.filename, 'capture.har');
    assert.equal(result.endpointCount, 2);
    assert.ok(Text.isAscii(result.content));
    const har = JSON.parse(result.content) as { log: { version: string; entries: { request: { method: string; url: string; headers: { name: string; value: string }[]; postData?: { text: string } } }[] } };
    assert.equal(har.log.version, '1.2');
    const urls = har.log.entries.map((entry) => `${entry.request.method} ${new URL(entry.request.url).pathname}`);
    assert.deepEqual(urls.sort(), ['GET /api/items/1', 'GET /api/items/2', 'GET /api/items/999', 'POST /login'].sort());
    const login = har.log.entries.find((entry) => entry.request.method === 'POST');
    assert.ok(login);
    const form = new URLSearchParams(login.request.postData?.text);
    assert.equal(form.get('password'), '<redacted>');
    assert.equal(form.get('csrf_token'), '<redacted>');
    assert.equal(form.get('email'), FIXTURE_USER.email);
    const cookie = login.request.headers.find((h) => h.name.toLowerCase() === 'cookie')?.value ?? '';
    assert.match(cookie, /^sid=<redacted>; theme=<redacted>$/);
    assert.ok(!result.content.includes(FIXTURE_USER.password));
    const raw = exporter.export(model, { capture: fixture.capture, endpoints: ['postLogin'], redact: false }).content;
    assert.ok(raw.includes(encodeURIComponent(FIXTURE_USER.password)));
    const roundTrip = new HarConverter().fromHar(raw);
    assert.equal(roundTrip.exchanges.length, 1);
    assert.equal(roundTrip.exchanges[0]?.request.url, `${fixture.site.origin}/login`);
  });

  test('the JSON export is the model restricted to the selected endpoints', () => {
    const exporter = new JsonExporter();
    const all = exporter.export(model);
    assert.equal(all.filename, 'api.json');
    assert.deepEqual(JSON.parse(all.content), model);
    const some = JSON.parse(exporter.export(model, { endpoints: ['getMe', 'listItems'] }).content) as ApiModel;
    assert.deepEqual(some.endpoints.map((e) => e.name), ['listItems', 'getMe']);
    assert.deepEqual({ ...some, endpoints: [], cookies: [], forms: [] }, { ...model, endpoints: [], cookies: [], forms: [] });
    const ids = new Set(some.endpoints.map((e) => e.id));
    assert.ok(some.cookies.length > 0);
    for (const cookie of some.cookies) for (const id of [...cookie.setBy, ...cookie.usedBy]) assert.ok(ids.has(id), id);
    const unicode = exporter.export({ ...model, name: 'Caf\u00e9 \u{1F600}' }).content;
    assert.ok(Text.isAscii(unicode));
    assert.equal((JSON.parse(unicode) as ApiModel).name, 'Caf\u00e9 \u{1F600}');
  });
});

describe('ExchangeSanitizer', () => {
  function exchange(request: Partial<Exchange['request']>, response?: Exchange['response']): Exchange {
    const out: Exchange = {
      id: 'x1',
      source: 'browser',
      resourceType: 'fetch',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      request: { method: 'POST', url: 'https://shop.example.com/a?token=abc&page=2', headers: [], ...request },
    };
    if (response) out.response = response;
    return out;
  }

  const body = (text: string, type: string) => Http.toBodyData(new TextEncoder().encode(text), type);

  test('redacts URLs, headers, urlencoded and JSON bodies without touching other values', () => {
    const sanitizer = new ExchangeSanitizer();
    const out = sanitizer.sanitize(
      exchange(
        {
          headers: [
            { name: 'Authorization', value: 'Bearer abc.def' },
            { name: 'Cookie', value: 'sid=1; theme=dark' },
            { name: 'Content-Type', value: 'application/x-www-form-urlencoded' },
          ],
          body: body('user=bob&password=hunter2&csrf_token=xyz&note=a+b', 'application/x-www-form-urlencoded'),
        },
        {
          status: 200,
          statusText: 'OK',
          headers: [
            { name: 'Set-Cookie', value: 'sid=2; Path=/' },
            { name: 'Content-Type', value: 'application/json' },
          ],
          body: body('{"access_token":"t0k3n","user":{"name":"bob"}}', 'application/json'),
        },
      ),
    );
    assert.equal(out.request.url, 'https://shop.example.com/a?token=%3Credacted%3E&page=2');
    assert.deepEqual(out.request.headers.map((h) => h.value), ['Bearer <redacted>', 'sid=<redacted>; theme=<redacted>', 'application/x-www-form-urlencoded']);
    assert.equal(Http.bodyText(out.request.body), 'user=bob&password=%3Credacted%3E&csrf_token=%3Credacted%3E&note=a+b');
    assert.equal(out.response?.headers[0]?.value, 'sid=<redacted>; Path=/');
    assert.deepEqual(JSON.parse(Http.bodyText(out.response?.body)), { access_token: '<redacted>', user: { name: 'bob' } });
  });

  test('redacts secret multipart parts and token fields in HTML pages; disabled redaction copies', () => {
    const multipart = '--B\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter2\r\n--B\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\npassword\r\n--B--\r\n';
    const sanitizer = new ExchangeSanitizer();
    const out = sanitizer.sanitize(exchange({ headers: [{ name: 'content-type', value: 'multipart/form-data; boundary=B' }], body: body(multipart, 'multipart/form-data; boundary=B') }));
    assert.equal(
      Http.bodyText(out.request.body),
      '--B\r\nContent-Disposition: form-data; name="password"\r\n\r\n<redacted>\r\n--B\r\nContent-Disposition: form-data; name="file"; filename="a.txt"\r\nContent-Type: text/plain\r\n\r\npassword\r\n--B--\r\n',
    );
    const page = '<form><input type="hidden" value="s3cr3t" name="csrf_token"><input name="q" value="keep"></form><meta content="m3ta" name="csrf-token">';
    const html = sanitizer.sanitize(
      exchange({ method: 'GET' }, { status: 200, statusText: 'OK', headers: [{ name: 'content-type', value: 'text/html' }], body: body(page, 'text/html') }),
    );
    assert.equal(
      Http.bodyText(html.response?.body),
      '<form><input type="hidden" value="&lt;redacted&gt;" name="csrf_token"><input name="q" value="keep"></form><meta content="&lt;redacted&gt;" name="csrf-token">',
    );
    const original = exchange({ headers: [{ name: 'Cookie', value: 'sid=1' }] });
    const copy = new ExchangeSanitizer({ redactor: new Redactor(false) }).sanitize(original);
    assert.deepEqual(copy, original);
    assert.notEqual(copy, original);
  });
});
