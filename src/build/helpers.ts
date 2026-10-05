import type { Exchange, JsonSchema } from '../model/index.js';
import { Http, Json } from '../shared/index.js';

export class Helpers {
  static readonly HTTP_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

  static compare(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }

  static httpUrl(value: string | undefined): URL | undefined {
    const url = Http.parseUrl(value);
    return url && Helpers.HTTP_SCHEMES.has(url.protocol) ? url : undefined;
  }

  static originOf(value: string | undefined): string | undefined {
    return Helpers.httpUrl(value)?.origin;
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
}
