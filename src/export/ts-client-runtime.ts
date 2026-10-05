export class TsClientRuntime {
  static readonly IDENTIFIERS: readonly string[] = [
    'HttpStatus',
    'ApiResponse',
    'ClientOptions',
    'RequestInput',
    'ValidityCode',
    'FieldError',
    'ValidationError',
    'StoredCookie',
    'CookieJar',
    'BaseApiClient',
    'FieldRule',
    'FieldEntry',
    'FormEntry',
    'SubmitterSpec',
    'FormSpec',
    'CsrfSpec',
    'BodySpec',
    'EndpointSpec',
    'FetchedDocument',
    'Exchanged',
    'Problem',
    'AppiiRuntime',
    'AppiiHtml',
    'AppiiForms',
    'PRIMARY_ORIGIN',
    'DEFAULT_BASE_URL',
  ];

  static readonly CLIENT_MEMBERS: readonly string[] = ['constructor', 'cookies', 'base', 'resolve', 'clearTokens', 'send'];

  static readonly PUBLIC_TYPES = String.raw`export interface ApiResponse<S extends number = number, T = unknown> {
  status: S;
  ok: boolean;
  url: string;
  redirected: boolean;
  headers: Headers;
  data: T;
}

export interface ClientOptions {
  baseUrl?: string;
  origins?: Record<string, string>;
  headers?: Record<string, string>;
  cookies?: string;
  fetch?: typeof fetch;
  validate?: boolean;
  redirect?: 'follow' | 'manual';
  maxRedirects?: number;
}

export interface RequestInput {
  params?: object;
  query?: object;
  body?: unknown;
  headers?: Record<string, string | undefined>;
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

interface FormSpec {
  target: 'body' | 'query';
  noValidate: boolean;
  page?: string;
  selector?: string;
  rules: FieldRule[];
  fields: FieldEntry[];
  submitters: SubmitterSpec[];
}

interface CsrfSpec {
  location: 'header' | 'body' | 'query';
  name: string;
  source: string;
  sourceName?: string;
  sourceUrl?: string;
  seed?: string;
}

interface BodySpec {
  kind: string;
  mimeType: string;
  defaults?: Record<string, unknown>;
}

interface EndpointSpec {
  name: string;
  method: string;
  origin: string;
  path: string;
  headers: Record<string, string>;
  query: Record<string, unknown>;
  body?: BodySpec;
  csrf: CsrfSpec[];
  form?: FormSpec;
}

interface FetchedDocument {
  headers: Headers;
  text: string;
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
      } else if (!CookieJar.domainMatches(host, domain) || (!domain.includes('.') && domain !== host)) {
        return false;
      } else {
        hostOnly = false;
        cookieDomain = domain;
      }
    }
    const cookiePath = path ?? CookieJar.defaultPath(target.pathname);
    const secureOrigin = CookieJar.isSecure(target);
    if (secure && !secureOrigin) return false;
    if (sameSite === 'None' && !secure) return false;
    const lower = name.toLowerCase();
    if (name === '' && /^__(?:secure|host)-/i.test(value)) return false;
    if (lower.startsWith('__secure-') && !secure) return false;
    if (lower.startsWith('__host-') && !(secure && domain === '' && cookiePath === '/')) return false;
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

  static urlencoded(entries: readonly FormEntry[]): string {
    const params = new URLSearchParams();
    for (const entry of entries) params.append(AppiiRuntime.crlf(entry.name), typeof entry.value === 'string' ? AppiiRuntime.crlf(entry.value) : '');
    return params.toString();
  }

  static multipart(entries: readonly FormEntry[]): { body: Blob; contentType: string } {
    const boundary = '----WebKitFormBoundary' + AppiiRuntime.random(16);
    const parts: (string | Blob)[] = [];
    for (const entry of entries) {
      const disposition = '--' + boundary + '\r\nContent-Disposition: form-data; name="' + AppiiRuntime.escapeName(AppiiRuntime.crlf(entry.name)) + '"';
      if (typeof entry.value === 'string') {
        parts.push(disposition + '\r\n\r\n' + AppiiRuntime.crlf(entry.value) + '\r\n');
      } else {
        const type = entry.value.type === '' ? 'application/octet-stream' : entry.value.type;
        parts.push(disposition + '; filename="' + AppiiRuntime.escapeName(entry.filename ?? 'blob') + '"\r\nContent-Type: ' + type + '\r\n\r\n', entry.value, '\r\n');
      }
    }
    parts.push('--' + boundary + '--\r\n');
    return { body: new Blob(parts), contentType: 'multipart/form-data; boundary=' + boundary };
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

  static async data(response: Response, method: string): Promise<unknown> {
    if (method === 'HEAD' || response.status === 204 || response.status === 205 || response.status === 304) {
      await response.arrayBuffer().catch(() => undefined);
      return undefined;
    }
    const type = (response.headers.get('content-type') ?? '').toLowerCase();
    const essence = (type.split(';')[0] ?? '').trim();
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength === 0) return undefined;
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
    const charset = /;\s*charset\s*=\s*"?([^";\s]+)/.exec(type)?.[1];
    let decoder: TextDecoder;
    try {
      decoder = new TextDecoder(charset ?? 'utf-8');
    } catch {
      decoder = new TextDecoder('utf-8');
    }
    const text = decoder.decode(bytes);
    if (!json) return text;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
}

class AppiiHtml {
  static readonly TAG = /<(input|meta|form)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|<\/form\s*>/gi;
  static readonly ATTRIBUTE = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;
  static readonly FORM_ID = /^form#((?:\\[0-9a-fA-F]{1,6}[ \t\n\r\f]?|\\[^\r\n\f0-9a-fA-F]|[A-Za-z0-9_-]|[^\x00-\x7f])+)$/;
  static readonly ENTITIES: Record<string, string> = { amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'", nbsp: '\u00a0' };

  static attributes(source: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const match of source.matchAll(AppiiHtml.ATTRIBUTE)) {
      const name = (match[1] ?? '').toLowerCase();
      if (name !== '' && !out.has(name)) out.set(name, AppiiHtml.decode(match[2] ?? match[3] ?? match[4] ?? ''));
    }
    return out;
  }

  static decode(value: string): string {
    return value.replace(/&(?:#([xX][0-9a-fA-F]+|[0-9]+);?|([A-Za-z][A-Za-z0-9]*);)/g, (whole: string, numeric: string | undefined, named: string | undefined) => {
      if (numeric !== undefined) {
        const code = numeric.charAt(0) === 'x' || numeric.charAt(0) === 'X' ? parseInt(numeric.slice(1), 16) : parseInt(numeric, 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
      }
      return (named !== undefined ? AppiiHtml.ENTITIES[named] : undefined) ?? whole;
    });
  }

  static formId(selector: string | undefined): string | undefined {
    const match = selector === undefined ? null : AppiiHtml.FORM_ID.exec(selector);
    if (!match) return undefined;
    return (match[1] ?? '').replace(/\\([0-9a-fA-F]{1,6})[ \t\n\r\f]?|\\([^\r\n\f])/g, (_whole: string, hex: string | undefined, ch: string | undefined) =>
      hex !== undefined ? String.fromCodePoint(Math.min(parseInt(hex, 16), 0x10ffff) || 0xfffd) : (ch ?? ''),
    );
  }

  static find(html: string, element: 'input' | 'meta', key: string, valueAttribute: string, selector?: string): string | undefined {
    const formId = AppiiHtml.formId(selector);
    let inScope = formId === undefined;
    let fallback: string | undefined;
    for (const match of html.matchAll(AppiiHtml.TAG)) {
      const tag = (match[1] ?? '').toLowerCase();
      if (tag === '') {
        if (formId !== undefined) inScope = false;
        continue;
      }
      const attributes = AppiiHtml.attributes(match[2] ?? '');
      if (tag === 'form') {
        if (formId !== undefined) inScope = attributes.get('id') === formId;
        continue;
      }
      if (tag !== element) continue;
      const name = attributes.get('name') ?? '';
      if (element === 'meta' ? name.toLowerCase() !== key.toLowerCase() : name !== key) continue;
      const value = attributes.get(valueAttribute);
      if (value === undefined) continue;
      if (inScope || (formId !== undefined && attributes.get('form') === formId)) return value;
      if (fallback === undefined) fallback = value;
    }
    return fallback;
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

  static validate(spec: EndpointSpec, input: unknown): FieldError[] {
    const form = spec.form;
    if (!form || form.noValidate) return [];
    const user = AppiiRuntime.isRecord(input) ? input : {};
    const defaults = form.target === 'query' ? spec.query : (spec.body?.defaults ?? {});
    const values: Record<string, unknown> = { ...AppiiRuntime.clone(defaults), ...user };
    if (AppiiForms.submitter(form, values)?.noValidate === true) return [];
    return AppiiForms.check(form.rules, values, new Set(Object.keys(user)));
  }

  static submitter(form: FormSpec, values: Record<string, unknown>): SubmitterSpec | undefined {
    for (const submitter of form.submitters) {
      if (submitter.name !== '' && Object.hasOwn(values, submitter.name) && AppiiRuntime.text(values[submitter.name]) === submitter.value) return submitter;
    }
    return form.submitters[0];
  }

  static check(rules: readonly FieldRule[], values: Record<string, unknown>, dirty: ReadonlySet<string>): FieldError[] {
    const errors: FieldError[] = [];
    for (const rule of rules) {
      const raw = Object.hasOwn(values, rule.name) ? values[rule.name] : undefined;
      const problem = rule.list ? AppiiForms.#list(rule, raw, dirty.has(rule.name)) : AppiiForms.#scalar(rule, raw, dirty.has(rule.name));
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

  static #list(rule: FieldRule, raw: unknown, dirty: boolean): Problem | undefined {
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
      const problem = AppiiForms.#scalar(single, item, dirty);
      if (problem) return problem;
    }
    return undefined;
  }

  static #scalar(rule: FieldRule, raw: unknown, dirty: boolean): Problem | undefined {
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
    if (rule.pattern !== undefined && AppiiForms.PATTERN_TYPES.has(type)) {
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
  static readonly PAGE_SOURCES: readonly string[] = ['hidden-field', 'meta', 'response'];
  static readonly RETRY_STATUSES: readonly number[] = [403, 419];

  readonly cookies: CookieJar = new CookieJar();
  readonly #options: ClientOptions;
  readonly #primary: string;
  readonly #defaultBase: string;
  readonly #fetch: (input: string, init: RequestInit) => Promise<Response>;
  readonly #documents = new Map<string, Promise<FetchedDocument>>();

  constructor(options: ClientOptions, primaryOrigin: string, defaultBaseUrl: string) {
    this.#options = { ...options };
    this.#primary = primaryOrigin;
    this.#defaultBase = defaultBaseUrl;
    const impl = options.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (impl === undefined) throw new TypeError('No fetch implementation is available; pass options.fetch');
    this.#fetch = (input, init) => impl(input, init);
    if (options.cookies !== undefined) this.cookies.load(options.cookies, this.base(primaryOrigin) + '/');
  }

  base(origin: string): string {
    const mapped = this.#options.origins?.[origin] ?? (origin === this.#primary ? (this.#options.baseUrl ?? this.#defaultBase) : origin);
    return mapped.replace(/\/+$/, '');
  }

  resolve(url: string): string {
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return url;
    }
    return url.startsWith(origin) ? this.base(origin) + url.slice(origin.length) : url;
  }

  clearTokens(): void {
    this.#documents.clear();
  }

  protected async send(spec: EndpointSpec, input: RequestInput = {}): Promise<ApiResponse> {
    const params: Record<string, unknown> = { ...input.params };
    const userQuery: Record<string, unknown> = { ...input.query };
    const query: Record<string, unknown> = { ...AppiiRuntime.clone(spec.query), ...userQuery };
    const body = AppiiRuntime.merge(spec.body?.defaults, input.body);
    const form = spec.form;
    if (form && this.#options.validate !== false) {
      const errors = AppiiForms.validate(spec, form.target === 'query' ? input.query : input.body);
      if (errors.length > 0) throw new ValidationError(errors);
    }
    const path = spec.path.replace(/\{([^}]+)\}/g, (_whole: string, name: string) => {
      const value = params[name];
      if (value === undefined || value === null || value === '') throw new TypeError('Missing path parameter "' + name + '" for ' + spec.name);
      return encodeURIComponent(AppiiRuntime.text(value));
    });
    if (form && form.target === 'body' && AppiiRuntime.isRecord(body)) {
      const submitter = AppiiForms.submitter(form, body);
      for (const [name, value] of Object.entries(submitter?.query ?? {})) if (!Object.hasOwn(userQuery, name)) query[name] = value;
    }
    const address = this.base(spec.origin) + path;
    for (let attempt = 0; ; attempt++) {
      const headers = this.#headers(spec, input);
      const currentQuery: Record<string, unknown> = { ...query };
      const currentBody: unknown = AppiiRuntime.isRecord(body) ? { ...body } : body;
      for (const token of spec.csrf) await this.#fill(token, address, headers, currentQuery, currentBody, form);
      const search = form && form.target === 'query' ? AppiiRuntime.urlencoded(AppiiForms.entries(form.fields, currentQuery, false)) : AppiiRuntime.query(currentQuery);
      const url = address + (search === '' ? '' : '?' + search);
      const encoded = this.#encode(spec, currentBody, headers);
      if (form?.page !== undefined) {
        const page = this.resolve(form.page);
        if (headers['referer'] === undefined) headers['referer'] = page;
        if (spec.method !== 'GET' && spec.method !== 'HEAD' && headers['origin'] === undefined) {
          try {
            headers['origin'] = new URL(page).origin;
          } catch {
            delete headers['origin'];
          }
        }
      }
      const exchanged = await this.#exchange(spec.method, url, headers, encoded);
      const status = exchanged.response.status;
      if (attempt === 0 && BaseApiClient.RETRY_STATUSES.includes(status) && spec.csrf.some((token) => BaseApiClient.PAGE_SOURCES.includes(token.source))) {
        await exchanged.response.arrayBuffer().catch(() => undefined);
        this.clearTokens();
        continue;
      }
      const data = await AppiiRuntime.data(exchanged.response, spec.method);
      return { status, ok: exchanged.response.ok, url: exchanged.url, redirected: exchanged.redirected, headers: exchanged.response.headers, data };
    }
  }

  #headers(spec: EndpointSpec, input: RequestInput): Record<string, string> {
    const out: Record<string, string> = {};
    const sources: (Record<string, string | undefined> | undefined)[] = [spec.headers, this.#options.headers, input.headers];
    for (const source of sources) {
      for (const [name, value] of Object.entries(source ?? {})) {
        if (value === undefined) delete out[name.toLowerCase()];
        else out[name.toLowerCase()] = value;
      }
    }
    return out;
  }

  #encode(spec: EndpointSpec, body: unknown, headers: Record<string, string>): BodyInit | undefined {
    if (body === undefined || spec.method === 'GET' || spec.method === 'HEAD') return undefined;
    const kind = spec.body?.kind ?? (AppiiRuntime.isRecord(body) || Array.isArray(body) ? 'json' : 'text');
    const mimeType = spec.body?.mimeType ?? '';
    const setType = (type: string): void => {
      if (headers['content-type'] === undefined && type !== '') headers['content-type'] = type;
    };
    const fields = spec.form?.fields ?? [];
    if (kind === 'form' && AppiiRuntime.isRecord(body)) {
      setType('application/x-www-form-urlencoded');
      return AppiiRuntime.urlencoded(AppiiForms.entries(fields, body, false));
    }
    if (kind === 'multipart' && AppiiRuntime.isRecord(body)) {
      const encoded = AppiiRuntime.multipart(AppiiForms.entries(fields, body, true));
      headers['content-type'] = encoded.contentType;
      return encoded.body;
    }
    if (kind === 'json' || kind === 'graphql') {
      if (typeof body === 'string') {
        setType(mimeType || 'application/json');
        return body;
      }
      setType(mimeType || 'application/json');
      return JSON.stringify(body);
    }
    setType(mimeType);
    if (typeof body === 'string' || body instanceof Blob || body instanceof ArrayBuffer || body instanceof Uint8Array || body instanceof URLSearchParams || body instanceof FormData) {
      return body as BodyInit;
    }
    return AppiiRuntime.text(body);
  }

  async #fill(token: CsrfSpec, url: string, headers: Record<string, string>, query: Record<string, unknown>, body: unknown, form: FormSpec | undefined): Promise<void> {
    if (token.location === 'header' && !AppiiRuntime.blank(headers[token.name.toLowerCase()])) return;
    if (token.location === 'query' && !AppiiRuntime.blank(query[token.name])) return;
    if (token.location === 'body' && (!AppiiRuntime.isRecord(body) || !AppiiRuntime.blank(body[token.name]))) return;
    const value = await this.#token(token, url, form);
    if (value === undefined) return;
    if (token.location === 'header') headers[token.name.toLowerCase()] = value;
    else if (token.location === 'query') query[token.name] = value;
    else if (AppiiRuntime.isRecord(body)) body[token.name] = value;
  }

  async #token(token: CsrfSpec, url: string, form: FormSpec | undefined): Promise<string | undefined> {
    const name = token.sourceName ?? token.name;
    if (token.source === 'cookie') {
      let value = this.cookies.get(name, url);
      if (value === undefined && token.seed !== undefined) {
        await this.#document(this.resolve(token.seed));
        value = this.cookies.get(name, url);
      }
      return value === undefined ? undefined : AppiiRuntime.decodeCookie(value);
    }
    const source = token.sourceUrl ?? form?.page;
    if (source === undefined) return undefined;
    const document = await this.#document(this.resolve(source));
    if (token.source === 'hidden-field') {
      return AppiiHtml.find(document.text, 'input', name, 'value', source === form?.page ? form.selector : undefined);
    }
    if (token.source === 'meta') return AppiiHtml.find(document.text, 'meta', name, 'content');
    if (token.source === 'response') {
      const header = document.headers.get(name);
      if (header !== null && header !== '') return header;
      try {
        return AppiiRuntime.find(JSON.parse(document.text) as unknown, name);
      } catch {
        return AppiiHtml.find(document.text, 'input', name, 'value') ?? AppiiHtml.find(document.text, 'meta', name, 'content');
      }
    }
    return undefined;
  }

  #document(url: string): Promise<FetchedDocument> {
    const cached = this.#documents.get(url);
    if (cached) return cached;
    const loaded = this.#exchange('GET', url, { accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' }, undefined).then(async (exchanged) => ({
      headers: exchanged.response.headers,
      text: await exchanged.response.text(),
    }));
    this.#documents.set(url, loaded);
    loaded.catch(() => this.#documents.delete(url));
    return loaded;
  }

  async #exchange(method: string, url: string, headers: Record<string, string>, body: BodyInit | undefined): Promise<Exchanged> {
    let current = url;
    let currentMethod = method;
    let currentBody = body;
    const currentHeaders: Record<string, string> = { ...headers };
    let redirected = false;
    const limit = this.#options.maxRedirects ?? 20;
    for (let hop = 0; ; hop++) {
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
      if (hop >= limit) throw new TypeError('Too many redirects for ' + url);
      await response.arrayBuffer().catch(() => undefined);
      const next = new URL(location, current);
      const status = response.status;
      if ((status === 303 && currentMethod !== 'GET' && currentMethod !== 'HEAD') || ((status === 301 || status === 302) && currentMethod === 'POST')) {
        currentMethod = 'GET';
        currentBody = undefined;
        for (const name of AppiiRuntime.REQUEST_BODY_HEADERS) delete currentHeaders[name];
        delete currentHeaders['origin'];
      }
      if (next.origin !== new URL(current).origin) delete currentHeaders['authorization'];
      current = next.href;
      redirected = true;
    }
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
