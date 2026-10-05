import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import type { Endpoint, JsonSchema } from '../src/model/index.js';
import { CharsetEncoder, Json, SampleText, Samples, Schema } from '../src/shared/index.js';
import { SchemaCheck } from './fixtures/build-schema-check.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const PLACEHOLDER = '\u0000placeholder';

function plain(value: Samples.SampleValue | undefined): unknown {
  if (value instanceof SampleText) return value.isLiteral ? value.toString() : PLACEHOLDER;
  if (Array.isArray(value)) return value.map((item: Samples.SampleValue) => plain(item));
  if (Samples.isFileValue(value)) return '';
  if (Samples.isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, plain(item)]));
  return value;
}

function withoutPlaceholders(schema: JsonSchema, value: Record<string, unknown>): { schema: JsonSchema; value: Record<string, unknown> } {
  const skipped = new Set(Object.entries(value).filter(([, item]) => item === PLACEHOLDER).map(([name]) => name));
  const strip = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(strip);
    if (!Json.isPlainObject(node)) return node;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(node)) {
      if (key === 'required' && Array.isArray(item)) out[key] = item.filter((name) => !skipped.has(String(name)));
      else if (key === 'properties' && Json.isPlainObject(item)) out[key] = Object.fromEntries(Object.entries(item).map(([name, inner]) => [name, skipped.has(name) ? true : strip(inner)]));
      else out[key] = strip(item);
    }
    return out;
  };
  return { schema: strip(schema) as JsonSchema, value: Object.fromEntries(Object.entries(value).filter(([name]) => !skipped.has(name))) };
}

function formEndpoints(): Endpoint[] {
  const model = ModelBuilder.create().build(CaptureFactory.fixture().capture);
  return model.endpoints.filter((endpoint) => endpoint.form !== undefined && endpoint.requestBody?.schema !== undefined && endpoint.requestBody.kind !== 'empty');
}

describe('Samples.requestSample for HTML form submissions', () => {
  test('every form example validates against the request schema of its endpoint', () => {
    const endpoints = formEndpoints();
    assert.ok(endpoints.length >= 2, String(endpoints.length));
    for (const endpoint of endpoints) {
      const sample = Samples.requestSample(endpoint);
      const body = plain(sample.body?.value);
      assert.ok(Json.isPlainObject(body), endpoint.id);
      const checked = withoutPlaceholders(endpoint.requestBody?.schema ?? {}, body);
      assert.deepEqual(SchemaCheck.errors(checked.schema, checked.value), [], `${endpoint.id}: ${JSON.stringify(body)}`);
    }
  });

  test('the signup example applies the rules of the Create submitter and sends an empty file part', () => {
    const signup = formEndpoints().find((endpoint) => endpoint.path === '/signup');
    assert.ok(signup);
    const sample = Samples.requestSample(signup);
    const value = sample.body?.value;
    assert.ok(Samples.isRecord(value));
    const body = plain(value) as Record<string, unknown>;
    assert.equal(body.intent, 'create');
    assert.equal(body.country, 'us');
    assert.equal(body.email, 'user@example.com');
    assert.equal(body.age, 13);
    assert.equal(body.birthday, '1900-01-01');
    assert.equal(body.website, 'https://example.com/');
    assert.equal(body.terms, 'on');
    const avatar = Samples.formEntries(value).find((entry) => entry.name === 'avatar');
    assert.deepEqual(avatar && { file: avatar.file, name: avatar.value.toString(), type: avatar.contentType?.toString() }, { file: true, name: '', type: 'application/octet-stream' });
    assert.equal(sample.body?.charset, 'UTF-8');
  });

  test('names and values of HTML form entries are normalized to CRLF, other bodies keep their line breaks', () => {
    const signup = formEndpoints().find((endpoint) => endpoint.path === '/signup');
    assert.ok(signup);
    const bio = Samples.formEntries(Samples.requestSample(signup).body?.value).find((entry) => entry.name === 'bio');
    assert.equal(bio?.value.toString(), 'Hello\r\nworld');
    const factory = new CaptureFactory('https://nl.example.com');
    factory.exchange({ url: '/note', method: 'POST', resourceType: 'fetch', requestType: 'application/x-www-form-urlencoded', requestBody: 'note=a%0Ab', status: 200, responseType: 'text/plain', responseBody: 'ok' });
    const note = ModelBuilder.create().build(factory.capture()).endpoints.find((endpoint) => endpoint.path === '/note');
    assert.ok(note);
    const entry = Samples.formEntries(Samples.requestSample(note).body?.value).find((item) => item.name === 'note');
    assert.equal(entry?.value.toString(), 'a\nb');
  });

  test('a text/plain form is serialized as name=value lines with CRLF', () => {
    const factory = new CaptureFactory('https://tp.example.com');
    factory.document('/f', '<!doctype html><form id="t" action="/t" method="post" enctype="text/plain"><input name="a" value="1"><input name="b" value="x y"><textarea name="c">l1\nl2</textarea><input type="hidden" name="csrf_token" value="tok-abcdefghijklmnop"><button>Go</button></form>');
    const endpoint = ModelBuilder.create().build(factory.capture()).endpoints.find((item) => item.path === '/t');
    assert.ok(endpoint);
    const sample = Samples.requestSample(endpoint);
    assert.equal(sample.body?.kind, 'text');
    assert.equal(sample.body?.mimeType, 'text/plain');
    assert.ok(sample.body?.value instanceof SampleText);
    assert.equal(sample.body.value.toString(), 'a=1\r\nb=x y\r\nc=l1\r\nl2\r\ncsrf_token={{csrf_token}}\r\n');
    assert.deepEqual(sample.headers.map((header) => [header.name, header.value.toString()]), [['Content-Type', 'text/plain']]);
  });

  test('a captured text/plain submission keeps its entries and turns redacted values into placeholders', () => {
    const factory = new CaptureFactory('https://tp.example.com');
    factory.document('/f', '<!doctype html><form action="/t" method="post" enctype="text/plain"><input name="user"><input type="password" name="password"><button>Go</button></form>');
    factory.exchange({ url: '/t', method: 'POST', resourceType: 'document', pageUrl: factory.url('/f'), requestType: 'text/plain', requestBody: 'user=bob\r\npassword=S3cr3t-XYZZY-1\r\n', status: 200, responseType: 'text/plain', responseBody: 'ok' });
    const endpoint = ModelBuilder.create().build(factory.capture()).endpoints.find((item) => item.path === '/t');
    assert.ok(endpoint);
    const value = Samples.requestSample(endpoint).body?.value;
    assert.ok(value instanceof SampleText);
    assert.equal(value.toString(), 'user=bob\r\npassword={{password}}\r\n');
  });

  test('a GET form encodes its query with the form charset', () => {
    const factory = new CaptureFactory('https://cs.example.com');
    const html = '<!doctype html><form action="/find" method="get"><input name="city" value="Z\u00fcrich &#20013;"><button>Go</button></form>';
    factory.exchange({ url: '/f', resourceType: 'document', status: 200, responseHeaders: { 'content-type': 'text/html; charset=windows-1252' }, responseBody: Uint8Array.from(Buffer.from(html, 'latin1')) });
    const endpoint = ModelBuilder.create().build(factory.capture()).endpoints.find((item) => item.path === '/find');
    assert.ok(endpoint);
    assert.equal(endpoint.form?.charset, 'windows-1252');
    assert.equal(Samples.requestSample(endpoint).url.toString(), 'https://cs.example.com/find?city=Z%FCrich+%26%2320013%3B');
  });
});

describe('Schema.sampleValue', () => {
  test('respects bounds, steps, lengths, enums and patterns, and asks for a placeholder when no valid value is known', () => {
    const missing = (name: string): string => `<${name}>`;
    assert.equal(Schema.sampleValue({ type: 'integer', minimum: 13, maximum: 120 }), 13);
    assert.equal(Schema.sampleValue({ type: 'number', exclusiveMinimum: 0, multipleOf: 0.5 }), 0.5);
    assert.equal(Schema.sampleValue({ type: 'integer', maximum: -5 }), -5);
    assert.equal(Schema.sampleValue({ type: 'string', minLength: 6, maxLength: 8 }, 'pw'), 'pwxxxx');
    assert.equal(Schema.sampleValue({ type: 'string', enum: ['', 'us'] }, 'c'), '');
    assert.deepEqual(Schema.sampleValue({ type: 'object', required: ['c'], properties: { c: { type: 'string', enum: ['', 'us'] } } }), { c: 'us' });
    assert.equal(Schema.sampleValue({ type: 'string', 'x-html-type': 'date', 'x-html-min': '2001-02-03' }), '2001-02-03');
    assert.equal(Schema.sampleValue({ type: 'string', pattern: '^[0-9]{5}$' }, 'zip', { missing }), '<zip>');
    assert.equal(Schema.sampleValue({ type: 'string', pattern: '^[0-9]{5}$' }, 'zip'), null);
    assert.equal(Schema.sampleValue({ type: 'string', 'x-html-pattern': '[\\p{N}--[5-9]]{3}' }, 'pin', { missing }), '<pin>');
    assert.deepEqual(Schema.sampleValue({ type: 'array', minItems: 2, items: { type: 'string', enum: ['a', 'b', 'c'] } }), ['a', 'b']);
  });

  test('resolveConditions merges the branch that the instance selects and drops forbidden properties', () => {
    const schema: JsonSchema = {
      type: 'object',
      required: ['go'],
      properties: { a: { type: 'string' }, b: { type: 'string' }, go: { enum: ['x', 'y'] } },
      if: { required: ['go'], properties: { go: { const: 'x' } } },
      then: { required: ['a'], properties: { a: { minLength: 2 }, b: false } },
      else: { if: { required: ['go'], properties: { go: { const: 'y' } } }, then: { required: ['b'] } },
    };
    assert.deepEqual(Schema.resolveConditions(schema, { go: 'x' }), { type: 'object', required: ['go', 'a'], properties: { a: { type: 'string', minLength: 2 }, go: { enum: ['x', 'y'] } } });
    assert.deepEqual(Schema.resolveConditions(schema, { go: 'y' })?.required, ['go', 'b']);
    assert.deepEqual(Schema.resolveConditions(schema, {})?.required, ['go']);
  });
});

describe('CharsetEncoder', () => {
  test('encodes single-byte charsets with the HTML rule for unmappable characters', () => {
    const encoder = CharsetEncoder.for('windows-1252');
    assert.equal(encoder.exact, true);
    assert.deepEqual([...encoder.encode('Z\u00fc\u20ac\u4e2d')], [0x5a, 0xfc, 0x80, ...Buffer.from('&#20013;', 'latin1')]);
    assert.equal(encoder.formComponent('a b+\u00fc*-._~'), 'a+b%2B%FC*-._%7E');
    assert.equal(CharsetEncoder.for('UTF-8').formComponent('\u00fc'), '%C3%BC');
    assert.equal(CharsetEncoder.for(undefined).exact, true);
    assert.equal(CharsetEncoder.for('shift_jis').exact, false);
  });
});
