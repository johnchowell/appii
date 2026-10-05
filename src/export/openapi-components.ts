import type { JsonSchema } from '../model/index.js';
import { Text } from '../shared/index.js';

export type SecurityScheme = Record<string, unknown>;

export class OpenApiComponents {
  static readonly SCHEMA_PREFIX = '#/components/schemas/';
  static readonly NAME_PATTERN: RegExp = /^[A-Za-z0-9._-]+$/;
  static readonly FALLBACK_NAME = 'Schema';

  readonly #schemas = new Map<string, JsonSchema>();
  readonly #schemes = new Map<string, SecurityScheme>();
  readonly #schemeNames = new Map<string, string>();
  readonly #schemaNames = new Set<string>();
  readonly #takenSchemes = new Set<string>();

  static ref(name: string): JsonSchema {
    return { $ref: OpenApiComponents.SCHEMA_PREFIX + name };
  }

  static refName(schema: unknown): string | undefined {
    if (typeof schema !== 'object' || schema === null) return undefined;
    const ref = (schema as Record<string, unknown>).$ref;
    return typeof ref === 'string' && ref.startsWith(OpenApiComponents.SCHEMA_PREFIX) ? ref.slice(OpenApiComponents.SCHEMA_PREFIX.length) : undefined;
  }

  static safeName(base: string): string {
    const pascal = Text.pascalCase(base).replace(/^_+/, '');
    const name = pascal === '' ? OpenApiComponents.FALLBACK_NAME : /^[0-9]/.test(pascal) ? OpenApiComponents.FALLBACK_NAME + pascal : pascal;
    return OpenApiComponents.NAME_PATTERN.test(name) ? name : OpenApiComponents.FALLBACK_NAME;
  }

  schema(base: string, schema: JsonSchema): JsonSchema {
    const name = Text.uniqueName(OpenApiComponents.safeName(base), this.#schemaNames);
    this.#schemas.set(name, schema);
    return OpenApiComponents.ref(name);
  }

  resolve(schema: unknown): JsonSchema | undefined {
    const name = OpenApiComponents.refName(schema);
    return name === undefined ? undefined : this.#schemas.get(name);
  }

  scheme(key: string, base: string, scheme: SecurityScheme): string {
    const existing = this.#schemeNames.get(key);
    if (existing !== undefined) return existing;
    const name = Text.uniqueName(Text.camelCase(base).replace(/^_+/, '') || 'auth', this.#takenSchemes);
    this.#schemeNames.set(key, name);
    this.#schemes.set(name, scheme);
    return name;
  }

  toObject(): Record<string, unknown> | undefined {
    const out: Record<string, unknown> = {};
    if (this.#schemas.size > 0) out.schemas = Object.fromEntries(this.#schemas);
    if (this.#schemes.size > 0) out.securitySchemes = Object.fromEntries(this.#schemes);
    return Object.keys(out).length > 0 ? out : undefined;
  }
}
