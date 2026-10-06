import type { Capture, CapturedRequest, CapturedResponse, Exchange, Header } from '../model/index.js';
import { TokenDetector } from '../forms/index.js';
import { Http, Json } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import type { ParsedBody } from './body-parser.js';
import { CookieClassifier } from './cookie-classifier.js';
import { Redactor } from './redactor.js';
import { SecretValues } from './secret-values.js';

export interface SecretCollectorDeps {
  redactor: Redactor;
  body: BodyParser;
  cookies: CookieClassifier;
}

export interface SecretCollectorOptions {
  redact?: boolean;
}

export class SecretCollector {
  static readonly NOT_SECRET_ROLES: ReadonlySet<string> = new Set(['preference']);
  static readonly WALKED_KINDS: ReadonlySet<string> = new Set(['json', 'graphql', 'form', 'multipart']);
  static readonly BASIC = 'basic';
  static readonly LINE_BREAK: RegExp = /\r\n|\r|\n/;
  static readonly URL_HEADERS: ReadonlySet<string> = new Set(['referer', 'location', 'content-location']);
  static readonly BEARER: RegExp = /^bearer\s+(\S+)$/i;
  static readonly WHITESPACE: RegExp = /\s/;

  readonly #redactor: Redactor;
  readonly #body: BodyParser;
  readonly #cookies: CookieClassifier;

  constructor(deps: SecretCollectorDeps) {
    this.#redactor = deps.redactor;
    this.#body = deps.body;
    this.#cookies = deps.cookies;
  }

  static create(options: SecretCollectorOptions = {}): SecretCollector {
    const tokens = new TokenDetector();
    return new SecretCollector({ redactor: new Redactor(options.redact ?? true, { tokens }), body: BodyParser.create(), cookies: new CookieClassifier() });
  }

  collect(capture: Pick<Capture, 'exchanges' | 'cookies'>, names: ReadonlySet<string> = Redactor.NO_NAMES): SecretValues {
    if (!this.#redactor.enabled) return SecretValues.EMPTY;
    const out = new Set<string>();
    for (const cookie of capture.cookies) this.#cookie(cookie.name, cookie.value, out);
    for (const exchange of capture.exchanges) this.exchange(exchange, names, out);
    return new SecretValues(out);
  }

  exchange(exchange: Exchange, names: ReadonlySet<string>, out: Set<string>): void {
    this.#url(exchange.request.url, names, out);
    this.#request(exchange.request, names, out);
    if (exchange.response) this.#response(exchange.response, names, out);
    for (const header of [...exchange.request.headers, ...(exchange.response?.headers ?? [])]) {
      if (!SecretCollector.URL_HEADERS.has(header.name.toLowerCase())) continue;
      const target = Http.parseUrl(header.value, exchange.request.url);
      if (target) this.#url(target.href, names, out);
    }
  }

  #request(request: CapturedRequest, names: ReadonlySet<string>, out: Set<string>): void {
    this.#headers(request.headers, out);
    let parsed: ParsedBody | undefined;
    try {
      parsed = this.#body.request(request);
    } catch {
      parsed = undefined;
    }
    if (parsed) this.#parsed(parsed, names, out);
  }

  #response(response: CapturedResponse, names: ReadonlySet<string>, out: Set<string>): void {
    this.#headers(response.headers, out);
    let parsed: ParsedBody | undefined;
    try {
      parsed = this.#body.response(response);
    } catch {
      parsed = undefined;
    }
    if (parsed && (parsed.kind === 'json' || parsed.kind === 'graphql')) this.#walk(parsed.value, names, out, true);
  }

  #headers(headers: readonly Header[], out: Set<string>): void {
    for (const header of headers) {
      const lower = header.name.toLowerCase();
      if (lower === 'cookie') {
        for (const cookie of Http.parseCookieHeader(header.value)) this.#cookie(cookie.name, cookie.value, out);
      } else if (lower === 'set-cookie') {
        for (const line of header.value.split('\n')) this.#setCookie(line, out);
      } else if (Redactor.SCHEME_HEADERS.has(lower)) {
        this.#authorization(header.value, out);
      } else if (this.#redactor.isSecretHeader(header.name) || Redactor.looksSecret(header.value)) {
        SecretCollector.#add(header.value, out);
      }
    }
  }

  #authorization(value: string, out: Set<string>): void {
    const trimmed = value.trim();
    const space = trimmed.search(/\s/);
    if (space < 0) {
      SecretCollector.#add(trimmed, out);
      return;
    }
    const scheme = trimmed.slice(0, space).toLowerCase();
    const credentials = trimmed.slice(space).trim();
    SecretCollector.#add(credentials, out);
    if (scheme !== SecretCollector.BASIC) return;
    const decoded = Buffer.from(credentials, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return;
    SecretCollector.#add(decoded, out);
    SecretCollector.#add(decoded.slice(colon + 1), out);
  }

  #cookie(name: string, value: string, out: Set<string>): void {
    if (SecretCollector.NOT_SECRET_ROLES.has(this.#cookies.classify(name))) return;
    SecretCollector.#add(value, out);
    const decoded = Http.decodeComponent(value);
    if (decoded !== value) SecretCollector.#add(decoded, out);
  }

  #setCookie(line: string, out: Set<string>): void {
    const pair = line.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    this.#cookie(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim(), out);
  }

  #url(value: string, names: ReadonlySet<string>, out: Set<string>): void {
    const url = Http.parseUrl(value);
    if (!url) return;
    if (url.password !== '') SecretCollector.#add(Http.decodeComponent(url.password), out);
    const segments = url.pathname.split('/');
    segments.forEach((segment, position) => {
      if (Redactor.isSecretSegment(segments, position)) SecretCollector.#add(Http.decodeComponent(segment), out);
    });
    for (const [name, item] of url.searchParams) {
      if (names.has(name) || this.#redactor.isSecretQueryParam(name, url) || Redactor.looksSecret(item)) SecretCollector.#add(item, out);
    }
    const hash = url.hash.slice(1);
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash.includes('=') ? hash : '';
    for (const [name, item] of new URLSearchParams(query)) {
      if (names.has(name) || this.#redactor.isSecretQueryParam(name, url) || Redactor.looksSecret(item)) SecretCollector.#add(item, out);
    }
  }

  #parsed(parsed: ParsedBody, names: ReadonlySet<string>, out: Set<string>): void {
    if (SecretCollector.WALKED_KINDS.has(parsed.kind)) {
      this.#walk(parsed.value, names, out, false);
      return;
    }
    if (parsed.kind !== 'text' || typeof parsed.value !== 'string' || Redactor.plainTextMode(parsed.mimeType) !== 'pairs') return;
    for (const line of parsed.value.split(SecretCollector.LINE_BREAK)) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const name = line.slice(0, eq);
      if (names.has(name) || this.#redactor.isSecretField(name)) SecretCollector.#add(line.slice(eq + 1), out);
    }
  }

  #walk(value: unknown, names: ReadonlySet<string>, out: Set<string>, response: boolean): void {
    if (typeof value === 'string') {
      if (Redactor.looksSecret(value)) SecretCollector.#add(value, out);
      const bearer = SecretCollector.BEARER.exec(value.trim());
      if (bearer?.[1] !== undefined) SecretCollector.#add(bearer[1], out);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) this.#walk(item, names, out, response);
      return;
    }
    if (!Json.isPlainObject(value) || BodyParser.isUploadedFile(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (names.has(key) || this.#redactor.isSecretField(key)) SecretCollector.#leaf(item, out, response);
      this.#walk(item, names, out, response);
    }
  }

  static #leaf(value: unknown, out: Set<string>, response: boolean): void {
    if (Array.isArray(value)) {
      for (const item of value) if (!Array.isArray(item)) SecretCollector.#leaf(item, out, response);
      return;
    }
    if (typeof value === 'number' || typeof value === 'bigint') SecretCollector.#add(String(value), out);
    else if (typeof value === 'string' && !(response && SecretCollector.WHITESPACE.test(value))) SecretCollector.#add(value, out);
  }

  static #add(value: string, out: Set<string>): void {
    if (SecretValues.worthHiding(value)) out.add(value);
  }
}
