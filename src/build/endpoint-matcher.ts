import type { Endpoint, Exchange } from '../model/index.js';
import { BodyParser } from './body-parser.js';
import { ExchangeSignature } from './exchange-signature.js';
import { Helpers } from './helpers.js';
import { PathTemplater } from './path-templater.js';

export interface EndpointMatcherDeps {
  body?: BodyParser;
  signatures?: ExchangeSignature;
}

export class EndpointMatcher {
  readonly #bySample = new Map<string, Endpoint>();
  readonly #buckets = new Map<string, Endpoint[]>();
  readonly #signatures: ExchangeSignature;

  constructor(endpoints: readonly Endpoint[], deps: EndpointMatcherDeps = {}) {
    this.#signatures = deps.signatures ?? new ExchangeSignature({ body: deps.body ?? new BodyParser() });
    for (const endpoint of endpoints) {
      for (const sample of endpoint.samples) if (!this.#bySample.has(sample.exchangeId)) this.#bySample.set(sample.exchangeId, endpoint);
      const key = EndpointMatcher.#bucket(endpoint.method, endpoint.origin);
      const list = this.#buckets.get(key);
      if (list) list.push(endpoint);
      else this.#buckets.set(key, [endpoint]);
    }
  }

  static paramCount(template: string): number {
    return (template.match(/\{[^{}]+\}/g) ?? []).length;
  }

  match(exchange: Exchange): Endpoint | undefined {
    const direct = this.#bySample.get(exchange.id);
    if (direct) return direct;
    const url = Helpers.httpUrl(exchange.request.url);
    if (!url) return undefined;
    const candidates = (this.#buckets.get(EndpointMatcher.#bucket(exchange.request.method, url.origin)) ?? []).filter(
      (endpoint) => endpoint.resourceTypes.includes(exchange.resourceType) && PathTemplater.match(endpoint.path, url.pathname) !== undefined,
    );
    if (candidates.length === 0) return undefined;
    let operation: string | undefined;
    if (candidates.some((endpoint) => endpoint.kind === 'graphql' || endpoint.operationName !== undefined)) {
      operation = this.#signatures.of(exchange)?.operationName;
    }
    let best: Endpoint | undefined;
    let bestParams = Number.POSITIVE_INFINITY;
    for (const endpoint of candidates) {
      if ((endpoint.operationName ?? '') !== (operation ?? '')) continue;
      const params = EndpointMatcher.paramCount(endpoint.path);
      if (params < bestParams) {
        best = endpoint;
        bestParams = params;
      }
    }
    return best;
  }

  group(exchanges: readonly Exchange[]): Map<Endpoint, Exchange[]> {
    const out = new Map<Endpoint, Exchange[]>();
    for (const exchange of exchanges) {
      const endpoint = this.match(exchange);
      if (!endpoint) continue;
      const list = out.get(endpoint);
      if (list) list.push(exchange);
      else out.set(endpoint, [exchange]);
    }
    return out;
  }

  static #bucket(method: string, origin: string): string {
    return `${method} ${origin}`;
  }
}
