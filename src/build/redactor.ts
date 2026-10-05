import type { FormDescriptor, FormField, JsonSchema } from '../model/index.js';
import { Http, Json, Samples, Text } from '../shared/index.js';
import { Helpers } from './helpers.js';

export class Redactor {
  static readonly SECRET_HEADERS: ReadonlySet<string> = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'api-key',
    'apikey',
    'x-apikey',
    'x-auth-token',
    'x-access-token',
    'x-refresh-token',
    'x-id-token',
    'x-session-token',
    'x-csrf-token',
    'x-xsrf-token',
    'x-csrftoken',
    'csrf-token',
    'x-amz-security-token',
    'x-goog-api-key',
    'x-rapidapi-key',
    'ocp-apim-subscription-key',
    'x-functions-key',
    'private-token',
  ]);
  static readonly SECRET_FIELD_PATTERN: RegExp =
    /(?:^|_)(?:pass(?:word|wd|phrase|code)?|pwd|secret|client_secret|token|access_token|refresh_token|id_token|auth_token|api_?key|apikey|auth|authorization|credentials?|sid|session(?:_?id)?|csrf(?:_?token)?|xsrf(?:_?token)?|otp|totp|mfa_code|pin|ssn|cvv|cvc|card_?number|private_?key|signature|jwt|bearer)(?:_|$)/;
  static readonly SECRET_VALUE_PATTERNS: readonly RegExp[] = [
    /^eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*$/,
    /^(?:bearer|basic|digest)\s+\S+$/i,
  ];
  static readonly SCHEME_HEADERS: ReadonlySet<string> = new Set(['authorization', 'proxy-authorization']);
  static readonly CONSTANT_VALUE_TYPES: ReadonlySet<string> = new Set([
    'checkbox',
    'radio',
    'submit',
    'image',
    'reset',
    'button',
    'select-one',
    'select-multiple',
    'file',
  ]);
  static readonly TOKEN_EXAMPLE = 'x-appii-token-example';
  static readonly SCHEMA_LISTS: readonly string[] = ['anyOf', 'oneOf', 'allOf', 'prefixItems'];

  readonly #enabled: boolean;

  constructor(enabled = true) {
    this.#enabled = enabled;
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  isSecretField(name: string): boolean {
    const snake = Text.snakeCase(name);
    return snake !== '' && Redactor.SECRET_FIELD_PATTERN.test(snake);
  }

  isSecretHeader(name: string): boolean {
    return Redactor.SECRET_HEADERS.has(name.toLowerCase()) || this.isSecretField(name);
  }

  isSecretValue(value: string): boolean {
    return Redactor.SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  }

  header(name: string, value: string): string {
    if (!this.#enabled) return value;
    const lower = name.toLowerCase();
    if (lower === 'cookie') {
      return Http.parseCookieHeader(value)
        .map((cookie) => (cookie.name ? `${cookie.name}=${Samples.REDACTED}` : Samples.REDACTED))
        .join('; ');
    }
    if (lower === 'set-cookie') return value.split('\n').map((line) => Redactor.#setCookie(line)).join('\n');
    if (Redactor.SCHEME_HEADERS.has(lower)) {
      const m = /^(\S+)\s+\S/.exec(value.trim());
      return m ? `${m[1]} ${Samples.REDACTED}` : Samples.REDACTED;
    }
    if (this.isSecretHeader(name) || this.isSecretValue(value)) return Samples.REDACTED;
    return value;
  }

  field(name: string, value: unknown): unknown {
    if (!this.#enabled) return value;
    if (this.isSecretField(name)) return Redactor.#all(value);
    return this.deep(value);
  }

  deep(value: unknown): unknown {
    if (!this.#enabled) return value;
    if (typeof value === 'string') return this.isSecretValue(value) ? Samples.REDACTED : value;
    if (Array.isArray(value)) return value.map((item) => this.deep(item));
    if (Json.isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.field(key, item)]));
    return value;
  }

  url(url: string): string {
    if (!this.#enabled) return url;
    const parsed = Helpers.parseUrl(url);
    if (!parsed) return url;
    let changed = false;
    if (parsed.password !== '') {
      parsed.password = Samples.REDACTED;
      changed = true;
    }
    if (parsed.search.length > 1) {
      const parts = parsed.search.slice(1).split('&').map((part) => {
        const eq = part.indexOf('=');
        const rawName = eq < 0 ? part : part.slice(0, eq);
        const name = Helpers.decode(rawName.replace(/\+/g, ' '));
        const value = eq < 0 ? '' : Helpers.decode(part.slice(eq + 1).replace(/\+/g, ' '));
        if (!this.isSecretField(name) && !this.isSecretValue(value)) return part;
        changed = true;
        return `${rawName}=${encodeURIComponent(Samples.REDACTED)}`;
      });
      parsed.search = '?' + parts.join('&');
    }
    return changed ? parsed.href : url;
  }

  formField(field: FormField, token = false): FormField {
    if (!this.#enabled) return field;
    const out: FormField = { ...field };
    const secret = token || (this.isSecretField(field.name) && !Redactor.CONSTANT_VALUE_TYPES.has(field.type));
    if (secret && out.value !== '') out.value = Samples.REDACTED;
    if (out.formAction !== undefined) out.formAction = this.url(out.formAction);
    return out;
  }

  form(form: FormDescriptor): FormDescriptor {
    if (!this.#enabled) return form;
    const tokens = new Set(form.tokenFields);
    return {
      ...form,
      pageUrl: this.url(form.pageUrl),
      action: this.url(form.action),
      fields: form.fields.map((field) => this.formField(field, tokens.has(field.name))),
      submitters: form.submitters.map((field) => this.formField(field)),
    };
  }

  schema(schema: JsonSchema): JsonSchema {
    if (!this.#enabled) return schema;
    const copy = Json.clone(schema);
    this.#schemaNode(copy, false);
    return copy;
  }

  #schemaNode(node: JsonSchema, secret: boolean): void {
    if (Object.hasOwn(node, Redactor.TOKEN_EXAMPLE)) node[Redactor.TOKEN_EXAMPLE] = Samples.REDACTED;
    if (secret && Object.hasOwn(node, 'default')) node.default = Redactor.#all(node.default);
    for (const [name, child] of Helpers.properties(node)) this.#schemaNode(child, this.isSecretField(name) || child['x-appii-token'] === true);
    const items = node.items;
    if (Json.isPlainObject(items)) this.#schemaNode(items, secret);
    for (const key of Redactor.SCHEMA_LISTS) {
      const list = node[key];
      if (Array.isArray(list)) for (const item of list) if (Json.isPlainObject(item)) this.#schemaNode(item, secret);
    }
  }

  static #all(value: unknown): unknown {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return Samples.REDACTED;
    if (Array.isArray(value)) return value.map((item) => Redactor.#all(item));
    if (Json.isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Redactor.#all(item)]));
    return value;
  }

  static #setCookie(line: string): string {
    const semi = line.indexOf(';');
    const pair = semi < 0 ? line : line.slice(0, semi);
    const rest = semi < 0 ? '' : line.slice(semi);
    const eq = pair.indexOf('=');
    return eq < 0 ? Samples.REDACTED + rest : `${pair.slice(0, eq)}=${Samples.REDACTED}${rest}`;
  }
}
