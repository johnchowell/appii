import type { JsonSchema } from '../model/index.js';
import { isPlainObject } from './json.js';
import { short } from './text.js';

export function asSchema(value: unknown): JsonSchema | undefined {
  return isPlainObject(value) ? (value as JsonSchema) : undefined;
}

export function schemaTypes(schema: JsonSchema | undefined): string[] {
  if (!schema) return [];
  const t = schema.type;
  if (typeof t === 'string') return [t];
  if (Array.isArray(t)) return t.filter((x): x is string => typeof x === 'string');
  if ('const' in schema) return [jsonType(schema.const)];
  if (Array.isArray(schema.enum)) return [...new Set(schema.enum.map(jsonType))];
  const variants = [...asArray(schema.oneOf), ...asArray(schema.anyOf)];
  if (variants.length) return [...new Set(variants.flatMap((v) => schemaTypes(asSchema(v))))];
  if (schema.properties) return ['object'];
  if (schema.items) return ['array'];
  return [];
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function jsonType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

export function isNullable(schema: JsonSchema | undefined): boolean {
  return schemaTypes(schema).includes('null');
}

export function primaryType(schema: JsonSchema | undefined): string | undefined {
  return schemaTypes(schema).find((t) => t !== 'null');
}

export function properties(schema: JsonSchema | undefined): Record<string, JsonSchema> {
  const props = schema?.properties;
  if (!isPlainObject(props)) return {};
  return Object.fromEntries(
    Object.entries(props).flatMap(([k, v]): [string, JsonSchema][] => {
      const s = asSchema(v);
      return s ? [[k, s]] : [];
    }),
  );
}

export function requiredSet(schema: JsonSchema | undefined): Set<string> {
  const req = schema?.required;
  return new Set(Array.isArray(req) ? req.filter((x): x is string => typeof x === 'string') : []);
}

export function items(schema: JsonSchema | undefined): JsonSchema | undefined {
  return asSchema(schema?.items);
}

export function variants(schema: JsonSchema | undefined): JsonSchema[] {
  if (!schema) return [];
  return [...asArray(schema.oneOf), ...asArray(schema.anyOf)].map(asSchema).filter((s): s is JsonSchema => !!s);
}

export const ENUM_VALUE = 16;
export const EMPTY_STRING = '""';

export function displayValue(value: unknown, max?: number): string {
  return value === '' ? EMPTY_STRING : short(value, max);
}

export function requiredWhen(schema: JsonSchema | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const always = requiredSet(schema);
  let node = schema;
  while (node && isPlainObject(node.if)) {
    const condition = conditionText(asSchema(node.if));
    const then = asSchema(node.then);
    if (condition && then) {
      for (const name of requiredSet(then)) {
        if (always.has(name)) continue;
        const list = out.get(name) ?? [];
        if (!list.includes(condition)) list.push(condition);
        out.set(name, list);
      }
    }
    node = asSchema(node.else);
  }
  return out;
}

function conditionText(condition: JsonSchema | undefined): string | undefined {
  const [name] = [...requiredSet(condition)];
  if (name === undefined) return undefined;
  const value = properties(condition)[name];
  if (value && 'const' in value) return `${name}=${String(value.const)}`;
  if (value && Array.isArray(value.enum) && value.enum.length > 0) return `${name}=${value.enum.map(String).join('|')}`;
  return `${name} is sent`;
}

export function emptyStringOnly(schema: JsonSchema | undefined): boolean {
  return schema !== undefined && schema.maxLength === 0 && schemaTypes(schema).includes('string');
}

export function typeLabel(schema: JsonSchema | undefined): string {
  if (!schema) return 'any';
  if ('const' in schema) return `const ${displayValue(schema.const)}`;
  if (Array.isArray(schema.enum)) return `enum(${schema.enum.length})`;
  const types = schemaTypes(schema);
  if (types.length === 0) return 'any';
  return types
    .map((t) => {
      if (t === 'array') {
        const inner = items(schema);
        return inner ? `array<${typeLabel(inner)}>` : 'array';
      }
      if (t === 'string' && typeof schema.format === 'string') return `string(${schema.format})`;
      if (t === 'string' && emptyStringOnly(schema)) return 'empty';
      return t;
    })
    .join('|');
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

export function constraintSummary(schema: JsonSchema | undefined): string[] {
  if (!schema) return [];
  const out: string[] = [];
  const htmlType = str(schema['x-html-type']);
  if (htmlType && !['text', 'textarea', 'select-one', 'select-multiple'].includes(htmlType)) out.push(`html ${htmlType}`);
  if (typeof schema.format === 'string') out.push(`format ${schema.format}`);
  const pattern = str(schema['x-html-pattern']) ?? str(schema.pattern);
  if (pattern) out.push(`pattern ${pattern}`);
  const minLen = str(schema['x-html-minlength']) ?? str(schema.minLength);
  const maxLen = str(schema['x-html-maxlength']) ?? (emptyStringOnly(schema) ? undefined : str(schema.maxLength));
  if (minLen !== undefined || maxLen !== undefined) out.push(`length ${minLen ?? '0'}..${maxLen ?? ''}`);
  const min = str(schema['x-html-min']) ?? str(schema.minimum);
  const max = str(schema['x-html-max']) ?? str(schema.maximum);
  if (min !== undefined || max !== undefined) out.push(`range ${min ?? ''}..${max ?? ''}`);
  const step = str(schema['x-html-step']) ?? str(schema.multipleOf);
  if (step !== undefined) out.push(`step ${step}`);
  if (Array.isArray(schema.enum)) out.push(`one of ${schema.enum.map((v) => displayValue(v, ENUM_VALUE)).join('|')}`);
  if ('const' in schema) out.push(`always ${displayValue(schema.const)}`);
  if (schema.minItems !== undefined || schema.maxItems !== undefined) out.push(`items ${str(schema.minItems) ?? '0'}..${str(schema.maxItems) ?? ''}`);
  if (schema['x-appii-token'] === true) out.push('token');
  if (schema.readOnly === true && schema['x-appii-token'] !== true) out.push('read-only');
  return out;
}

const FORMAT_SAMPLES: Record<string, unknown> = {
  email: 'user@example.com',
  uri: 'https://example.com/',
  url: 'https://example.com/',
  'uri-reference': '/path',
  uuid: '123e4567-e89b-12d3-a456-426614174000',
  date: '2024-01-01',
  'date-time': '2024-01-01T00:00:00.000Z',
  time: '12:00',
  ipv4: '192.0.2.1',
  ipv6: '2001:db8::1',
  hostname: 'example.com',
  binary: '',
};

export function sampleValue(schema: JsonSchema | undefined, name = '', depth = 0): unknown {
  if (!schema || depth > 8) return null;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if ('const' in schema) return schema.const;
  if ('default' in schema) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  const vs = variants(schema);
  if (vs.length) return sampleValue(vs[0], name, depth + 1);
  const type = primaryType(schema);
  switch (type) {
    case 'object':
      return Object.fromEntries(Object.entries(properties(schema)).map(([k, v]) => [k, sampleValue(v, k, depth + 1)]));
    case 'array':
      return [sampleValue(items(schema), name, depth + 1)];
    case 'integer': {
      const min = typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : undefined;
      return min ?? 1;
    }
    case 'number':
      return typeof schema.minimum === 'number' ? schema.minimum : 1;
    case 'boolean':
      return true;
    case 'null':
      return null;
    case 'string': {
      const format = typeof schema.format === 'string' ? schema.format : undefined;
      if (format && format in FORMAT_SAMPLES) return FORMAT_SAMPLES[format];
      const minLength = typeof schema.minLength === 'number' ? schema.minLength : 0;
      const base = name ? name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase() || 'value' : 'value';
      return base.length >= minLength ? base : base.padEnd(minLength, 'x');
    }
    default:
      return null;
  }
}

export function walkSchema(schema: JsonSchema | undefined, visit: (node: JsonSchema, path: string[]) => void, path: string[] = []): void {
  if (!schema) return;
  visit(schema, path);
  for (const [k, v] of Object.entries(properties(schema))) walkSchema(v, visit, [...path, k]);
  const inner = items(schema);
  if (inner) walkSchema(inner, visit, [...path, '[]']);
  variants(schema).forEach((v, i) => walkSchema(v, visit, [...path, `|${i}`]));
  const extra = asSchema(schema.additionalProperties);
  if (extra) walkSchema(extra, visit, [...path, '*']);
}

export function isTokenSchema(schema: JsonSchema | undefined): boolean {
  return schema?.['x-appii-token'] === true;
}
