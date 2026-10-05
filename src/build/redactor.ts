import type { FormDescriptor, FormField, JsonSchema } from '../model/index.js';
import { TokenDetector } from '../forms/index.js';
import { Http, Json, Samples, Text } from '../shared/index.js';
import { Helpers } from './helpers.js';

export interface RedactorDeps {
  tokens?: TokenDetector;
}

export interface RedactorOptions {
  redact?: boolean;
}

interface PairContext {
  readonly path: string;
  readonly names: ReadonlySet<string>;
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
  static readonly SECRET_WORDS: ReadonlySet<string> = new Set([
    'pass',
    'passwd',
    'password',
    'passphrase',
    'passcode',
    'pw',
    'pwd',
    'pin',
    'secret',
    'token',
    'auth',
    'authorization',
    'credential',
    'credentials',
    'session',
    'sessionid',
    'sid',
    'otp',
    'totp',
    'ssn',
    'cvv',
    'cvc',
    'jwt',
    'bearer',
    'signature',
    'apikey',
    'csrf',
    'xsrf',
  ]);
  static readonly SECRET_STEMS: readonly string[] = ['password', 'passwd', 'passphrase'];
  static readonly SECRET_SUFFIXES: readonly string[] = ['token', 'secret', 'apikey', 'passcode', 'sessionid'];
  static readonly SECRET_KEY_QUALIFIERS: readonly string[] = [
    'api', 'access', 'secret', 'private', 'app', 'rp', 'reset', 'activation', 'recovery', 'confirmation', 'verification',
    'license', 'session', 'encryption', 'signing', 'master', 'subscription', 'sas', 'shared',
  ];
  static readonly SECRET_CODE_QUALIFIERS: readonly string[] = [
    'reset', 'verification', 'confirmation', 'activation', 'recovery', 'backup', 'security', 'mfa', 'sms', 'login', 'factor', 'invite', 'magic',
  ];
  static readonly SECRET_PHRASES: readonly (readonly string[])[] = [
    ...Redactor.SECRET_KEY_QUALIFIERS.map((qualifier) => [qualifier, 'key']),
    ...Redactor.SECRET_CODE_QUALIFIERS.map((qualifier) => [qualifier, 'code']),
    ['card', 'number'],
  ];
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
  static readonly JSON_STARTS: readonly string[] = ['{', '['];
  static readonly LINE_BREAK: RegExp = /(\r\n|\n|\r)/;
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

  isSecretField(name: string): boolean {
    const words = Text.letterWords(name);
    if (words.length === 0) return false;
    if (words.some((word) => Redactor.#secretWord(word))) return true;
    if (Redactor.SECRET_PHRASES.some((phrase) => Redactor.#hasPhrase(words, phrase))) return true;
    return this.#tokens.isHiddenTokenField(name);
  }

  isSecretQueryParam(name: string, url?: URL): boolean {
    const names = new Set(url ? [...url.searchParams.keys()] : []);
    return this.#secretPair(name, { path: url?.pathname ?? '', names });
  }

  isSecretHeader(name: string): boolean {
    return Redactor.SECRET_HEADERS.has(name.toLowerCase()) || this.#tokens.isCsrfHeader(name) || this.isSecretField(name);
  }

  isSecretValue(value: string): boolean {
    return Redactor.looksSecret(value);
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

  queryField(name: string, value: string, url: URL): string {
    if (!this.#enabled) return value;
    if (this.isSecretQueryParam(name, url)) return Samples.REDACTED;
    return String(this.deep(value));
  }

  deep(value: unknown): unknown {
    if (!this.#enabled) return value;
    if (typeof value === 'string') return this.isSecretValue(value) ? Samples.REDACTED : this.#jsonString(value);
    if (Array.isArray(value)) return value.map((item) => this.deep(item));
    if (Json.isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.field(key, item)]));
    return value;
  }

  named(name: string, value: unknown, names: ReadonlySet<string>): unknown {
    return this.#enabled && names.has(name) ? Redactor.#all(value) : value;
  }

  examples(examples: readonly unknown[], names: ReadonlySet<string>): unknown[] {
    if (!this.#enabled || names.size === 0) return [...examples];
    return examples.map((example) => {
      if (typeof example === 'string') return this.plainText(example, names);
      if (!Json.isPlainObject(example)) return example;
      return Object.fromEntries(Object.entries(example).map(([key, item]) => [key, this.named(key, item, names)]));
    });
  }

  plainText(text: string, names: ReadonlySet<string> = new Set()): string {
    if (!this.#enabled) return text;
    return text
      .split(Redactor.LINE_BREAK)
      .map((line, i) => {
        if (i % 2 === 1) return line;
        const eq = line.indexOf('=');
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

  url(url: string): string {
    if (!this.#enabled) return url;
    const parsed = Http.parseUrl(url);
    if (!parsed) return url;
    let changed = false;
    if (parsed.password !== '') {
      parsed.password = Samples.REDACTED;
      changed = true;
    }
    const path = this.#segments(parsed.pathname);
    if (path !== undefined) {
      parsed.pathname = path;
      changed = true;
    }
    if (parsed.search.length > 1) {
      const search = parsed.search.slice(1);
      const query = this.#pairs(search, { path: parsed.pathname, names: Redactor.#pairNames(search) });
      if (query !== undefined) {
        parsed.search = '?' + query;
        changed = true;
      }
    }
    if (parsed.hash.length > 1) {
      const hash = this.#fragment(parsed.hash.slice(1), parsed.pathname);
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
    if (this.isSecretField(name)) return true;
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
      const inner = this.#jsonString(value);
      if (inner === value) return part;
      changed = true;
      return `${rawName}=${encodeURIComponent(inner)}`;
    });
    return changed ? parts.join('&') : undefined;
  }

  #fragment(text: string, path: string): string | undefined {
    const question = text.indexOf('?');
    const pairsOnly = question < 0 && text.includes('=');
    const route = question >= 0 ? text.slice(0, question) : pairsOnly ? '' : text;
    const query = question >= 0 ? text.slice(question + 1) : pairsOnly ? text : undefined;
    const routed = route === '' ? undefined : this.#segments(route);
    const paired = query === undefined ? undefined : this.#pairs(query, { path, names: Redactor.#pairNames(query) });
    if (routed === undefined && paired === undefined) return undefined;
    return (routed ?? route) + (question >= 0 ? '?' : '') + (paired ?? query ?? '');
  }

  #segments(path: string): string | undefined {
    let changed = false;
    const segments = path.split('/').map((segment) => {
      if (!this.isSecretValue(Http.decodeComponent(segment))) return segment;
      changed = true;
      return encodeURIComponent(Samples.REDACTED);
    });
    return changed ? segments.join('/') : undefined;
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
        return this.isSecretHeader(name) || this.isSecretValue(line.slice(colon + 1)) ? `${name}:${Samples.REDACTED}` : line;
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
    if (Object.hasOwn(node, Redactor.TOKEN_EXAMPLE)) node[Redactor.TOKEN_EXAMPLE] = Samples.REDACTED;
    if (secret && Object.hasOwn(node, 'default')) node.default = Redactor.#all(node.default);
    for (const [name, child] of Helpers.properties(node)) this.#schemaNode(child, this.isSecretField(name) || child['x-appii-token'] === true);
    for (const key of Redactor.SCHEMA_CHILDREN) {
      const child = node[key];
      if (Json.isPlainObject(child)) this.#schemaNode(child, secret);
    }
    for (const key of Redactor.SCHEMA_LISTS) {
      const list = node[key];
      if (Array.isArray(list)) for (const item of list) if (Json.isPlainObject(item)) this.#schemaNode(item, secret);
    }
  }

  static #secretWord(word: string): boolean {
    return (
      Redactor.SECRET_WORDS.has(word) ||
      Redactor.SECRET_STEMS.some((stem) => word.includes(stem)) ||
      Redactor.SECRET_SUFFIXES.some((suffix) => word.endsWith(suffix))
    );
  }

  static #hasPhrase(words: readonly string[], phrase: readonly string[]): boolean {
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phrase.every((part, j) => words[i + j] === part)) return true;
    }
    return false;
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

  static #setCookie(line: string): string {
    const semi = line.indexOf(';');
    const pair = semi < 0 ? line : line.slice(0, semi);
    const rest = semi < 0 ? '' : line.slice(semi);
    const eq = pair.indexOf('=');
    return eq < 0 ? Samples.REDACTED + rest : `${pair.slice(0, eq)}=${Samples.REDACTED}${rest}`;
  }
}
