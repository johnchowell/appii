import type { JsonSchema } from '../model/index.js';
import { isPlainObject, setOwn, stableStringify } from './json.js';
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

export interface SchemaBranch {
  condition: string;
  when: JsonSchema;
  then: JsonSchema;
}

export function branches(schema: JsonSchema | undefined): SchemaBranch[] {
  const out: SchemaBranch[] = [];
  let node = schema;
  while (node && isPlainObject(node.if)) {
    const when = asSchema(node.if);
    const condition = conditionText(when);
    const then = asSchema(node.then);
    if (when && condition && then) out.push({ condition, when, then });
    node = asSchema(node.else);
  }
  return out;
}

export function requiredWhen(schema: JsonSchema | undefined): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const always = requiredSet(schema);
  for (const { condition, then } of branches(schema)) {
    for (const name of requiredSet(then)) {
      if (always.has(name)) continue;
      const list = out.get(name) ?? [];
      if (!list.includes(condition)) list.push(condition);
      out.set(name, list);
    }
  }
  return out;
}

export function conditionText(condition: JsonSchema | undefined): string | undefined {
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

export const FORMAT_SAMPLES: Readonly<Record<string, unknown>> = Object.freeze({
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
});

export const HTML_TYPE_SAMPLES: Readonly<Record<string, string>> = Object.freeze({
  email: 'user@example.com',
  url: 'https://example.com/',
  tel: '+15555550100',
  date: '2024-01-01',
  month: '2024-01',
  week: '2024-W01',
  time: '12:00',
  'datetime-local': '2024-01-01T12:00',
  color: '#000000',
});

export const MAX_SAMPLE_DEPTH = 8;
export const MAX_PATTERN_INPUT = 32;
export const MAX_NAME_SAMPLE = 16;
export const DEFAULT_SAMPLE_NAME = 'value';
export const PADDING = 'x';
export const PATTERN_FLAGS = 'u';
export const HTML_PATTERN = 'x-html-pattern';
export const HTML_PATTERN_FLAGS = 'v';

export interface SampleValueOptions {
  missing?: (name: string) => unknown;
}

export function sampleValue(schema: JsonSchema | undefined, name = '', options: SampleValueOptions = {}): unknown {
  return sampleNode(schema, name, options, 0, false);
}

export function accepts(schema: JsonSchema | boolean | undefined, value: unknown): boolean {
  if (schema === undefined || schema === true) return true;
  if (schema === false) return false;
  if (typeof value === 'object' && value !== null && !Array.isArray(value) && !isPlainObject(value)) return true;
  const types = declaredTypes(schema);
  if (types.length > 0 && !types.some((type) => isType(type, value))) return false;
  if ('const' in schema && !sameJson(schema.const, value)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => sameJson(item, value))) return false;
  if (typeof value === 'string' && !acceptsString(schema, value)) return false;
  if (typeof value === 'number' && !acceptsNumber(schema, value)) return false;
  if (Array.isArray(value) && !acceptsArray(schema, value)) return false;
  if (isPlainObject(value)) {
    for (const required of requiredSet(schema)) if (!Object.hasOwn(value, required)) return false;
    const props = isPlainObject(schema.properties) ? schema.properties : {};
    for (const [key, item] of Object.entries(value)) {
      if (Object.hasOwn(props, key) && !accepts(props[key] as JsonSchema | boolean, item)) return false;
    }
  }
  return true;
}

export function patternMatches(pattern: string, value: string): boolean {
  if ([...value].length > MAX_PATTERN_INPUT) return false;
  try {
    return new RegExp(pattern, PATTERN_FLAGS).test(value);
  } catch {
    return false;
  }
}

export function htmlPatternAccepts(schema: JsonSchema, value: unknown): boolean {
  const pattern = schema[HTML_PATTERN];
  if (typeof pattern !== 'string' || typeof schema.pattern === 'string' || typeof value !== 'string' || value === '') return true;
  if ([...value].length > MAX_PATTERN_INPUT) return false;
  try {
    return new RegExp(`^(?:${pattern})$`, HTML_PATTERN_FLAGS).test(value);
  } catch {
    return true;
  }
}

export function resolveConditions(schema: JsonSchema | undefined, instance: Record<string, unknown>): JsonSchema | undefined {
  if (!schema) return schema;
  let out: JsonSchema = withoutConditions(schema);
  let node: JsonSchema | undefined = schema;
  while (node && node.if !== undefined) {
    const when = node.if === true || node.if === false ? node.if : asSchema(node.if);
    const branch = accepts(when, instance) ? node.then : node.else;
    if (branch === false) return out;
    const next = asSchema(branch);
    if (!next) break;
    out = mergeBranch(out, withoutConditions(next));
    node = next;
  }
  return out;
}

function withoutConditions(schema: JsonSchema): JsonSchema {
  return Object.fromEntries(Object.entries(schema).filter(([key]) => key !== 'if' && key !== 'then' && key !== 'else'));
}

function mergeBranch(base: JsonSchema, branch: JsonSchema): JsonSchema {
  const out: JsonSchema = { ...base };
  const props: Record<string, unknown> = { ...(isPlainObject(base.properties) ? base.properties : {}) };
  const branchProps = isPlainObject(branch.properties) ? branch.properties : {};
  for (const [key, item] of Object.entries(branchProps)) {
    const current = asSchema(props[key]);
    const next = item === false ? false : asSchema(item);
    if (next === undefined) continue;
    setOwn(props, key, next === false ? false : current ? { ...current, ...next } : next);
  }
  const forbidden = new Set(Object.entries(props).filter(([, item]) => item === false).map(([key]) => key));
  out.properties = Object.fromEntries(Object.entries(props).filter(([key]) => !forbidden.has(key)));
  const required = [...new Set([...requiredSet(base), ...requiredSet(branch)])].filter((key) => !forbidden.has(key));
  if (required.length > 0) out.required = required;
  for (const [key, item] of Object.entries(branch)) if (key !== 'properties' && key !== 'required' && !Object.hasOwn(out, key)) setOwn(out, key, item);
  return out;
}

function sampleNode(schema: JsonSchema | undefined, name: string, options: SampleValueOptions, depth: number, required: boolean): unknown {
  if (!schema || depth > MAX_SAMPLE_DEPTH) return null;
  const fixed: unknown[] = [];
  if (Array.isArray(schema.examples) && schema.examples.length > 0) fixed.push(schema.examples[0]);
  if ('const' in schema) fixed.push(schema.const);
  if ('default' in schema) fixed.push(schema.default);
  if (Array.isArray(schema.enum)) {
    const allowed = schema.enum.filter((item) => item !== '' || !required);
    fixed.push(...allowed, ...schema.enum.filter((item) => !allowed.includes(item)));
  }
  for (const candidate of fixed) if (accepts(schema, candidate)) return candidate;
  const vs = variants(schema);
  if (vs.length > 0) return sampleNode(vs[0], name, options, depth + 1, required);
  const type = primaryType(schema);
  if (type === 'object') {
    const req = requiredSet(schema);
    return Object.fromEntries(Object.entries(properties(schema)).map(([key, item]) => [key, sampleNode(item, key, options, depth + 1, req.has(key))]));
  }
  if (type === 'array') return sampleArray(schema, name, options, depth);
  if (type === 'null' || (type === undefined && !hasStringHints(schema))) return null;
  for (const candidate of scalarCandidates(schema, type, name)) if (accepts(schema, candidate) && htmlPatternAccepts(schema, candidate)) return candidate;
  return options.missing ? options.missing(name) : null;
}

function hasStringHints(schema: JsonSchema): boolean {
  return ['x-html-type', 'format', 'pattern', 'minLength', 'maxLength'].some((key) => Object.hasOwn(schema, key));
}

function sampleArray(schema: JsonSchema, name: string, options: SampleValueOptions, depth: number): unknown[] {
  const inner = items(schema);
  const count = Math.max(1, typeof schema.minItems === 'number' ? Math.ceil(schema.minItems) : 1);
  const allowed = Array.isArray(inner?.enum) ? inner.enum.filter((item) => item !== '' && accepts(inner, item)) : [];
  if (allowed.length >= count) return allowed.slice(0, count);
  const item = sampleNode(inner, name, options, depth + 1, true);
  return Array.from({ length: count }, () => item);
}

function scalarCandidates(schema: JsonSchema, type: string | undefined, name: string): unknown[] {
  if (type === 'boolean') return [true, false];
  if (type === 'integer' || type === 'number') return numberCandidates(schema);
  if (type !== 'string' && type !== undefined) return [];
  const out: unknown[] = [];
  const htmlType = typeof schema['x-html-type'] === 'string' ? schema['x-html-type'] : undefined;
  const min = typeof schema['x-html-min'] === 'string' ? schema['x-html-min'] : undefined;
  const max = typeof schema['x-html-max'] === 'string' ? schema['x-html-max'] : undefined;
  const typed = htmlType === undefined ? undefined : HTML_TYPE_SAMPLES[htmlType];
  if (typed !== undefined) out.push(...[min, typed, max].filter((value): value is string => value !== undefined));
  const format = typeof schema.format === 'string' ? FORMAT_SAMPLES[schema.format] : undefined;
  if (format !== undefined) out.push(format);
  out.push(nameSample(schema, name));
  return out;
}

function nameSample(schema: JsonSchema, name: string): string {
  const base = (name.replace(/[^A-Za-z0-9]+/g, '_').toLowerCase().replace(/^_+|_+$/g, '') || DEFAULT_SAMPLE_NAME).slice(0, MAX_NAME_SAMPLE);
  const lengths = (keys: string[]): number[] => keys.map((key) => Number(schema[key])).filter((value) => Number.isInteger(value) && value >= 0);
  const minLength = Math.max(0, ...lengths(['minLength', 'x-html-minlength']));
  const maxLength = Math.min(Number.MAX_SAFE_INTEGER, ...lengths(['maxLength', 'x-html-maxlength']));
  const padded = base.length >= minLength ? base : base.padEnd(minLength, PADDING);
  return padded.slice(0, Math.max(maxLength, 0));
}

function numberCandidates(schema: JsonSchema): number[] {
  const html = (key: string): number | undefined => {
    const raw = schema[key];
    const value = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
    return Number.isFinite(value) ? value : undefined;
  };
  const step = typeof schema.multipleOf === 'number' && schema.multipleOf > 0 ? schema.multipleOf : 1;
  const out: (number | undefined)[] = [];
  const minimum = typeof schema.minimum === 'number' ? schema.minimum : html('x-html-min');
  const maximum = typeof schema.maximum === 'number' ? schema.maximum : html('x-html-max');
  if (minimum !== undefined) out.push(minimum, Math.ceil(minimum / step) * step);
  if (typeof schema.exclusiveMinimum === 'number') out.push(Math.floor(schema.exclusiveMinimum / step) * step + step);
  out.push(1, 0, step);
  if (typeof schema.exclusiveMaximum === 'number') out.push(Math.ceil(schema.exclusiveMaximum / step) * step - step);
  if (maximum !== undefined) out.push(maximum, Math.floor(maximum / step) * step);
  return out.filter((value): value is number => value !== undefined && Number.isFinite(value));
}

function declaredTypes(schema: JsonSchema): string[] {
  if (typeof schema.type === 'string') return [schema.type];
  return Array.isArray(schema.type) ? schema.type.filter((type): type is string => typeof type === 'string') : [];
}

function isType(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a, 0) === stableStringify(b, 0);
}

function acceptsString(schema: JsonSchema, value: string): boolean {
  const length = [...value].length;
  if (typeof schema.minLength === 'number' && length < schema.minLength) return false;
  if (typeof schema.maxLength === 'number' && length > schema.maxLength) return false;
  return typeof schema.pattern !== 'string' || patternMatches(schema.pattern, value);
}

function acceptsNumber(schema: JsonSchema, value: number): boolean {
  if (typeof schema.minimum === 'number' && value < schema.minimum) return false;
  if (typeof schema.maximum === 'number' && value > schema.maximum) return false;
  if (typeof schema.exclusiveMinimum === 'number' && value <= schema.exclusiveMinimum) return false;
  if (typeof schema.exclusiveMaximum === 'number' && value >= schema.exclusiveMaximum) return false;
  if (typeof schema.multipleOf === 'number' && schema.multipleOf > 0) {
    const quotient = value / schema.multipleOf;
    if (Math.abs(quotient - Math.round(quotient)) > 1e-9 * Math.max(1, Math.abs(quotient))) return false;
  }
  return true;
}

function acceptsArray(schema: JsonSchema, value: readonly unknown[]): boolean {
  if (typeof schema.minItems === 'number' && value.length < schema.minItems) return false;
  if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return false;
  if (schema.uniqueItems === true && new Set(value.map((item) => stableStringify(item, 0))).size !== value.length) return false;
  const inner = schema.items;
  return inner === undefined || value.every((item) => accepts(inner as JsonSchema | boolean, item));
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

export function isFileSchema(schema: JsonSchema | undefined): boolean {
  return schema !== undefined && (schema.format === 'binary' || schema['x-html-type'] === 'file' || typeof schema.contentMediaType === 'string');
}

export function isTokenSchema(schema: JsonSchema | undefined): boolean {
  return schema?.['x-appii-token'] === true;
}
