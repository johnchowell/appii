import type { JsonSchema } from '../model/index.js';
import { Json, Schema, Text } from '../shared/index.js';

export interface TsTypeWriterOptions {
  indent?: string;
  maxDepth?: number;
}

export class TsTypeWriter {
  static readonly DEFAULT_INDENT = '  ';
  static readonly DEFAULT_MAX_DEPTH = 12;
  static readonly UNKNOWN = 'unknown';

  readonly #indent: string;
  readonly #maxDepth: number;

  constructor(options: TsTypeWriterOptions = {}) {
    this.#indent = options.indent ?? TsTypeWriter.DEFAULT_INDENT;
    this.#maxDepth = options.maxDepth ?? TsTypeWriter.DEFAULT_MAX_DEPTH;
  }

  type(schema: JsonSchema | undefined): string {
    return this.#type(schema, 0);
  }

  declaration(name: string, schema: JsonSchema | undefined): string {
    if (schema && TsTypeWriter.#isPlainObject(schema)) return `export interface ${name} ${this.#object(schema, 0)}`;
    return `export type ${name} = ${this.#type(schema, 0)};`;
  }

  static literal(value: unknown): string {
    if (typeof value === 'string') return Text.jsString(value);
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'number';
    if (typeof value === 'boolean') return String(value);
    if (value === null) return 'null';
    return TsTypeWriter.UNKNOWN;
  }

  static union(types: readonly string[]): string {
    const distinct = [...new Set(types)];
    if (distinct.includes(TsTypeWriter.UNKNOWN)) return TsTypeWriter.UNKNOWN;
    if (distinct.length === 0) return 'never';
    return distinct.join(' | ');
  }

  static wrap(type: string): string {
    return TsTypeWriter.#topLevel(type, '|') || TsTypeWriter.#topLevel(type, '&') ? `(${type})` : type;
  }

  #type(schema: JsonSchema | undefined, depth: number): string {
    if (!schema || !Json.isPlainObject(schema) || depth > this.#maxDepth) return TsTypeWriter.UNKNOWN;
    const nullable = schema.nullable === true;
    const base = this.#base(schema, depth);
    return nullable && base !== TsTypeWriter.UNKNOWN ? TsTypeWriter.union([base, 'null']) : base;
  }

  #base(schema: JsonSchema, depth: number): string {
    if ('const' in schema) return TsTypeWriter.literal(schema.const);
    if (Array.isArray(schema.enum)) return TsTypeWriter.union(schema.enum.map((value) => TsTypeWriter.literal(value)));
    const alternatives = [...(Array.isArray(schema.oneOf) ? schema.oneOf : []), ...(Array.isArray(schema.anyOf) ? schema.anyOf : [])];
    if (alternatives.length > 0) {
      return TsTypeWriter.union(alternatives.map((variant) => this.#type(Schema.asSchema(variant), depth)));
    }
    if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
      const parts = schema.allOf.map((part) => this.#type(Schema.asSchema(part), depth)).filter((part) => part !== TsTypeWriter.UNKNOWN);
      return parts.length === 0 ? TsTypeWriter.UNKNOWN : [...new Set(parts)].map((part) => TsTypeWriter.wrap(part)).join(' & ');
    }
    const declared = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((t): t is string => typeof t === 'string') : [];
    const types = declared.length > 0 ? declared : Schema.schemaTypes(schema);
    if (types.length === 0) return TsTypeWriter.UNKNOWN;
    return TsTypeWriter.union(types.map((type) => this.#named(type, schema, depth)));
  }

  #named(type: string, schema: JsonSchema, depth: number): string {
    switch (type) {
      case 'string':
        return schema.format === 'binary' ? 'Blob' : 'string';
      case 'integer':
      case 'number':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'array':
        return this.#array(schema, depth);
      case 'object':
        return this.#object(schema, depth);
      default:
        return TsTypeWriter.UNKNOWN;
    }
  }

  #array(schema: JsonSchema, depth: number): string {
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems.map((item) => this.#type(Schema.asSchema(item), depth)) : [];
    const items = Schema.items(schema);
    if (prefix.length > 0) {
      const rest = schema.items === false ? [] : [`...${TsTypeWriter.wrap(items ? this.#type(items, depth) : TsTypeWriter.UNKNOWN)}[]`];
      return `[${[...prefix, ...rest].join(', ')}]`;
    }
    return `${TsTypeWriter.wrap(items ? this.#type(items, depth) : TsTypeWriter.UNKNOWN)}[]`;
  }

  #object(schema: JsonSchema, depth: number): string {
    const properties = Object.entries(Schema.properties(schema));
    const required = Schema.requiredSet(schema);
    const extra = schema.additionalProperties;
    const patterns = Json.isPlainObject(schema.patternProperties) && Object.keys(schema.patternProperties).length > 0;
    if (properties.length === 0) {
      if (extra === false && !patterns) return 'Record<string, never>';
      const value = Json.isPlainObject(extra) && !patterns ? this.#type(extra, depth + 1) : TsTypeWriter.UNKNOWN;
      return `Record<string, ${value}>`;
    }
    const pad = this.#indent.repeat(depth + 1);
    const lines = properties.map(([name, property]) => `${pad}${Text.propertyKey(name)}${required.has(name) ? '' : '?'}: ${this.#type(property, depth + 1)};`);
    if (extra === true || Json.isPlainObject(extra) || patterns) lines.push(`${pad}[key: string]: unknown;`);
    return `{\n${lines.join('\n')}\n${this.#indent.repeat(depth)}}`;
  }

  static #isPlainObject(schema: JsonSchema): boolean {
    if ('const' in schema || Array.isArray(schema.enum) || schema.nullable === true) return false;
    if (Array.isArray(schema.oneOf) || Array.isArray(schema.anyOf) || Array.isArray(schema.allOf)) return false;
    const types = Schema.schemaTypes(schema);
    return types.length === 1 && types[0] === 'object' && Object.keys(Schema.properties(schema)).length > 0;
  }

  static #topLevel(type: string, operator: string): boolean {
    let depth = 0;
    let quote = '';
    for (let i = 0; i < type.length; i++) {
      const ch = type[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") quote = ch;
      else if (ch === '{' || ch === '(' || ch === '[' || ch === '<') depth++;
      else if (ch === '}' || ch === ')' || ch === ']' || ch === '>') depth--;
      else if (depth === 0 && ch === operator) return true;
    }
    return false;
  }
}
