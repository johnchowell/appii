import type { ApiModel, Endpoint, EndpointKind } from '../model/index.js';

export interface ListFilter {
  text?: string;
  method?: string;
  origin?: string;
  kind?: EndpointKind[];
  firstPartyOnly?: boolean;
}

export interface OriginMatcher {
  origin?: string;
  host?: string;
}

export class EndpointFilter {
  static readonly LIST_SEPARATOR: RegExp = /[\s,]+/;
  static readonly HTTP_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);

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
      const url = EndpointFilter.#parse(text);
      return url && EndpointFilter.HTTP_SCHEMES.has(url.protocol) ? { origin: url.origin } : { origin: raw };
    }
    const url = EndpointFilter.#parse(`http://${text}`);
    if (!url || url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '') return { host: raw };
    return { host: url.port === '' ? url.hostname : `${url.hostname}:${url.port}` };
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

  describe(): string[] {
    const parts: string[] = [];
    if (this.#methods.size > 0) parts.push(`method ${[...this.#methods].join('|')}`);
    if (this.#kinds.size > 0) parts.push(`kind ${[...this.#kinds].join('|')}`);
    if (this.#origin) parts.push(`origin ${this.#origin.origin ?? this.#origin.host ?? ''}`);
    if (this.#terms.length > 0) parts.push(`text "${this.#terms.join(' ')}"`);
    if (this.#firstPartyOnly) parts.push('first-party only');
    return parts;
  }

  static #split(value: string | undefined): string[] {
    return (value ?? '').split(EndpointFilter.LIST_SEPARATOR).filter((part) => part !== '');
  }

  static #parse(value: string): URL | undefined {
    try {
      return new URL(value);
    } catch {
      return undefined;
    }
  }

  static #originMatches(matcher: OriginMatcher, origin: string): boolean {
    if (matcher.origin !== undefined) return origin.toLowerCase() === matcher.origin;
    const url = EndpointFilter.#parse(origin);
    if (!url) return origin.toLowerCase() === matcher.host;
    return url.host === matcher.host || url.hostname === matcher.host;
  }

  static #haystack(endpoint: Endpoint): string {
    return [endpoint.id, endpoint.name, endpoint.key, endpoint.method, endpoint.kind, endpoint.origin + endpoint.path, endpoint.operationName ?? '']
      .join('\n')
      .toLowerCase();
  }
}
