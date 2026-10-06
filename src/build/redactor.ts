import type { FormDescriptor, FormField, JsonSchema } from '../model/index.js';
import { TokenDetector } from '../forms/index.js';
import { Http, Json, Samples, Schema, SecretNames, Text } from '../shared/index.js';
import { SecretValues } from './secret-values.js';

export interface RedactorDeps {
  tokens?: TokenDetector;
}

export interface RedactorOptions {
  redact?: boolean;
}

export type PlainTextMode = 'form' | 'pairs' | 'values';

export type CookieAlias = (name: string, value: string) => string;

interface PairContext {
  readonly path: string;
  readonly names: ReadonlySet<string>;
  readonly secrets: ReadonlySet<string>;
}

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
  static readonly PUBLIC_HEADERS: ReadonlySet<string> = new Set([
    'access-control-allow-credentials',
    'access-control-allow-headers',
    'access-control-allow-methods',
    'access-control-allow-origin',
    'access-control-allow-private-network',
    'access-control-expose-headers',
    'access-control-max-age',
    'access-control-request-headers',
    'access-control-request-method',
    'access-control-request-private-network',
  ]);
  static readonly ERROR_CONTAINERS: ReadonlySet<string> = new Set(['errors', 'error', 'messages', 'details', 'detail', 'violations', 'fielderrors', 'validationerrors']);
  static readonly QUERY_SECRET_NAMES: ReadonlySet<string> = new Set([
    'key',
    'appid',
    'sig',
    'signature',
    'x-amz-signature',
    'x-amz-credential',
    'x-amz-security-token',
    'x-goog-signature',
    'x-goog-credential',
  ]);
  static readonly CALLBACK_SECRET_NAMES: ReadonlySet<string> = new Set(['code', 'ticket']);
  static readonly CALLBACK_PATH: RegExp = /callback|oauth|oidc|openid|authori[sz]e|redirect|signin|sign-in|sso|saml|cas\b/i;
  static readonly CALLBACK_COMPANION = 'state';
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
  static readonly SCHEMA_CHILDREN: readonly string[] = ['items', 'if', 'then', 'else', 'not'];
  static readonly SCHEMA_VALUES: readonly string[] = ['default', 'const', 'enum', 'examples', 'x-appii-token-example'];
  static readonly ABSOLUTE_URL: RegExp = /^https?:\/\/[^\s]+$/i;
  static readonly COOKIE_HEADERS: ReadonlySet<string> = new Set(['cookie', 'set-cookie']);
  static readonly JSON_STARTS: readonly string[] = ['{', '['];
  static readonly LINE_BREAK: RegExp = /(\r\n|\n|\r)/;
  static readonly PAIR_NAME: RegExp = /^[^\s=]+$/;
  static readonly PAIR_TEXT_MIME = 'text/plain';
  static readonly NO_NAMES: ReadonlySet<string> = new Set();
  static readonly SECRET_CONTEXT_WORDS: ReadonlySet<string> = new Set([
    'reset', 'key', 'token', 'magic', 'verify', 'verification', 'confirm', 'confirmation', 'activate', 'activation', 'invite', 'invitation', 'login', 'password', 'unlock', 'recover', 'recovery',
  ]);
  static readonly HEX_VALUE: RegExp = /^(?:[0-9a-f]{16,}|[0-9A-F]{16,})$/;
  static readonly TOKEN_CHARACTERS: RegExp = /^[A-Za-z0-9_-]+$/;
  static readonly LONG_TOKEN_LENGTH = 16;
  static readonly LONG_TOKEN_TRANSITIONS = 3;
  static readonly MIXED_TOKEN_LENGTH = 10;
  static readonly MIXED_TOKEN_TRANSITIONS = 2;
  static readonly RECORD_SEPARATOR = '\u001e';
  static readonly SOCKET_IO_FRAME: RegExp = /^([0-9]+-?(?:\/[^,]*,)?[0-9]*)([[{][\s\S]*)$/;
  static readonly STOMP_HEAD: RegExp = /^([A-Z]+)\r?\n/;
  static readonly STOMP_BLANK_LINE: RegExp = /\r?\n\r?\n/;
  static readonly STOMP_END = '\u0000';
  static readonly STOMP_COMMANDS: ReadonlySet<string> = new Set([
    'CONNECT',
    'STOMP',
    'CONNECTED',
    'SEND',
    'SUBSCRIBE',
    'UNSUBSCRIBE',
    'ACK',
    'NACK',
    'BEGIN',
    'COMMIT',
    'ABORT',
    'DISCONNECT',
    'MESSAGE',
    'RECEIPT',
    'ERROR',
  ]);

  readonly #enabled: boolean;
  readonly #tokens: TokenDetector;
  #values: SecretValues = SecretValues.EMPTY;

  constructor(enabled = true, deps: RedactorDeps = {}) {
    this.#enabled = enabled;
    this.#tokens = deps.tokens ?? new TokenDetector();
  }

  static create(options: RedactorOptions = {}): Redactor {
    return new Redactor(options.redact ?? true, { tokens: new TokenDetector() });
  }

  static looksSecret(value: string): boolean {
    return Redactor.SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
  }

  get enabled(): boolean {
    return this.#enabled;
  }

  get values(): SecretValues {
    return this.#values;
  }

  useValues(values: SecretValues): void {
    this.#values = values;
  }

  scrub(text: string): string {
    return this.#enabled ? this.#values.scrub(text) : text;
  }

  isSecretField(name: string): boolean {
    return SecretNames.isSecret(name) || this.#tokens.isHiddenTokenField(name);
  }

  isSecretQueryParam(name: string, url?: URL): boolean {
    const names = new Set(url ? [...url.searchParams.keys()] : []);
    return this.#secretPair(name, { path: url?.pathname ?? '', names, secrets: Redactor.NO_NAMES });
  }

  isSecretHeader(name: string): boolean {
    const lower = name.toLowerCase();
    if (Redactor.PUBLIC_HEADERS.has(lower)) return false;
    return Redactor.SECRET_HEADERS.has(lower) || this.#tokens.isCsrfHeader(name) || this.isSecretField(name);
  }

  static isErrorContainer(name: string, value: unknown): boolean {
    return Redactor.ERROR_CONTAINERS.has(name.toLowerCase()) && (Array.isArray(value) || Json.isPlainObject(value));
  }

  isSecretValue(value: string): boolean {
    return Redactor.looksSecret(value) || this.#values.has(value);
  }

  header(name: string, value: string, alias?: CookieAlias): string {
    if (!this.#enabled) return value;
    const lower = name.toLowerCase();
    if (lower === 'cookie') {
      return Http.parseCookieHeader(value)
        .map((cookie) => (cookie.name ? `${cookie.name}=${Redactor.#cookieValue(cookie.name, cookie.value, alias)}` : Samples.REDACTED))
        .join('; ');
    }
    if (lower === 'set-cookie') return value.split('\n').map((line) => Redactor.#setCookie(line, alias)).join('\n');
    if (Redactor.SCHEME_HEADERS.has(lower)) {
      const m = /^(\S+)\s+\S/.exec(value.trim());
      return m ? `${m[1]} ${Samples.REDACTED}` : Samples.REDACTED;
    }
    if (this.isSecretHeader(name) || this.isSecretValue(value)) return Samples.REDACTED;
    return this.#values.scrub(value);
  }

  field(name: string, value: unknown): unknown {
    return this.#field(name, value, false);
  }

  #field(name: string, value: unknown, inErrors: boolean): unknown {
    if (!this.#enabled) return value;
    if (inErrors && !SecretNames.isPassword(name)) return this.#deep(value, true);
    if (this.isSecretField(name)) return Redactor.#all(value);
    const lower = name.toLowerCase();
    if (Redactor.COOKIE_HEADERS.has(lower) || Redactor.SCHEME_HEADERS.has(lower)) return typeof value === 'string' ? this.header(name, value) : this.#headerList(name, value);
    if (Redactor.SECRET_HEADERS.has(lower)) return Redactor.#all(value);
    return this.#deep(value, Redactor.isErrorContainer(name, value));
  }

  queryField(name: string, value: string, url: URL): string {
    if (!this.#enabled) return value;
    if (this.isSecretQueryParam(name, url)) return Samples.REDACTED;
    return String(this.deep(value));
  }

  deep(value: unknown): unknown {
    return this.#deep(value, false);
  }

  #deep(value: unknown, inErrors: boolean): unknown {
    if (!this.#enabled) return value;
    if (typeof value === 'string') return this.#string(value);
    if (Array.isArray(value)) return value.map((item) => this.#deep(item, inErrors));
    if (Json.isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.#field(key, item, inErrors)]));
    return value;
  }

  named(name: string, value: unknown, names: ReadonlySet<string>): unknown {
    if (!this.#enabled) return value;
    return names.has(name) ? Redactor.#all(value) : this.#values.scrubDeep(value);
  }

  examples(examples: readonly unknown[], names: ReadonlySet<string>): unknown[] {
    if (!this.#enabled) return [...examples];
    if (names.size === 0) return examples.map((example) => this.#values.scrubDeep(example));
    return examples.map((example) => {
      if (typeof example === 'string') return this.plainText(example, names, 'form');
      if (!Json.isPlainObject(example)) return this.#values.scrubDeep(example);
      return Object.fromEntries(Object.entries(example).map(([key, item]) => [key, this.named(key, item, names)]));
    });
  }

  plainText(text: string, names: ReadonlySet<string> = new Set(), mode: PlainTextMode = 'pairs'): string {
    if (!this.#enabled) return text;
    return text
      .split(Redactor.LINE_BREAK)
      .map((line, i) => {
        if (i % 2 === 1) return line;
        const eq = Redactor.#pairEnd(line, mode);
        if (eq < 0) return String(this.deep(line));
        const name = line.slice(0, eq);
        const value = line.slice(eq + 1);
        if (names.has(name) || this.isSecretField(name) || this.isSecretValue(value)) return `${name}=${Samples.REDACTED}`;
        return `${name}=${String(this.deep(value))}`;
      })
      .join('');
  }

  frame(data: string): string {
    if (!this.#enabled) return data;
    if (data.includes(Redactor.RECORD_SEPARATOR)) {
      return data
        .split(Redactor.RECORD_SEPARATOR)
        .map((part) => (part === '' ? part : this.frame(part)))
        .join(Redactor.RECORD_SEPARATOR);
    }
    const json = this.#jsonDocument(data);
    if (json !== undefined) return json;
    const socket = Redactor.SOCKET_IO_FRAME.exec(data);
    const payload = socket ? this.#jsonDocument(socket[2] ?? '') : undefined;
    if (socket && payload !== undefined) return (socket[1] ?? '') + payload;
    const stomp = this.#stomp(data);
    if (stomp !== undefined) return stomp;
    return String(this.deep(data));
  }

  url(url: string, names: ReadonlySet<string> = Redactor.NO_NAMES): string {
    if (!this.#enabled) return url;
    const parsed = Http.parseUrl(url);
    if (!parsed) return this.#values.scrub(url);
    let changed = false;
    if (parsed.password !== '') {
      parsed.password = Samples.REDACTED;
      changed = true;
    }
    if (parsed.username !== '' && this.#values.contains(Http.decodeComponent(parsed.username))) {
      parsed.username = encodeURIComponent(this.#values.scrub(Http.decodeComponent(parsed.username)));
      changed = true;
    }
    const path = this.#segments(parsed.pathname);
    if (path !== undefined) {
      parsed.pathname = path;
      changed = true;
    }
    if (parsed.search.length > 1) {
      const search = parsed.search.slice(1);
      const query = this.#pairs(search, { path: parsed.pathname, names: Redactor.#pairNames(search), secrets: names });
      if (query !== undefined) {
        parsed.search = '?' + query;
        changed = true;
      }
    }
    if (parsed.hash.length > 1) {
      const hash = this.#fragment(parsed.hash.slice(1), parsed.pathname, names);
      if (hash !== undefined) {
        parsed.hash = '#' + hash;
        changed = true;
      }
    }
    return changed ? parsed.href : url;
  }

  formField(field: FormField, token = false): FormField {
    if (!this.#enabled) return field;
    const out: FormField = { ...field };
    const secret = token || (this.isSecretField(field.name) && !Redactor.CONSTANT_VALUE_TYPES.has(field.type));
    if (secret && out.value !== '') out.value = Samples.REDACTED;
    else out.value = this.#values.scrub(out.value);
    if (out.options !== undefined) out.options = out.options.map((option) => ({ ...option, value: this.#values.scrub(option.value), label: this.#values.scrub(option.label) }));
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

  #secretPair(name: string, context: PairContext): boolean {
    if (context.secrets.has(name) || this.isSecretField(name)) return true;
    const lower = name.toLowerCase();
    if (Redactor.QUERY_SECRET_NAMES.has(lower)) return true;
    if (!Redactor.CALLBACK_SECRET_NAMES.has(lower)) return false;
    return Redactor.CALLBACK_PATH.test(context.path) || context.names.has(Redactor.CALLBACK_COMPANION);
  }

  #pairs(text: string, context: PairContext): string | undefined {
    let changed = false;
    const parts = text.split('&').map((part) => {
      const eq = part.indexOf('=');
      const rawName = eq < 0 ? part : part.slice(0, eq);
      const name = Http.decodeComponent(rawName.replace(/\+/g, ' '));
      const value = eq < 0 ? '' : Http.decodeComponent(part.slice(eq + 1).replace(/\+/g, ' '));
      if (this.#secretPair(name, context) || this.isSecretValue(value)) {
        changed = true;
        return `${rawName}=${encodeURIComponent(Samples.REDACTED)}`;
      }
      const inner = this.#values.scrub(this.#jsonString(value));
      if (inner === value) return part;
      changed = true;
      return `${rawName}=${encodeURIComponent(inner)}`;
    });
    return changed ? parts.join('&') : undefined;
  }

  #fragment(text: string, path: string, secrets: ReadonlySet<string>): string | undefined {
    const question = text.indexOf('?');
    const pairsOnly = question < 0 && text.includes('=');
    const route = question >= 0 ? text.slice(0, question) : pairsOnly ? '' : text;
    const query = question >= 0 ? text.slice(question + 1) : pairsOnly ? text : undefined;
    const routed = route === '' ? undefined : this.#segments(route);
    const paired = query === undefined ? undefined : this.#pairs(query, { path, names: Redactor.#pairNames(query), secrets });
    if (routed === undefined && paired === undefined) return undefined;
    return (routed ?? route) + (question >= 0 ? '?' : '') + (paired ?? query ?? '');
  }

  #segments(path: string): string | undefined {
    let changed = false;
    const raw = path.split('/');
    const segments = raw.map((segment, position) => {
      if (Redactor.isSecretSegment(raw, position)) {
        changed = true;
        return encodeURIComponent(Samples.REDACTED);
      }
      const decoded = Http.decodeComponent(segment);
      if (!this.#values.contains(decoded)) return segment;
      changed = true;
      return encodeURIComponent(this.#values.scrub(decoded));
    });
    return changed ? segments.join('/') : undefined;
  }

  pathValue(segments: readonly string[], position: number, name: string, value: string): string {
    if (!this.#enabled) return value;
    return Redactor.isSecretSegment(segments, position) ? Samples.REDACTED : String(this.field(name, value));
  }

  static isOpaqueValue(segment: string): boolean {
    return Redactor.isHexValue(segment) || Redactor.isOpaqueToken(segment);
  }

  static isHexValue(segment: string): boolean {
    return Redactor.HEX_VALUE.test(segment) && /[0-9]/.test(segment) && /[a-fA-F]/.test(segment);
  }

  static isOpaqueToken(segment: string): boolean {
    if (!Redactor.TOKEN_CHARACTERS.test(segment) || !/[0-9]/.test(segment) || !/[A-Za-z]/.test(segment)) return false;
    const transitions = Redactor.#transitions(segment);
    if (segment.length >= Redactor.LONG_TOKEN_LENGTH && transitions >= Redactor.LONG_TOKEN_TRANSITIONS) return true;
    return segment.length >= Redactor.MIXED_TOKEN_LENGTH && /[a-z]/.test(segment) && /[A-Z]/.test(segment) && transitions >= Redactor.MIXED_TOKEN_TRANSITIONS;
  }

  static isSecretSegment(segments: readonly string[], position: number): boolean {
    const segment = Http.decodeComponent(segments[position] ?? '');
    if (segment === '') return false;
    if (Redactor.looksSecret(segment)) return true;
    if (!Redactor.isOpaqueValue(segment)) return false;
    return segments.slice(0, position).some((earlier) => {
      const literal = Http.decodeComponent(earlier);
      if (literal === '' || Redactor.isOpaqueValue(literal) || /^[0-9]+$/.test(literal)) return false;
      return Text.letterWords(literal).some((word) => Redactor.SECRET_CONTEXT_WORDS.has(word));
    });
  }

  static #transitions(segment: string): number {
    let count = 0;
    for (let i = 1; i < segment.length; i++) {
      const prevDigit = /[0-9]/.test(segment.charAt(i - 1));
      const curDigit = /[0-9]/.test(segment.charAt(i));
      const prevLetter = /[A-Za-z]/.test(segment.charAt(i - 1));
      const curLetter = /[A-Za-z]/.test(segment.charAt(i));
      if ((prevDigit && curLetter) || (prevLetter && curDigit)) count++;
    }
    return count;
  }

  #string(value: string): string {
    if (this.isSecretValue(value)) return Samples.REDACTED;
    if (Redactor.ABSOLUTE_URL.test(value) && Http.parseUrl(value)) return this.url(value);
    if (Redactor.LINE_BREAK.test(value) && Redactor.#pairLines(value)) return this.plainText(value, Redactor.NO_NAMES, 'pairs');
    return this.#values.scrub(this.#jsonString(value));
  }

  #headerList(name: string, value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => (typeof item === 'string' ? this.header(name, item) : Redactor.#all(item)));
    return Redactor.#all(value);
  }

  static #pairLines(text: string): boolean {
    const lines = text.split(Redactor.LINE_BREAK).filter((line, i) => i % 2 === 0 && line !== '');
    return lines.length > 0 && lines.every((line) => Redactor.#pairEnd(line, 'pairs') > 0);
  }

  #jsonString(value: string): string {
    const start = value.trimStart().charAt(0);
    if (!Redactor.JSON_STARTS.includes(start)) return value;
    return this.#jsonDocument(value) ?? value;
  }

  #jsonDocument(text: string): string | undefined {
    const parsed = Json.safeParse(text);
    if (!parsed.ok || typeof parsed.value !== 'object' || parsed.value === null) return undefined;
    const redacted = this.deep(parsed.value);
    const out = JSON.stringify(redacted);
    return out === JSON.stringify(parsed.value) ? text : out;
  }

  #stomp(data: string): string | undefined {
    const head = Redactor.STOMP_HEAD.exec(data);
    if (!head || !Redactor.STOMP_COMMANDS.has(head[1] ?? '')) return undefined;
    const blank = Redactor.STOMP_BLANK_LINE.exec(data);
    const headerEnd = blank ? blank.index : data.length;
    const headers = data
      .slice(0, headerEnd)
      .split(Redactor.LINE_BREAK)
      .map((line, i) => {
        if (i === 0 || i % 2 === 1) return line;
        const colon = line.indexOf(':');
        if (colon < 0) return line;
        const name = line.slice(0, colon);
        return this.isSecretHeader(name) || this.isSecretValue(line.slice(colon + 1)) ? `${name}:${Samples.REDACTED}` : this.#values.scrub(line);
      })
      .join('');
    if (!blank) return headers;
    const body = data.slice(headerEnd + blank[0].length);
    const end = body.endsWith(Redactor.STOMP_END) ? Redactor.STOMP_END : '';
    const content = end === '' ? body : body.slice(0, -end.length);
    const redacted = content === '' ? '' : (this.#jsonDocument(content) ?? String(this.deep(content)));
    return headers + blank[0] + redacted + end;
  }

  #schemaNode(node: JsonSchema, secret: boolean): void {
    for (const key of Redactor.SCHEMA_VALUES) if (Object.hasOwn(node, key)) node[key] = this.#values.scrubDeep(node[key]);
    if (Object.hasOwn(node, Redactor.TOKEN_EXAMPLE)) node[Redactor.TOKEN_EXAMPLE] = Samples.REDACTED;
    if (secret && Object.hasOwn(node, 'default')) node.default = Redactor.#all(node.default);
    for (const [name, child] of Object.entries(Schema.properties(node))) this.#schemaNode(child, this.isSecretField(name) || child['x-appii-token'] === true);
    for (const key of Redactor.SCHEMA_CHILDREN) {
      const child = node[key];
      if (Json.isPlainObject(child)) this.#schemaNode(child, secret);
    }
    for (const key of Redactor.SCHEMA_LISTS) {
      const list = node[key];
      if (Array.isArray(list)) for (const item of list) if (Json.isPlainObject(item)) this.#schemaNode(item, secret);
    }
  }

  static plainTextMode(mimeType: string | undefined): PlainTextMode {
    return Http.mimeEssence(mimeType ?? '') === Redactor.PAIR_TEXT_MIME ? 'pairs' : 'values';
  }

  static #pairEnd(line: string, mode: PlainTextMode): number {
    if (mode === 'values') return -1;
    const eq = line.indexOf('=');
    return mode === 'form' || Redactor.PAIR_NAME.test(line.slice(0, eq)) ? eq : -1;
  }

  static #pairNames(text: string): Set<string> {
    return new Set(
      text.split('&').map((part) => {
        const eq = part.indexOf('=');
        return Http.decodeComponent((eq < 0 ? part : part.slice(0, eq)).replace(/\+/g, ' '));
      }),
    );
  }

  static #all(value: unknown): unknown {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') return Samples.REDACTED;
    if (Array.isArray(value)) return value.map((item) => Redactor.#all(item));
    if (Json.isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, Redactor.#all(item)]));
    return value;
  }

  static #setCookie(line: string, alias: CookieAlias | undefined): string {
    const semi = line.indexOf(';');
    const pair = semi < 0 ? line : line.slice(0, semi);
    const rest = semi < 0 ? '' : line.slice(semi);
    const eq = pair.indexOf('=');
    if (eq < 0) return Samples.REDACTED + rest;
    const name = pair.slice(0, eq);
    return `${name}=${Redactor.#cookieValue(name.trim(), pair.slice(eq + 1).trim(), alias)}${rest}`;
  }

  static #cookieValue(name: string, value: string, alias: CookieAlias | undefined): string {
    return alias === undefined ? Samples.REDACTED : alias(name, value);
  }
}
