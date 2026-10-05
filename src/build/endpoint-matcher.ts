import type { Endpoint, Exchange, JsonSchema, ParamInfo } from '../model/index.js';
import { EndpointIndex, Samples, Schema } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { ExchangeSignature } from './exchange-signature.js';
import { Helpers } from './helpers.js';
import { PathTemplater } from './path-templater.js';

export interface EndpointMatcherDeps {
  body?: BodyParser;
  signatures?: ExchangeSignature;
  paths?: PathTemplater;
}

export interface AcceptOptions {
  byExamples?: boolean;
}

export class EndpointMatcher {
  static readonly INTEGER: RegExp = /^-?[0-9]+$/;
  static readonly UUID: RegExp = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  static readonly DATE: RegExp = /^[0-9]{4,}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/;

  readonly #bySample = new Map<string, Endpoint>();
  readonly #buckets = new Map<string, Endpoint[]>();
  readonly #signatures: ExchangeSignature;
  readonly #paths: PathTemplater;

  constructor(endpoints: readonly Endpoint[], deps: EndpointMatcherDeps = {}) {
    this.#signatures = deps.signatures ?? new ExchangeSignature({ body: deps.body ?? new BodyParser() });
    this.#paths = deps.paths ?? new PathTemplater();
    for (const endpoint of endpoints) {
      for (const sample of endpoint.samples) if (!this.#bySample.has(sample.exchangeId)) this.#bySample.set(sample.exchangeId, endpoint);
      const key = EndpointMatcher.#bucket(endpoint.method, endpoint.origin);
      const list = this.#buckets.get(key);
      if (list) list.push(endpoint);
      else this.#buckets.set(key, [endpoint]);
    }
  }

  static create(endpoints: readonly Endpoint[]): EndpointMatcher {
    const body = BodyParser.create();
    return new EndpointMatcher(endpoints, { body, signatures: new ExchangeSignature({ body }), paths: new PathTemplater() });
  }

  static paramCount(template: string): number {
    return (template.match(/\{[^{}]+\}/g) ?? []).length;
  }

  accepts(endpoint: Endpoint, pathname: string, options: AcceptOptions = {}): boolean {
    const values = EndpointIndex.matchPath(endpoint.path, pathname);
    if (!values) return false;
    const params = new Map(endpoint.pathParams.map((param) => [param.name, param]));
    return Object.entries(values).every(([name, value]) => this.#fits(params.get(name), value, options.byExamples === true));
  }

  match(exchange: Exchange): Endpoint | undefined {
    const direct = this.#bySample.get(exchange.id);
    if (direct) return direct;
    const url = Helpers.httpUrl(exchange.request.url);
    if (!url) return undefined;
    const candidates = (this.#buckets.get(EndpointMatcher.#bucket(exchange.request.method, url.origin)) ?? []).filter(
      (endpoint) => endpoint.resourceTypes.includes(exchange.resourceType) && this.accepts(endpoint, url.pathname),
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

  #fits(param: ParamInfo | undefined, value: string, byExamples: boolean): boolean {
    if (!param) return true;
    if (!EndpointMatcher.#schemaFits(param.schema, value)) return false;
    if (!byExamples) return true;
    const kinds = param.examples.filter((example) => !Samples.isRedacted(example)).map((example) => this.#paths.classify(example));
    return kinds.length === 0 || kinds.includes('literal') || this.#paths.classify(value) !== 'literal';
  }

  static #schemaFits(schema: JsonSchema, value: string): boolean {
    const type = Schema.primaryType(schema);
    if (type === 'integer' && !EndpointMatcher.INTEGER.test(value)) return false;
    if (type === 'number' && (value.trim() === '' || !Number.isFinite(Number(value)))) return false;
    if (schema.format === 'uuid' && !EndpointMatcher.UUID.test(value)) return false;
    if (schema.format === 'date' && !EndpointMatcher.DATE.test(value)) return false;
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern, 'u').test(value)) return false;
      } catch {
        return true;
      }
    }
    return true;
  }

  static #bucket(method: string, origin: string): string {
    return `${method} ${origin}`;
  }
}
