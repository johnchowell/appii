import type { JsonSchema } from '../model/index.js';
import { AppiiError, Schema, Text } from '../shared/index.js';

export interface SchemaTreeRow {
  path: string;
  type: string;
  required: boolean;
  constraints: string;
}

export interface SchemaTreeOptions {
  maxDepth?: number;
}

interface SchemaChild {
  path: string;
  schema: JsonSchema;
  required: boolean;
  passThrough: boolean;
}

export class SchemaTree {
  static readonly DEFAULT_MAX_DEPTH = 6;
  static readonly ROOT = '(root)';
  static readonly ITEMS = '[]';
  static readonly ANY_KEY = '*';
  static readonly QUOTED_KEY: RegExp = /^$|[\s."*\x00-\x1f\x7f]/;
  static readonly SHORT_VALUE = 24;

  readonly #maxDepth: number;

  constructor(options: SchemaTreeOptions = {}) {
    const depth = options.maxDepth ?? SchemaTree.DEFAULT_MAX_DEPTH;
    if (!Number.isInteger(depth) || depth < 1) {
      throw new AppiiError('BAD_INPUT', `SchemaTree maxDepth must be a positive integer (got ${String(depth)})`, { details: { maxDepth: depth } });
    }
    this.#maxDepth = depth;
  }

  static key(name: string): string {
    return SchemaTree.QUOTED_KEY.test(name) ? `[${JSON.stringify(name)}]` : name;
  }

  static join(prefix: string, name: string): string {
    const key = SchemaTree.key(name);
    if (prefix === '') return key;
    return key.startsWith('["') ? prefix + key : `${prefix}.${key}`;
  }

  static constraints(schema: JsonSchema): string[] {
    const parts = Schema.constraintSummary(schema);
    if ('default' in schema && !('const' in schema)) parts.push(`default ${Text.short(schema.default, SchemaTree.SHORT_VALUE)}`);
    if (typeof schema.$ref === 'string') parts.push(`ref ${schema.$ref}`);
    return parts;
  }

  rows(schema: JsonSchema | undefined): SchemaTreeRow[] {
    if (!schema) return [];
    const out: SchemaTreeRow[] = [];
    const seen = new Set<string>();
    if (!SchemaTree.#children(schema, '').some((child) => !child.passThrough)) SchemaTree.#push(out, seen, SchemaTree.ROOT, schema, true);
    this.#descend(schema, '', 1, out, seen, new Set());
    return out;
  }

  #descend(schema: JsonSchema, path: string, depth: number, out: SchemaTreeRow[], seen: Set<string>, ancestors: ReadonlySet<JsonSchema>): void {
    if (ancestors.has(schema)) return;
    const children = SchemaTree.#children(schema, path);
    if (children.length === 0) return;
    if (depth > this.#maxDepth) {
      const last = out[out.length - 1];
      if (last) last.constraints = [last.constraints, `+${children.length} nested`].filter((part) => part !== '').join(', ');
      return;
    }
    const lineage = new Set(ancestors).add(schema);
    for (const child of children) {
      if (child.passThrough) {
        this.#descend(child.schema, child.path, depth, out, seen, lineage);
        continue;
      }
      if (SchemaTree.#push(out, seen, child.path, child.schema, child.required)) this.#descend(child.schema, child.path, depth + 1, out, seen, lineage);
    }
  }

  static #push(out: SchemaTreeRow[], seen: Set<string>, path: string, schema: JsonSchema, required: boolean): boolean {
    if (seen.has(path)) return false;
    seen.add(path);
    out.push({ path, type: Schema.typeLabel(schema), required, constraints: SchemaTree.constraints(schema).join(', ') });
    return true;
  }

  static #children(schema: JsonSchema, path: string, required: ReadonlySet<string> = Schema.requiredSet(schema), visiting: ReadonlySet<JsonSchema> = new Set()): SchemaChild[] {
    const children: SchemaChild[] = [];
    if (visiting.has(schema)) return children;
    for (const [name, child] of Object.entries(Schema.properties(schema))) {
      children.push({ path: SchemaTree.join(path, name), schema: child, required: required.has(name), passThrough: false });
    }
    const extra = Schema.asSchema(schema.additionalProperties);
    if (extra) children.push({ path: path === '' ? SchemaTree.ANY_KEY : `${path}.${SchemaTree.ANY_KEY}`, schema: extra, required: false, passThrough: false });
    const items = Schema.items(schema);
    if (items) {
      const itemPath = path + SchemaTree.ITEMS;
      if (SchemaTree.#hasChildren(items)) children.push({ path: itemPath, schema: items, required: false, passThrough: true });
      else if (SchemaTree.constraints(items).length > 0) children.push({ path: itemPath, schema: items, required: false, passThrough: false });
    }
    const nested = new Set(visiting).add(schema);
    for (const variant of Schema.variants(schema)) {
      for (const child of SchemaTree.#children(variant, path, required, nested)) {
        if (!children.some((existing) => existing.path === child.path)) children.push(child);
      }
    }
    return children;
  }

  static #hasChildren(schema: JsonSchema): boolean {
    return SchemaTree.#isContainer(schema) || Schema.items(schema) !== undefined || Schema.variants(schema).some((variant) => SchemaTree.#isContainer(variant) || Schema.items(variant) !== undefined);
  }

  static #isContainer(schema: JsonSchema): boolean {
    return Object.keys(Schema.properties(schema)).length > 0 || Schema.asSchema(schema.additionalProperties) !== undefined;
  }
}
