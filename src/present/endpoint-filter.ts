import type { ApiModel, CookieInfo, Endpoint, EndpointKind } from '../model/index.js';
import { EndpointIndex, Http } from '../shared/index.js';

export interface ListFilter {
  text?: string;
  method?: string;
  origin?: string;
  kind?: EndpointKind[];
  firstPartyOnly?: boolean;
}

export interface OriginMatcher {
  origin?: string;
  hostname?: string;
  port?: number;
}

export type TextField = readonly [label: string, read: (endpoint: Endpoint) => string | undefined];

export class EndpointFilter {
  static readonly LIST_SEPARATOR: RegExp = /[\s,]+/;
  static readonly HTTP_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);
  static readonly DEFAULT_PORTS: Readonly<Record<string, number>> = { 'http:': 80, 'ws:': 80, 'https:': 443, 'wss:': 443 };
  static readonly EXPLICIT_PORT: RegExp = /^(?:\[[^\]]*\]|[^:]*):([0-9]+)$/;
  static readonly TEXT_FIELDS: readonly TextField[] = [
    ['method', (endpoint) => endpoint.method],
    ['path', (endpoint) => endpoint.path],
    ['name', (endpoint) => endpoint.name],
    ['id', (endpoint) => endpoint.id],
    ['GraphQL operation', (endpoint) => endpoint.operationName],
  ];

  readonly #terms: readonly string[];
  readonly #methods: ReadonlySet<string>;
  readonly #origin: OriginMatcher | undefined;
  readonly #kinds: ReadonlySet<string>;
  readonly #firstPartyOnly: boolean;

  constructor(filter: ListFilter = {}) {
    this.#terms = EndpointFilter.#split(filter.text).map((term) => term.toLowerCase());
    this.#methods = new Set(EndpointFilter.#split(filter.method).map((method) => method.toUpperCase()));
    this.#origin = EndpointFilter.originMatcher(filter.origin);
    this.#kinds = new Set(filter.kind ?? []);
    this.#firstPartyOnly = filter.firstPartyOnly === true;
  }

  get active(): boolean {
    return this.#terms.length > 0 || this.#methods.size > 0 || this.#origin !== undefined || this.#kinds.size > 0 || this.#firstPartyOnly;
  }

  static originMatcher(value: string | undefined): OriginMatcher | undefined {
    const text = (value ?? '').trim();
    if (text === '') return undefined;
    const raw = text.toLowerCase().replace(/\/+$/, '');
    if (text.includes('://')) {
      const url = Http.parseUrl(text);
      return url && EndpointFilter.HTTP_SCHEMES.has(url.protocol) ? { origin: url.origin } : { origin: raw };
    }
    const url = Http.parseUrl(`http://${text}`);
    if (!url || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') return { hostname: raw };
    const port = EndpointFilter.EXPLICIT_PORT.exec(raw)?.[1];
    return port === undefined ? { hostname: url.hostname } : { hostname: url.hostname, port: Number(port) };
  }

  static textFields(): string {
    const labels = EndpointFilter.TEXT_FIELDS.map(([label]) => label);
    return labels.length > 1 ? `${labels.slice(0, -1).join(', ')} or ${labels[labels.length - 1]}` : labels.join('');
  }

  matches(endpoint: Endpoint): boolean {
    if (this.#methods.size > 0 && !this.#methods.has(endpoint.method.toUpperCase())) return false;
    if (this.#kinds.size > 0 && !this.#kinds.has(endpoint.kind)) return false;
    if (this.#firstPartyOnly && !endpoint.firstParty) return false;
    if (this.#origin && !EndpointFilter.#originMatches(this.#origin, endpoint.origin)) return false;
    if (this.#terms.length > 0) {
      const haystack = EndpointFilter.#haystack(endpoint);
      if (!this.#terms.every((term) => haystack.includes(term))) return false;
    }
    return true;
  }

  apply(model: ApiModel): Endpoint[] {
    return model.endpoints.filter((endpoint) => this.matches(endpoint));
  }

  cookies(model: ApiModel): CookieInfo[] {
    return this.active ? EndpointIndex.subset(model, this.apply(model)).cookies : model.cookies;
  }

  describe(): string[] {
    const parts: string[] = [];
    if (this.#methods.size > 0) parts.push(`method ${[...this.#methods].join('|')}`);
    if (this.#kinds.size > 0) parts.push(`kind ${[...this.#kinds].join('|')}`);
    if (this.#origin) parts.push(`origin ${EndpointFilter.#originText(this.#origin)}`);
    if (this.#terms.length > 0) parts.push(`text "${this.#terms.join(' ')}"`);
    if (this.#firstPartyOnly) parts.push('first-party only');
    return parts;
  }

  static #split(value: string | undefined): string[] {
    return (value ?? '').split(EndpointFilter.LIST_SEPARATOR).filter((part) => part !== '');
  }

  static #originText(matcher: OriginMatcher): string {
    if (matcher.origin !== undefined) return matcher.origin;
    return matcher.port === undefined ? (matcher.hostname ?? '') : `${matcher.hostname ?? ''}:${matcher.port}`;
  }

  static #originMatches(matcher: OriginMatcher, origin: string): boolean {
    if (matcher.origin !== undefined) return origin.toLowerCase() === matcher.origin;
    const url = Http.parseUrl(origin);
    if (!url) return origin.toLowerCase() === matcher.hostname;
    if (url.hostname !== matcher.hostname) return false;
    return matcher.port === undefined || matcher.port === EndpointFilter.#effectivePort(url);
  }

  static #effectivePort(url: URL): number | undefined {
    return url.port === '' ? EndpointFilter.DEFAULT_PORTS[url.protocol] : Number(url.port);
  }

  static #haystack(endpoint: Endpoint): string {
    return EndpointFilter.TEXT_FIELDS.map(([, read]) => read(endpoint) ?? '')
      .join('\n')
      .toLowerCase();
  }
}
