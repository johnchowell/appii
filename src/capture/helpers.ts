import { isIP } from 'node:net';
import { getPublicSuffix } from 'tldts';
import type { Exchange, Header } from '../model/index.js';

export class Helpers {
  static readonly NETWORK_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'ws:', 'wss:']);
  static readonly SECURE_SCHEMES: ReadonlySet<string> = new Set(['https:', 'wss:']);
  static readonly LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', 'localhost.']);

  static stripPseudoHeaders(headers: readonly Header[]): Header[] {
    return headers.filter((h) => !h.name.startsWith(':')).map((h) => ({ name: h.name, value: h.value }));
  }

  static bareHost(host: string): string {
    return host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  }

  static isIpAddress(host: string): boolean {
    return isIP(Helpers.bareHost(host)) !== 0;
  }

  static isPublicSuffix(domain: string): boolean {
    const d = domain.toLowerCase().replace(/\.$/, '');
    if (!d || Helpers.isIpAddress(d)) return false;
    return getPublicSuffix(d, { allowPrivateDomains: true }) === d;
  }

  static isLoopbackHost(host: string): boolean {
    const h = Helpers.bareHost(host.toLowerCase());
    if (Helpers.LOOPBACK_NAMES.has(h) || h.endsWith('.localhost') || h.endsWith('.localhost.')) return true;
    if (isIP(h) === 4) return h.split('.')[0] === '127';
    if (isIP(h) === 6) return h === '::1' || h === '0:0:0:0:0:0:0:1';
    return false;
  }

  static isPotentiallyTrustworthy(url: URL): boolean {
    if (Helpers.SECURE_SCHEMES.has(url.protocol)) return true;
    if (url.protocol !== 'http:' && url.protocol !== 'ws:') return false;
    return Helpers.isLoopbackHost(url.hostname);
  }

  static isNetworkUrl(url: string): boolean {
    try {
      return Helpers.NETWORK_SCHEMES.has(new URL(url).protocol);
    } catch {
      return false;
    }
  }

  static isWebPageUrl(url: string): boolean {
    try {
      const protocol = new URL(url).protocol;
      return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
    } catch {
      return false;
    }
  }

  static errorMessage(err: unknown): string {
    const text = err instanceof Error ? err.message : String(err);
    return (text.split('\n')[0] ?? '').trim() || 'Unknown error';
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
