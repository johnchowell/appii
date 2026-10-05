import type { BodyKind, BodyShape, JsonSchema } from '../model/index.js';
import { Json, Text } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import type { ParsedBody, UploadedFile } from './body-parser.js';
import { Helpers } from './helpers.js';
import { Redactor } from './redactor.js';
import { SchemaInferrer } from './schema-inferrer.js';

export interface BodyShaperDeps {
  schemas: SchemaInferrer;
  redactor: Redactor;
}

export interface BodyShaperOptions {
  maxExamples: number;
}

export class BodyShaper {
  static readonly EXAMPLE_KINDS: ReadonlySet<BodyKind> = new Set(['json', 'graphql', 'form', 'multipart', 'text']);
  static readonly TEXT_EXAMPLE_LENGTH = 200;
  static readonly COMPACT_ARRAY_ITEMS = 10;
  static readonly COMPACT_STRING_LENGTH = 500;
  static readonly GENERIC_FILE_TYPES: ReadonlySet<string> = new Set(['application/octet-stream', '']);

  readonly #schemas: SchemaInferrer;
  readonly #redactor: Redactor;
  readonly #maxExamples: number;

  constructor(deps: BodyShaperDeps, options: BodyShaperOptions) {
    this.#schemas = deps.schemas;
    this.#redactor = deps.redactor;
    this.#maxExamples = options.maxExamples;
  }

  static create(options: BodyShaperOptions): BodyShaper {
    return new BodyShaper({ schemas: SchemaInferrer.create(), redactor: Redactor.create() }, options);
  }

  shape(bodies: readonly ParsedBody[], compact = false): BodyShape | undefined {
    const present = bodies.filter((body) => body.kind !== 'empty');
    const kind = Helpers.mostFrequent(present.map((body) => body.kind));
    if (kind === undefined) return undefined;
    const chosen = present.filter((body) => body.kind === kind);
    const mimeType = Helpers.mostFrequent(chosen.map((body) => body.mimeType)) ?? '';
    const values = chosen.filter((body) => body.value !== undefined).map((body) => body.value);
    const schema = this.schema(kind, values);
    return {
      mimeType,
      kind,
      ...(schema ? { schema } : {}),
      examples: this.#examples(kind, values, compact, mimeType),
    };
  }

  schema(kind: BodyKind, values: readonly unknown[]): JsonSchema | undefined {
    switch (kind) {
      case 'json':
      case 'graphql':
      case 'form':
        return values.length > 0 ? this.#schemas.infer([...values]) : undefined;
      case 'multipart':
        return values.length > 0 ? this.#multipart(values) : undefined;
      case 'html':
      case 'text':
        return { type: 'string' };
      default:
        return undefined;
    }
  }

  #multipart(values: readonly unknown[]): JsonSchema {
    const files = new Map<string, UploadedFile[]>();
    const flattened = values.map((value) => {
      if (!Json.isPlainObject(value)) return value;
      return Object.fromEntries(
        Object.entries(value).map(([key, field]) => {
          const list = Array.isArray(field) ? field : [field];
          const uploads = list.filter((item): item is UploadedFile => BodyParser.isUploadedFile(item));
          if (uploads.length > 0) files.set(key, [...(files.get(key) ?? []), ...uploads]);
          const replace = (item: unknown): unknown => (BodyParser.isUploadedFile(item) ? '' : item);
          return [key, Array.isArray(field) ? field.map(replace) : replace(field)];
        }),
      );
    });
    const schema = this.#schemas.infer(flattened);
    const props = schema.properties;
    if (!Json.isPlainObject(props)) return schema;
    for (const [key, uploads] of files) {
      const current = Object.hasOwn(props, key) ? props[key] : undefined;
      if (!Json.isPlainObject(current)) continue;
      const binary = BodyShaper.#binary(uploads);
      Json.setOwn(props, key, current.type === 'array' ? { ...current, items: binary } : binary);
    }
    return schema;
  }

  #examples(kind: BodyKind, values: readonly unknown[], compact: boolean, mimeType: string): unknown[] {
    if (!BodyShaper.EXAMPLE_KINDS.has(kind) || this.#maxExamples <= 0) return [];
    const out: unknown[] = [];
    const seen = new Set<string>();
    const mode = Redactor.plainTextMode(mimeType);
    for (const value of values) {
      let example = kind === 'text' && typeof value === 'string' ? this.#redactor.plainText(value, new Set(), mode) : this.#redactor.deep(value);
      if (kind === 'text' && typeof example === 'string') example = Text.truncate(example, BodyShaper.TEXT_EXAMPLE_LENGTH);
      else if (compact) example = BodyShaper.#compact(example);
      const key = Json.stableStringify(example, 0);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(example);
      if (out.length >= this.#maxExamples) break;
    }
    return out;
  }

  static #binary(uploads: readonly UploadedFile[]): JsonSchema {
    const schema: JsonSchema = { type: 'string', format: 'binary' };
    const types = new Set(uploads.map((upload) => upload.contentType.toLowerCase()));
    const [only] = types;
    if (types.size === 1 && only !== undefined && !BodyShaper.GENERIC_FILE_TYPES.has(only)) schema.contentMediaType = only;
    return schema;
  }

  static #compact(value: unknown): unknown {
    if (typeof value === 'string') return Text.truncate(value, BodyShaper.COMPACT_STRING_LENGTH);
    if (Array.isArray(value)) return value.slice(0, BodyShaper.COMPACT_ARRAY_ITEMS).map((item) => BodyShaper.#compact(item));
    if (Json.isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, BodyShaper.#compact(item)]));
    return value;
  }
}
