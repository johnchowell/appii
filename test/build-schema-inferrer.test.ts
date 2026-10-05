import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FormatDetector, SchemaInferrer } from '../src/build/index.js';
import type { JsonSchema } from '../src/model/index.js';
import { Json, Schema } from '../src/shared/index.js';

const inferrer = new SchemaInferrer();

function hasExamples(schema: JsonSchema): boolean {
  let found = false;
  Schema.walkSchema(schema, (node) => {
    if ('examples' in node || 'example' in node) found = true;
  });
  return found;
}

describe('SchemaInferrer.fromExample and infer', () => {
  test('scalars and integer versus number', () => {
    assert.deepEqual(inferrer.fromExample(null), { type: 'null' });
    assert.deepEqual(inferrer.fromExample(true), { type: 'boolean' });
    assert.deepEqual(inferrer.fromExample(3), { type: 'integer' });
    assert.deepEqual(inferrer.fromExample(3.5), { type: 'number' });
    assert.deepEqual(inferrer.fromExample('x'), { type: 'string' });
    assert.deepEqual(inferrer.fromExample(undefined), {});
    assert.deepEqual(inferrer.infer([1, 2.5, 3]), { type: 'number' });
    assert.deepEqual(inferrer.infer([1, 2]), { type: 'integer' });
    assert.deepEqual(inferrer.infer([]), {});
  });

  test('type unions include null and keep structural keywords of each type', () => {
    assert.deepEqual(inferrer.infer(['a', null]), { type: ['string', 'null'] });
    assert.deepEqual(inferrer.infer([1, 'a', true]), { type: ['string', 'integer', 'boolean'] });
    const schema = inferrer.infer([{ a: 1 }, null, [1]]);
    assert.deepEqual(schema, { type: ['object', 'array', 'null'], properties: { a: { type: 'integer' } }, required: ['a'], items: { type: 'integer' } });
  });

  test('required lists the keys present in every object sample, in first-seen order', () => {
    const schema = inferrer.infer([
      { id: 1, name: 'a', tags: ['x'] },
      { id: 2, tags: [], extra: null },
      { tags: ['y', 'z'], id: 3, name: null },
    ]);
    assert.deepEqual(schema, {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        name: { type: ['string', 'null'] },
        tags: { type: 'array', items: { type: 'string' } },
        extra: { type: 'null' },
      },
      required: ['id', 'tags'],
    });
  });

  test('array items are merged across elements and nested objects', () => {
    const schema = inferrer.infer([[{ a: 1, b: 'x' }, { a: 2.5 }], [], [{ a: 3, c: true }]]);
    assert.deepEqual(schema, {
      type: 'array',
      items: { type: 'object', properties: { a: { type: 'number' }, b: { type: 'string' }, c: { type: 'boolean' } }, required: ['a'] },
    });
    assert.deepEqual(inferrer.infer([[]]), { type: 'array' });
    assert.deepEqual(inferrer.infer([{}, { a: 1 }]), { type: 'object', properties: { a: { type: 'integer' } } });
  });

  test('formats are kept only when every string sample matches the same format', () => {
    assert.deepEqual(inferrer.infer(['2026-01-02T03:04:05.000Z', '2026-02-03T04:05:06Z']), { type: 'string', format: 'date-time' });
    assert.deepEqual(inferrer.infer(['2026-01-02T03:04:05.000Z', 'soon']), { type: 'string' });
    assert.deepEqual(inferrer.infer(['2026-01-02', '2025-12-31']), { type: 'string', format: 'date' });
    assert.deepEqual(inferrer.infer(['12:00:00Z']), { type: 'string', format: 'time' });
    assert.deepEqual(inferrer.infer(['a@b.example']), { type: 'string', format: 'email' });
    assert.deepEqual(inferrer.infer(['https://example.com/a?b=1']), { type: 'string', format: 'uri' });
    assert.deepEqual(inferrer.infer(['123e4567-e89b-12d3-a456-426614174000']), { type: 'string', format: 'uuid' });
    assert.deepEqual(inferrer.infer(['192.168.0.1', null]), { type: ['string', 'null'], format: 'ipv4' });
    assert.deepEqual(inferrer.infer(['2026-01-02', '2026-01-02T00:00:00Z']), { type: 'string' });
    assert.deepEqual(inferrer.infer(['']), { type: 'string' });
    assert.deepEqual(new SchemaInferrer({ detectFormats: false }).infer(['2026-01-02']), { type: 'string' });
  });

  test('map-like objects with three or more id keys use additionalProperties', () => {
    const numeric = inferrer.infer([{ '1': { name: 'a' }, '2': { name: 'b', x: 1 }, '30': { name: 'c' } }]);
    assert.deepEqual(numeric, {
      type: 'object',
      propertyNames: { pattern: '^[0-9]+$' },
      additionalProperties: { type: 'object', properties: { name: { type: 'string' }, x: { type: 'integer' } }, required: ['name'] },
    });
    const uuids = inferrer.infer([
      {
        '123e4567-e89b-12d3-a456-426614174000': 1,
        '123e4567-e89b-12d3-a456-426614174001': 2,
        '123e4567-e89b-12d3-a456-426614174002': 3,
      },
    ]);
    assert.deepEqual(uuids, { type: 'object', propertyNames: { format: 'uuid' }, additionalProperties: { type: 'integer' } });
    assert.deepEqual(inferrer.infer([{ '1': 1, '2': 2 }]), { type: 'object', properties: { '1': { type: 'integer' }, '2': { type: 'integer' } }, required: ['1', '2'] });
    assert.ok(!('additionalProperties' in inferrer.infer([{ a: 1, b: 2, c: 3 }])));
  });

  test('a map merged with a small object of id keys stays a map; with other keys it keeps both', () => {
    const map = inferrer.infer([{ '1': 'a', '2': 'b', '3': 'c' }]);
    assert.deepEqual(inferrer.merge(map, inferrer.fromExample({ '4': 5 })), {
      type: 'object',
      propertyNames: { pattern: '^[0-9]+$' },
      additionalProperties: { type: ['string', 'integer'] },
    });
    assert.deepEqual(inferrer.merge(map, inferrer.fromExample({ total: 5 })), {
      type: 'object',
      properties: { total: { type: 'integer' } },
      additionalProperties: { type: 'string' },
    });
    assert.deepEqual(inferrer.merge(map, inferrer.infer([{ '7': 'x', '8': 'y', '9': 'z' }])), map);
  });

  test('schemas never contain examples', () => {
    const schema = inferrer.infer([{ a: [{ b: 'x' }], c: { d: 1 } }, { a: [], c: null }]);
    assert.equal(hasExamples(schema), false);
  });

  test('prototype-like keys are own properties and do not pollute prototypes', () => {
    const value = JSON.parse('{"__proto__":{"polluted":true},"ok":1}') as unknown;
    const schema = inferrer.infer([value, value]);
    const props = schema.properties as Record<string, unknown>;
    assert.ok(Object.hasOwn(props, '__proto__'));
    assert.deepEqual(Object.getOwnPropertyDescriptor(props, '__proto__')?.value, { type: 'object', properties: { polluted: { type: 'boolean' } }, required: ['polluted'] });
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
  });
});

describe('SchemaInferrer.merge', () => {
  test('is pure and order-stable', () => {
    const a = inferrer.fromExample({ x: 1, y: 'a' });
    const b = inferrer.fromExample({ y: 'b', z: true });
    const before = Json.clone([a, b]);
    const merged = inferrer.merge(a, b);
    assert.deepEqual([a, b], before);
    assert.deepEqual(merged, { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'string' }, z: { type: 'boolean' } }, required: ['y'] });
    assert.deepEqual(inferrer.merge({}, b), b);
    assert.notEqual(inferrer.merge({}, b), b);
  });

  test('enums and consts are unioned up to maxEnum and dropped when a side is unconstrained', () => {
    const small = new SchemaInferrer({ maxEnum: 3 });
    assert.deepEqual(small.merge({ type: 'string', const: 'a' }, { type: 'string', const: 'b' }), { type: 'string', enum: ['a', 'b'] });
    assert.deepEqual(small.merge({ type: 'string', const: 'a' }, { type: 'string', const: 'a' }), { type: 'string', const: 'a' });
    assert.deepEqual(small.merge({ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['b', 'c'] }), { type: 'string', enum: ['a', 'b', 'c'] });
    assert.deepEqual(small.merge({ type: 'string', enum: ['a', 'b'] }, { type: 'string', enum: ['c', 'd'] }), { type: 'string' });
    assert.deepEqual(small.merge({ type: 'string', enum: ['a'] }, { type: 'string' }), { type: 'string' });
    assert.deepEqual(small.merge({ type: 'string', enum: ['a'] }, { type: 'null' }), { type: ['string', 'null'] });
  });

  test('keyword constraints are loosened to cover both sides and annotations are kept', () => {
    const merged = inferrer.merge(
      { type: 'string', title: 'Name', minLength: 3, maxLength: 5, pattern: '^a', 'x-html-type': 'text' },
      { type: 'string', minLength: 1, maxLength: 9, pattern: '^b', description: 'd' },
    );
    assert.deepEqual(merged, { title: 'Name', 'x-html-type': 'text', description: 'd', type: 'string', minLength: 1, maxLength: 9 });
    assert.deepEqual(inferrer.merge({ type: 'integer', minimum: 2, maximum: 4 }, { type: 'number', minimum: 0.5 }), { type: 'number', minimum: 0.5 });
    assert.deepEqual(inferrer.merge({ type: 'integer', minimum: 2 }, { type: 'null' }), { type: ['integer', 'null'], minimum: 2 });
    assert.deepEqual(inferrer.merge({ type: 'array', minItems: 1, uniqueItems: true }, { type: 'array', minItems: 2, uniqueItems: true }), {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
    });
    assert.deepEqual(inferrer.merge({ type: 'string', default: 'a' }, { type: 'string', default: 'a' }), { type: 'string', default: 'a' });
    assert.deepEqual(inferrer.merge({ type: 'string', default: 'a' }, { type: 'string', default: 'b' }), { type: 'string' });
  });
});

describe('SchemaInferrer.fromStrings', () => {
  test('types string values as integer, number, boolean or string', () => {
    assert.deepEqual(inferrer.fromStrings(['1', '20', '-3']), { type: 'integer' });
    assert.deepEqual(inferrer.fromStrings(['1', '2.5', '1e3']), { type: 'number' });
    assert.deepEqual(inferrer.fromStrings(['true', 'false']), { type: 'boolean' });
    assert.deepEqual(inferrer.fromStrings(['007']), { type: 'string' });
    assert.deepEqual(inferrer.fromStrings(['1', '']), { type: 'string' });
    assert.deepEqual(inferrer.fromStrings(['TRUE']), { type: 'string' });
    assert.deepEqual(inferrer.fromStrings(['2026-01-01']), { type: 'string', format: 'date' });
    assert.deepEqual(inferrer.fromStrings([]), { type: 'string' });
  });
});

describe('FormatDetector', () => {
  const formats = new FormatDetector();

  test('dates and times follow RFC 3339 exactly', () => {
    assert.equal(FormatDetector.isDate('2024-02-29'), true);
    assert.equal(FormatDetector.isDate('2023-02-29'), false);
    assert.equal(FormatDetector.isDate('2100-02-29'), false);
    assert.equal(FormatDetector.isDate('2000-02-29'), true);
    assert.equal(FormatDetector.isDate('2024-04-31'), false);
    assert.equal(FormatDetector.isDate('2024-13-01'), false);
    assert.equal(FormatDetector.isTime('23:59:60.123+05:30'), true);
    assert.equal(FormatDetector.isTime('24:00:00Z'), false);
    assert.equal(FormatDetector.isTime('12:00'), false);
    assert.equal(FormatDetector.isTime('12:00:00'), false);
    assert.equal(FormatDetector.isDateTime('2026-01-02t03:04:05z'), true);
    assert.equal(FormatDetector.isDateTime('2026-01-02 03:04:05Z'), false);
    assert.equal(FormatDetector.isDateTime('2026-01-02T03:04:05'), false);
    assert.equal(FormatDetector.isDateTime('2026-01-02T03:04:05+25:00'), false);
  });

  test('email, uri, uuid and ipv4', () => {
    assert.equal(FormatDetector.isEmail('first.last+tag@sub.example.co'), true);
    assert.equal(FormatDetector.isEmail('"quoted local"@example.com'), true);
    assert.equal(FormatDetector.isEmail('user@[192.0.2.1]'), true);
    assert.equal(FormatDetector.isEmail('user@localhost'), true);
    assert.equal(FormatDetector.isEmail('a..b@example.com'), false);
    assert.equal(FormatDetector.isEmail('no-at-sign'), false);
    assert.equal(FormatDetector.isEmail('@example.com'), false);
    assert.equal(FormatDetector.isEmail('a@-bad.com'), false);
    assert.equal(FormatDetector.isUri('https://example.com/a%20b?c#d'), true);
    assert.equal(FormatDetector.isUri('file:///etc/hosts'), true);
    assert.equal(FormatDetector.isUri('mailto:a@b.c'), true);
    assert.equal(FormatDetector.isUri('urn:isbn:0451450523'), true);
    assert.equal(FormatDetector.isUri('status:ok'), false);
    assert.equal(FormatDetector.isUri('https://example.com/a b'), false);
    assert.equal(FormatDetector.isUri('https://example.com/%zz'), false);
    assert.equal(FormatDetector.isUri('/relative/path'), false);
    assert.equal(FormatDetector.isUuid('00000000-0000-0000-0000-000000000000'), true);
    assert.equal(FormatDetector.isUuid('123e4567e89b12d3a456426614174000'), false);
    assert.equal(FormatDetector.isIpv4('255.255.255.255'), true);
    assert.equal(FormatDetector.isIpv4('256.1.1.1'), false);
    assert.equal(FormatDetector.isIpv4('01.1.1.1'), false);
  });

  test('detect picks the first matching rule and matches checks one format', () => {
    assert.equal(formats.detect('2026-01-02'), 'date');
    assert.equal(formats.detect('hello'), undefined);
    assert.equal(formats.detect(''), undefined);
    assert.equal(formats.matches('email', 'a@b.c'), true);
    assert.equal(formats.matches('unknown-format', 'x'), false);
    assert.deepEqual(
      FormatDetector.RULES.map((rule) => rule.format),
      ['uuid', 'date-time', 'date', 'time', 'ipv4', 'email', 'uri'],
    );
  });
});
