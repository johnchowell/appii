import type { JsonSchema } from '../model/index.js';
import { AppiiError, Json, Schema } from '../shared/index.js';

export interface SchemaTreeRow {
  path: string;
  type: string;
  required: boolean;
  requiredWhen?: string[];
  constraints: string;
}

export interface SchemaTreeBranch {
  condition: string;
  label?: string;
  requires: string[];
  excluded: string[];
  noValidate: boolean;
  rows: SchemaTreeRow[];
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
  static readonly NOVALIDATE = 'x-html-novalidate';
  static readonly ALTERNATIVE = '|';

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
    if ('default' in schema && !('const' in schema)) parts.push(`default ${Schema.displayValue(schema.default, SchemaTree.SHORT_VALUE)}`);
    if (typeof schema.$ref === 'string') parts.push(`ref ${schema.$ref}`);
    return parts;
  }

  rows(schema: JsonSchema | undefined): SchemaTreeRow[] {
    if (!schema) return [];
    const out: SchemaTreeRow[] = [];
    const seen = new Set<string>();
    if (!SchemaTree.#children(schema, '').some((child) => !child.passThrough)) SchemaTree.#push(out, seen, SchemaTree.ROOT, schema, true);
    this.#descend(schema, '', 1, out, seen, new Set());
    const conditional = Schema.requiredWhen(schema);
    for (const row of out) {
      const when = row.required ? undefined : conditional.get(row.path);
      if (when && SchemaTree.key(row.path) === row.path) row.requiredWhen = [...when];
    }
    return out;
  }

  static alternatives(schema: JsonSchema | undefined): string[][] {
    let groups: Set<string>[] = [];
    for (const { when, then } of Schema.branches(schema)) {
      const excluded = SchemaTree.#excluded(then);
      if (excluded.length === 0) continue;
      const members = new Set([...Schema.requiredSet(when), ...excluded]);
      const overlapping = groups.filter((group) => [...group].some((name) => members.has(name)));
      groups = [...groups.filter((group) => !overlapping.includes(group)), new Set([...overlapping.flatMap((group) => [...group]), ...members])];
    }
    return groups.map((group) => [...group]);
  }

  static fieldNames(schema: JsonSchema | undefined): string[] {
    const names = Object.keys(Schema.properties(schema));
    const groups = SchemaTree.alternatives(schema);
    const emitted = new Set<string[]>();
    const out: string[] = [];
    for (const name of names) {
      const group = groups.find((candidate) => candidate.includes(name));
      if (!group) {
        out.push(name);
        continue;
      }
      if (emitted.has(group)) continue;
      emitted.add(group);
      out.push(names.filter((member) => group.includes(member)).join(SchemaTree.ALTERNATIVE));
    }
    return out;
  }

  branches(schema: JsonSchema | undefined): SchemaTreeBranch[] {
    const always = Schema.requiredSet(schema);
    return Schema.branches(schema).map(({ condition, when, then }) => {
      const keys = Schema.requiredSet(when);
      const properties = Schema.properties(then);
      const shown = Object.entries(properties).filter(([name]) => !keys.has(name));
      const required = [...Schema.requiredSet(then)];
      const branch: SchemaTreeBranch = {
        condition,
        requires: required.filter((name) => !always.has(name) && !keys.has(name)),
        excluded: SchemaTree.#excluded(then),
        noValidate: then[SchemaTree.NOVALIDATE] === true,
        rows: shown.length === 0 ? [] : this.rows({ type: 'object', properties: Object.fromEntries(shown), required: required.filter((name) => Object.hasOwn(properties, name)) }),
      };
      const label = [...keys].map((name) => properties[name]?.title).find((title): title is string => typeof title === 'string' && title !== '');
      if (label !== undefined) branch.label = label;
      return branch;
    });
  }

  static #excluded(then: JsonSchema): string[] {
    const declared = Json.isPlainObject(then.properties) ? Object.entries(then.properties) : [];
    return declared.filter(([, value]) => value === false).map(([name]) => name);
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
