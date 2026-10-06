export class TsClientRuntime {
  static readonly IDENTIFIERS: readonly string[] = [
    'HttpStatus',
    'ApiResponse',
    'ClientOptions',
    'RedirectMode',
    'AccessToken',
    'ResponseFor',
    'MissingCredentialError',
    'MissingLoginError',
    'LoginSpec',
    'ValidateOptions',
    'RequestInput',
    'ValidityCode',
    'FieldError',
    'ValidationError',
    'MissingToken',
    'MissingTokenError',
    'StaleTokens',
    'PageToken',
    'LoadedDocument',
    'StoredCookie',
    'CookieJar',
    'BaseApiClient',
    'FieldRule',
    'FieldEntry',
    'FormEntry',
    'SubmitterSpec',
    'FormCondition',
    'FormVariant',
    'FormIdentity',
    'FormCharset',
    'FormSpec',
    'CsrfSpec',
    'BodySpec',
    'EndpointSpec',
    'ScannedForm',
    'ScannedInput',
    'HtmlScan',
    'HtmlTag',
    'HtmlFrame',
    'HtmlFieldset',
    'FetchedDocument',
    'StoredDocument',
    'TokenState',
    'RequestContext',
    'Exchanged',
    'Problem',
    'AppiiRuntime',
    'AppiiHtml',
    'AppiiForms',
    'PRIMARY_ORIGIN',
    'DEFAULT_BASE_URL',
    'REGISTRABLE_DOMAINS',
    'SINGLE_BYTE_INDEXES',
    'NAMED_REFERENCES',
  ];

  static readonly CLIENT_MEMBERS: readonly string[] = ['constructor', 'cookies', 'base', 'resolve', 'clearTokens', 'refreshTokens', 'send'];

  static readonly PUBLIC_TYPES = String.raw`export interface ApiResponse<S extends number = number, T = unknown> {
  status: S;
  ok: boolean;
  url: string;
  redirected: boolean;
  headers: Headers;
  data: T;
  staleTokens?: StaleTokens;
}

export interface StaleTokens {
  tokens: string[];
  pages: string[];
  message: string;
}

export type RedirectMode = 'follow' | 'manual';

export type ResponseFor<R extends RedirectMode, Follow, Manual> = R extends 'manual' ? Manual : Follow;

export type AccessToken = string | (() => string | undefined | Promise<string | undefined>);

export interface ClientOptions<R extends RedirectMode = RedirectMode> {
  baseUrl?: string;
  origins?: Record<string, string>;
  headers?: Record<string, string>;
  cookies?: string;
  accessToken?: AccessToken;
  fetch?: typeof fetch;
  validate?: boolean;
  unsafePatterns?: boolean;
  redirect?: R;
  maxRedirects?: number;
  encoders?: Record<string, (text: string) => ArrayLike<number>>;
  registrableDomain?: (host: string) => string | undefined;
}

export interface ValidateOptions {
  unsafePatterns?: boolean;
}

export interface RequestInput {
  params?: object;
  query?: object;
  contentType?: string;
  body?: unknown;
  headers?: Record<string, string | undefined>;
  accessToken?: string;
}

export type ValidityCode =
  | 'valueMissing'
  | 'typeMismatch'
  | 'patternMismatch'
  | 'tooLong'
  | 'tooShort'
  | 'rangeUnderflow'
  | 'rangeOverflow'
  | 'stepMismatch'
  | 'badInput';

export interface FieldError {
  field: string;
  code: ValidityCode;
  message: string;
  label?: string;
  hint?: string;
}

export class ValidationError extends Error {
  readonly errors: FieldError[];
  readonly fields: Record<string, string>;

  constructor(errors: FieldError[]) {
    super(errors.length === 0 ? 'Validation failed' : errors.map((error) => error.field + ': ' + error.message).join('\n'));
    this.name = 'ValidationError';
    this.errors = errors;
    this.fields = Object.fromEntries([...errors].reverse().map((error) => [error.field, error.message]));
  }
}

export interface MissingToken {
  token: string;
  source: string;
  call?: string;
  expected?: string;
}

export class MissingTokenError extends Error {
  readonly response: ApiResponse;
  readonly missing: MissingToken[];

  constructor(response: ApiResponse, missing: MissingToken[]) {
    const steps = missing.map((item) =>
      item.expected !== undefined
        ? 'The client did not send the token ' + item.token + '. It loaded ' + item.source + ' and found no ' + item.expected + '. Give ' + item.token + ' in the request to send it.'
        : 'The client did not send the token ' + item.token + '. This token comes from the response of ' + item.source + '. ' +
          (item.call === undefined ? 'Send that request first.' : 'Call ' + item.call + '() first.'),
    );
    super(['The server rejected the request with status ' + response.status + '.', ...steps].join(' '));
    this.name = 'MissingTokenError';
    this.response = response;
    this.missing = missing;
  }
}

export class MissingCredentialError extends Error {
  readonly endpoint: string;

  constructor(endpoint: string) {
    super(
      'The endpoint ' + endpoint + ' needs a bearer token, and the client has none, so it sent no request. ' +
        'Log in through this client first, or pass accessToken in the client options or in the request, or set the authorization header.',
    );
    this.name = 'MissingCredentialError';
    this.endpoint = endpoint;
  }
}

export class MissingLoginError extends Error {
  readonly endpoint: string;
  readonly field: string;

  constructor(endpoint: string, field: string, label: string) {
    super('The login ' + endpoint + ' needs ' + label + ' in the field ' + field + ', so it sent no request. The client has no default for it: pass it in the request.');
    this.name = 'MissingLoginError';
    this.endpoint = endpoint;
    this.field = field;
  }
}`;

  static readonly SPEC_TYPES = String.raw`interface FieldRule {
  name: string;
  type: string;
  label?: string;
  hint?: string;
  required?: boolean;
  list?: boolean;
  itemRequired?: boolean;
  unique?: boolean;
  maxItems?: number;
  contains?: string[];
  options?: string[];
  constant?: string;
  pattern?: string;
  unsafePattern?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  base?: string;
  multiple?: boolean;
}

interface FieldEntry {
  name: string;
  type: string;
  constant?: string;
}

interface FormEntry {
  name: string;
  value: string | Blob;
  filename?: string;
}

interface SubmitterSpec {
  name: string;
  value: string;
  noValidate: boolean;
  query?: Record<string, string>;
}

interface FormCondition {
  name: string;
  values?: string[];
}

interface FormVariant {
  when: FormCondition;
  noValidate: boolean;
  rules: FieldRule[];
  fields: FieldEntry[];
  defaults: Record<string, unknown>;
}

interface FormIdentity {
  index?: number;
  id?: string;
  name?: string;
}

interface FormCharset {
  name: string;
}

interface FormSpec {
  target: 'body' | 'query';
  noValidate: boolean;
  enctype: string;
  charset: FormCharset;
  page?: string;
  form?: FormIdentity;
  rules: FieldRule[];
  fields: FieldEntry[];
  submitters: SubmitterSpec[];
  variants?: FormVariant[];
}

interface CsrfSpec {
  location: 'header' | 'body' | 'query';
  name: string;
  source: string;
  sourceName?: string;
  sourceUrl?: string;
  sourceMethod?: string;
  sourceKey?: string;
  sourceCall?: string;
  seed?: string;
}

interface LoginSpec {
  identifier?: string;
  password?: string;
  tokens: string[];
}

interface BodySpec {
  kind: string;
  mimeType: string;
  contentType?: string;
  jsonLines?: boolean;
  defaults?: Record<string, unknown>;
}

interface EndpointSpec {
  name: string;
  method: string;
  origin: string;
  path: string;
  mode: 'navigate' | 'cors' | 'no-cors';
  page?: string;
  tokenKey?: string;
  headers: Record<string, string>;
  query: Record<string, unknown>;
  body?: BodySpec;
  bodies?: BodySpec[];
  bearer?: 'required' | 'optional';
  login?: LoginSpec;
  logout?: boolean;
  jsonLines?: number[];
  csrf: CsrfSpec[];
  form?: FormSpec;
}

interface ScannedForm {
  index: number;
  id?: string;
  name?: string;
}

interface ScannedInput {
  name: string;
  value?: string;
  owner: number;
  ownerId?: string;
}

interface HtmlFrame {
  name: string;
  space: 'svg' | 'math';
  integration: boolean;
}

interface HtmlFieldset {
  disabled: boolean;
  legend: 'none' | 'open' | 'closed';
}

interface HtmlScan {
  forms: ScannedForm[];
  inputs: ScannedInput[];
  metas: [string, string][];
}

interface HtmlTag {
  name: string;
  attributes: Map<string, string>;
  end: number;
  selfClosing: boolean;
}

interface FetchedDocument {
  headers: Headers;
  text: string;
  scan?: HtmlScan;
}

interface StoredDocument {
  cookie: string;
  document: FetchedDocument;
}

interface LoadedDocument {
  document: FetchedDocument;
  cached: boolean;
}

interface PageToken {
  token: string;
  page: string;
}

interface TokenState {
  cached: PageToken[];
  missing: MissingToken[];
}

interface RequestContext {
  mode: string;
  page?: string;
  explicit: ReadonlySet<string>;
}

interface Exchanged {
  response: Response;
  url: string;
  redirected: boolean;
}

type Problem = [ValidityCode, string];`;

  static readonly COOKIES = String.raw`export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  hostOnly: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  expires?: number;
  created: number;
}

export class CookieJar {
  static readonly MAX_AGE_SECONDS = 34560000;
  static readonly MAX_NAME_VALUE_LENGTH = 4096;
  static readonly MAX_ATTRIBUTE_LENGTH = 1024;
  static readonly MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  #cookies: StoredCookie[] = [];
  #sequence = 0;
  readonly #site: (host: string) => string | undefined;

  constructor(registrableDomain: (host: string) => string | undefined = CookieJar.knownSite) {
    this.#site = registrableDomain;
  }

  static knownSite(host: string): string | undefined {
    return Object.hasOwn(REGISTRABLE_DOMAINS, host) ? REGISTRABLE_DOMAINS[host] : undefined;
  }

  list(now: number = Date.now()): StoredCookie[] {
    this.#evict(now);
    return this.#cookies.map((cookie) => ({ ...cookie }));
  }

  get(name: string, url?: string, now: number = Date.now()): string | undefined {
    const candidates = url === undefined ? this.list(now) : this.#matching(url, now);
    return candidates.find((cookie) => cookie.name === name)?.value;
  }

  header(url: string, now: number = Date.now()): string {
    return this.#matching(url, now)
      .map((cookie) => (cookie.name === '' ? cookie.value : cookie.name + '=' + cookie.value))
      .join('; ');
  }

  clear(): void {
    this.#cookies = [];
  }

  load(header: string, url: string): void {
    const target = CookieJar.#url(url);
    if (!target) return;
    for (const part of header.split(';')) {
      const pair = CookieJar.#trim(part);
      if (pair === '') continue;
      const eq = pair.indexOf('=');
      const name = eq < 0 ? '' : CookieJar.#trim(pair.slice(0, eq));
      const value = eq < 0 ? pair : CookieJar.#trim(pair.slice(eq + 1));
      this.#put({ name, value, domain: target.hostname.toLowerCase(), path: '/', hostOnly: true, secure: false, httpOnly: false, created: 0 }, Date.now());
    }
  }

  store(headers: Headers, url: string, now: number = Date.now()): void {
    for (const line of CookieJar.setCookies(headers)) this.set(line, url, now);
  }

  static setCookies(headers: Headers): string[] {
    const getter = (headers as Headers & { getSetCookie?: () => string[] }).getSetCookie;
    if (typeof getter === 'function') return getter.call(headers);
    const joined = headers.get('set-cookie');
    return joined === null ? [] : joined.split(/,(?=\s*[^;,=\s]+=)/);
  }

  set(line: string, url: string, now: number = Date.now()): boolean {
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(line)) return false;
    const target = CookieJar.#url(url);
    if (!target) return false;
    const parts = line.split(';');
    const pair = parts[0] ?? '';
    const eq = pair.indexOf('=');
    const name = CookieJar.#trim(eq < 0 ? '' : pair.slice(0, eq));
    const value = CookieJar.#trim(eq < 0 ? pair : pair.slice(eq + 1));
    if ((name === '' && value === '') || name.length + value.length > CookieJar.MAX_NAME_VALUE_LENGTH) return false;
    let expires: number | undefined;
    let maxAge: number | undefined;
    let domain = '';
    let path: string | undefined;
    let pathAttribute = false;
    let secure = false;
    let httpOnly = false;
    let sameSite: StoredCookie['sameSite'];
    for (const attribute of parts.slice(1)) {
      const i = attribute.indexOf('=');
      const key = CookieJar.#trim(i < 0 ? attribute : attribute.slice(0, i)).toLowerCase();
      const raw = CookieJar.#trim(i < 0 ? '' : attribute.slice(i + 1));
      if (raw.length > CookieJar.MAX_ATTRIBUTE_LENGTH) continue;
      if (key === 'expires') {
        const date = CookieJar.parseDate(raw);
        if (date !== undefined) expires = date;
      } else if (key === 'max-age') {
        if (/^-?[0-9]+$/.test(raw)) maxAge = Number(raw);
      } else if (key === 'domain') {
        if (raw !== '') domain = raw.replace(/^\./, '').toLowerCase();
      } else if (key === 'path') {
        pathAttribute = true;
        path = raw.startsWith('/') ? raw : undefined;
      } else if (key === 'secure') {
        secure = true;
      } else if (key === 'httponly') {
        httpOnly = true;
      } else if (key === 'samesite') {
        const lower = raw.toLowerCase();
        sameSite = lower === 'strict' ? 'Strict' : lower === 'lax' ? 'Lax' : lower === 'none' ? 'None' : undefined;
      }
    }
    const limit = now + CookieJar.MAX_AGE_SECONDS * 1000;
    let expiry: number | undefined;
    if (maxAge !== undefined) expiry = maxAge <= 0 ? Number.NEGATIVE_INFINITY : Math.min(now + maxAge * 1000, limit);
    else if (expires !== undefined) expiry = Math.min(expires, limit);
    const host = target.hostname.toLowerCase();
    let hostOnly = true;
    let cookieDomain = host;
    if (domain !== '') {
      if (CookieJar.#isIp(host)) {
        if (domain !== host && '[' + domain + ']' !== host) return false;
      } else if (!CookieJar.domainMatches(host, domain)) {
        return false;
      } else {
        const site = this.#site(host);
        const registrable = site !== undefined && (domain === site || domain.endsWith('.' + site));
        if (!registrable && domain !== host) return false;
        if (registrable) {
          hostOnly = false;
          cookieDomain = domain;
        }
      }
    }
    const cookiePath = path ?? CookieJar.defaultPath(target.pathname);
    const secureOrigin = CookieJar.isSecure(target);
    if (secure && !secureOrigin) return false;
    if (sameSite === 'None' && !secure) return false;
    const lower = name.toLowerCase();
    if (name === '' && /^__(?:secure|host)-/i.test(value)) return false;
    if (lower.startsWith('__secure-') && !secure) return false;
    if (lower.startsWith('__host-') && !(secure && domain === '' && pathAttribute && cookiePath === '/')) return false;
    if (!secure && !secureOrigin) {
      for (const existing of this.#cookies) {
        if (existing.name !== name || !existing.secure) continue;
        const overlap = CookieJar.domainMatches(existing.domain, cookieDomain) || CookieJar.domainMatches(cookieDomain, existing.domain);
        if (overlap && CookieJar.pathMatches(cookiePath, existing.path)) return false;
      }
    }
    const cookie: StoredCookie = { name, value, domain: cookieDomain, path: cookiePath, hostOnly, secure, httpOnly, created: 0 };
    if (sameSite !== undefined) cookie.sameSite = sameSite;
    if (expiry !== undefined) cookie.expires = expiry;
    this.#put(cookie, now);
    return true;
  }

  static domainMatches(host: string, domain: string): boolean {
    if (host === domain) return true;
    return !CookieJar.#isIp(host) && host.endsWith('.' + domain);
  }

  static pathMatches(requestPath: string, cookiePath: string): boolean {
    if (requestPath === cookiePath) return true;
    if (!requestPath.startsWith(cookiePath)) return false;
    return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
  }

  static defaultPath(pathname: string): string {
    if (!pathname.startsWith('/')) return '/';
    const last = pathname.lastIndexOf('/');
    return last <= 0 ? '/' : pathname.slice(0, last);
  }

  static isSecure(url: URL): boolean {
    if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
    if (url.protocol !== 'http:' && url.protocol !== 'ws:') return false;
    const host = url.hostname.toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || /^127(?:\.[0-9]{1,3}){3}$/.test(host) || host === '[::1]';
  }

  static parseDate(input: string): number | undefined {
    let time: number[] | undefined;
    let day: number | undefined;
    let month: number | undefined;
    let year: number | undefined;
    for (const token of input.split(/[\x09\x20-\x2f\x3b-\x40\x5b-\x60\x7b-\x7e]+/)) {
      if (token === '') continue;
      if (time === undefined) {
        const match = /^([0-9]{1,2}):([0-9]{1,2}):([0-9]{1,2})(?:[^0-9].*)?$/.exec(token);
        if (match) {
          time = [Number(match[1]), Number(match[2]), Number(match[3])];
          continue;
        }
      }
      if (day === undefined) {
        const match = /^([0-9]{1,2})(?:[^0-9].*)?$/.exec(token);
        if (match) {
          day = Number(match[1]);
          continue;
        }
      }
      if (month === undefined && token.length >= 3) {
        const index = CookieJar.MONTHS.indexOf(token.slice(0, 3).toLowerCase());
        if (index >= 0) {
          month = index;
          continue;
        }
      }
      if (year === undefined) {
        const match = /^([0-9]{2,4})(?:[^0-9].*)?$/.exec(token);
        if (match) {
          year = Number(match[1]);
          continue;
        }
      }
    }
    if (time === undefined || day === undefined || month === undefined || year === undefined) return undefined;
    if (year >= 70 && year <= 99) year += 1900;
    else if (year >= 0 && year <= 69) year += 2000;
    const [hour = 0, minute = 0, second = 0] = time;
    if (day < 1 || day > 31 || year < 1601 || hour > 23 || minute > 59 || second > 59) return undefined;
    const date = new Date(Date.UTC(year, month, day, hour, minute, second));
    return date.getUTCDate() === day ? date.getTime() : undefined;
  }

  #put(cookie: StoredCookie, now: number): void {
    const index = this.#cookies.findIndex(
      (existing) => existing.name === cookie.name && existing.domain === cookie.domain && existing.hostOnly === cookie.hostOnly && existing.path === cookie.path,
    );
    if (index >= 0) {
      cookie.created = this.#cookies[index]?.created ?? ++this.#sequence;
      this.#cookies.splice(index, 1);
    } else {
      cookie.created = ++this.#sequence;
    }
    if (cookie.expires !== undefined && cookie.expires <= now) return;
    this.#cookies.push(cookie);
  }

  #matching(url: string, now: number): StoredCookie[] {
    this.#evict(now);
    const target = CookieJar.#url(url);
    if (!target) return [];
    const host = target.hostname.toLowerCase();
    const secure = CookieJar.isSecure(target);
    return this.#cookies
      .filter(
        (cookie) =>
          (cookie.hostOnly ? host === cookie.domain : CookieJar.domainMatches(host, cookie.domain)) &&
          CookieJar.pathMatches(target.pathname, cookie.path) &&
          (!cookie.secure || secure),
      )
      .sort((a, b) => b.path.length - a.path.length || a.created - b.created);
  }

  #evict(now: number): void {
    this.#cookies = this.#cookies.filter((cookie) => cookie.expires === undefined || cookie.expires > now);
  }

  static #trim(value: string): string {
    return value.replace(/^[ \t]+|[ \t]+$/g, '');
  }

  static #url(url: string): URL | undefined {
    try {
      return new URL(url);
    } catch {
      return undefined;
    }
  }

  static #isIp(host: string): boolean {
    return host.startsWith('[') || /^[0-9]{1,3}(?:\.[0-9]{1,3}){3}$/.test(host);
  }
}`;

  static readonly HELPERS = String.raw`class AppiiRuntime {
  static readonly REQUEST_BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language', 'content-location'];
  static readonly NO_BODY_STATUSES = [204, 205, 304];
  static readonly REFERRER_POLICIES = [
    'no-referrer',
    'no-referrer-when-downgrade',
    'same-origin',
    'origin',
    'strict-origin',
    'origin-when-cross-origin',
    'strict-origin-when-cross-origin',
    'unsafe-url',
  ];
  static readonly DEFAULT_POLICY = 'strict-origin-when-cross-origin';
  static readonly DOWNGRADE_POLICIES = ['no-referrer-when-downgrade', 'strict-origin', 'strict-origin-when-cross-origin'];
  static readonly MAX_REFERRER_LENGTH = 4096;
  static readonly UTF8 = 'utf-8';
  static readonly FIRST_HIGH_BYTE = 0x80;
  static readonly UNMAPPED = 0xfffd;

  static isRecord(value: unknown): value is Record<string, unknown> {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const proto: unknown = Object.getPrototypeOf(value);
    return proto === Object.prototype || proto === null;
  }

  static clone<T>(value: T): T {
    return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  }

  static merge(defaults: Record<string, unknown> | undefined, value: unknown): unknown {
    if (defaults === undefined) return value;
    if (value === undefined) return AppiiRuntime.clone(defaults);
    if (AppiiRuntime.isRecord(value)) return { ...AppiiRuntime.clone(defaults), ...value };
    return value;
  }

  static blank(value: unknown): boolean {
    return value === undefined || value === null || value === '';
  }

  static text(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'object' && value !== null) return JSON.stringify(value);
    return String(value);
  }

  static url(value: string, base?: string): URL | undefined {
    try {
      return new URL(value, base);
    } catch {
      return undefined;
    }
  }

  static crlf(value: string): string {
    return value.replace(/\r\n|\r|\n/g, '\r\n');
  }

  static query(values: Record<string, unknown>): string {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(values)) {
      for (const item of Array.isArray(value) ? value : [value]) {
        if (item !== undefined && item !== null) params.append(name, AppiiRuntime.text(item));
      }
    }
    return params.toString();
  }

  static bytes(source: ArrayLike<number>) {
    return Uint8Array.from(source);
  }

  static ascii(text: string) {
    return AppiiRuntime.bytes(new TextEncoder().encode(text));
  }

  static encoder(charset: FormCharset | undefined, custom: Record<string, (text: string) => ArrayLike<number>> | undefined): (text: string) => ArrayLike<number> {
    const name = charset?.name ?? AppiiRuntime.UTF8;
    const lower = name.toLowerCase();
    if (lower === AppiiRuntime.UTF8) return (text) => new TextEncoder().encode(text);
    const own = Object.entries(custom ?? {}).find(([key]) => key.toLowerCase() === lower)?.[1];
    if (own !== undefined) return own;
    const high = AppiiRuntime.index(name);
    if (high === undefined) {
      throw new TypeError('The form sends text in the ' + name + ' character encoding. This client has no table for ' + name + '. Give an encoder in options.encoders["' + name + '"].');
    }
    const table = new Map<number, number>();
    for (let i = 0; i < high.length; i++) {
      const code = high.charCodeAt(i);
      if (code !== AppiiRuntime.UNMAPPED && !table.has(code)) table.set(code, AppiiRuntime.FIRST_HIGH_BYTE + i);
    }
    return (text) => {
      const out: number[] = [];
      for (const ch of text) {
        let cp = ch.codePointAt(0) ?? 0;
        if (cp >= 0xd800 && cp <= 0xdfff) cp = AppiiRuntime.UNMAPPED;
        const byte = cp < AppiiRuntime.FIRST_HIGH_BYTE ? cp : table.get(cp);
        if (byte !== undefined) out.push(byte);
        else for (const unit of '&#' + cp + ';') out.push(unit.charCodeAt(0));
      }
      return out;
    };
  }

  static percent(bytes: ArrayLike<number>): string {
    let out = '';
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i] ?? 0;
      if (byte === 0x20) out += '+';
      else if ((byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a) || byte === 0x2a || byte === 0x2d || byte === 0x2e || byte === 0x5f) {
        out += String.fromCharCode(byte);
      } else out += '%' + (byte < 0x10 ? '0' : '') + byte.toString(16).toUpperCase();
    }
    return out;
  }

  static urlencoded(entries: readonly FormEntry[], normalize: boolean, encode: (text: string) => ArrayLike<number>): string {
    return entries
      .map((entry) => {
        const name = normalize ? AppiiRuntime.crlf(entry.name) : entry.name;
        const raw = typeof entry.value === 'string' ? entry.value : '';
        const value = normalize ? AppiiRuntime.crlf(raw) : raw;
        return AppiiRuntime.percent(encode(name)) + '=' + AppiiRuntime.percent(encode(value));
      })
      .join('&');
  }

  static multipart(entries: readonly FormEntry[], encode: (text: string) => ArrayLike<number>): { body: Blob; contentType: string } {
    const boundary = '----WebKitFormBoundary' + AppiiRuntime.random(16);
    const parts: (ReturnType<typeof AppiiRuntime.bytes> | Blob)[] = [];
    for (const entry of entries) {
      parts.push(
        AppiiRuntime.ascii('--' + boundary + '\r\nContent-Disposition: form-data; name="'),
        AppiiRuntime.bytes(encode(AppiiRuntime.escapeName(AppiiRuntime.crlf(entry.name)))),
      );
      if (typeof entry.value === 'string') {
        parts.push(AppiiRuntime.ascii('"\r\n\r\n'), AppiiRuntime.bytes(encode(AppiiRuntime.crlf(entry.value))), AppiiRuntime.ascii('\r\n'));
      } else {
        const type = entry.value.type === '' ? 'application/octet-stream' : entry.value.type;
        parts.push(
          AppiiRuntime.ascii('"; filename="'),
          AppiiRuntime.bytes(encode(AppiiRuntime.escapeName(entry.filename ?? 'blob'))),
          AppiiRuntime.ascii('"\r\nContent-Type: ' + type + '\r\n\r\n'),
          entry.value,
          AppiiRuntime.ascii('\r\n'),
        );
      }
    }
    parts.push(AppiiRuntime.ascii('--' + boundary + '--\r\n'));
    return { body: new Blob(parts), contentType: 'multipart/form-data; boundary=' + boundary };
  }

  static textPlain(entries: readonly FormEntry[], encode: (text: string) => ArrayLike<number>) {
    let text = '';
    for (const entry of entries) text += AppiiRuntime.crlf(entry.name) + '=' + (typeof entry.value === 'string' ? AppiiRuntime.crlf(entry.value) : '') + '\r\n';
    return AppiiRuntime.bytes(encode(text));
  }

  static escapeName(value: string): string {
    return value.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
  }

  static random(length: number): string {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const bytes = new Uint8Array(length);
    if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(bytes);
    else for (let i = 0; i < length; i++) bytes[i] = Math.floor(Math.random() * 256);
    let out = '';
    for (const byte of bytes) out += alphabet.charAt(byte % alphabet.length);
    return out;
  }

  static decodeCookie(value: string): string {
    if (!value.includes('%')) return value;
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  static at(value: unknown, path: string): string | undefined {
    let current: unknown = value;
    for (const key of path.split('.')) {
      if (!AppiiRuntime.isRecord(current) || !Object.hasOwn(current, key)) return undefined;
      current = current[key];
    }
    return typeof current === 'string' && current !== '' ? current : undefined;
  }

  static find(value: unknown, key: string, depth = 0): string | undefined {
    if (depth > 8) return undefined;
    if (Array.isArray(value)) {
      for (const item of value) {
        const found = AppiiRuntime.find(item, key, depth + 1);
        if (found !== undefined) return found;
      }
      return undefined;
    }
    if (!AppiiRuntime.isRecord(value)) return undefined;
    const direct = value[key];
    if (typeof direct === 'string' && direct !== '') return direct;
    for (const item of Object.values(value)) {
      const found = AppiiRuntime.find(item, key, depth + 1);
      if (found !== undefined) return found;
    }
    return undefined;
  }

  static async read(response: Response, method: string): Promise<Uint8Array | undefined> {
    if (method === 'HEAD' || AppiiRuntime.NO_BODY_STATUSES.includes(response.status)) {
      await response.arrayBuffer().catch(() => undefined);
      return undefined;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  static index(label: string): string | undefined {
    let name: string;
    try {
      name = new TextDecoder(label).encoding;
    } catch {
      name = label.trim().toLowerCase();
    }
    return Object.hasOwn(SINGLE_BYTE_INDEXES, name) ? SINGLE_BYTE_INDEXES[name] : undefined;
  }

  static decode(bytes: Uint8Array, contentType: string): string {
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/i.exec(contentType)?.[1] ?? AppiiRuntime.UTF8;
    const high = AppiiRuntime.index(charset);
    if (high !== undefined) {
      let out = '';
      for (const byte of bytes) out += byte < AppiiRuntime.FIRST_HIGH_BYTE ? String.fromCharCode(byte) : high.charAt(byte - AppiiRuntime.FIRST_HIGH_BYTE);
      return out;
    }
    try {
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return new TextDecoder(AppiiRuntime.UTF8).decode(bytes);
    }
  }

  static jsonLines(bytes: Uint8Array | undefined, contentType: string): unknown {
    if (bytes === undefined || bytes.byteLength === 0) return undefined;
    const text = AppiiRuntime.decode(bytes, contentType);
    const out: unknown[] = [];
    for (const line of text.split(/\r\n|\r|\n/)) {
      if (line.trim() === '') continue;
      try {
        out.push(JSON.parse(line) as unknown);
      } catch {
        return text;
      }
    }
    return out;
  }

  static essence(contentType: string): string {
    return (contentType.toLowerCase().split(';')[0] ?? '').trim();
  }

  static data(bytes: Uint8Array | undefined, contentType: string): unknown {
    if (bytes === undefined || bytes.byteLength === 0) return undefined;
    const essence = AppiiRuntime.essence(contentType);
    const json = essence === 'application/json' || essence === 'text/json' || essence.endsWith('+json');
    const textual =
      json ||
      essence === '' ||
      essence.startsWith('text/') ||
      essence.endsWith('+xml') ||
      essence === 'application/xml' ||
      essence === 'application/javascript' ||
      essence === 'application/x-www-form-urlencoded';
    if (!textual) return bytes;
    const text = AppiiRuntime.decode(bytes, contentType);
    if (!json) return text;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }

  static referrerPolicy(header: string | null): string | undefined {
    if (header === null) return undefined;
    let policy: string | undefined;
    for (const token of header.split(',')) {
      const value = token.trim().toLowerCase();
      if (AppiiRuntime.REFERRER_POLICIES.includes(value)) policy = value;
    }
    return policy;
  }

  static referrer(page: URL, target: URL, policy: string): string | undefined {
    const stripped = new URL(page.href);
    stripped.hash = '';
    stripped.username = '';
    stripped.password = '';
    const origin = page.origin + '/';
    const full = stripped.href.length > AppiiRuntime.MAX_REFERRER_LENGTH ? origin : stripped.href;
    const same = page.origin === target.origin;
    const downgrade = CookieJar.isSecure(page) && !CookieJar.isSecure(target);
    switch (policy) {
      case 'no-referrer':
        return undefined;
      case 'origin':
        return origin;
      case 'unsafe-url':
        return full;
      case 'same-origin':
        return same ? full : undefined;
      case 'strict-origin':
        return downgrade ? undefined : origin;
      case 'origin-when-cross-origin':
        return same ? full : origin;
      case 'no-referrer-when-downgrade':
        return downgrade ? undefined : full;
      default:
        return same ? full : downgrade ? undefined : origin;
    }
  }

  static originHeader(page: URL, target: URL, method: string, mode: string, policy: string, tainted: boolean, cors: boolean): string | undefined {
    const serialized = tainted ? 'null' : page.origin;
    if (cors) return serialized;
    if (method === 'GET' || method === 'HEAD') return undefined;
    if (mode !== 'cors') {
      if (policy === 'no-referrer') return 'null';
      if (AppiiRuntime.DOWNGRADE_POLICIES.includes(policy) && page.protocol === 'https:' && target.protocol !== 'https:') return 'null';
      if (policy === 'same-origin' && page.origin !== target.origin) return 'null';
    }
    return serialized;
  }
}

class AppiiHtml {
  static readonly RAW_TEXT = new Set(['style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'textarea', 'title']);
  static readonly SCRIPT = 'script';
  static readonly BREAKOUT = new Set([
    'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike',
    'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
  ]);
  static readonly BREAKOUT_END = new Set(['br', 'p']);
  static readonly FONT_BREAKOUT = ['color', 'face', 'size'];
  static readonly SVG_INTEGRATION = new Set(['foreignobject', 'desc', 'title']);
  static readonly MATH_TEXT_INTEGRATION = new Set(['mi', 'mo', 'mn', 'ms', 'mtext']);
  static readonly HTML_ANNOTATIONS = new Set(['text/html', 'application/xhtml+xml']);
  static readonly UNSENT_TYPES = new Set(['submit', 'image', 'reset', 'button', 'file']);
  static readonly CHECKABLE_TYPES = new Set(['checkbox', 'radio']);
  static readonly LONGEST_REFERENCE = 32;
  static readonly C1 = [
    0x20ac, 0x81, 0x201a, 0x192, 0x201e, 0x2026, 0x2020, 0x2021, 0x2c6, 0x2030, 0x160, 0x2039, 0x152, 0x8d, 0x17d, 0x8f,
    0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x2dc, 0x2122, 0x161, 0x203a, 0x153, 0x9d, 0x17e, 0x178,
  ];
  static #references: Map<string, string> | undefined;

  static scan(source: string): HtmlScan {
    const html = source.replace(/\r\n?/g, '\n');
    const forms: ScannedForm[] = [];
    const inputs: ScannedInput[] = [];
    const metas: [string, string][] = [];
    const ids = new Map<string, number>();
    const frames: HtmlFrame[] = [];
    const fieldsets: HtmlFieldset[] = [];
    let pointer = -1;
    let template = 0;
    let i = 0;
    while (i < html.length) {
      const open = html.indexOf('<', i);
      if (open < 0) break;
      const next = html.charAt(open + 1);
      if (next === '!') {
        i = AppiiHtml.#markup(html, open);
        continue;
      }
      if (next === '?') {
        i = AppiiHtml.#past(html, '>', open + 2);
        continue;
      }
      if (next === '/') {
        const first = html.charAt(open + 2);
        if (!AppiiHtml.#letter(first)) {
          i = first === '>' ? open + 3 : AppiiHtml.#past(html, '>', open + 2);
          continue;
        }
        const closing = AppiiHtml.#tag(html, open + 2);
        if (closing === undefined) break;
        i = closing.end;
        if (AppiiHtml.#closeForeign(frames, closing.name)) continue;
        if (closing.name === 'template' && template > 0) template--;
        else if (template > 0) continue;
        else if (closing.name === 'form') pointer = -1;
        else if (closing.name === 'fieldset') fieldsets.pop();
        else if (closing.name === 'legend') AppiiHtml.#legend(fieldsets, 'closed');
        continue;
      }
      if (!AppiiHtml.#letter(next)) {
        i = open + 1;
        continue;
      }
      const tag = AppiiHtml.#tag(html, open + 1);
      if (tag === undefined) break;
      i = tag.end;
      const attributes = tag.attributes;
      if (AppiiHtml.#foreign(frames)) {
        if (!AppiiHtml.#breaksOut(tag)) {
          if (template === 0) AppiiHtml.#identify(ids, attributes, -1);
          if (!tag.selfClosing) frames.push(AppiiHtml.#frame(frames, tag));
          continue;
        }
        while (AppiiHtml.#foreign(frames)) frames.pop();
      }
      if (template === 0 && tag.name === 'form') {
        if (pointer < 0) {
          pointer = forms.length;
          const form: ScannedForm = { index: pointer };
          const id = attributes.get('id');
          const name = attributes.get('name');
          if (id !== undefined) form.id = id;
          if (name !== undefined) form.name = name;
          forms.push(form);
          AppiiHtml.#identify(ids, attributes, pointer);
        }
      } else if (template === 0) {
        AppiiHtml.#identify(ids, attributes, -1);
        if (tag.name === 'input') inputs.push(AppiiHtml.#input(attributes, pointer, fieldsets));
        else if (tag.name === 'fieldset') fieldsets.push({ disabled: attributes.has('disabled'), legend: 'none' });
        else if (tag.name === 'legend') AppiiHtml.#legend(fieldsets, 'open');
        else if (tag.name === 'meta') {
          const name = attributes.get('name');
          const content = attributes.get('content');
          if (name !== undefined && content !== undefined) metas.push([name, content]);
        }
      }
      if (tag.name === 'svg' || tag.name === 'math') {
        if (!tag.selfClosing) frames.push({ name: tag.name, space: tag.name, integration: false });
      } else if (tag.name === 'template') template++;
      else if (tag.name === 'plaintext') break;
      else if (tag.name === AppiiHtml.SCRIPT) i = AppiiHtml.#scriptData(html, i);
      else if (AppiiHtml.RAW_TEXT.has(tag.name)) i = AppiiHtml.#rawText(html, i, tag.name);
    }
    for (const input of inputs) if (input.ownerId !== undefined) input.owner = ids.get(input.ownerId) ?? -1;
    return { forms, inputs, metas };
  }

  static form(scan: HtmlScan, identity: FormIdentity): ScannedForm | undefined {
    if (identity.id !== undefined) {
      const found = scan.forms.find((form) => form.id === identity.id);
      if (found !== undefined || identity.name === undefined) return found;
    }
    if (identity.name !== undefined) return scan.forms.find((form) => form.name === identity.name);
    return identity.index === undefined ? undefined : scan.forms[identity.index];
  }

  static input(scan: HtmlScan, name: string, identity: FormIdentity | undefined): string | string[] | undefined {
    const form = identity === undefined ? undefined : AppiiHtml.form(scan, identity);
    if (form !== undefined) {
      const owned = scan.inputs.filter((input) => input.owner === form.index && input.name === name && input.value !== undefined).map((input) => input.value ?? '');
      return owned.length === 0 ? undefined : owned.length === 1 ? owned[0] : owned;
    }
    return scan.inputs.find((input) => input.name === name && input.value !== undefined && input.value !== '')?.value;
  }

  static meta(scan: HtmlScan, name: string): string | undefined {
    const key = AppiiHtml.#lower(name);
    return scan.metas.find(([candidate]) => AppiiHtml.#lower(candidate) === key)?.[1];
  }

  static decode(value: string): string {
    const text = value.replace(/\0/g, '\ufffd');
    if (!text.includes('&')) return text;
    let out = '';
    let i = 0;
    for (;;) {
      const amp = text.indexOf('&', i);
      if (amp < 0) return out + text.slice(i);
      out += text.slice(i, amp);
      const [replacement, next] = AppiiHtml.#reference(text, amp + 1);
      out += replacement;
      i = next;
    }
  }

  static #reference(text: string, at: number): [string, number] {
    if (text.charAt(at) === '#') {
      const hex = text.charAt(at + 1) === 'x' || text.charAt(at + 1) === 'X';
      const start = hex ? at + 2 : at + 1;
      let end = start;
      while (end < text.length && (hex ? /[0-9A-Fa-f]/ : /[0-9]/).test(text.charAt(end))) end++;
      if (end === start) return ['&', at];
      const digits = text.slice(start, end).replace(/^0+/, '');
      const code = digits.length > 8 ? 0x110000 : parseInt(digits === '' ? '0' : digits, hex ? 16 : 10);
      return [AppiiHtml.#numeric(code), text.charAt(end) === ';' ? end + 1 : end];
    }
    let run = at;
    while (run < text.length && run - at < AppiiHtml.LONGEST_REFERENCE && /[0-9A-Za-z]/.test(text.charAt(run))) run++;
    if (run === at) return ['&', at];
    const table = AppiiHtml.#named();
    for (let end = run; end > at; end--) {
      const name = text.slice(at, end);
      const terminated = text.charAt(end) === ';' ? table.get(name + ';') : undefined;
      if (terminated !== undefined) return [terminated, end + 1];
      const legacy = table.get(name);
      if (legacy === undefined) continue;
      const after = text.charAt(end);
      return after === '=' || /[0-9A-Za-z]/.test(after) ? ['&', at] : [legacy, end];
    }
    return ['&', at];
  }

  static #named(): Map<string, string> {
    if (AppiiHtml.#references !== undefined) return AppiiHtml.#references;
    const table = new Map<string, string>();
    for (const line of NAMED_REFERENCES) {
      for (const entry of line.split(' ')) {
        const colon = entry.indexOf(':');
        const head = entry.slice(0, colon);
        const legacy = head.endsWith('!');
        const name = legacy ? head.slice(0, -1) : head;
        const text = String.fromCodePoint(...entry.slice(colon + 1).split('.').map((hex) => parseInt(hex, 16)));
        table.set(name + ';', text);
        if (legacy) table.set(name, text);
      }
    }
    AppiiHtml.#references = table;
    return table;
  }

  static #numeric(code: number): string {
    if (!Number.isFinite(code) || code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
    if (code >= 0x80 && code <= 0x9f) return String.fromCodePoint(AppiiHtml.C1[code - 0x80] ?? code);
    return String.fromCodePoint(code);
  }

  static #input(attributes: Map<string, string>, pointer: number, fieldsets: readonly HtmlFieldset[]): ScannedInput {
    const input: ScannedInput = { name: attributes.get('name') ?? '', owner: pointer };
    const owner = attributes.get('form');
    if (owner !== undefined) input.ownerId = owner;
    const type = AppiiHtml.#lower(attributes.get('type') ?? '');
    const disabled = attributes.has('disabled') || fieldsets.some((fieldset) => fieldset.disabled && fieldset.legend !== 'open');
    const checkable = AppiiHtml.CHECKABLE_TYPES.has(type);
    if (disabled || AppiiHtml.UNSENT_TYPES.has(type) || (checkable && !attributes.has('checked'))) return input;
    input.value = attributes.get('value') ?? (checkable ? 'on' : '');
    return input;
  }

  static #legend(fieldsets: HtmlFieldset[], state: 'open' | 'closed'): void {
    const top = fieldsets[fieldsets.length - 1];
    if (top === undefined) return;
    if (state === 'open' && top.legend === 'none') top.legend = 'open';
    else if (state === 'closed' && top.legend === 'open') top.legend = 'closed';
  }

  static #foreign(frames: readonly HtmlFrame[]): boolean {
    const top = frames[frames.length - 1];
    return top !== undefined && !top.integration;
  }

  static #breaksOut(tag: HtmlTag): boolean {
    if (AppiiHtml.BREAKOUT.has(tag.name)) return true;
    return tag.name === 'font' && AppiiHtml.FONT_BREAKOUT.some((name) => tag.attributes.has(name));
  }

  static #frame(frames: readonly HtmlFrame[], tag: HtmlTag): HtmlFrame {
    const parent = frames[frames.length - 1];
    const space = parent?.space === 'math' && parent.name === 'annotation-xml' && tag.name === 'svg' ? 'svg' : (parent?.space ?? 'svg');
    let integration = false;
    if (space === 'svg') integration = AppiiHtml.SVG_INTEGRATION.has(tag.name);
    else if (AppiiHtml.MATH_TEXT_INTEGRATION.has(tag.name)) integration = true;
    else if (tag.name === 'annotation-xml') integration = AppiiHtml.HTML_ANNOTATIONS.has(AppiiHtml.#lower(tag.attributes.get('encoding') ?? ''));
    return { name: tag.name, space, integration };
  }

  static #closeForeign(frames: HtmlFrame[], name: string): boolean {
    const top = frames[frames.length - 1];
    if (top === undefined) return false;
    if (top.integration) {
      if (top.name !== name) return false;
      frames.pop();
      return true;
    }
    if (AppiiHtml.BREAKOUT_END.has(name)) {
      while (AppiiHtml.#foreign(frames)) frames.pop();
      return false;
    }
    for (let at = frames.length - 1; at >= 0; at--) {
      if (frames[at]?.name === name) {
        frames.length = at;
        return true;
      }
    }
    return false;
  }

  static #identify(ids: Map<string, number>, attributes: Map<string, string>, index: number): void {
    const id = attributes.get('id');
    if (id !== undefined && id !== '' && !ids.has(id)) ids.set(id, index);
  }

  static #markup(html: string, open: number): number {
    if (!html.startsWith('<!--', open)) return AppiiHtml.#past(html, '>', open + 2);
    const start = open + 4;
    if (html.charAt(start) === '>') return start + 1;
    if (html.startsWith('->', start)) return start + 2;
    let at = start;
    for (;;) {
      const dashes = html.indexOf('--', at);
      if (dashes < 0) return html.length;
      if (html.charAt(dashes + 2) === '>') return dashes + 3;
      if (html.startsWith('!>', dashes + 2)) return dashes + 4;
      at = dashes + 1;
    }
  }

  static #rawText(html: string, from: number, name: string): number {
    let at = from;
    for (;;) {
      const close = html.indexOf('</', at);
      if (close < 0) return html.length;
      if (AppiiHtml.#nameAt(html, close + 2, name)) {
        const tag = AppiiHtml.#tag(html, close + 2);
        return tag === undefined ? html.length : tag.end;
      }
      at = close + 2;
    }
  }

  static #scriptData(html: string, from: number): number {
    const length = html.length;
    let state: 'data' | 'escaped' | 'dash' | 'dashDash' | 'double' | 'doubleDash' | 'doubleDashDash' = 'data';
    let i = from;
    while (i < length) {
      const ch = html.charAt(i);
      if (state === 'data') {
        if (ch === '<' && html.charAt(i + 1) === '/' && AppiiHtml.#nameAt(html, i + 2, AppiiHtml.SCRIPT)) return AppiiHtml.#endTag(html, i + 2);
        if (ch === '<' && html.startsWith('<!--', i)) {
          state = 'dashDash';
          i += 4;
          continue;
        }
        i++;
        continue;
      }
      if (state === 'double' || state === 'doubleDash' || state === 'doubleDashDash') {
        if (ch === '-') state = state === 'double' ? 'doubleDash' : 'doubleDashDash';
        else if (ch === '>' && state === 'doubleDashDash') state = 'data';
        else if (ch === '<') {
          state = 'double';
          if (html.charAt(i + 1) === '/' && AppiiHtml.#nameAt(html, i + 2, AppiiHtml.SCRIPT)) {
            state = 'escaped';
            i += 2 + AppiiHtml.SCRIPT.length;
            continue;
          }
        } else state = 'double';
        i++;
        continue;
      }
      if (ch === '-') state = state === 'escaped' ? 'dash' : 'dashDash';
      else if (ch === '>' && state === 'dashDash') state = 'data';
      else if (ch === '<') {
        state = 'escaped';
        if (html.charAt(i + 1) === '/' && AppiiHtml.#nameAt(html, i + 2, AppiiHtml.SCRIPT)) return AppiiHtml.#endTag(html, i + 2);
        if (AppiiHtml.#nameAt(html, i + 1, AppiiHtml.SCRIPT)) {
          state = 'double';
          i += 1 + AppiiHtml.SCRIPT.length;
          continue;
        }
      } else state = 'escaped';
      i++;
    }
    return length;
  }

  static #nameAt(html: string, at: number, name: string): boolean {
    if (AppiiHtml.#lower(html.slice(at, at + name.length)) !== name) return false;
    const after = html.charAt(at + name.length);
    return AppiiHtml.#space(after) || after === '/' || after === '>';
  }

  static #endTag(html: string, at: number): number {
    const tag = AppiiHtml.#tag(html, at);
    return tag === undefined ? html.length : tag.end;
  }

  static #tag(html: string, start: number): HtmlTag | undefined {
    const length = html.length;
    let i = start;
    while (i < length && !AppiiHtml.#space(html.charAt(i)) && html.charAt(i) !== '/' && html.charAt(i) !== '>') i++;
    const name = AppiiHtml.#lower(html.slice(start, i));
    const attributes = new Map<string, string>();
    let selfClosing = false;
    for (;;) {
      while (i < length && (AppiiHtml.#space(html.charAt(i)) || html.charAt(i) === '/')) {
        selfClosing = html.charAt(i) === '/' && html.charAt(i + 1) === '>';
        i++;
      }
      if (i >= length) return undefined;
      if (html.charAt(i) === '>') return { name, attributes, end: i + 1, selfClosing };
      selfClosing = false;
      const keyStart = i;
      i++;
      while (i < length && !AppiiHtml.#space(html.charAt(i)) && html.charAt(i) !== '/' && html.charAt(i) !== '>' && html.charAt(i) !== '=') i++;
      const key = AppiiHtml.#lower(html.slice(keyStart, i));
      while (i < length && AppiiHtml.#space(html.charAt(i))) i++;
      let value = '';
      if (html.charAt(i) === '=') {
        i++;
        while (i < length && AppiiHtml.#space(html.charAt(i))) i++;
        const quote = html.charAt(i);
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, i + 1);
          if (close < 0) return undefined;
          value = html.slice(i + 1, close);
          i = close + 1;
        } else {
          const valueStart = i;
          while (i < length && !AppiiHtml.#space(html.charAt(i)) && html.charAt(i) !== '>') i++;
          value = html.slice(valueStart, i);
        }
      }
      if (!attributes.has(key)) attributes.set(key, AppiiHtml.decode(value));
    }
  }

  static #past(html: string, ch: string, from: number): number {
    const at = html.indexOf(ch, from);
    return at < 0 ? html.length : at + 1;
  }

  static #letter(ch: string): boolean {
    return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
  }

  static #space(ch: string): boolean {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\r';
  }

  static #lower(text: string): string {
    return text.replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  }
}`;

  static readonly FORMS = String.raw`class AppiiForms {
  static readonly TEXT_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'hidden']);
  static readonly PATTERN_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);
  static readonly LENGTH_TYPES = new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'textarea']);
  static readonly NUMERIC_TYPES = new Set(['number', 'range']);
  static readonly TEMPORAL_TYPES = new Set(['date', 'month', 'week', 'time', 'datetime-local']);
  static readonly CHOICE_TYPES = new Set(['checkbox', 'radio', 'select-one', 'select-multiple']);
  static readonly EMPTY_SENT_TYPES = new Set([
    'text', 'search', 'tel', 'url', 'email', 'password', 'hidden', 'number', 'range', 'color', 'date', 'month', 'week', 'time', 'datetime-local', 'textarea',
  ]);
  static readonly EMAIL = /^[a-zA-Z0-9.!#$%&'*+\/=?^_\x60{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  static readonly EMAIL_LOCAL_CHAR = /^[a-zA-Z0-9!#$%&'*+\/=?^_\x60{|}~.-]$/;
  static readonly EMAIL_DOMAIN_CHAR = /^[a-zA-Z0-9.-]$/;
  static readonly FLOAT = /^-?(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)(?:[eE][-+]?[0-9]+)?$/;
  static readonly DAY_MS = 86400000;
  static readonly WEEK_MS = 604800000;
  static readonly STEPS: Record<string, [number, number, number]> = {
    number: [1, 1, 0],
    range: [1, 1, 0],
    date: [1, 86400000, 0],
    month: [1, 1, 0],
    week: [1, 604800000, -259200000],
    time: [60, 1000, 0],
    'datetime-local': [60, 1000, 0],
  };
  static readonly LIMITS: Record<string, [number, number]> = {
    number: [-Number.MAX_VALUE, Number.MAX_VALUE],
    range: [-Number.MAX_VALUE, Number.MAX_VALUE],
    date: [-62135596800000, 8640000000000000],
    month: [-23628, 3285488],
    week: [-62135596800000, 8640000000000000],
    time: [0, 86399999],
    'datetime-local': [-62135596800000, 8640000000000000],
  };

  static validate(spec: EndpointSpec, input: unknown, unsafePatterns: boolean): FieldError[] {
    const form = spec.form;
    if (form === undefined || form.noValidate) return [];
    const user = AppiiRuntime.isRecord(input) ? input : {};
    const variant = form.target === 'body' ? AppiiForms.variant(spec, user) : undefined;
    const defaults = variant !== undefined ? variant.defaults : form.target === 'query' ? spec.query : (spec.body?.defaults ?? {});
    const values: Record<string, unknown> = { ...AppiiRuntime.clone(defaults), ...user };
    const dirty = new Set(Object.keys(user));
    if (variant !== undefined) return variant.noValidate ? [] : AppiiForms.check(variant.rules, values, dirty, unsafePatterns);
    if (AppiiForms.submitter(form, values)?.noValidate === true) return [];
    return AppiiForms.check(form.rules, values, dirty, unsafePatterns);
  }

  static variant(spec: EndpointSpec, user: Record<string, unknown>): FormVariant | undefined {
    const variants = spec.form?.variants ?? [];
    if (variants.length === 0) return undefined;
    return AppiiForms.#pick(variants, user) ?? AppiiForms.#pick(variants, spec.body?.defaults ?? {});
  }

  static #pick(variants: readonly FormVariant[], values: Record<string, unknown>): FormVariant | undefined {
    return variants.find((variant) => {
      const name = variant.when.name;
      const value = Object.hasOwn(values, name) ? values[name] : undefined;
      if (value === undefined || value === null) return false;
      const allowed = variant.when.values;
      return allowed === undefined || allowed.includes(AppiiRuntime.text(value));
    });
  }

  static submitter(form: FormSpec, values: Record<string, unknown>): SubmitterSpec | undefined {
    for (const submitter of form.submitters) {
      if (submitter.name !== '' && Object.hasOwn(values, submitter.name) && AppiiRuntime.text(values[submitter.name]) === submitter.value) return submitter;
    }
    return form.submitters[0];
  }

  static check(rules: readonly FieldRule[], values: Record<string, unknown>, dirty: ReadonlySet<string>, unsafePatterns: boolean): FieldError[] {
    const errors: FieldError[] = [];
    for (const rule of rules) {
      const raw = Object.hasOwn(values, rule.name) ? values[rule.name] : undefined;
      const changed = dirty.has(rule.name);
      const problem = rule.list ? AppiiForms.#list(rule, raw, changed, unsafePatterns) : AppiiForms.#scalar(rule, raw, changed, unsafePatterns);
      if (!problem) continue;
      const error: FieldError = { field: rule.name, code: problem[0], message: problem[1] };
      if (rule.label !== undefined) error.label = rule.label;
      if (rule.hint !== undefined) error.hint = rule.hint;
      errors.push(error);
    }
    return errors;
  }

  static entries(fields: readonly FieldEntry[], values: Record<string, unknown>, multipart: boolean): FormEntry[] {
    const out: FormEntry[] = [];
    const known = new Set<string>();
    for (const field of fields) {
      known.add(field.name);
      AppiiForms.#append(out, field, Object.hasOwn(values, field.name) ? values[field.name] : undefined, multipart);
    }
    for (const [name, value] of Object.entries(values)) {
      if (!known.has(name)) AppiiForms.#append(out, { name, type: 'unknown' }, value, multipart);
    }
    return out;
  }

  static sanitize(type: string, value: string, multiple: boolean): string {
    if (type === 'textarea') return value.replace(/\r\n?/g, '\n');
    if (type === 'email') {
      const stripped = value.replace(/[\r\n]/g, '');
      return multiple ? stripped.split(',').map((part) => AppiiForms.#trim(part)).join(',') : AppiiForms.#trim(stripped);
    }
    if (type === 'url') return AppiiForms.#trim(value.replace(/[\r\n]/g, ''));
    if (AppiiForms.TEXT_TYPES.has(type)) return value.replace(/[\r\n]/g, '');
    return value;
  }

  static pattern(source: string): RegExp | undefined {
    let flags = 'u';
    try {
      new RegExp('', 'v');
      flags = 'v';
    } catch {
      flags = 'u';
    }
    try {
      new RegExp(source, flags);
      return new RegExp('^(?:' + source + ')$', flags);
    } catch {
      return undefined;
    }
  }

  static number(value: string): number | undefined {
    if (!AppiiForms.FLOAT.test(value)) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  static convert(type: string, value: string): number | undefined {
    switch (type) {
      case 'number':
      case 'range':
        return AppiiForms.number(value);
      case 'date':
        return AppiiForms.#date(value);
      case 'month': {
        const match = /^([0-9]{4,})-([0-9]{2})$/.exec(value);
        if (!match) return undefined;
        const year = Number(match[1]);
        const month = Number(match[2]);
        return year < 1 || month < 1 || month > 12 ? undefined : (year - 1970) * 12 + month - 1;
      }
      case 'week': {
        const match = /^([0-9]{4,})-W([0-9]{2})$/.exec(value);
        if (!match) return undefined;
        const year = Number(match[1]);
        const week = Number(match[2]);
        if (year < 1 || week < 1 || week > AppiiForms.#weeksInYear(year)) return undefined;
        return AppiiForms.#weekStart(year) + (week - 1) * AppiiForms.WEEK_MS;
      }
      case 'time':
        return AppiiForms.#time(value);
      case 'datetime-local': {
        const match = /^([0-9]{4,}-[0-9]{2}-[0-9]{2})[T ](.+)$/.exec(value);
        if (!match) return undefined;
        const date = AppiiForms.#date(match[1] ?? '');
        const time = AppiiForms.#time(match[2] ?? '');
        return date === undefined || time === undefined ? undefined : date + time;
      }
      default:
        return undefined;
    }
  }

  static #list(rule: FieldRule, raw: unknown, dirty: boolean, unsafePatterns: boolean): Problem | undefined {
    const items: unknown[] = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw];
    const present = items.filter((item) => !AppiiForms.#empty(item));
    if (present.length === 0 && rule.required === true) return AppiiForms.#missing(rule.type);
    for (const value of rule.contains ?? []) {
      if (!present.some((item) => AppiiRuntime.text(item) === value)) return AppiiForms.#missing('checkbox');
    }
    if (rule.maxItems !== undefined && present.length > rule.maxItems) {
      return ['typeMismatch', 'Please select at most ' + rule.maxItems + (rule.maxItems === 1 ? ' item.' : ' items.')];
    }
    if (rule.unique === true) {
      const seen = new Set<string>();
      for (const item of present) {
        const key = AppiiRuntime.text(item);
        if (seen.has(key)) return ['typeMismatch', "The value '" + key + "' is selected more than once."];
        seen.add(key);
      }
    }
    const single: FieldRule = { ...rule, list: false, required: rule.itemRequired === true };
    for (const item of items) {
      const problem = AppiiForms.#scalar(single, item, dirty, unsafePatterns);
      if (problem) return problem;
    }
    return undefined;
  }

  static #scalar(rule: FieldRule, raw: unknown, dirty: boolean, unsafePatterns: boolean): Problem | undefined {
    const type = rule.type;
    if (AppiiForms.CHOICE_TYPES.has(type)) {
      const value = raw === true && rule.constant !== undefined ? rule.constant : raw;
      if (AppiiForms.#empty(value)) return rule.required === true ? AppiiForms.#missing(type) : undefined;
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return ['typeMismatch', 'Please select one of the listed options.'];
      const text = String(value);
      if (rule.constant !== undefined && text !== rule.constant) return ['typeMismatch', "Please use the value '" + rule.constant + "' to check this box."];
      if (rule.options !== undefined && !rule.options.includes(text)) return ['typeMismatch', "'" + text + "' is not one of the options: " + rule.options.join(', ') + '.'];
      return undefined;
    }
    if (type === 'file') {
      const missing = AppiiForms.#empty(raw) || (typeof Blob !== 'undefined' && raw instanceof Blob && raw.size === 0 && AppiiForms.#fileName(raw) === '');
      return missing && rule.required === true ? AppiiForms.#missing(type) : undefined;
    }
    let value: string;
    if (raw === undefined || raw === null) value = '';
    else if (typeof raw === 'string') value = raw;
    else if (typeof raw === 'number') {
      if (!Number.isFinite(raw)) return AppiiForms.#bad(type);
      value = String(raw);
    } else if (typeof raw === 'boolean' || typeof raw === 'bigint') value = String(raw);
    else return ['typeMismatch', 'Please enter a text value.'];
    value = AppiiForms.sanitize(type, value, rule.multiple === true);
    if (AppiiForms.NUMERIC_TYPES.has(type) && value !== '' && AppiiForms.number(value) === undefined) return AppiiForms.#bad(type);
    if (AppiiForms.TEMPORAL_TYPES.has(type) && value !== '' && AppiiForms.convert(type, value) === undefined) return AppiiForms.#bad(type);
    if (value === '') return rule.required === true ? AppiiForms.#missing(type) : undefined;
    if (type === 'email') {
      const message = AppiiForms.#email(value, rule.multiple === true);
      if (message !== undefined) return ['typeMismatch', message];
    }
    if (type === 'url' && !AppiiForms.#isUrl(value)) return ['typeMismatch', 'Please enter a URL.'];
    if (type === 'color' && !/^#[0-9a-fA-F]{6}$/.test(value)) return ['typeMismatch', 'Please enter a color such as #000000.'];
    if (rule.options !== undefined && !rule.options.includes(value)) return ['typeMismatch', "'" + value + "' is not one of the options: " + rule.options.join(', ') + '.'];
    if (rule.pattern !== undefined && AppiiForms.PATTERN_TYPES.has(type) && (rule.unsafePattern !== true || unsafePatterns)) {
      const regex = AppiiForms.pattern(rule.pattern);
      const values = type === 'email' && rule.multiple === true ? value.split(',') : [value];
      if (regex && values.some((each) => !regex.test(each))) return ['patternMismatch', 'Please match the requested format.'];
    }
    if (dirty && AppiiForms.LENGTH_TYPES.has(type)) {
      const length = value.length;
      if (rule.maxLength !== undefined && length > rule.maxLength) {
        return ['tooLong', 'Please shorten this text to ' + rule.maxLength + ' characters or less (you are currently using ' + length + ' characters).'];
      }
      if (rule.minLength !== undefined && length < rule.minLength) {
        return ['tooShort', 'Please lengthen this text to ' + rule.minLength + ' characters or more (you are currently using ' + length + (length === 1 ? ' character).' : ' characters).')];
      }
    }
    if (AppiiForms.NUMERIC_TYPES.has(type) || AppiiForms.TEMPORAL_TYPES.has(type)) return AppiiForms.#range(rule, value);
    return undefined;
  }

  static #range(rule: FieldRule, value: string): Problem | undefined {
    const type = rule.type;
    const n = AppiiForms.convert(type, value);
    if (n === undefined) return undefined;
    const min = rule.min === undefined ? undefined : AppiiForms.convert(type, rule.min);
    const max = rule.max === undefined ? undefined : AppiiForms.convert(type, rule.max);
    const [limitMin, limitMax] = AppiiForms.LIMITS[type] ?? [-Number.MAX_VALUE, Number.MAX_VALUE];
    let minimum = type === 'range' ? (min ?? 0) : (min ?? limitMin);
    let maximum = type === 'range' ? (max ?? 100) : (max ?? limitMax);
    if (type === 'range' && maximum < minimum) maximum = minimum;
    const digits = Math.max(AppiiForms.#decimals(rule.step), AppiiForms.#decimals(rule.min ?? rule.base));
    if (type === 'time' && min !== undefined && max !== undefined && max < min) {
      if (n > max && n < min) return ['rangeUnderflow', 'Value must be ' + AppiiForms.#format(type, min, digits) + ' or later.'];
      minimum = limitMin;
      maximum = limitMax;
    } else {
      if ((min !== undefined || type === 'range') && n < minimum) return ['rangeUnderflow', AppiiForms.#limit(type, minimum, digits, true)];
      if ((max !== undefined || type === 'range') && n > maximum) return ['rangeOverflow', AppiiForms.#limit(type, maximum, digits, false)];
    }
    const [defaultStep, scale, defaultBase] = AppiiForms.STEPS[type] ?? [1, 1, 0];
    const rawStep = rule.step === undefined ? undefined : AppiiForms.#trim(rule.step);
    if (rawStep !== undefined && rawStep.toLowerCase() === 'any') return undefined;
    let step = rawStep === undefined ? undefined : AppiiForms.number(rawStep);
    if (step === undefined || step <= 0) step = defaultStep;
    if (type === 'date' || type === 'month' || type === 'week') step = Math.max(1, Math.round(step));
    let scaled = step * scale;
    if (type === 'time' || type === 'datetime-local') scaled = Math.max(1, Math.round(scaled));
    const baseValue = rule.base === undefined ? undefined : AppiiForms.convert(type, rule.base);
    const base = min ?? baseValue ?? defaultBase;
    const acceptable = AppiiForms.NUMERIC_TYPES.has(type) ? scaled / 16777216 : 0;
    const distance = Math.abs(n - base);
    const remainder = Math.abs(distance - scaled * Math.round(distance / scaled));
    if (!(acceptable < remainder && remainder < scaled - acceptable)) return undefined;
    const inRange = Math.max(minimum, Math.min(n, maximum));
    const rounded = base + AppiiForms.#round((inRange - base) / scaled) * scaled;
    let first = rounded > maximum ? rounded - scaled : rounded < minimum ? rounded + scaled : rounded;
    if (first < minimum || first > maximum) first = inRange;
    const second = first < n ? first + scaled : first - scaled;
    if (!Number.isFinite(second) || second < minimum || second > maximum) {
      return ['stepMismatch', 'Please enter a valid value. The nearest valid value is ' + AppiiForms.#format(type, first, digits) + '.'];
    }
    const low = Math.min(first, second);
    const high = Math.max(first, second);
    return ['stepMismatch', 'Please enter a valid value. The two nearest valid values are ' + AppiiForms.#format(type, low, digits) + ' and ' + AppiiForms.#format(type, high, digits) + '.'];
  }

  static #limit(type: string, value: number, digits: number, lower: boolean): string {
    const text = AppiiForms.#format(type, value, digits);
    if (AppiiForms.NUMERIC_TYPES.has(type)) return 'Value must be ' + (lower ? 'greater than or equal to ' : 'less than or equal to ') + text + '.';
    return 'Value must be ' + text + (lower ? ' or later.' : ' or earlier.');
  }

  static #format(type: string, value: number, digits: number): string {
    switch (type) {
      case 'date':
        return AppiiForms.#calendar(value);
      case 'month': {
        const total = Math.round(value);
        const year = Math.floor(total / 12) + 1970;
        const month = total - (year - 1970) * 12 + 1;
        return AppiiForms.#pad(year, 4) + '-' + AppiiForms.#pad(month, 2);
      }
      case 'week': {
        const year = new Date(value + 3 * AppiiForms.DAY_MS).getUTCFullYear();
        const week = Math.round((value - AppiiForms.#weekStart(year)) / AppiiForms.WEEK_MS) + 1;
        return 'Week ' + AppiiForms.#pad(week, 2) + ', ' + AppiiForms.#pad(year, 4);
      }
      case 'time':
        return AppiiForms.#clock(value);
      case 'datetime-local': {
        const day = Math.floor(value / AppiiForms.DAY_MS) * AppiiForms.DAY_MS;
        return AppiiForms.#calendar(day) + ', ' + AppiiForms.#clock(value - day);
      }
      default:
        return digits > 0 ? String(Number(value.toFixed(Math.min(digits, 100)))) : String(value);
    }
  }

  static #calendar(ms: number): string {
    const date = new Date(ms);
    return AppiiForms.#pad(date.getUTCMonth() + 1, 2) + '/' + AppiiForms.#pad(date.getUTCDate(), 2) + '/' + AppiiForms.#pad(date.getUTCFullYear(), 4);
  }

  static #clock(ms: number): string {
    const total = Math.round(ms);
    const hours = Math.floor(total / 3600000);
    const minutes = Math.floor(total / 60000) % 60;
    const seconds = Math.floor(total / 1000) % 60;
    const millis = total % 1000;
    let text = String(hours % 12 === 0 ? 12 : hours % 12) + ':' + AppiiForms.#pad(minutes, 2);
    if (seconds !== 0 || millis !== 0) text += ':' + AppiiForms.#pad(seconds, 2);
    if (millis !== 0) text += '.' + AppiiForms.#pad(millis, 3);
    return text + (hours < 12 ? ' AM' : ' PM');
  }

  static #pad(value: number, width: number): string {
    return String(value).padStart(width, '0');
  }

  static #round(value: number): number {
    return Math.sign(value) * Math.round(Math.abs(value));
  }

  static #decimals(value: string | undefined): number {
    if (value === undefined) return 0;
    const match = /^-?[0-9]*(?:\.([0-9]+))?(?:[eE]([-+]?[0-9]+))?$/.exec(value.trim());
    if (!match) return 0;
    return Math.max(0, (match[1]?.length ?? 0) - Number(match[2] ?? 0));
  }

  static #date(value: string): number | undefined {
    const match = /^([0-9]{4,})-([0-9]{2})-([0-9]{2})$/.exec(value);
    if (!match) return undefined;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (year < 1 || month < 1 || month > 12 || day < 1 || day > AppiiForms.#daysInMonth(year, month)) return undefined;
    return AppiiForms.#utc(year, month - 1, day);
  }

  static #time(value: string): number | undefined {
    const match = /^([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.([0-9]{1,3}))?)?$/.exec(value);
    if (!match) return undefined;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    const seconds = match[3] === undefined ? 0 : Number(match[3]);
    const millis = match[4] === undefined ? 0 : Number(match[4].padEnd(3, '0'));
    if (hours > 23 || minutes > 59 || seconds > 59) return undefined;
    return ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis;
  }

  static #utc(year: number, monthIndex: number, day: number): number {
    const date = new Date(0);
    date.setUTCFullYear(year, monthIndex, day);
    date.setUTCHours(0, 0, 0, 0);
    return date.getTime();
  }

  static #leap(year: number): boolean {
    return year % 400 === 0 || (year % 4 === 0 && year % 100 !== 0);
  }

  static #daysInMonth(year: number, month: number): number {
    if (month === 2) return AppiiForms.#leap(year) ? 29 : 28;
    return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
  }

  static #weekStart(year: number): number {
    const jan4 = AppiiForms.#utc(year, 0, 4);
    const weekday = new Date(jan4).getUTCDay();
    return jan4 - ((weekday + 6) % 7) * AppiiForms.DAY_MS;
  }

  static #weeksInYear(year: number): number {
    const weekday = new Date(AppiiForms.#utc(year, 0, 1)).getUTCDay();
    return weekday === 4 || (weekday === 3 && AppiiForms.#leap(year)) ? 53 : 52;
  }

  static #empty(value: unknown): boolean {
    return value === undefined || value === null || value === '' || value === false || (Array.isArray(value) && value.length === 0);
  }

  static #missing(type: string): Problem {
    if (type === 'checkbox') return ['valueMissing', 'Please check this box if you want to proceed.'];
    if (type === 'radio') return ['valueMissing', 'Please select one of these options.'];
    if (type === 'select-one' || type === 'select-multiple') return ['valueMissing', 'Please select an item in the list.'];
    if (type === 'file') return ['valueMissing', 'Please select a file.'];
    return ['valueMissing', 'Please fill out this field.'];
  }

  static #bad(type: string): Problem {
    if (AppiiForms.NUMERIC_TYPES.has(type)) return ['badInput', 'Please enter a number.'];
    if (AppiiForms.TEMPORAL_TYPES.has(type)) return ['badInput', 'Please enter a valid value. The field is incomplete or has an invalid date.'];
    return ['badInput', 'Please enter a valid value.'];
  }

  static #email(value: string, multiple: boolean): string | undefined {
    for (const address of multiple ? value.split(',') : [value]) {
      if (AppiiForms.EMAIL.test(address)) continue;
      if (address === '') return 'Please enter a non-empty email address.';
      const at = address.indexOf('@');
      if (at < 0) return "Please include an '@' in the email address. '" + address + "' is missing an '@'.";
      const local = address.slice(0, at);
      const domain = address.slice(at + 1);
      if (local === '') return "Please enter a part followed by '@'. '" + address + "' is incomplete.";
      if (domain === '') return "Please enter a part following '@'. '" + address + "' is incomplete.";
      const badLocal = [...local].find((ch) => !AppiiForms.EMAIL_LOCAL_CHAR.test(ch));
      if (badLocal !== undefined) return "A part followed by '@' should not contain the symbol '" + badLocal + "'.";
      const badDomain = [...domain].find((ch) => !AppiiForms.EMAIL_DOMAIN_CHAR.test(ch));
      if (badDomain !== undefined) return "A part following '@' should not contain the symbol '" + badDomain + "'.";
      if (domain.startsWith('.') || domain.endsWith('.') || domain.includes('..')) return "'.' is used at a wrong position in '" + domain + "'.";
      return 'Please enter an email address.';
    }
    return undefined;
  }

  static #isUrl(value: string): boolean {
    try {
      new URL(value);
      return true;
    } catch {
      return false;
    }
  }

  static #trim(value: string): string {
    return value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  }

  static #fileName(value: Blob): string {
    return typeof File !== 'undefined' && value instanceof File ? value.name : '';
  }

  static #append(out: FormEntry[], field: FieldEntry, raw: unknown, multipart: boolean): void {
    if (raw === undefined || raw === null || raw === false) {
      if (field.type === 'file') {
        if (multipart) out.push({ name: field.name, value: new Blob([], { type: 'application/octet-stream' }), filename: '' });
        else out.push({ name: field.name, value: '' });
      } else if (raw !== false && AppiiForms.EMPTY_SENT_TYPES.has(field.type)) {
        out.push({ name: field.name, value: '' });
      }
      return;
    }
    if (Array.isArray(raw)) {
      const item: FieldEntry = { ...field, type: field.type === 'file' ? 'file' : 'item' };
      for (const value of raw) AppiiForms.#append(out, item, value, multipart);
      return;
    }
    if (typeof Blob !== 'undefined' && raw instanceof Blob) {
      const name = AppiiForms.#fileName(raw);
      if (multipart) out.push({ name: field.name, value: raw, filename: typeof File !== 'undefined' && raw instanceof File ? name : 'blob' });
      else out.push({ name: field.name, value: name });
      return;
    }
    if (raw === true) {
      out.push({ name: field.name, value: field.constant ?? 'on' });
      return;
    }
    out.push({ name: field.name, value: AppiiRuntime.text(raw) });
  }
}`;

  static readonly CLIENT = String.raw`export class BaseApiClient {
  static readonly REDIRECT_STATUSES: readonly number[] = [301, 302, 303, 307, 308];
  static readonly STALE_STATUSES: readonly number[] = [400, 403, 419, 422];
  static readonly HTTP_SCHEMES: readonly string[] = ['http:', 'https:'];
  static readonly DOCUMENT_ACCEPT = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8';
  static readonly CLIENT_ERROR = 400;

  readonly cookies: CookieJar;
  readonly #options: ClientOptions;
  readonly #primary: string;
  readonly #defaultBase: string;
  readonly #fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly #documents = new Map<string, Promise<StoredDocument>>();
  readonly #responses = new Map<string, FetchedDocument>();
  #bearer: string | undefined;

  constructor(options: ClientOptions, primaryOrigin: string, defaultBaseUrl: string) {
    this.#options = { ...options };
    this.#primary = primaryOrigin;
    this.#defaultBase = defaultBaseUrl;
    this.cookies = new CookieJar(options.registrableDomain ?? CookieJar.knownSite);
    const impl = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (impl === undefined) throw new TypeError('No fetch implementation is available. Pass options.fetch.');
    this.#fetch = (input, init) => impl(input, init);
    if (options.cookies !== undefined) this.cookies.load(options.cookies, this.base(primaryOrigin) + '/');
  }

  base(origin: string): string {
    const mapped = this.#options.origins?.[origin] ?? (origin === this.#primary ? (this.#options.baseUrl ?? this.#defaultBase) : origin);
    return mapped.replace(/\/+$/, '');
  }

  resolve(url: string): string {
    const parsed = AppiiRuntime.url(url);
    if (parsed === undefined) return url;
    return url.startsWith(parsed.origin) ? this.base(parsed.origin) + url.slice(parsed.origin.length) : url;
  }

  clearTokens(): void {
    this.#documents.clear();
    this.#responses.clear();
  }

  refreshTokens(): void {
    this.#documents.clear();
  }

  protected async send(endpoint: EndpointSpec, input: RequestInput = {}): Promise<ApiResponse> {
    const spec = BaseApiClient.#bodyVariant(endpoint, input.contentType);
    const params: Record<string, unknown> = { ...input.params };
    const userQuery: Record<string, unknown> = { ...input.query };
    const form = spec.form;
    const variant = form !== undefined && form.target === 'body' ? AppiiForms.variant(spec, AppiiRuntime.isRecord(input.body) ? input.body : {}) : undefined;
    const query: Record<string, unknown> = { ...AppiiRuntime.clone(spec.query), ...userQuery };
    const body = AppiiRuntime.merge(variant !== undefined ? variant.defaults : spec.body?.defaults, input.body);
    if (form !== undefined && this.#options.validate !== false) {
      const errors = AppiiForms.validate(spec, form.target === 'query' ? input.query : input.body, this.#options.unsafePatterns === true);
      if (errors.length > 0) throw new ValidationError(errors);
    }
    if (spec.login !== undefined) BaseApiClient.#credentials(spec.name, spec.login, form !== undefined && form.target === 'query' ? query : body);
    const path = spec.path.replace(/\{([^}]+)\}/g, (_whole: string, name: string) => {
      const value = params[name];
      if (value === undefined || value === null || value === '') throw new TypeError('Missing path parameter "' + name + '" for ' + spec.name);
      return encodeURIComponent(AppiiRuntime.text(value));
    });
    if (form !== undefined && form.target === 'body' && AppiiRuntime.isRecord(body)) {
      const submitter = AppiiForms.submitter(form, body);
      for (const [name, value] of Object.entries(submitter?.query ?? {})) if (!Object.hasOwn(userQuery, name)) query[name] = value;
    }
    const fields = variant?.fields ?? form?.fields ?? [];
    const address = this.base(spec.origin) + path;
    const page = spec.page ?? form?.page;
    const explicit = new Set<string>();
    const headers = this.#headers(spec, input, explicit);
    await this.#authorize(spec, input, headers);
    const state: TokenState = { cached: [], missing: [] };
    const sent: unknown = AppiiRuntime.isRecord(body) ? { ...body } : body;
    for (const token of spec.csrf) await this.#fill(token, address, headers, query, sent, form, state);
    const search =
      form !== undefined && form.target === 'query' ? AppiiRuntime.urlencoded(AppiiForms.entries(form.fields, query, false), true, this.#encoder(form)) : AppiiRuntime.query(query);
    const url = address + (search === '' ? '' : '?' + search);
    const encoded = this.#encode(spec, sent, headers, fields);
    const context: RequestContext = { mode: spec.mode, explicit };
    if (page !== undefined) context.page = this.resolve(page);
    const exchanged = await this.#exchange(spec.method, url, headers, encoded, context);
    const status = exchanged.response.status;
    const bytes = await AppiiRuntime.read(exchanged.response, spec.method);
    const type = exchanged.response.headers.get('content-type') ?? '';
    if (spec.tokenKey !== undefined && exchanged.response.ok) {
      this.#responses.set(spec.tokenKey, { headers: exchanged.response.headers, text: bytes === undefined ? '' : AppiiRuntime.decode(bytes, type) });
    }
    const response: ApiResponse = {
      status,
      ok: exchanged.response.ok,
      url: exchanged.url,
      redirected: exchanged.redirected,
      headers: exchanged.response.headers,
      data: spec.jsonLines?.includes(status) === true ? AppiiRuntime.jsonLines(bytes, type) : AppiiRuntime.data(bytes, type),
    };
    if (spec.login !== undefined && response.ok) {
      for (const path of spec.login.tokens) {
        const token = AppiiRuntime.at(response.data, path);
        if (token === undefined) continue;
        this.#bearer = token;
        break;
      }
    }
    if (spec.logout === true && status < BaseApiClient.CLIENT_ERROR) this.#bearer = undefined;
    if (status >= BaseApiClient.CLIENT_ERROR && state.missing.length > 0) throw new MissingTokenError(response, state.missing);
    if (state.cached.length > 0 && BaseApiClient.STALE_STATUSES.includes(status)) {
      response.staleTokens = BaseApiClient.#stale(status, state.cached);
      for (const stale of response.staleTokens.pages) this.#documents.delete(stale);
    }
    return response;
  }

  static #bodyVariant(spec: EndpointSpec, contentType: string | undefined): EndpointSpec {
    if (contentType === undefined || spec.bodies === undefined) return spec;
    const wanted = AppiiRuntime.essence(contentType);
    const body = spec.bodies.find((candidate) => AppiiRuntime.essence(candidate.contentType ?? candidate.mimeType) === wanted);
    if (body === undefined) {
      const known = spec.bodies.map((candidate) => AppiiRuntime.essence(candidate.contentType ?? candidate.mimeType)).join(', ');
      throw new TypeError('The endpoint ' + spec.name + ' takes no ' + contentType + ' body. It takes ' + known + '.');
    }
    if (body === spec.bodies[0]) return spec;
    const out: EndpointSpec = { ...spec, body };
    delete out.form;
    return out;
  }

  static #credentials(endpoint: string, login: LoginSpec, values: unknown): void {
    const record = AppiiRuntime.isRecord(values) ? values : {};
    const fields: [string | undefined, string][] = [
      [login.identifier, 'the user name'],
      [login.password, 'the password'],
    ];
    for (const [field, label] of fields) if (field !== undefined && AppiiRuntime.blank(record[field])) throw new MissingLoginError(endpoint, field, label);
  }

  async #authorize(spec: EndpointSpec, input: RequestInput, headers: Record<string, string>): Promise<void> {
    if (spec.bearer === undefined) return;
    if (Object.keys(input.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')) return;
    const token = input.accessToken ?? (AppiiRuntime.blank(headers['authorization']) ? (this.#bearer ?? (await this.#accessToken())) : undefined);
    if (!AppiiRuntime.blank(token)) headers['authorization'] = 'Bearer ' + token;
    else if (AppiiRuntime.blank(headers['authorization']) && spec.bearer === 'required') throw new MissingCredentialError(spec.name);
  }

  async #accessToken(): Promise<string | undefined> {
    const option = this.#options.accessToken;
    return typeof option === 'function' ? await option() : option;
  }

  static #stale(status: number, cached: readonly PageToken[]): StaleTokens {
    const tokens = [...new Set(cached.map((item) => item.token))];
    const pages = [...new Set(cached.map((item) => item.page))];
    const one = tokens.length === 1;
    const message = [
      'The server rejected the request with status ' + status + '.',
      'The client took ' + (one ? 'the token ' : 'the tokens ') + tokens.join(', ') + ' from ' + pages.join(', ') + ', which it loaded for an earlier request.',
      (one ? 'This token' : 'These tokens') + ' can be stale.',
      'The client forgot ' + (pages.length === 1 ? 'this page' : 'these pages') + ' and loads ' + (pages.length === 1 ? 'it' : 'them') + ' again for the next request, as a browser would after a reload.',
      'Send this request again only if the server can safely receive it two times.',
    ].join(' ');
    return { tokens, pages, message };
  }

  #headers(spec: EndpointSpec, input: RequestInput, explicit: Set<string>): Record<string, string> {
    const out: Record<string, string> = {};
    const sources: [Record<string, string | undefined> | undefined, boolean][] = [
      [spec.headers, false],
      [this.#options.headers, true],
      [input.headers, true],
    ];
    for (const [source, own] of sources) {
      for (const [name, value] of Object.entries(source ?? {})) {
        const lower = name.toLowerCase();
        if (own) explicit.add(lower);
        if (value === undefined) delete out[lower];
        else out[lower] = value;
      }
    }
    return out;
  }

  #encoder(form: FormSpec | undefined): (text: string) => ArrayLike<number> {
    return AppiiRuntime.encoder(form?.charset, this.#options.encoders);
  }

  #encode(spec: EndpointSpec, body: unknown, headers: Record<string, string>, fields: readonly FieldEntry[]): NonNullable<RequestInit['body']> | undefined {
    if (body === undefined || spec.method === 'GET' || spec.method === 'HEAD') return undefined;
    const kind = spec.body?.kind ?? (AppiiRuntime.isRecord(body) || Array.isArray(body) ? 'json' : 'text');
    const mimeType = spec.body?.mimeType ?? '';
    const form = spec.form;
    const setType = (type: string): void => {
      if (headers['content-type'] === undefined && type !== '') headers['content-type'] = type;
    };
    if (kind === 'form' && AppiiRuntime.isRecord(body)) {
      setType('application/x-www-form-urlencoded');
      return AppiiRuntime.urlencoded(AppiiForms.entries(fields, body, false), form !== undefined, this.#encoder(form));
    }
    if (kind === 'multipart' && AppiiRuntime.isRecord(body)) {
      const encoded = AppiiRuntime.multipart(AppiiForms.entries(fields, body, true), this.#encoder(form));
      headers['content-type'] = encoded.contentType;
      return encoded.body;
    }
    if (kind === 'text' && form !== undefined && form.enctype === 'text/plain' && AppiiRuntime.isRecord(body)) {
      setType('text/plain');
      return AppiiRuntime.textPlain(AppiiForms.entries(fields, body, false), this.#encoder(form));
    }
    if (kind === 'json' && spec.body?.jsonLines === true && Array.isArray(body)) {
      setType(mimeType || 'application/x-ndjson');
      return body.map((item: unknown) => JSON.stringify(item) + '\n').join('');
    }
    if (kind === 'json' || kind === 'graphql') {
      setType(mimeType || 'application/json');
      return typeof body === 'string' ? body : JSON.stringify(body);
    }
    setType(mimeType);
    if (typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array || body instanceof URLSearchParams || body instanceof FormData) {
      return body as NonNullable<RequestInit['body']>;
    }
    return AppiiRuntime.text(body);
  }

  async #fill(
    token: CsrfSpec,
    url: string,
    headers: Record<string, string>,
    query: Record<string, unknown>,
    body: unknown,
    form: FormSpec | undefined,
    state: TokenState,
  ): Promise<void> {
    if (token.location === 'header' && !AppiiRuntime.blank(headers[token.name.toLowerCase()])) return;
    if (token.location === 'query' && !AppiiRuntime.blank(query[token.name])) return;
    if (token.location === 'body' && (!AppiiRuntime.isRecord(body) || !AppiiRuntime.blank(body[token.name]))) return;
    const value = await this.#token(token, url, form, state);
    if (value === undefined) return;
    if (token.location === 'header') headers[token.name.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : value;
    else if (token.location === 'query') query[token.name] = value;
    else if (AppiiRuntime.isRecord(body)) body[token.name] = value;
  }

  async #token(token: CsrfSpec, url: string, form: FormSpec | undefined, state: TokenState): Promise<string | string[] | undefined> {
    const name = token.sourceName ?? token.name;
    if (token.source === 'cookie') {
      let value = this.cookies.get(name, url);
      if (value === undefined && token.seed !== undefined) {
        await this.#document(this.resolve(token.seed));
        value = this.cookies.get(name, url);
      }
      return value === undefined ? undefined : AppiiRuntime.decodeCookie(value);
    }
    if (token.sourceKey !== undefined) {
      const stored = this.#responses.get(token.sourceKey);
      if (stored !== undefined) return BaseApiClient.#extract(stored, token, name, undefined);
      const missing: MissingToken = { token: token.name, source: token.sourceKey };
      if (token.sourceCall !== undefined) missing.call = token.sourceCall;
      state.missing.push(missing);
      return undefined;
    }
    const source = token.sourceUrl ?? form?.page;
    if (source === undefined) return undefined;
    const page = this.resolve(source);
    const loaded = await this.#document(page);
    const value = BaseApiClient.#extract(loaded.document, token, name, form !== undefined && source === form.page ? form.form : undefined);
    if (value !== undefined && loaded.cached) state.cached.push({ token: token.name, page });
    if (AppiiRuntime.blank(value)) state.missing.push({ token: token.name, source: page, expected: BaseApiClient.#expected(token, name) });
    return value;
  }

  static #expected(token: CsrfSpec, name: string): string {
    if (token.source === 'hidden-field') return 'hidden field ' + name;
    if (token.source === 'meta') return 'meta ' + name;
    return name + ' in the response';
  }

  static #extract(document: FetchedDocument, token: CsrfSpec, name: string, identity: FormIdentity | undefined): string | string[] | undefined {
    if (token.source === 'hidden-field') return AppiiHtml.input(BaseApiClient.#scan(document), name, identity);
    if (token.source === 'meta') return AppiiHtml.meta(BaseApiClient.#scan(document), name);
    if (token.source !== 'response') return undefined;
    const header = document.headers.get(name);
    if (header !== null && header !== '') return header;
    try {
      return AppiiRuntime.find(JSON.parse(document.text) as unknown, name);
    } catch {
      const scan = BaseApiClient.#scan(document);
      return AppiiHtml.input(scan, name, undefined) ?? AppiiHtml.meta(scan, name);
    }
  }

  static #scan(document: FetchedDocument): HtmlScan {
    if (document.scan === undefined) document.scan = AppiiHtml.scan(document.text);
    return document.scan;
  }

  async #document(url: string): Promise<LoadedDocument> {
    const cached = this.#documents.get(url);
    if (cached !== undefined) {
      const entry = await cached.catch(() => undefined);
      if (entry !== undefined && entry.cookie === this.cookies.header(url)) return { document: entry.document, cached: true };
    }
    const context: RequestContext = { mode: 'navigate', explicit: new Set<string>() };
    const loading = this.#exchange('GET', url, { accept: BaseApiClient.DOCUMENT_ACCEPT }, undefined, context).then(async (exchanged): Promise<StoredDocument> => {
      const bytes = await AppiiRuntime.read(exchanged.response, 'GET');
      const type = exchanged.response.headers.get('content-type') ?? '';
      const document: FetchedDocument = { headers: exchanged.response.headers, text: bytes === undefined ? '' : AppiiRuntime.decode(bytes, type) };
      return { cookie: this.cookies.header(url), document };
    });
    this.#documents.set(url, loading);
    loading.catch(() => {
      if (this.#documents.get(url) === loading) this.#documents.delete(url);
    });
    return { document: (await loading).document, cached: false };
  }

  async #exchange(
    method: string,
    url: string,
    headers: Record<string, string>,
    body: NonNullable<RequestInit['body']> | undefined,
    context: RequestContext,
  ): Promise<Exchanged> {
    let current = url;
    let currentMethod = method;
    let currentBody = body;
    const currentHeaders: Record<string, string> = { ...headers };
    const page = context.page === undefined ? undefined : AppiiRuntime.url(context.page);
    let policy = AppiiRuntime.DEFAULT_POLICY;
    let tainted = false;
    let cors = false;
    let redirected = false;
    const limit = this.#options.maxRedirects ?? 20;
    for (let hop = 0; ; hop++) {
      const target = AppiiRuntime.url(current);
      if (target === undefined) throw new TypeError('The request URL ' + current + ' is not a valid URL.');
      if (page !== undefined) {
        cors = cors || (context.mode === 'cors' && target.origin !== page.origin);
        if (!context.explicit.has('referer')) BaseApiClient.#set(currentHeaders, 'referer', AppiiRuntime.referrer(page, target, policy));
        if (!context.explicit.has('origin')) {
          BaseApiClient.#set(currentHeaders, 'origin', AppiiRuntime.originHeader(page, target, currentMethod, context.mode, policy, tainted, cors));
        }
      }
      const sent = new Headers();
      for (const [name, value] of Object.entries(currentHeaders)) sent.set(name, value);
      const jar = this.cookies.header(current);
      if (jar !== '') {
        const own = sent.get('cookie');
        sent.set('cookie', own ? own + '; ' + jar : jar);
      }
      const init: RequestInit = { method: currentMethod, headers: sent, redirect: 'manual' };
      if (currentBody !== undefined) init.body = currentBody;
      const response = await this.#fetch(current, init);
      this.cookies.store(response.headers, current);
      const location = response.headers.get('location');
      if (this.#options.redirect === 'manual' || location === null || !BaseApiClient.REDIRECT_STATUSES.includes(response.status)) {
        return { response, url: current, redirected };
      }
      if (hop >= limit) throw new TypeError('The server sent more than ' + limit + ' redirects for ' + url + '.');
      await response.arrayBuffer().catch(() => undefined);
      const next = AppiiRuntime.url(location, current);
      if (next === undefined || !BaseApiClient.HTTP_SCHEMES.includes(next.protocol)) {
        throw new TypeError('The server redirected ' + current + ' to a location that is not an http or https URL. A browser stops this redirect with a network error.');
      }
      if (context.mode === 'cors' && (next.username !== '' || next.password !== '') && (cors || page === undefined || next.origin !== page.origin)) {
        throw new TypeError('The server redirected ' + current + ' to a URL that contains credentials. A browser stops this redirect with a network error.');
      }
      policy = AppiiRuntime.referrerPolicy(response.headers.get('referrer-policy')) ?? policy;
      if (page !== undefined && next.origin !== target.origin && page.origin !== target.origin) tainted = true;
      const status = response.status;
      if ((status === 303 && currentMethod !== 'GET' && currentMethod !== 'HEAD') || ((status === 301 || status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
        for (const name of AppiiRuntime.REQUEST_BODY_HEADERS) delete currentHeaders[name];
      }
      if (next.origin !== target.origin) delete currentHeaders['authorization'];
      current = next.href;
      redirected = true;
    }
  }

  static #set(headers: Record<string, string>, name: string, value: string | undefined): void {
    if (value === undefined) delete headers[name];
    else headers[name] = value;
  }
}`;

  static httpStatus(): string {
    const codes = ['0'];
    for (let code = 200; code <= 599; code++) codes.push(String(code));
    const lines: string[] = [];
    for (let i = 0; i < codes.length; i += 20) lines.push('  | ' + codes.slice(i, i + 20).join(' | '));
    return `export type HttpStatus =\n${lines.join('\n')};`;
  }

  static source(): string {
    return [TsClientRuntime.httpStatus(), TsClientRuntime.PUBLIC_TYPES, TsClientRuntime.SPEC_TYPES, TsClientRuntime.COOKIES, TsClientRuntime.HELPERS, TsClientRuntime.FORMS, TsClientRuntime.CLIENT].join('\n\n');
  }
}
