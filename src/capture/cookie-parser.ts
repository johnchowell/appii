import { Http } from '../shared/index.js';
import type { Cookie, Exchange, SameSite } from '../model/index.js';
import { Helpers } from './helpers.js';

export interface CookieParserOptions {
  now?: () => Date;
}

export interface CookieAttribute {
  name: string;
  value: string;
}

export interface SetCookieParts {
  name: string;
  value: string;
  attributes: CookieAttribute[];
}

export interface PlaywrightCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: 'Strict' | 'Lax' | 'None';
  partitionKey?: string;
}

export interface CdpPartitionKey {
  topLevelSite: string;
  hasCrossSiteAncestor?: boolean;
}

export interface CdpCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  size?: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  partitionKey?: string | CdpPartitionKey;
}

export interface CookieContext {
  sameSite: boolean;
  partition: string | undefined;
}

interface CookieAttributeList {
  expiresAt?: number;
  maxAgeAt?: number;
  domain?: string;
  path?: string;
  hasPath: boolean;
  secure: boolean;
  httpOnly: boolean;
  sameSite: SameSite | null;
  partitioned: boolean;
}

interface ParsedCookie {
  readonly cookie: Cookie;
}

export class CookieParser {
  static readonly MAX_NAME_VALUE_BYTES = 4096;
  static readonly MAX_ATTRIBUTE_VALUE_BYTES = 1024;
  static readonly MAX_AGE_LIMIT_SECONDS = 400 * 24 * 60 * 60;
  static readonly SECURE_PREFIX = '__secure-';
  static readonly HOST_PREFIX = '__host-';
  static readonly CTL = /[\x00-\x08\x0A-\x1F\x7F]/;
  static readonly MONTHS: readonly string[] = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

  readonly #now: () => Date;

  constructor(options: CookieParserOptions = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  static fromPlaywright(c: PlaywrightCookie): Cookie {
    const hostOnly = !c.domain.startsWith('.');
    return {
      name: c.name,
      value: c.value,
      domain: hostOnly ? c.domain : c.domain.slice(1),
      path: c.path,
      expires: c.expires < 0 ? null : c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite ?? null,
      hostOnly,
      ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
    };
  }

  static fromCdp(c: CdpCookie): Cookie {
    const hostOnly = !c.domain.startsWith('.');
    const partitionKey = typeof c.partitionKey === 'string' ? c.partitionKey : c.partitionKey?.topLevelSite;
    return {
      name: c.name,
      value: c.value,
      domain: hostOnly ? c.domain : c.domain.slice(1),
      path: c.path,
      expires: c.session || c.expires < 0 ? null : c.expires,
      httpOnly: c.httpOnly,
      secure: c.secure,
      sameSite: c.sameSite ?? null,
      hostOnly,
      ...(partitionKey ? { partitionKey } : {}),
    };
  }

  static site(url: string | undefined): string | undefined {
    const parsed = Http.parseUrl(url);
    if (!parsed || !Helpers.NETWORK_SCHEMES.has(parsed.protocol)) return undefined;
    return `${parsed.protocol}//${Http.registrableDomain(parsed.hostname)}`;
  }

  static context(exchange: Exchange): CookieContext {
    const url = exchange.request.url;
    const navigation = Helpers.isTopLevelNavigation(exchange);
    const siteFor = navigation ? url : (exchange.pageUrl ?? url);
    let sameSite = navigation || exchange.pageUrl === undefined;
    if (!sameSite) {
      try {
        sameSite = Http.isSameSite(url, siteFor);
      } catch {
        sameSite = false;
      }
    }
    return { sameSite, partition: CookieParser.site(siteFor) };
  }

  static tokenize(setCookie: string): SetCookieParts | null {
    if (CookieParser.CTL.test(setCookie)) return null;
    const semi = setCookie.indexOf(';');
    const pair = semi < 0 ? setCookie : setCookie.slice(0, semi);
    const unparsed = semi < 0 ? '' : setCookie.slice(semi);
    const eq = pair.indexOf('=');
    const name = CookieParser.#trim(eq < 0 ? '' : pair.slice(0, eq));
    const value = CookieParser.#trim(eq < 0 ? pair : pair.slice(eq + 1));
    if (!name && !value) return null;
    if (Helpers.utf8Length(name) + Helpers.utf8Length(value) > CookieParser.MAX_NAME_VALUE_BYTES) return null;
    const attributes: CookieAttribute[] = [];
    for (const av of unparsed.split(';').slice(1)) {
      const i = av.indexOf('=');
      const attrName = CookieParser.#trim(i < 0 ? av : av.slice(0, i));
      const attrValue = CookieParser.#trim(i < 0 ? '' : av.slice(i + 1));
      if (Helpers.utf8Length(attrValue) > CookieParser.MAX_ATTRIBUTE_VALUE_BYTES) continue;
      attributes.push({ name: attrName, value: attrValue });
    }
    return { name, value, attributes };
  }

  static parseDate(input: string): number | null {
    const tokens = input.split(/[\x09\x20-\x2F\x3B-\x40\x5B-\x60\x7B-\x7E]+/).filter((t) => t.length > 0);
    let time: [number, number, number] | undefined;
    let day: number | undefined;
    let month: number | undefined;
    let year: number | undefined;
    for (const token of tokens) {
      if (!time) {
        const m = /^(\d{1,2}):(\d{1,2}):(\d{1,2})(?:\D[\s\S]*)?$/.exec(token);
        if (m) {
          time = [Number(m[1]), Number(m[2]), Number(m[3])];
          continue;
        }
      }
      if (day === undefined) {
        const m = /^(\d{1,2})(?:\D[\s\S]*)?$/.exec(token);
        if (m) {
          day = Number(m[1]);
          continue;
        }
      }
      if (month === undefined) {
        const index = CookieParser.MONTHS.indexOf(token.slice(0, 3).toLowerCase());
        if (index >= 0 && token.length >= 3) {
          month = index;
          continue;
        }
      }
      if (year === undefined) {
        const m = /^(\d{2,4})(?:\D[\s\S]*)?$/.exec(token);
        if (m) {
          year = Number(m[1]);
          continue;
        }
      }
    }
    if (!time || day === undefined || month === undefined || year === undefined) return null;
    if (year >= 70 && year <= 99) year += 1900;
    else if (year >= 0 && year <= 69) year += 2000;
    const [hour, minute, second] = time;
    if (day < 1 || day > 31 || year < 1601 || hour > 23 || minute > 59 || second > 59) return null;
    const date = new Date(0);
    date.setUTCFullYear(year, month, day);
    date.setUTCHours(hour, minute, second, 0);
    if (date.getUTCDate() !== day || date.getUTCMonth() !== month || date.getUTCFullYear() !== year) return null;
    return date.getTime();
  }

  static defaultPath(url: URL | string): string {
    const path = (typeof url === 'string' ? new URL(url) : url).pathname;
    if (!path.startsWith('/')) return '/';
    const last = path.lastIndexOf('/');
    return last <= 0 ? '/' : path.slice(0, last);
  }

  static domainMatches(host: string, domain: string): boolean {
    const h = host.toLowerCase();
    const d = domain.toLowerCase();
    if (h === d) return true;
    return h.endsWith(d) && h.charAt(h.length - d.length - 1) === '.' && !Http.isIpAddress(h);
  }

  static pathMatches(requestPath: string, cookiePath: string): boolean {
    if (requestPath === cookiePath) return true;
    if (!requestPath.startsWith(cookiePath)) return false;
    return cookiePath.endsWith('/') || requestPath.charAt(cookiePath.length) === '/';
  }

  static key(cookie: Pick<Cookie, 'name' | 'domain' | 'path' | 'hostOnly' | 'partitionKey'>): string {
    return `${cookie.name}\u0000${cookie.hostOnly ? '' : '.'}${cookie.domain}\u0000${cookie.path}\u0000${cookie.partitionKey ?? ''}`;
  }

  static sentIn(cookie: Pick<Cookie, 'partitionKey'>, partition: string | undefined): boolean {
    return cookie.partitionKey === undefined || cookie.partitionKey === partition;
  }

  static isExpired(cookie: Cookie, atMs: number): boolean {
    return cookie.expires !== null && cookie.expires * 1000 <= atMs;
  }

  parse(setCookie: string, requestUrl: string, partition?: string): Cookie | null {
    return this.#parseAt(setCookie, requestUrl, this.#now().getTime(), partition)?.cookie ?? null;
  }

  replay(exchanges: Exchange[], jar: Cookie[] = []): Cookie[] {
    const store = new Map<string, Cookie>();
    for (const cookie of jar) store.set(CookieParser.key(cookie), { ...cookie });
    let clock = Number.NEGATIVE_INFINITY;
    for (const exchange of exchanges) {
      if (!exchange.response || !Http.reachedServer(exchange)) continue;
      const end = Helpers.endTime(exchange);
      const at = Number.isNaN(end) ? this.#now().getTime() : end;
      clock = Math.max(clock, at);
      CookieParser.#evict(store, at);
      const context = CookieParser.context(exchange);
      for (const header of Http.getHeaderAll(exchange.response.headers, 'set-cookie')) {
        for (const line of header.split('\n')) {
          if (line.trim()) this.#store(store, line, exchange.request.url, at, context);
        }
      }
    }
    CookieParser.#evict(store, Number.isFinite(clock) ? clock : this.#now().getTime());
    return [...store.values()];
  }

  #store(store: Map<string, Cookie>, line: string, requestUrl: string, at: number, context: CookieContext): void {
    const parsed = this.#parseAt(line, requestUrl, at, context.partition);
    if (!parsed) return;
    const cookie = parsed.cookie;
    if (cookie.sameSite !== 'None' && !context.sameSite) return;
    if (!cookie.secure && !Http.isPotentiallyTrustworthy(new URL(requestUrl))) {
      for (const existing of store.values()) {
        if (
          existing.secure &&
          existing.name === cookie.name &&
          existing.partitionKey === cookie.partitionKey &&
          (CookieParser.domainMatches(existing.domain, cookie.domain) || CookieParser.domainMatches(cookie.domain, existing.domain)) &&
          CookieParser.pathMatches(cookie.path, existing.path)
        ) {
          return;
        }
      }
    }
    const key = CookieParser.key(cookie);
    store.delete(key);
    if (!CookieParser.isExpired(cookie, at)) store.set(key, cookie);
  }

  #parseAt(setCookie: string, requestUrl: string, nowMs: number, partition: string | undefined): ParsedCookie | null {
    const parts = CookieParser.tokenize(setCookie);
    if (!parts) return null;
    let url: URL;
    try {
      url = new URL(requestUrl);
    } catch {
      return null;
    }
    if (!Helpers.NETWORK_SCHEMES.has(url.protocol)) return null;
    const host = url.hostname.toLowerCase();
    const attrs = CookieParser.#attributes(parts.attributes, url, nowMs);

    let domainAttribute = attrs.domain ?? '';
    if (/[^\x00-\x7F]/.test(domainAttribute)) return null;
    if (domainAttribute && Helpers.isPublicSuffix(domainAttribute)) {
      if (domainAttribute !== host) return null;
      domainAttribute = '';
    }
    if (domainAttribute && Http.isIpAddress(host) && domainAttribute === host) domainAttribute = '';
    let hostOnly = true;
    let domain = host;
    if (domainAttribute) {
      if (!CookieParser.domainMatches(host, domainAttribute)) return null;
      hostOnly = false;
      domain = domainAttribute;
    }

    const path = attrs.path ?? CookieParser.defaultPath(url);
    if (attrs.secure && !Http.isPotentiallyTrustworthy(url)) return null;
    if (attrs.sameSite === 'None' && !attrs.secure) return null;
    if (attrs.partitioned && !attrs.secure) return null;

    const lowerName = parts.name.toLowerCase();
    if (lowerName.startsWith(CookieParser.SECURE_PREFIX) && !attrs.secure) return null;
    if (lowerName.startsWith(CookieParser.HOST_PREFIX) && !(attrs.secure && hostOnly && attrs.hasPath && path === '/')) return null;
    if (!parts.name) {
      const lowerValue = parts.value.toLowerCase();
      if (lowerValue.startsWith(CookieParser.SECURE_PREFIX) || lowerValue.startsWith(CookieParser.HOST_PREFIX)) return null;
    }

    const expiry = attrs.maxAgeAt ?? attrs.expiresAt;
    return {
      cookie: {
        name: parts.name,
        value: parts.value,
        domain,
        path,
        expires: expiry === undefined ? null : expiry / 1000,
        httpOnly: attrs.httpOnly,
        secure: attrs.secure,
        sameSite: attrs.sameSite,
        hostOnly,
        ...(attrs.partitioned && partition !== undefined ? { partitionKey: partition } : {}),
      },
    };
  }

  static #attributes(list: CookieAttribute[], url: URL, nowMs: number): CookieAttributeList {
    const limitMs = nowMs + CookieParser.MAX_AGE_LIMIT_SECONDS * 1000;
    const out: CookieAttributeList = { hasPath: false, secure: false, httpOnly: false, sameSite: null, partitioned: false };
    for (const { name, value } of list) {
      switch (name.toLowerCase()) {
        case 'expires': {
          const date = CookieParser.parseDate(value);
          if (date !== null) out.expiresAt = Math.max(0, Math.min(date, limitMs));
          break;
        }
        case 'max-age': {
          if (!/^-?\d+$/.test(value)) break;
          const seconds = Number(value);
          out.maxAgeAt = seconds <= 0 ? 0 : Math.min(nowMs + seconds * 1000, limitMs);
          break;
        }
        case 'domain': {
          if (!value) break;
          out.domain = (value.startsWith('.') ? value.slice(1) : value).toLowerCase();
          break;
        }
        case 'path': {
          out.hasPath = true;
          out.path = value.startsWith('/') ? value : CookieParser.defaultPath(url);
          break;
        }
        case 'secure':
          out.secure = true;
          break;
        case 'httponly':
          out.httpOnly = true;
          break;
        case 'partitioned':
          out.partitioned = true;
          break;
        case 'samesite': {
          const v = value.toLowerCase();
          out.sameSite = v === 'none' ? 'None' : v === 'strict' ? 'Strict' : v === 'lax' ? 'Lax' : null;
          break;
        }
        default:
          break;
      }
    }
    return out;
  }

  static #evict(store: Map<string, Cookie>, atMs: number): void {
    for (const [key, cookie] of store) if (CookieParser.isExpired(cookie, atMs)) store.delete(key);
  }

  static #trim(value: string): string {
    return value.replace(/^[\t ]+|[\t ]+$/g, '');
  }
}
