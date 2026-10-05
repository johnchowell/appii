import { getPublicSuffix } from 'tldts';
import type { Exchange, Header } from '../model/index.js';
import { Http } from '../shared/index.js';

export class Helpers {
  static readonly NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);
  static readonly WEB_PAGE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'file:']);

  static stripPseudoHeaders(headers: readonly Header[]): Header[] {
    return headers.filter((h) => !h.name.startsWith(':')).map((h) => ({ name: h.name, value: h.value }));
  }

  static isPublicSuffix(domain: string): boolean {
    const d = domain.toLowerCase().replace(/\.$/, '');
    if (!d || Http.isIpAddress(d)) return false;
    return getPublicSuffix(d, { allowPrivateDomains: true }) === d;
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
