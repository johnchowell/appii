import type { Header, JsonSchema, ParamInfo, ParamLocation } from '../model/index.js';
import { EndpointIndex } from '../shared/index.js';
import { HeaderPolicy } from './header-policy.js';
import { Helpers } from './helpers.js';
import type { PathTemplate, SegmentKind } from './path-templater.js';
import { Redactor } from './redactor.js';
import { SchemaInferrer } from './schema-inferrer.js';

export interface ParamInferrerDeps {
  schemas: SchemaInferrer;
  redactor: Redactor;
  headers?: HeaderPolicy;
}

export interface ParamInferrerOptions {
  maxExamples: number;
}

interface ParamStats {
  present: number;
  repeated: boolean;
  values: string[];
}

export class ParamInferrer {
  static readonly CANONICAL_INTEGER: RegExp = /^(?:0|[1-9][0-9]*)$/;

  readonly #schemas: SchemaInferrer;
  readonly #redactor: Redactor;
  readonly #headers: HeaderPolicy;
  readonly #maxExamples: number;

  constructor(deps: ParamInferrerDeps, options: ParamInferrerOptions) {
    this.#schemas = deps.schemas;
    this.#redactor = deps.redactor;
    this.#headers = deps.headers ?? new HeaderPolicy();
    this.#maxExamples = options.maxExamples;
  }

  static create(options: ParamInferrerOptions): ParamInferrer {
    return new ParamInferrer({ schemas: SchemaInferrer.create(), redactor: new Redactor(), headers: new HeaderPolicy() }, options);
  }

  static pathSchema(kind: SegmentKind, values: readonly string[]): JsonSchema {
    switch (kind) {
      case 'integer':
        return values.every((value) => ParamInferrer.CANONICAL_INTEGER.test(value)) ? { type: 'integer' } : { type: 'string', pattern: '^[0-9]+$' };
      case 'uuid':
        return { type: 'string', format: 'uuid' };
      case 'date':
        return { type: 'string', format: 'date' };
      case 'hex':
        return { type: 'string', pattern: '^[0-9a-fA-F]+$' };
      default:
        return { type: 'string' };
    }
  }

  query(urls: readonly URL[]): ParamInfo[] {
    const stats = new Map<string, ParamStats>();
    for (const url of urls) {
      const counts = new Map<string, number>();
      for (const [name, value] of url.searchParams) {
        counts.set(name, (counts.get(name) ?? 0) + 1);
        ParamInferrer.#stat(stats, name).values.push(value);
      }
      for (const [name, count] of counts) {
        const stat = ParamInferrer.#stat(stats, name);
        stat.present++;
        if (count > 1) stat.repeated = true;
      }
    }
    return [...stats].map(([name, stat]) => {
      const scalar = this.#schemas.fromStrings(stat.values);
      const schema: JsonSchema = stat.repeated ? { type: 'array', items: scalar } : scalar;
      const examples = stat.values.map((value) => String(this.#redactor.field(name, value)));
      return this.#param(name, 'query', stat.present === urls.length, schema, examples);
    });
  }

  headers(requests: readonly (readonly Header[])[]): ParamInfo[] {
    const stats = new Map<string, ParamStats>();
    for (const headers of requests) {
      const seen = new Set<string>();
      for (const header of headers) {
        const name = header.name.toLowerCase();
        if (!this.#headers.isParam(name)) continue;
        const stat = ParamInferrer.#stat(stats, name);
        stat.values.push(header.value);
        if (seen.has(name)) stat.repeated = true;
        else {
          seen.add(name);
          stat.present++;
        }
      }
    }
    return [...stats].map(([name, stat]) => {
      const examples = stat.values.map((value) => this.#redactor.header(name, value));
      return this.#param(name, 'header', stat.present === requests.length, { type: 'string' }, examples);
    });
  }

  path(template: PathTemplate, paths: readonly string[]): ParamInfo[] {
    const matches = paths.map((path) => EndpointIndex.matchPath(template.template, path)).filter((m): m is Record<string, string> => m !== undefined);
    return template.params.map((param) => {
      const values = matches.map((m) => m[param.name]).filter((value): value is string => value !== undefined);
      const examples = values.map((value) => String(this.#redactor.field(param.name, value)));
      return this.#param(param.name, 'path', true, ParamInferrer.pathSchema(param.kind, values), examples);
    });
  }

  #param(name: string, location: ParamLocation, required: boolean, schema: JsonSchema, examples: readonly string[]): ParamInfo {
    return {
      name,
      in: location,
      required,
      schema,
      examples: Helpers.distinct(examples).slice(0, Math.max(0, this.#maxExamples)),
    };
  }

  static #stat(stats: Map<string, ParamStats>, name: string): ParamStats {
    let stat = stats.get(name);
    if (!stat) {
      stat = { present: 0, repeated: false, values: [] };
      stats.set(name, stat);
    }
    return stat;
  }
}
