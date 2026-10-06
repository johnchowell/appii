import type { Capture, CookieRole, Exchange } from '../model/index.js';
import { CookieParser } from '../capture/index.js';
import { TokenDetector } from '../forms/index.js';
import { Http, Json, SecretNames, Text } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { CookieClassifier } from './cookie-classifier.js';
import { CookieInventory } from './cookie-inventory.js';
import { CredentialEvidence } from './credential-evidence.js';
import type { GenerationEvent } from './credential-evidence.js';
import { HeaderPolicy } from './header-policy.js';
import { Redactor } from './redactor.js';

export interface CredentialAnalyzerDeps {
  cookies: CookieClassifier;
  body: BodyParser;
  headers: HeaderPolicy;
  redactor: Redactor;
}

export interface CredentialInput {
  passwordFields?: ReadonlySet<string>;
  loginPages?: ReadonlySet<string>;
  identifierFields?: ReadonlySet<string>;
  personalFields?: ReadonlySet<string>;
}

export interface LoginValue {
  readonly name: string;
  readonly value: string;
  readonly password: boolean;
}

export interface LoginSubmission {
  readonly password: string;
  readonly identifier?: string;
  readonly values: readonly LoginValue[];
}

interface Sent {
  readonly name: string;
  readonly value: string;
}

interface FieldEntry {
  readonly path: string;
  readonly key: string;
  readonly value: unknown;
  readonly container: object;
}

export class CredentialAnalyzer {
  static readonly SIGN_OUT: RegExp = /(?:^|[^a-z])(?:log|sign)[-_.]?(?:out|off)(?:[^a-z]|$)/i;
  static readonly CLIENT_ROLE: CookieRole = 'tracking';
  static readonly FIELD_KINDS: ReadonlySet<string> = new Set(['form', 'multipart', 'json', 'graphql']);
  static readonly SCHEME_HEADERS: ReadonlySet<string> = new Set(['authorization']);
  static readonly MIN_ECHO_LENGTH = 8;
  static readonly PATH_SEPARATOR = '.';
  static readonly CLIENT_ERROR_MIN = 400;
  static readonly CLIENT_ERROR_MAX = 499;
  static readonly IDENTIFIER_NAMES: ReadonlySet<string> = new Set([
    'username', 'user', 'userid', 'login', 'loginid', 'loginname', 'email', 'mail', 'emailaddress', 'useremail', 'account', 'accountname',
    'identifier', 'handle', 'phone', 'phonenumber', 'mobile',
  ]);

  readonly #cookies: CookieClassifier;
  readonly #body: BodyParser;
  readonly #headers: HeaderPolicy;
  readonly #redactor: Redactor;

  constructor(deps: CredentialAnalyzerDeps) {
    this.#cookies = deps.cookies;
    this.#body = deps.body;
    this.#headers = deps.headers;
    this.#redactor = deps.redactor;
  }

  static create(): CredentialAnalyzer {
    const tokens = new TokenDetector();
    return new CredentialAnalyzer({ cookies: new CookieClassifier(), body: BodyParser.create(), headers: new HeaderPolicy({ tokens }), redactor: new Redactor(true, { tokens }) });
  }

  static ordered(exchanges: readonly Exchange[]): Exchange[] {
    return exchanges
      .map((exchange, index) => ({ exchange, index }))
      .sort((a, b) => Text.compare(a.exchange.startedAt, b.exchange.startedAt) || a.index - b.index)
      .map((item) => item.exchange);
  }

  static sent(exchange: Exchange): Sent[] {
    return Http.parseCookieHeader(Http.getHeader(exchange.request.headers, 'cookie')).filter((cookie) => cookie.name !== '');
  }

  static setCookies(exchange: Exchange): Sent[] {
    const response = exchange.response;
    if (!response) return [];
    const out: Sent[] = [];
    for (const value of Http.getHeaderAll(response.headers, 'set-cookie')) {
      for (const line of value.split('\n')) {
        const cookie = CookieParser.tokenize(line);
        if (cookie && cookie.name !== '') out.push({ name: cookie.name, value: cookie.value });
      }
    }
    return out;
  }

  static isIdentifierName(name: string): boolean {
    return CredentialAnalyzer.IDENTIFIER_NAMES.has(Text.letterWords(name).join(''));
  }

  static isSignOut(exchange: Exchange): boolean {
    const url = Http.parseUrl(exchange.request.url);
    return url !== undefined && CredentialAnalyzer.SIGN_OUT.test(Http.decodeComponent(url.pathname));
  }

  analyze(capture: Pick<Capture, 'exchanges' | 'cookies'>, input: CredentialInput = {}): CredentialEvidence {
    const ordered = CredentialAnalyzer.ordered(capture.exchanges);
    const roles = this.#roles(capture, ordered);
    const classify = (name: string): CookieRole => this.#cookies.classify(name);
    const role = (name: string): CookieRole => roles.get(name) ?? classify(name);
    const positions = new Map(ordered.map((exchange, at) => [exchange, at]));
    const generations = this.#generations(ordered, role, input);
    return new CredentialEvidence({ roles, generations, positions, loginPages: input.loginPages ?? new Set(), classify });
  }

  isCredentialSubmission(exchange: Exchange, input: CredentialInput = {}): boolean {
    for (const header of exchange.request.headers) {
      if (header.value.trim() !== '' && (CredentialAnalyzer.SCHEME_HEADERS.has(header.name.toLowerCase()) || this.#headers.isAuth(header.name))) return true;
    }
    const url = Http.parseUrl(exchange.request.url);
    if (url) {
      for (const [name, value] of url.searchParams) {
        if (value === '') continue;
        if (this.#isPassword(name, input) || (Redactor.CALLBACK_SECRET_NAMES.has(name.toLowerCase()) && this.#redactor.isSecretQueryParam(name, url))) return true;
      }
    }
    let parsed;
    try {
      parsed = this.#body.request(exchange.request);
    } catch {
      return false;
    }
    if (!CredentialAnalyzer.FIELD_KINDS.has(parsed.kind)) return false;
    return this.#hasPassword(parsed.value, input);
  }

  loginSubmission(exchange: Exchange, input: CredentialInput = {}): LoginSubmission | undefined {
    const entries = this.#fieldEntries(exchange);
    const passwords = entries.filter((entry) => this.#isPassword(entry.key, input) && CredentialAnalyzer.#filled(entry.value));
    const [password] = passwords;
    if (passwords.length !== 1 || password === undefined) return undefined;
    const siblings = entries.filter((entry) => entry !== password && entry.container === password.container);
    const identifier = siblings.find((entry) => input.identifierFields?.has(entry.key) === true) ?? siblings.find((entry) => CredentialAnalyzer.isIdentifierName(entry.key));
    const personal = siblings.filter((entry) => entry === identifier || input.personalFields?.has(entry.key) === true);
    const values = [password, ...personal].flatMap((entry) => CredentialAnalyzer.#strings(entry.value).map((value) => ({ name: entry.key, value, password: entry === password })));
    return identifier ? { password: password.path, identifier: identifier.path, values } : { password: password.path, values };
  }

  #fieldEntries(exchange: Exchange): FieldEntry[] {
    const out: FieldEntry[] = [];
    const url = Http.parseUrl(exchange.request.url);
    if (url && url.search.length > 1) {
      const query: Record<string, string[]> = {};
      for (const [name, value] of url.searchParams) (query[name] ??= []).push(value);
      CredentialAnalyzer.#walk(query, [], out);
    }
    let parsed;
    try {
      parsed = this.#body.request(exchange.request);
    } catch {
      return out;
    }
    if (CredentialAnalyzer.FIELD_KINDS.has(parsed.kind)) CredentialAnalyzer.#walk(parsed.value, [], out);
    return out;
  }

  static #walk(value: unknown, path: readonly string[], out: FieldEntry[]): void {
    if (Array.isArray(value)) {
      for (const item of value) CredentialAnalyzer.#walk(item, path, out);
      return;
    }
    if (!Json.isPlainObject(value) || BodyParser.isUploadedFile(value)) return;
    for (const [key, item] of Object.entries(value)) {
      const at = [...path, key];
      out.push({ path: at.join(CredentialAnalyzer.PATH_SEPARATOR), key, value: item, container: value });
      CredentialAnalyzer.#walk(item, at, out);
    }
  }

  static #strings(value: unknown): string[] {
    if (Array.isArray(value)) return value.flatMap((item) => (Array.isArray(item) ? [] : CredentialAnalyzer.#strings(item)));
    if (typeof value === 'string') return value === '' ? [] : [value];
    return typeof value === 'number' ? [String(value)] : [];
  }

  static #refused(exchange: Exchange, loginPages: ReadonlySet<string>): boolean {
    const status = exchange.response?.status;
    if (status !== undefined && status >= CredentialAnalyzer.CLIENT_ERROR_MIN && status <= CredentialAnalyzer.CLIENT_ERROR_MAX) return true;
    const target = CredentialEvidence.redirectTarget(exchange);
    return target !== undefined && CredentialEvidence.loginPage(target, loginPages);
  }

  #hasPassword(value: unknown, input: CredentialInput): boolean {
    if (Array.isArray(value)) return value.some((item) => this.#hasPassword(item, input));
    if (!Json.isPlainObject(value) || BodyParser.isUploadedFile(value)) return false;
    return Object.entries(value).some(([key, item]) => {
      if (this.#isPassword(key, input) && CredentialAnalyzer.#filled(item)) return true;
      return this.#hasPassword(item, input);
    });
  }

  #isPassword(name: string, input: CredentialInput): boolean {
    return input.passwordFields?.has(name) === true || SecretNames.isPassword(name);
  }

  static #filled(value: unknown): boolean {
    if (Array.isArray(value)) return value.some((item) => CredentialAnalyzer.#filled(item));
    return (typeof value === 'string' && value !== '') || typeof value === 'number';
  }

  #roles(capture: Pick<Capture, 'exchanges' | 'cookies'>, ordered: readonly Exchange[]): Map<string, CookieRole> {
    const names = new Set<string>(capture.cookies.map((cookie) => cookie.name));
    for (const exchange of ordered) for (const cookie of CredentialAnalyzer.sent(exchange)) names.add(cookie.name);
    const roles = new Map<string, CookieRole>();
    let texts: string[] | undefined;
    for (const name of names) {
      const role = this.#cookies.classify(name);
      roles.set(name, role);
      if (!CredentialEvidence.CREDENTIAL_ROLES.has(role)) continue;
      if (!this.#clientCreated(name, capture, ordered)) continue;
      texts ??= CredentialAnalyzer.#responseTexts(ordered);
      const values = new Set([...capture.cookies.filter((cookie) => cookie.name === name).map((cookie) => cookie.value), ...ordered.flatMap((exchange) => CredentialAnalyzer.sent(exchange).filter((cookie) => cookie.name === name).map((cookie) => cookie.value))]);
      const echoed = [...values].some((value) => value.length < CredentialAnalyzer.MIN_ECHO_LENGTH || texts!.some((text) => text.includes(value)));
      if (!echoed) roles.set(name, CredentialAnalyzer.CLIENT_ROLE);
    }
    return roles;
  }

  #clientCreated(name: string, capture: Pick<Capture, 'exchanges' | 'cookies'>, ordered: readonly Exchange[]): boolean {
    if (capture.cookies.some((cookie) => cookie.name === name && cookie.httpOnly)) return false;
    if (ordered.some((exchange) => CredentialAnalyzer.setCookies(exchange).some((cookie) => cookie.name === name))) return false;
    const first = ordered.findIndex((exchange) => CredentialAnalyzer.sent(exchange).some((cookie) => cookie.name === name));
    if (first <= 0) return false;
    const carrier = Http.parseUrl(ordered[first]?.request.url ?? '');
    const jar = capture.cookies.filter((cookie) => cookie.name === name);
    return ordered.slice(0, first).some((exchange) => {
      const url = Http.parseUrl(exchange.request.url);
      if (!url || !Http.reachedServer(exchange)) return false;
      if (jar.length > 0) return jar.some((cookie) => CookieInventory.applies(cookie, url));
      return carrier !== undefined && url.host === carrier.host;
    });
  }

  static #responseTexts(ordered: readonly Exchange[]): string[] {
    return ordered.map((exchange) => {
      const response = exchange.response;
      if (!response) return '';
      const headers = response.headers.map((header) => header.value).join('\n');
      return headers + '\n' + (response.body ? Buffer.from(Http.bodyBytes(response.body)).toString('latin1') : '');
    });
  }

  #generations(ordered: readonly Exchange[], role: (name: string) => CookieRole, input: CredentialInput): Map<string, GenerationEvent[]> {
    const generations = new Map<string, GenerationEvent[]>();
    const credential = (name: string): boolean => CredentialEvidence.CREDENTIAL_ROLES.has(role(name));
    const current = (name: string, value: string): GenerationEvent | undefined => generations.get(CredentialEvidence.key(name, value))?.at(-1);
    ordered.forEach((exchange, at) => {
      const set = CredentialAnalyzer.setCookies(exchange).filter((cookie) => cookie.value !== '' && credential(cookie.name));
      if (set.length === 0) return;
      const carried = CredentialAnalyzer.sent(exchange).some((cookie) => credential(cookie.name) && cookie.value !== '' && current(cookie.name, cookie.value)?.generation !== 'anonymous');
      const submitted = this.isCredentialSubmission(exchange, input) && !CredentialAnalyzer.#refused(exchange, input.loginPages ?? new Set());
      const authenticated = submitted || (carried && !CredentialAnalyzer.isSignOut(exchange));
      for (const cookie of set) {
        const key = CredentialEvidence.key(cookie.name, cookie.value);
        const events = generations.get(key) ?? [];
        events.push({ at, generation: authenticated ? 'authenticated' : 'anonymous' });
        generations.set(key, events);
      }
    });
    return generations;
  }
}
