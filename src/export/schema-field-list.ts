import type { JsonSchema } from '../model/index.js';
import { Schema } from '../shared/index.js';

export interface SchemaField {
  path: string;
  type: string;
  required: boolean;
  requiredWhen?: string[];
  constraints: string[];
  description?: string;
}

export interface SchemaFieldListOptions {
  maxDepth?: number;
  maxRows?: number;
}

export class SchemaFieldList {
  static readonly DEFAULT_MAX_DEPTH = 6;
  static readonly DEFAULT_MAX_ROWS = 200;
  static readonly ROOT = '(body)';

  readonly #maxDepth: number;
  readonly #maxRows: number;

  constructor(options: SchemaFieldListOptions = {}) {
    this.#maxDepth = options.maxDepth ?? SchemaFieldList.DEFAULT_MAX_DEPTH;
    this.#maxRows = options.maxRows ?? SchemaFieldList.DEFAULT_MAX_ROWS;
  }

  rows(schema: JsonSchema | undefined): SchemaField[] {
    if (!schema) return [];
    const out: SchemaField[] = [];
    const properties = Object.keys(Schema.properties(schema));
    const items = Schema.items(schema);
    if (properties.length === 0 && !(items && Object.keys(Schema.properties(items)).length > 0)) {
      out.push(SchemaFieldList.#field(SchemaFieldList.ROOT, schema, true));
      return out;
    }
    this.#walk(schema, '', 0, out);
    const conditional = Schema.requiredWhen(schema);
    for (const field of out) {
      const when = field.required ? undefined : conditional.get(field.path);
      if (when) field.requiredWhen = [...when];
    }
    return out;
  }

  static requiredText(field: Pick<SchemaField, 'required' | 'requiredWhen'>): string {
    if (field.required) return 'yes';
    return field.requiredWhen ? `if ${field.requiredWhen.join(' or ')}` : 'no';
  }

  #walk(schema: JsonSchema, prefix: string, depth: number, out: SchemaField[]): void {
    if (depth > this.#maxDepth) return;
    const container = Schema.primaryType(schema) === 'array' ? (Schema.items(schema) ?? {}) : schema;
    const base = Schema.primaryType(schema) === 'array' ? `${prefix}[]` : prefix;
    const required = Schema.requiredSet(container);
    for (const [name, child] of Object.entries(Schema.properties(container))) {
      if (out.length >= this.#maxRows) return;
      const path = base === '' ? name : `${base}.${name}`;
      out.push(SchemaFieldList.#field(path, child, required.has(name)));
      const nested = Schema.primaryType(child) === 'array' ? Schema.items(child) : child;
      if (nested && Object.keys(Schema.properties(nested)).length > 0) this.#walk(child, path, depth + 1, out);
    }
  }

  static #field(path: string, schema: JsonSchema, required: boolean): SchemaField {
    const field: SchemaField = { path, type: Schema.typeLabel(schema), required, constraints: Schema.constraintSummary(schema) };
    const description = typeof schema.title === 'string' ? schema.title : typeof schema.description === 'string' ? schema.description : undefined;
    if (description !== undefined && description !== '') field.description = description;
    return field;
  }
}
