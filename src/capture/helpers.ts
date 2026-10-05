import { getPublicSuffix } from 'tldts';
import type { Exchange, Header } from '../model/index.js';
import { Http } from '../shared/index.js';

export class Helpers {
  static readonly NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);
  static readonly WEB_PAGE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'file:']);
  static readonly REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
  static readonly NO_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);
  static readonly NO_CONTENT_STATUSES: ReadonlySet<number> = new Set([204, 205]);
  static readonly NESTED_DESTINATIONS: ReadonlySet<string> = new Set(['iframe', 'frame', 'embed', 'object', 'fencedframe']);
  static readonly CHUNKED = 'chunked';
  static readonly MAX_DATE_MS = 8.64e15;

  static stripPseudoHeaders(headers: readonly Header[]): Header[] {
    return headers.filter((h) => !h.name.startsWith(':')).map((h) => ({ name: h.name, value: h.value }));
  }

  static headersFromCdp(headers: Readonly<Record<string, string>> | undefined): Header[] {
    const out: Header[] = [];
    for (const [name, value] of Object.entries(headers ?? {})) {
      if (typeof value !== 'string' || name.startsWith(':')) continue;
      for (const line of value.split('\n')) out.push({ name, value: line });
    }
    return out;
  }

  static contentLength(headers: Header[]): number | undefined {
    const value = Http.getHeader(headers, 'content-length')?.trim();
    return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
  }

  static fullBodySize(headers: Header[], received: number): number {
    const declared = Http.isContentEncoded(Http.getHeader(headers, 'content-encoding')) ? undefined : Helpers.contentLength(headers);
    return Math.max(declared ?? 0, received);
  }

  static isChunked(headers: Header[]): boolean {
    return (Http.getHeader(headers, 'transfer-encoding') ?? '').toLowerCase().includes(Helpers.CHUNKED);
  }

  static formatAddress(ip: string, port: number | undefined): string {
    const host = ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
    return port !== undefined && port > 0 ? `${host}:${port}` : host;
  }

  static timing(startMs: number, durationMs: number): { startedAt: string; durationMs: number } {
    const whole = Math.floor(startMs);
    return {
      startedAt: new Date(whole).toISOString(),
      durationMs: Math.round(Math.max(0, durationMs + (startMs - whole)) * 1000) / 1000,
    };
  }

  static isoTime<T>(ms: number, fallback: T): string | T {
    return Number.isFinite(ms) && Math.abs(ms) <= Helpers.MAX_DATE_MS ? new Date(ms).toISOString() : fallback;
  }

  static withoutFragment(url: string): string {
    const hash = url.indexOf('#');
    return hash < 0 ? url : url.slice(0, hash);
  }

  static isPublicSuffix(domain: string): boolean {
    const d = domain.toLowerCase().replace(/\.$/, '');
    if (!d || Http.isIpAddress(d)) return false;
    return getPublicSuffix(d, { allowPrivateDomains: true }) === d;
  }

  static isTopLevelNavigation(exchange: Exchange): boolean {
    if (exchange.resourceType !== 'document') return false;
    const destination = (Http.getHeader(exchange.request.headers, 'sec-fetch-dest') ?? '').trim().toLowerCase();
    return !Helpers.NESTED_DESTINATIONS.has(destination);
  }

  static isNetworkUrl(url: string): boolean {
    const parsed = Http.parseUrl(url);
    return parsed !== undefined && Helpers.NETWORK_SCHEMES.has(parsed.protocol);
  }

  static isWebPageUrl(url: string): boolean {
    const parsed = Http.parseUrl(url);
    return parsed !== undefined && Helpers.WEB_PAGE_SCHEMES.has(parsed.protocol);
  }

  static async withTimeout<T>(promise: Promise<T>, ms: number, fallback: () => T): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        try {
          resolve(fallback());
        } catch (err) {
          reject(err);
        }
      }, ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  static async settle<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return Helpers.withTimeout(
      promise.catch(() => undefined),
      ms,
      () => undefined,
    );
  }

  static endTime(exchange: Exchange): number {
    const start = Date.parse(exchange.startedAt);
    return Number.isNaN(start) ? Number.NaN : start + Math.max(0, exchange.durationMs);
  }

  static utf8Length(text: string): number {
    return Buffer.byteLength(text, 'utf8');
  }
}
