import type { Capture, CookieRole, Exchange } from '../model/index.js';
import { CookieParser } from '../capture/index.js';
import { TokenDetector } from '../forms/index.js';
import { Http, Json, Text } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { CookieClassifier } from './cookie-classifier.js';
import { CookieInventory } from './cookie-inventory.js';
import { CredentialEvidence } from './credential-evidence.js';
import type { CookieGeneration } from './credential-evidence.js';
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
}

interface Sent {
  readonly name: string;
  readonly value: string;
}

export class CredentialAnalyzer {
  static readonly SIGN_OUT: RegExp = /(?:^|[^a-z])(?:log|sign)[-_.]?(?:out|off)(?:[^a-z]|$)/i;
  static readonly PASSWORD_WORDS: ReadonlySet<string> = new Set(['password', 'passwd', 'passphrase', 'passcode', 'pass', 'pwd', 'pw']);
  static readonly PASSWORD_STEMS: readonly string[] = ['password', 'passwd', 'passphrase'];
  static readonly CLIENT_ROLE: CookieRole = 'tracking';
  static readonly FIELD_KINDS: ReadonlySet<string> = new Set(['form', 'multipart', 'json', 'graphql']);
  static readonly SCHEME_HEADERS: ReadonlySet<string> = new Set(['authorization']);
  static readonly MIN_ECHO_LENGTH = 8;

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

  static isSignOut(exchange: Exchange): boolean {
    const url = Http.parseUrl(exchange.request.url);
    return url !== undefined && CredentialAnalyzer.SIGN_OUT.test(Http.decodeComponent(url.pathname));
  }

  analyze(capture: Pick<Capture, 'exchanges' | 'cookies'>, input: CredentialInput = {}): CredentialEvidence {
    const ordered = CredentialAnalyzer.ordered(capture.exchanges);
    const roles = this.#roles(capture, ordered);
    const classify = (name: string): CookieRole => this.#cookies.classify(name);
    const role = (name: string): CookieRole => roles.get(name) ?? classify(name);
    const generations = this.#generations(ordered, role, input);
    return new CredentialEvidence({ roles, generations, loginPages: input.loginPages ?? new Set(), classify });
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

  #hasPassword(value: unknown, input: CredentialInput): boolean {
    if (Array.isArray(value)) return value.some((item) => this.#hasPassword(item, input));
    if (!Json.isPlainObject(value) || BodyParser.isUploadedFile(value)) return false;
    return Object.entries(value).some(([key, item]) => {
      if (this.#isPassword(key, input) && CredentialAnalyzer.#filled(item)) return true;
      return this.#hasPassword(item, input);
    });
  }

  #isPassword(name: string, input: CredentialInput): boolean {
    if (input.passwordFields?.has(name) === true) return true;
    const words = Text.letterWords(name);
    if (words.some((word) => CredentialAnalyzer.PASSWORD_WORDS.has(word))) return true;
    const lower = name.toLowerCase();
    return CredentialAnalyzer.PASSWORD_STEMS.some((stem) => lower.includes(stem));
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

  #generations(ordered: readonly Exchange[], role: (name: string) => CookieRole, input: CredentialInput): Map<string, CookieGeneration> {
    const generations = new Map<string, CookieGeneration>();
    const credential = (name: string): boolean => CredentialEvidence.CREDENTIAL_ROLES.has(role(name));
    for (const exchange of ordered) {
      const set = CredentialAnalyzer.setCookies(exchange).filter((cookie) => cookie.value !== '' && credential(cookie.name));
      if (set.length === 0) continue;
      const fresh = set.filter((cookie) => !generations.has(CredentialEvidence.key(cookie.name, cookie.value)));
      if (fresh.length === 0) continue;
      const carried = CredentialAnalyzer.sent(exchange).some((cookie) => credential(cookie.name) && cookie.value !== '' && generations.get(CredentialEvidence.key(cookie.name, cookie.value)) !== 'anonymous');
      const authenticated = this.isCredentialSubmission(exchange, input) || (carried && !CredentialAnalyzer.isSignOut(exchange));
      for (const cookie of fresh) generations.set(CredentialEvidence.key(cookie.name, cookie.value), authenticated ? 'authenticated' : 'anonymous');
    }
    return generations;
  }
}
