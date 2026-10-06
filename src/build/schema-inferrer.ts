import type { JsonSchema } from '../model/index.js';
import { Json, Schema } from '../shared/index.js';
import { FormatDetector } from './format-detector.js';

export interface SchemaInferrerOptions {
  maxEnum?: number;
  detectFormats?: boolean;
}

export interface SchemaInferrerDeps {
  formats?: FormatDetector;
}

export interface MapKeyRule {
  pattern: RegExp;
  propertyNames: JsonSchema;
}

type Combine = 'equal' | 'min' | 'max' | 'both-true';

export class SchemaInferrer {
  static readonly DEFAULT_MAX_ENUM = 50;
  static readonly MIN_MAP_KEYS = 3;
  static readonly MAP_KEY_RULES: readonly MapKeyRule[] = [
    { pattern: /^[0-9]+$/, propertyNames: { pattern: '^[0-9]+$' } },
    { pattern: /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/, propertyNames: { format: 'uuid' } },
  ];
  static readonly TYPE_ORDER: readonly string[] = ['object', 'array', 'string', 'integer', 'number', 'boolean', 'null'];
  static readonly INTEGER: RegExp = /^-?(?:0|[1-9][0-9]*)$/;
  static readonly NUMBER: RegExp = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
  static readonly BOOLEANS: ReadonlySet<string> = new Set(['true', 'false']);
  static readonly ANNOTATIONS: ReadonlySet<string> = new Set(['title', 'description', '$comment']);
  static readonly OBSERVED_KEY = 'x-appii-observed';
  static readonly NULL_TYPE = 'null';
  static readonly STRING_KEYWORDS: Readonly<Record<string, Combine>> = {
    format: 'equal',
    pattern: 'equal',
    minLength: 'min',
    maxLength: 'max',
    contentMediaType: 'equal',
    contentEncoding: 'equal',
  };
  static readonly NUMBER_KEYWORDS: Readonly<Record<string, Combine>> = {
    minimum: 'min',
    maximum: 'max',
    exclusiveMinimum: 'min',
    exclusiveMaximum: 'max',
    multipleOf: 'equal',
  };
  static readonly ARRAY_KEYWORDS: Readonly<Record<string, Combine>> = { minItems: 'min', maxItems: 'max', uniqueItems: 'both-true' };
  static readonly HANDLED: ReadonlySet<string> = new Set([
    'type',
    'enum',
    'const',
    'properties',
    'required',
    'additionalProperties',
    'propertyNames',
    'items',
    ...Object.keys(SchemaInferrer.STRING_KEYWORDS),
    ...Object.keys(SchemaInferrer.NUMBER_KEYWORDS),
    ...Object.keys(SchemaInferrer.ARRAY_KEYWORDS),
  ]);

  readonly #maxEnum: number;
  readonly #detectFormats: boolean;
  readonly #formats: FormatDetector;

  constructor(options: SchemaInferrerOptions = {}, deps: SchemaInferrerDeps = {}) {
    this.#maxEnum = options.maxEnum ?? SchemaInferrer.DEFAULT_MAX_ENUM;
    this.#detectFormats = options.detectFormats ?? true;
    this.#formats = deps.formats ?? new FormatDetector();
  }

  static create(options: SchemaInferrerOptions = {}): SchemaInferrer {
    return new SchemaInferrer(options, { formats: new FormatDetector() });
  }

  infer(samples: unknown[]): JsonSchema {
    let out: JsonSchema | undefined;
    for (const sample of samples) {
      const schema = this.fromExample(sample);
      out = out === undefined ? schema : this.merge(out, schema);
    }
    return out ?? {};
  }

  fromExample(value: unknown): JsonSchema {
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) {
      const schema: JsonSchema = { type: 'array' };
      const items = this.infer(value);
      if (!SchemaInferrer.#isEmpty(items)) schema.items = items;
      return schema;
    }
    switch (typeof value) {
      case 'boolean':
        return { type: 'boolean' };
      case 'bigint':
        return { type: 'integer' };
      case 'number':
        return Number.isFinite(value) ? { type: Number.isInteger(value) ? 'integer' : 'number' } : {};
      case 'string':
        return this.#string([value]);
      case 'object':
        return Json.isPlainObject(value) ? this.#object(value) : {};
      default:
        return {};
    }
  }

  fromStrings(values: readonly string[]): JsonSchema {
    if (values.length === 0) return { type: 'string' };
    if (values.every((value) => SchemaInferrer.INTEGER.test(value))) return { type: 'integer' };
    if (values.every((value) => SchemaInferrer.NUMBER.test(value))) return { type: 'number' };
    if (values.every((value) => SchemaInferrer.BOOLEANS.has(value))) return { type: 'boolean' };
    return this.#string(values);
  }

  finalize(schema: JsonSchema): JsonSchema {
    return SchemaInferrer.#finalNode(Json.clone(schema));
  }

  static isObservedNull(schema: JsonSchema): boolean {
    const keys = Object.keys(schema);
    return keys.length === 1 && schema[SchemaInferrer.OBSERVED_KEY] === SchemaInferrer.NULL_TYPE;
  }

  merge(left: JsonSchema, right: JsonSchema): JsonSchema {
    const a = SchemaInferrer.#restore(left);
    const b = SchemaInferrer.#restore(right);
    if (SchemaInferrer.#isEmpty(a)) return Json.clone(b);
    if (SchemaInferrer.#isEmpty(b)) return Json.clone(a);
    const ta = new Set(Schema.schemaTypes(a));
    const tb = new Set(Schema.schemaTypes(b));
    const types = SchemaInferrer.#normalizeTypes([...ta, ...tb]);
    const out: JsonSchema = {};
    SchemaInferrer.#annotations(out, a, b);
    if (types.length === 1) out.type = types[0];
    else if (types.length > 1) out.type = types;
    this.#mergeEnum(out, a, b);
    if (types.includes('string')) SchemaInferrer.#keywords(out, a, b, ta.has('string'), tb.has('string'), SchemaInferrer.STRING_KEYWORDS);
    if (types.includes('number') || types.includes('integer')) {
      const numeric = (set: Set<string>) => set.has('number') || set.has('integer');
      SchemaInferrer.#keywords(out, a, b, numeric(ta), numeric(tb), SchemaInferrer.NUMBER_KEYWORDS);
    }
    if (types.includes('object')) this.#mergeObject(out, a, b, ta.has('object'), tb.has('object'));
    if (types.includes('array')) this.#mergeArray(out, a, b, ta.has('array'), tb.has('array'));
    for (const [key, value] of Object.entries(a)) {
      if (key in out || SchemaInferrer.HANDLED.has(key) || !(key in b)) continue;
      if (Json.stableStringify(value, 0) === Json.stableStringify(b[key], 0)) out[key] = Json.clone(value);
    }
    return out;
  }

  #string(values: readonly string[]): JsonSchema {
    const schema: JsonSchema = { type: 'string' };
    if (!this.#detectFormats || values.length === 0) return schema;
    const format = this.#formats.detect(values[0] ?? '');
    if (format && values.every((value) => this.#formats.matches(format, value))) schema.format = format;
    return schema;
  }

  #object(value: Record<string, unknown>): JsonSchema {
    const keys = Object.keys(value);
    const rule = SchemaInferrer.#mapRule(keys);
    if (rule) {
      const schema: JsonSchema = { type: 'object', propertyNames: Json.clone(rule.propertyNames) };
      const values = this.infer(Object.values(value));
      schema.additionalProperties = SchemaInferrer.#isEmpty(values) ? true : values;
      return schema;
    }
    const schema: JsonSchema = {
      type: 'object',
      properties: Object.fromEntries(keys.map((key) => [key, this.fromExample(value[key])])),
    };
    if (keys.length > 0) schema.required = keys;
    return schema;
  }

  #mergeEnum(out: JsonSchema, a: JsonSchema, b: JsonSchema): void {
    const va = SchemaInferrer.#enumValues(a);
    const vb = SchemaInferrer.#enumValues(b);
    if (!va || !vb) return;
    const values: unknown[] = [];
    const seen = new Set<string>();
    for (const value of [...va, ...vb]) {
      const key = Json.stableStringify(value, 0);
      if (seen.has(key)) continue;
      seen.add(key);
      values.push(Json.clone(value));
    }
    if (values.length > this.#maxEnum) return;
    if (values.length === 1 && 'const' in a && 'const' in b) out.const = values[0];
    else out.enum = values;
  }

  #mergeObject(out: JsonSchema, a: JsonSchema, b: JsonSchema, inA: boolean, inB: boolean): void {
    if (!inA || !inB) {
      SchemaInferrer.#copyObject(out, inA ? a : b);
      return;
    }
    const aMap = SchemaInferrer.#isMap(a);
    const bMap = SchemaInferrer.#isMap(b);
    if (aMap && bMap) {
      out.additionalProperties = this.#mergeLoose(a.additionalProperties, b.additionalProperties);
      if (Json.stableStringify(a.propertyNames, 0) === Json.stableStringify(b.propertyNames, 0) && a.propertyNames !== undefined) {
        out.propertyNames = Json.clone(a.propertyNames);
      }
      return;
    }
    if (aMap || bMap) {
      const map = aMap ? a : b;
      const regular = aMap ? b : a;
      const props = Object.entries(Schema.properties(regular));
      const rule = SchemaInferrer.MAP_KEY_RULES.find((candidate) => Json.stableStringify(candidate.propertyNames, 0) === Json.stableStringify(map.propertyNames, 0));
      if (rule && props.every(([key]) => rule.pattern.test(key))) {
        out.propertyNames = Json.clone(rule.propertyNames);
        out.additionalProperties = props.reduce<unknown>((acc, [, schema]) => this.#mergeLoose(acc, schema), map.additionalProperties);
        return;
      }
      out.properties = Object.fromEntries(props.map(([key, schema]) => [key, Json.clone(schema)]));
      out.additionalProperties = Json.clone(map.additionalProperties);
      return;
    }
    const pa = new Map(Object.entries(Schema.properties(a)));
    const pb = new Map(Object.entries(Schema.properties(b)));
    const keys = [...pa.keys(), ...[...pb.keys()].filter((key) => !pa.has(key))];
    out.properties = Object.fromEntries(
      keys.map((key) => {
        const left = pa.get(key);
        const right = pb.get(key);
        const merged = left && right ? this.merge(left, right) : Json.clone((left ?? right) as JsonSchema);
        return [key, merged];
      }),
    );
    const rb = Schema.requiredSet(b);
    const required = [...Schema.requiredSet(a)].filter((key) => rb.has(key));
    if (required.length > 0) out.required = required;
    if (a.additionalProperties !== undefined && Json.stableStringify(a.additionalProperties, 0) === Json.stableStringify(b.additionalProperties, 0)) {
      out.additionalProperties = Json.clone(a.additionalProperties);
    }
  }

  #mergeArray(out: JsonSchema, a: JsonSchema, b: JsonSchema, inA: boolean, inB: boolean): void {
    if (!inA || !inB) {
      const source = inA ? a : b;
      if (source.items !== undefined) out.items = Json.clone(source.items);
      SchemaInferrer.#keywords(out, source, source, true, false, SchemaInferrer.ARRAY_KEYWORDS);
      return;
    }
    const ia = Schema.items(a);
    const ib = Schema.items(b);
    if (ia && ib) out.items = this.merge(ia, ib);
    else if (ia || ib) out.items = Json.clone((ia ?? ib) as JsonSchema);
    SchemaInferrer.#keywords(out, a, b, true, true, SchemaInferrer.ARRAY_KEYWORDS);
  }

  #mergeLoose(a: unknown, b: unknown): unknown {
    if (a === undefined) return Json.clone(b);
    if (b === undefined) return Json.clone(a);
    const sa = Schema.asSchema(a);
    const sb = Schema.asSchema(b);
    if (sa && sb) return this.merge(sa, sb);
    if (a === false) return Json.clone(b);
    if (b === false) return Json.clone(a);
    return true;
  }

  static #copyObject(out: JsonSchema, source: JsonSchema): void {
    for (const key of ['properties', 'required', 'additionalProperties', 'propertyNames']) {
      if (source[key] !== undefined) out[key] = Json.clone(source[key]);
    }
  }

  static #keywords(out: JsonSchema, a: JsonSchema, b: JsonSchema, inA: boolean, inB: boolean, table: Readonly<Record<string, Combine>>): void {
    for (const [key, combine] of Object.entries(table)) {
      if (!inA || !inB) {
        const source = inA ? a : b;
        if (source[key] !== undefined) out[key] = Json.clone(source[key]);
        continue;
      }
      const va = a[key];
      const vb = b[key];
      if (va === undefined || vb === undefined) continue;
      if (combine === 'equal') {
        if (Json.stableStringify(va, 0) === Json.stableStringify(vb, 0)) out[key] = Json.clone(va);
      } else if (combine === 'both-true') {
        if (va === true && vb === true) out[key] = true;
      } else if (typeof va === 'number' && typeof vb === 'number') {
        out[key] = combine === 'min' ? Math.min(va, vb) : Math.max(va, vb);
      }
    }
  }

  static #annotations(out: JsonSchema, a: JsonSchema, b: JsonSchema): void {
    for (const source of [a, b]) {
      for (const [key, value] of Object.entries(source)) {
        if (key in out) continue;
        if (SchemaInferrer.ANNOTATIONS.has(key) || key.startsWith('x-')) out[key] = Json.clone(value);
      }
    }
  }

  static #enumValues(schema: JsonSchema): unknown[] | undefined {
    if ('const' in schema) return [schema.const];
    return Array.isArray(schema.enum) ? schema.enum : undefined;
  }

  static #normalizeTypes(types: readonly string[]): string[] {
    const set = new Set(types);
    if (set.has('number')) set.delete('integer');
    const known = SchemaInferrer.TYPE_ORDER.filter((type) => set.has(type));
    return [...known, ...[...set].filter((type) => !SchemaInferrer.TYPE_ORDER.includes(type)).sort()];
  }

  static #mapRule(keys: readonly string[]): MapKeyRule | undefined {
    if (keys.length < SchemaInferrer.MIN_MAP_KEYS) return undefined;
    return SchemaInferrer.MAP_KEY_RULES.find((rule) => keys.every((key) => rule.pattern.test(key)));
  }

  static #isMap(schema: JsonSchema): boolean {
    return schema.additionalProperties !== undefined && schema.propertyNames !== undefined && Object.entries(Schema.properties(schema)).length === 0;
  }

  static #isEmpty(schema: JsonSchema): boolean {
    return Object.keys(schema).length === 0;
  }

  static #nullOnly(schema: JsonSchema): boolean {
    const type = schema.type;
    const only = type === SchemaInferrer.NULL_TYPE || (Array.isArray(type) && type.length === 1 && type[0] === SchemaInferrer.NULL_TYPE);
    return only && Object.keys(schema).length === 1;
  }

  static #restore(schema: JsonSchema): JsonSchema {
    return SchemaInferrer.isObservedNull(schema) ? { type: SchemaInferrer.NULL_TYPE } : schema;
  }

  static #finalNode(node: JsonSchema): JsonSchema {
    if (SchemaInferrer.#nullOnly(node)) return { [SchemaInferrer.OBSERVED_KEY]: SchemaInferrer.NULL_TYPE };
    const properties = node.properties;
    if (Json.isPlainObject(properties)) {
      for (const [key, child] of Object.entries(properties)) if (Json.isPlainObject(child)) Json.setOwn(properties, key, SchemaInferrer.#finalNode(child));
    }
    for (const key of ['items', 'additionalProperties']) {
      const child = node[key];
      if (Json.isPlainObject(child)) Json.setOwn(node, key, SchemaInferrer.#finalNode(child));
    }
    return node;
  }
}
