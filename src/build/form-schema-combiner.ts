import type { JsonSchema } from '../model/index.js';
import { Json, Schema } from '../shared/index.js';
import { Helpers } from './helpers.js';

interface Variant {
  readonly schema: JsonSchema;
  readonly properties: ReadonlyMap<string, JsonSchema>;
  readonly required: ReadonlySet<string>;
}

export class FormSchemaCombiner {
  static readonly SUBMIT_TYPE = 'submit';
  static readonly NOVALIDATE = 'x-html-novalidate';
  static readonly HTML_PREFIX = 'x-html-';
  static readonly FIELDS = Schema.VARIANT_FIELDS;
  static readonly ANNOTATION_KEYS: ReadonlySet<string> = new Set([
    'title',
    'description',
    'default',
    'examples',
    'readOnly',
    'writeOnly',
    'deprecated',
    'contentMediaType',
    'contentEncoding',
  ]);
  static readonly LOWER_BOUNDS: ReadonlySet<string> = new Set(['minLength', 'minimum', 'minItems']);
  static readonly UPPER_BOUNDS: ReadonlySet<string> = new Set(['maxLength', 'maximum', 'maxItems']);
  static readonly CHOICE_KEYS: ReadonlySet<string> = new Set(['const', 'enum', 'x-html-labels']);
  static readonly LABELS = 'x-html-labels';

  combine(schemas: readonly JsonSchema[]): JsonSchema {
    const collapsed: JsonSchema[] = [];
    for (const schema of schemas) {
      const twin = collapsed.findIndex((variant) => FormSchemaCombiner.#sameShape(variant, schema));
      if (twin >= 0) collapsed[twin] = FormSchemaCombiner.#merge(collapsed[twin] ?? {}, schema);
      else collapsed.push(Json.clone(schema));
    }
    const [only] = collapsed;
    if (!only) return { type: 'object', properties: {} };
    if (collapsed.length === 1) return only;
    const variants = collapsed.map((schema) => FormSchemaCombiner.#variant(schema));
    const out: JsonSchema = { type: 'object', properties: FormSchemaCombiner.#properties(variants) };
    const required = [...(variants[0]?.required ?? [])].filter((name) => variants.every((variant) => variant.required.has(name)));
    if (required.length > 0) out.required = required;
    if (variants.every((variant) => variant.schema[FormSchemaCombiner.NOVALIDATE] === true)) out[FormSchemaCombiner.NOVALIDATE] = true;
    const conditions = FormSchemaCombiner.#conditions(out, variants);
    if (conditions) Object.assign(out, conditions);
    return out;
  }

  overlay(form: JsonSchema, observed: JsonSchema | undefined): JsonSchema {
    const observedProps = Object.entries(Schema.properties(observed));
    if (!observed || Schema.primaryType(observed) !== 'object' || observedProps.length === 0) return form;
    const formProps = Object.entries(Schema.properties(form));
    const formNames = new Set(formProps.map(([name]) => name));
    const extra = observedProps.filter(([name]) => !formNames.has(name)).map(([name, schema]): [string, JsonSchema] => [name, Json.clone(schema)]);
    const required = Helpers.distinct([...Schema.requiredSet(form), ...[...Schema.requiredSet(observed)].filter((name) => !formNames.has(name))]);
    const { properties: _properties, required: _required, ...rest } = form;
    const out: JsonSchema = { type: 'object', ...rest, properties: Object.fromEntries([...formProps, ...extra]) };
    if (required.length > 0) out.required = required;
    return out;
  }

  static alternatives(existing: JsonSchema, other: JsonSchema): JsonSchema {
    if (!FormSchemaCombiner.#submitter(existing) || !FormSchemaCombiner.#submitter(other) || existing.type !== other.type) return existing;
    const a = FormSchemaCombiner.#values(existing);
    const b = FormSchemaCombiner.#values(other);
    if (!a || !b || ('const' in existing && 'const' in other && Object.is(existing.const, other.const))) return existing;
    const labels = (schema: JsonSchema, count: number): string[] => {
      if (Array.isArray(schema['x-html-labels'])) return schema['x-html-labels'].map(String);
      return Array.from({ length: count }, () => (typeof schema.title === 'string' ? schema.title : ''));
    };
    const enumValues: unknown[] = [];
    const enumLabels: string[] = [];
    const la = labels(existing, a.length);
    const lb = labels(other, b.length);
    [...a, ...b].forEach((value, i) => {
      if (enumValues.some((known) => Object.is(known, value))) return;
      enumValues.push(value);
      enumLabels.push((i < a.length ? la[i] : lb[i - a.length]) ?? '');
    });
    const { const: _const, title: _title, default: _default, ...rest } = existing;
    const merged: JsonSchema = { ...rest, enum: enumValues };
    if (enumLabels.some((label, i) => label !== '' && label !== enumValues[i])) merged['x-html-labels'] = enumLabels;
    else delete merged['x-html-labels'];
    return merged;
  }

  static generalize(schemas: readonly JsonSchema[]): JsonSchema {
    const [first, ...rest] = schemas;
    if (!first) return {};
    if (rest.every((schema) => FormSchemaCombiner.#key(schema) === FormSchemaCombiner.#key(first))) return Json.clone(first);
    if (schemas.every((schema) => FormSchemaCombiner.#submitter(schema) && schema.type === first.type)) {
      return rest.reduce((merged, schema) => FormSchemaCombiner.alternatives(merged, schema), Json.clone(first));
    }
    const out: JsonSchema = {};
    const keys = Helpers.distinct(schemas.flatMap((schema) => Object.keys(schema)));
    for (const key of keys) {
      if (FormSchemaCombiner.CHOICE_KEYS.has(key)) continue;
      const present = schemas.filter((schema) => Object.hasOwn(schema, key)).map((schema) => schema[key]);
      const all = present.length === schemas.length;
      const same = all && present.every((value) => Json.stableStringify(value, 0) === Json.stableStringify(present[0], 0));
      if (same) Json.setOwn(out, key, Json.clone(present[0]));
      else if (key.startsWith(FormSchemaCombiner.HTML_PREFIX)) continue;
      else if (key.startsWith('x-') || FormSchemaCombiner.ANNOTATION_KEYS.has(key)) Json.setOwn(out, key, Json.clone(present[0]));
      else if (all && key === 'type') out.type = FormSchemaCombiner.#types(present);
      else if (all && FormSchemaCombiner.LOWER_BOUNDS.has(key) && present.every((value) => typeof value === 'number')) out[key] = Math.min(...(present as number[]));
      else if (all && FormSchemaCombiner.UPPER_BOUNDS.has(key) && present.every((value) => typeof value === 'number')) out[key] = Math.max(...(present as number[]));
      else if (all && key === 'items' && present.every((value) => Json.isPlainObject(value))) out.items = FormSchemaCombiner.generalize(present as JsonSchema[]);
    }
    const choices = schemas.map((schema) => FormSchemaCombiner.#values(schema));
    if (choices.every((values): values is unknown[] => values !== undefined)) {
      const union: unknown[] = [];
      const labels: string[] = [];
      schemas.forEach((schema, i) => {
        const own = Array.isArray(schema[FormSchemaCombiner.LABELS]) ? (schema[FormSchemaCombiner.LABELS] as unknown[]) : [];
        (choices[i] ?? []).forEach((value, j) => {
          if (union.some((known) => Object.is(known, value))) return;
          union.push(value);
          labels.push(typeof own[j] === 'string' ? own[j] : '');
        });
      });
      if (union.length === 1 && schemas.every((schema) => 'const' in schema)) out.const = union[0];
      else out.enum = union;
      if (labels.some((label, i) => label !== '' && label !== union[i])) out[FormSchemaCombiner.LABELS] = labels;
    }
    return out;
  }

  static #conditions(top: JsonSchema, variants: readonly Variant[]): JsonSchema | undefined {
    const topProps = new Map(Object.entries(Schema.properties(top)));
    const branches: { when: JsonSchema; then: JsonSchema }[] = [];
    for (const variant of variants) {
      const others = variants.filter((other) => other !== variant);
      const when = FormSchemaCombiner.#discriminator(variant, others);
      if (!when) continue;
      branches.push({ when, then: FormSchemaCombiner.#restate(variant, others, topProps) });
    }
    let chain: JsonSchema | undefined;
    for (const branch of branches.reverse()) chain = { if: branch.when, then: branch.then, ...(chain ? { else: chain } : {}) };
    return chain;
  }

  static #discriminator(variant: Variant, others: readonly Variant[]): JsonSchema | undefined {
    const names = [...variant.required].sort((a, b) => Number(FormSchemaCombiner.#submitter(variant.properties.get(b) ?? {})) - Number(FormSchemaCombiner.#submitter(variant.properties.get(a) ?? {})));
    for (const name of names) {
      const own = variant.properties.get(name);
      const values = own ? FormSchemaCombiner.#values(own) : undefined;
      const excluded = others.every((other) => {
        const theirs = other.properties.get(name);
        if (!theirs) return true;
        const known = FormSchemaCombiner.#values(theirs);
        return values !== undefined && known !== undefined && other.required.has(name) && !known.some((value) => values.some((mine) => Object.is(mine, value)));
      });
      if (!excluded) continue;
      const when: JsonSchema = { required: [name] };
      if (values) when.properties = { [name]: values.length === 1 ? { const: values[0] } : { enum: values } };
      return when;
    }
    return undefined;
  }

  static #restate(variant: Variant, others: readonly Variant[], top: ReadonlyMap<string, JsonSchema>): JsonSchema {
    const properties: [string, JsonSchema | boolean][] = [];
    for (const [name, schema] of variant.properties) {
      const shared = top.get(name);
      if (!shared || FormSchemaCombiner.#key(shared) !== FormSchemaCombiner.#key(schema)) properties.push([name, Json.clone(schema)]);
    }
    const foreign = new Set<string>();
    for (const other of others) {
      for (const [name, schema] of other.properties) if (FormSchemaCombiner.#submitter(schema) && !variant.properties.has(name)) foreign.add(name);
    }
    for (const name of foreign) properties.push([name, false]);
    const out: JsonSchema = {};
    if (variant.required.size > 0) out.required = [...variant.required];
    if (properties.length > 0) out.properties = Object.fromEntries(properties);
    if (variant.schema[FormSchemaCombiner.NOVALIDATE] === true) out[FormSchemaCombiner.NOVALIDATE] = true;
    if ([...top.keys()].some((name) => !variant.properties.has(name) && !foreign.has(name))) out[FormSchemaCombiner.FIELDS] = [...variant.properties.keys()];
    return out;
  }

  static #properties(variants: readonly Variant[]): Record<string, JsonSchema> {
    const byName = new Map<string, JsonSchema[]>();
    for (const variant of variants) {
      for (const [name, schema] of variant.properties) byName.set(name, [...(byName.get(name) ?? []), schema]);
    }
    return Object.fromEntries([...byName].map(([name, list]) => [name, FormSchemaCombiner.generalize(list)]));
  }

  static #variant(schema: JsonSchema): Variant {
    return { schema, properties: new Map(Object.entries(Schema.properties(schema))), required: Schema.requiredSet(schema) };
  }

  static #sameShape(a: JsonSchema, b: JsonSchema): boolean {
    const pa = new Map(Object.entries(Schema.properties(a)));
    const pb = new Map(Object.entries(Schema.properties(b)));
    if (pa.size !== pb.size || (a[FormSchemaCombiner.NOVALIDATE] === true) !== (b[FormSchemaCombiner.NOVALIDATE] === true)) return false;
    const ra = Schema.requiredSet(a);
    const rb = Schema.requiredSet(b);
    if (ra.size !== rb.size || [...ra].some((name) => !rb.has(name))) return false;
    for (const [name, left] of pa) {
      const right = pb.get(name);
      if (!right) return false;
      if (FormSchemaCombiner.#key(left) === FormSchemaCombiner.#key(right)) continue;
      if (!FormSchemaCombiner.#submitter(left) || !FormSchemaCombiner.#submitter(right) || left.type !== right.type) return false;
    }
    return true;
  }

  static #merge(a: JsonSchema, b: JsonSchema): JsonSchema {
    const other = new Map(Object.entries(Schema.properties(b)));
    const properties = Object.entries(Schema.properties(a)).map(([name, schema]): [string, JsonSchema] => {
      const twin = other.get(name);
      return [name, twin && FormSchemaCombiner.#key(twin) !== FormSchemaCombiner.#key(schema) ? FormSchemaCombiner.alternatives(schema, twin) : schema];
    });
    return { ...a, properties: Object.fromEntries(properties) };
  }

  static #types(values: readonly unknown[]): unknown {
    const types = Helpers.distinct(values.flatMap((value) => (Array.isArray(value) ? value : [value])).filter((value): value is string => typeof value === 'string'));
    const numeric = (types.includes('number') ? types.filter((type) => type !== 'integer') : types).sort((a, b) => Number(a === 'string') - Number(b === 'string'));
    return numeric.length === 1 ? numeric[0] : numeric;
  }

  static #values(schema: JsonSchema): unknown[] | undefined {
    if ('const' in schema) return [schema.const];
    return Array.isArray(schema.enum) ? schema.enum : undefined;
  }

  static #submitter(schema: JsonSchema): boolean {
    return schema['x-html-type'] === FormSchemaCombiner.SUBMIT_TYPE;
  }

  static #key(schema: JsonSchema): string {
    return Json.stableStringify(schema, 0);
  }
}
