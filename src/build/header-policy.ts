import type { Exchange, ResourceType } from '../model/index.js';
import { TokenDetector } from '../forms/index.js';

export interface HeaderPolicyDeps {
  tokens?: TokenDetector;
}

export class HeaderPolicy {
  static readonly BROWSER_HEADERS: ReadonlySet<string> = new Set([
    'user-agent',
    'accept',
    'cookie',
    'referer',
    'origin',
    'host',
    'connection',
    'content-length',
    'content-type',
    'content-encoding',
    'cache-control',
    'pragma',
    'priority',
    'upgrade-insecure-requests',
    'dnt',
    'te',
    'range',
    'keep-alive',
    'transfer-encoding',
    'trailer',
    'expect',
    'upgrade',
    'via',
    'purpose',
    'x-client-data',
    'save-data',
    'device-memory',
    'dpr',
    'viewport-width',
    'width',
    'downlink',
    'ect',
    'rtt',
    'service-worker',
    'service-worker-navigation-preload',
    'early-data',
    'attribution-reporting-eligible',
    'x-devtools-emulate-network-conditions-client-id',
  ]);
  static readonly BROWSER_PREFIXES: readonly string[] = [':', 'accept-', 'sec-', 'if-', 'proxy-', 'access-control-request-'];
  static readonly AUTH_HEADERS: ReadonlySet<string> = new Set([
    'authorization',
    'x-authorization',
    'x-api-key',
    'api-key',
    'apikey',
    'x-apikey',
    'x-auth',
    'x-auth-token',
    'x-access-token',
    'x-refresh-token',
    'x-id-token',
    'x-session-token',
    'x-user-token',
    'x-token',
    'x-amz-security-token',
    'x-goog-api-key',
    'x-rapidapi-key',
    'ocp-apim-subscription-key',
    'x-functions-key',
    'private-token',
  ]);
  static readonly AUTH_PATTERN: RegExp = /(?:^|-)(?:api-?key|auth-?token|access-?token|session-?token|id-?token)$/;
  static readonly NOTABLE_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
    'content-type',
    'location',
    'set-cookie',
    'www-authenticate',
    'retry-after',
    'link',
    'content-disposition',
    'refresh',
    'allow',
  ]);
  static readonly NOTABLE_RESPONSE_PATTERN: RegExp = /^(?:x-)?rate-?limit|csrf|xsrf/i;
  static readonly SCRIPT_TYPES: ReadonlySet<ResourceType> = new Set(['fetch', 'xhr']);
  static readonly SCRIPT_RANGE_HEADERS: ReadonlySet<string> = new Set(['range']);
  static readonly CONDITIONAL_HEADERS: ReadonlySet<string> = new Set(['if-none-match', 'if-match', 'if-range', 'if-modified-since', 'if-unmodified-since']);
  static readonly VALIDATOR_HEADERS: ReadonlySet<string> = new Set(['etag', 'last-modified']);
  static readonly ENTITY_TAG_HEADERS: ReadonlySet<string> = new Set(['etag', 'if-none-match', 'if-match', 'if-range']);

  readonly #tokens: TokenDetector;

  constructor(deps: HeaderPolicyDeps = {}) {
    this.#tokens = deps.tokens ?? new TokenDetector();
  }

  static create(): HeaderPolicy {
    return new HeaderPolicy({ tokens: new TokenDetector() });
  }

  static #entityTags(value: string): string[] {
    return value
      .split(',')
      .map((tag) => tag.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1'))
      .filter((tag) => tag !== '');
  }

  static #validatorValues(name: string, value: string): string[] {
    return HeaderPolicy.ENTITY_TAG_HEADERS.has(name) ? [value.trim(), ...HeaderPolicy.#entityTags(value)] : [value.trim()];
  }

  scriptHeaders(exchanges: readonly Exchange[]): Map<Exchange, Set<string>> {
    const out = new Map<Exchange, Set<string>>();
    const validators = new Map<string, Set<string>>();
    const ordered = [...exchanges].sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt));
    for (const exchange of ordered) {
      const key = exchange.request.url;
      const seen = validators.get(key) ?? new Set<string>();
      if (HeaderPolicy.SCRIPT_TYPES.has(exchange.resourceType)) {
        const names = new Set<string>();
        for (const header of exchange.request.headers) {
          const name = header.name.toLowerCase();
          if (HeaderPolicy.SCRIPT_RANGE_HEADERS.has(name)) names.add(name);
          else if (HeaderPolicy.CONDITIONAL_HEADERS.has(name) && !HeaderPolicy.#validatorValues(name, header.value).some((value) => seen.has(value))) names.add(name);
        }
        if (names.size > 0) out.set(exchange, names);
      }
      for (const header of exchange.response?.headers ?? []) {
        const name = header.name.toLowerCase();
        if (!HeaderPolicy.VALIDATOR_HEADERS.has(name)) continue;
        for (const value of HeaderPolicy.#validatorValues(name, header.value)) seen.add(value);
      }
      if (seen.size > 0) validators.set(key, seen);
    }
    return out;
  }

  isParam(name: string, scripted: ReadonlySet<string> = new Set()): boolean {
    const lower = name.toLowerCase();
    if (scripted.has(lower)) return true;
    if (lower === '' || HeaderPolicy.BROWSER_HEADERS.has(lower)) return false;
    return !HeaderPolicy.BROWSER_PREFIXES.some((prefix) => lower.startsWith(prefix));
  }

  isAuth(name: string): boolean {
    const lower = name.toLowerCase();
    return HeaderPolicy.AUTH_HEADERS.has(lower) || HeaderPolicy.AUTH_PATTERN.test(lower);
  }

  isCsrf(name: string): boolean {
    return this.#tokens.isCsrfHeader(name);
  }

  isNotableResponse(name: string): boolean {
    const lower = name.toLowerCase();
    return HeaderPolicy.NOTABLE_RESPONSE_HEADERS.has(lower) || HeaderPolicy.NOTABLE_RESPONSE_PATTERN.test(lower);
  }
}
