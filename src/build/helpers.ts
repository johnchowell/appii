import { isIP } from 'node:net';
import type { Exchange, JsonSchema } from '../model/index.js';
import { Json } from '../shared/index.js';

export class Helpers {
  static readonly HTTP_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);
  static readonly LOOPBACK_NAMES: ReadonlySet<string> = new Set(['localhost', 'localhost.']);

  static compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  static parseUrl(value: string | undefined): URL | undefined {
    if (value === undefined) return undefined;
    try {
      return new URL(value);
    } catch {
      return undefined;
    }
  }

  static httpUrl(value: string | undefined): URL | undefined {
    const url = Helpers.parseUrl(value);
    return url && Helpers.HTTP_SCHEMES.has(url.protocol) ? url : undefined;
  }

  static originOf(value: string | undefined): string | undefined {
    return Helpers.httpUrl(value)?.origin;
  }

  static decode(value: string): string {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  static distinct<T>(values: Iterable<T>, key: (value: T) => unknown = (value) => value): T[] {
    const seen = new Set<unknown>();
    const out: T[] = [];
    for (const value of values) {
      const k = key(value);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(value);
    }
    return out;
  }

  static mostFrequent<T>(values: Iterable<T>): T | undefined {
    const counts = new Map<T, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    let best: T | undefined;
    let bestCount = 0;
    for (const [value, count] of counts) {
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  }

  static startMs(exchange: Exchange): number {
    return Date.parse(exchange.startedAt);
  }

  static properties(schema: JsonSchema | undefined): [string, JsonSchema][] {
    const props = schema?.properties;
    if (!Json.isPlainObject(props)) return [];
    return Object.entries(props).filter((entry): entry is [string, JsonSchema] => Json.isPlainObject(entry[1]));
  }

  static setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
    Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
  }

  static isPotentiallyTrustworthy(url: URL): boolean {
    if (url.protocol === 'https:' || url.protocol === 'wss:') return true;
    if (url.protocol !== 'http:' && url.protocol !== 'ws:') return false;
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (Helpers.LOOPBACK_NAMES.has(host) || host.endsWith('.localhost') || host.endsWith('.localhost.')) return true;
    if (isIP(host) === 4) return host.split('.')[0] === '127';
    if (isIP(host) === 6) return host === '::1' || host === '0:0:0:0:0:0:0:1';
    return false;
  }
}
