import type { Capture, CapturedRequest, CapturedResponse, CookieRole, Exchange, Header } from '../model/index.js';
import { TokenDetector } from '../forms/index.js';
import { Http, Json, SecretNames } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import type { ParsedBody } from './body-parser.js';
import { CookieClassifier } from './cookie-classifier.js';
import { CredentialAnalyzer } from './credential-analyzer.js';
import type { CredentialInput } from './credential-analyzer.js';
import type { CredentialEvidence } from './credential-evidence.js';
import { HeaderPolicy } from './header-policy.js';
import { Redactor } from './redactor.js';
import { SecretValues } from './secret-values.js';

export interface SecretCollectorDeps {
  redactor: Redactor;
  body: BodyParser;
  cookies: CookieClassifier;
  credentials?: CredentialAnalyzer;
}

export interface SecretCollectorOptions {
  redact?: boolean;
}

export type SecretSource = Pick<Capture, 'exchanges' | 'cookies'> & Partial<Pick<Capture, 'pages'>>;

interface Candidate {
  label: string;
  strong: boolean;
  personal?: boolean;
}

interface Place {
  readonly key: string;
  readonly text: string;
}

interface Corpus {
  readonly requests: readonly Place[];
  readonly content: readonly Place[];
}

type Candidates = Map<string, Candidate>;

type RoleOf = (name: string) => CookieRole;

export class SecretCollector {
  static readonly SECRET_COOKIE_ROLES: ReadonlySet<CookieRole> = new Set<CookieRole>(['session', 'auth', 'csrf']);
  static readonly OPEN_COOKIE_ROLE: CookieRole = 'unknown';
  static readonly WALKED_KINDS: ReadonlySet<string> = new Set(['json', 'graphql', 'form', 'multipart']);
  static readonly BASIC = 'basic';
  static readonly LINE_BREAK: RegExp = /\r\n|\r|\n/;
  static readonly URL_HEADERS: ReadonlySet<string> = new Set(['referer', 'location', 'content-location']);
  static readonly BEARER: RegExp = /^bearer\s+(\S+)$/i;
  static readonly WHITESPACE: RegExp = /\s/;
  static readonly WORD_CHARACTER: RegExp = /[A-Za-z0-9_]/;
  static readonly TOKEN_LABEL = 'token';
  static readonly PASSWORD_LABEL = 'password';
  static readonly CREDENTIALS_LABEL = 'authorization';
  static readonly MIN_CONTENT_PLACES = 2;

  readonly #redactor: Redactor;
  readonly #body: BodyParser;
  readonly #credentials: CredentialAnalyzer;

  constructor(deps: SecretCollectorDeps) {
    this.#redactor = deps.redactor;
    this.#body = deps.body;
    this.#credentials = deps.credentials ?? new CredentialAnalyzer({ cookies: deps.cookies, body: deps.body, headers: new HeaderPolicy(), redactor: deps.redactor });
  }

  static create(options: SecretCollectorOptions = {}): SecretCollector {
    const tokens = new TokenDetector();
    const redactor = new Redactor(options.redact ?? true, { tokens });
    const body = BodyParser.create();
    const cookies = new CookieClassifier();
    return new SecretCollector({ redactor, body, cookies, credentials: new CredentialAnalyzer({ cookies, body, headers: new HeaderPolicy({ tokens }), redactor }) });
  }

  static isTokenShaped(value: string): boolean {
    return Redactor.looksSecret(value) || Redactor.isOpaqueValue(value);
  }

  static isSecretCookie(name: string, value: string, role: CookieRole): boolean {
    if (value === '' || SecretValues.isWordLike(value)) return false;
    if (SecretCollector.SECRET_COOKIE_ROLES.has(role)) return true;
    if (role !== SecretCollector.OPEN_COOKIE_ROLE) return false;
    return SecretNames.isSecret(name) || SecretCollector.isTokenShaped(value);
  }

  collect(capture: SecretSource, names: ReadonlySet<string> = Redactor.NO_NAMES, evidence?: CredentialEvidence, input: CredentialInput = {}): SecretValues {
    if (!this.#redactor.enabled) return SecretValues.EMPTY;
    const known = evidence ?? this.#credentials.analyze(capture, input);
    const role: RoleOf = (name) => known.role(name);
    const out: Candidates = new Map();
    for (const cookie of capture.cookies) this.#cookie(cookie.name, cookie.value, role, out);
    for (const exchange of capture.exchanges) {
      this.#exchange(exchange, names, role, out);
      this.#login(exchange, input, out);
    }
    let corpus: Corpus | undefined;
    const kept = [...out].filter(([value, candidate]) => {
      if (!SecretValues.worthHiding(value)) return false;
      if (candidate.personal === true) return true;
      if (!candidate.strong && SecretValues.isWordLike(value)) return false;
      if (SecretCollector.isTokenShaped(value)) return true;
      corpus ??= SecretCollector.#corpus(capture);
      return SecretCollector.#contentPlaces(value, corpus) < SecretCollector.MIN_CONTENT_PLACES;
    });
    return new SecretValues(
      kept.map(([value]) => value),
      new Map(kept.map(([value, candidate]) => [value, candidate.label])),
    );
  }

  #exchange(exchange: Exchange, names: ReadonlySet<string>, role: RoleOf, out: Candidates): void {
    this.#url(exchange.request.url, names, out);
    this.#request(exchange.request, names, role, out);
    if (exchange.response) this.#response(exchange.response, names, role, out);
    for (const header of [...exchange.request.headers, ...(exchange.response?.headers ?? [])]) {
      if (!SecretCollector.URL_HEADERS.has(header.name.toLowerCase())) continue;
      const target = Http.parseUrl(header.value, exchange.request.url);
      if (target) this.#url(target.href, names, out);
    }
  }

  #login(exchange: Exchange, input: CredentialInput, out: Candidates): void {
    for (const { name, value, password } of this.#credentials.loginSubmission(exchange, input)?.values ?? []) {
      if (password) SecretCollector.#add(value, name, true, out);
      else if (SecretValues.worthHiding(value)) out.set(value, { label: name, strong: true, personal: true });
    }
  }

  #request(request: CapturedRequest, names: ReadonlySet<string>, role: RoleOf, out: Candidates): void {
    this.#headers(request.headers, role, out);
    let parsed: ParsedBody | undefined;
    try {
      parsed = this.#body.request(request);
    } catch {
      parsed = undefined;
    }
    if (parsed) this.#parsed(parsed, names, out);
  }

  #response(response: CapturedResponse, names: ReadonlySet<string>, role: RoleOf, out: Candidates): void {
    this.#headers(response.headers, role, out);
    let parsed: ParsedBody | undefined;
    try {
      parsed = this.#body.response(response);
    } catch {
      parsed = undefined;
    }
    if (parsed && (parsed.kind === 'json' || parsed.kind === 'graphql')) this.#walk(parsed.value, names, out, true, false);
  }

  #headers(headers: readonly Header[], role: RoleOf, out: Candidates): void {
    for (const header of headers) {
      const lower = header.name.toLowerCase();
      if (lower === 'cookie') {
        for (const cookie of Http.parseCookieHeader(header.value)) this.#cookie(cookie.name, cookie.value, role, out);
      } else if (lower === 'set-cookie') {
        for (const line of header.value.split('\n')) this.#setCookie(line, role, out);
      } else if (Redactor.SCHEME_HEADERS.has(lower)) {
        SecretCollector.#authorization(header.value, out);
      } else if (this.#redactor.isSecretHeader(header.name) || Redactor.looksSecret(header.value)) {
        SecretCollector.#add(header.value, lower, true, out);
      }
    }
  }

  static #authorization(value: string, out: Candidates): void {
    const trimmed = value.trim();
    const space = trimmed.search(/\s/);
    if (space < 0) {
      SecretCollector.#add(trimmed, SecretCollector.CREDENTIALS_LABEL, true, out);
      return;
    }
    const scheme = trimmed.slice(0, space).toLowerCase();
    const credentials = trimmed.slice(space).trim();
    SecretCollector.#add(credentials, SecretCollector.CREDENTIALS_LABEL, true, out);
    if (scheme !== SecretCollector.BASIC) return;
    const decoded = Buffer.from(credentials, 'base64').toString('utf8');
    const colon = decoded.indexOf(':');
    if (colon < 0) return;
    SecretCollector.#add(decoded, SecretCollector.CREDENTIALS_LABEL, true, out);
    SecretCollector.#add(decoded.slice(colon + 1), SecretCollector.PASSWORD_LABEL, true, out);
  }

  #cookie(name: string, value: string, role: RoleOf, out: Candidates): void {
    if (!SecretCollector.isSecretCookie(name, value, role(name))) return;
    SecretCollector.#add(value, name, true, out);
    const decoded = Http.decodeComponent(value);
    if (decoded !== value) SecretCollector.#add(decoded, name, true, out);
  }

  #setCookie(line: string, role: RoleOf, out: Candidates): void {
    const pair = line.split(';')[0] ?? '';
    const eq = pair.indexOf('=');
    if (eq < 0) return;
    this.#cookie(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim(), role, out);
  }

  #url(value: string, names: ReadonlySet<string>, out: Candidates): void {
    const url = Http.parseUrl(value);
    if (!url) return;
    if (url.password !== '') SecretCollector.#add(Http.decodeComponent(url.password), SecretCollector.PASSWORD_LABEL, true, out);
    const segments = url.pathname.split('/');
    segments.forEach((segment, position) => {
      if (Redactor.isSecretSegment(segments, position)) SecretCollector.#add(Http.decodeComponent(segment), SecretCollector.TOKEN_LABEL, true, out);
    });
    for (const [name, item] of url.searchParams) {
      if (names.has(name) || this.#redactor.isSecretQueryParam(name, url) || Redactor.looksSecret(item)) SecretCollector.#add(item, name, true, out);
    }
    const hash = url.hash.slice(1);
    const query = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : hash.includes('=') ? hash : '';
    for (const [name, item] of new URLSearchParams(query)) {
      if (names.has(name) || this.#redactor.isSecretQueryParam(name, url) || Redactor.looksSecret(item)) SecretCollector.#add(item, name, true, out);
    }
  }

  #parsed(parsed: ParsedBody, names: ReadonlySet<string>, out: Candidates): void {
    if (SecretCollector.WALKED_KINDS.has(parsed.kind)) {
      this.#walk(parsed.value, names, out, false, false);
      return;
    }
    if (parsed.kind !== 'text' || typeof parsed.value !== 'string' || Redactor.plainTextMode(parsed.mimeType) !== 'pairs') return;
    for (const line of parsed.value.split(SecretCollector.LINE_BREAK)) {
      const eq = line.indexOf('=');
      if (eq <= 0) continue;
      const name = line.slice(0, eq);
      if (names.has(name) || this.#redactor.isSecretField(name)) SecretCollector.#add(line.slice(eq + 1), name, true, out);
    }
  }

  #walk(value: unknown, names: ReadonlySet<string>, out: Candidates, response: boolean, inErrors: boolean): void {
    if (typeof value === 'string') {
      if (Redactor.looksSecret(value)) SecretCollector.#add(value, SecretCollector.TOKEN_LABEL, true, out);
      const bearer = SecretCollector.BEARER.exec(value.trim());
      if (bearer?.[1] !== undefined) SecretCollector.#add(bearer[1], SecretCollector.TOKEN_LABEL, true, out);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) this.#walk(item, names, out, response, inErrors);
      return;
    }
    if (!Json.isPlainObject(value) || BodyParser.isUploadedFile(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const named = names.has(key) || this.#redactor.isSecretField(key);
      if (named && !(inErrors && !SecretNames.isPassword(key))) SecretCollector.#leaf(item, key, out, response);
      this.#walk(item, names, out, response, inErrors || (response && Redactor.isErrorContainer(key, item)));
    }
  }

  static #leaf(value: unknown, label: string, out: Candidates, response: boolean): void {
    if (Array.isArray(value)) {
      for (const item of value) if (!Array.isArray(item)) SecretCollector.#leaf(item, label, out, response);
      return;
    }
    if (typeof value === 'number' || typeof value === 'bigint') SecretCollector.#add(String(value), label, !response, out);
    else if (typeof value === 'string' && !(response && SecretCollector.WHITESPACE.test(value))) SecretCollector.#add(value, label, !response, out);
  }

  static #add(value: string, label: string, strong: boolean, out: Candidates): void {
    if (!SecretValues.worthHiding(value)) return;
    const known = out.get(value);
    if (known === undefined) out.set(value, { label, strong });
    else if (strong && !known.strong) out.set(value, { label, strong });
  }

  static #corpus(capture: SecretSource): Corpus {
    const requests: Place[] = [];
    const content: Place[] = [];
    for (const exchange of capture.exchanges) {
      const key = SecretCollector.#place(exchange.request.url);
      const sent = [exchange.request.url, ...exchange.request.headers.map((header) => header.value), exchange.request.body ? SecretCollector.#text(exchange.request.body) : ''].join('\n');
      requests.push({ key, text: sent });
      const body = exchange.response?.body;
      if (body) content.push({ key, text: SecretCollector.#text(body) });
    }
    for (const page of capture.pages ?? []) content.push({ key: SecretCollector.#place(page.url), text: page.html });
    return { requests, content };
  }

  static #contentPlaces(value: string, corpus: Corpus): number {
    const forms = SecretValues.variants(value);
    const carried = new Set(corpus.requests.filter((place) => forms.some((form) => place.text.includes(form))).map((place) => place.key));
    const places = new Set<string>();
    for (const place of corpus.content) {
      if (carried.has(place.key) || places.has(place.key)) continue;
      if (forms.some((form) => SecretCollector.#hasWord(place.text, form))) places.add(place.key);
    }
    return places.size;
  }

  static #hasWord(text: string, word: string): boolean {
    for (let at = text.indexOf(word); at >= 0; at = text.indexOf(word, at + 1)) {
      const before = at > 0 ? text.charAt(at - 1) : '';
      const after = text.charAt(at + word.length);
      if (!SecretCollector.WORD_CHARACTER.test(before) && !SecretCollector.WORD_CHARACTER.test(after)) return true;
    }
    return false;
  }

  static #place(url: string): string {
    const parsed = Http.parseUrl(url);
    return parsed ? parsed.origin + parsed.pathname : url;
  }

  static #text(body: NonNullable<CapturedRequest['body']>): string {
    return Buffer.from(Http.bodyBytes(body)).toString('latin1');
  }
}
