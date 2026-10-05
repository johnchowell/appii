import type { Capture, CsrfToken, Endpoint, Exchange } from '../model/index.js';
import { CookieParser } from '../capture/index.js';
import { FormExtractor, TokenDetector } from '../forms/index.js';
import { Http, Json } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { CsrfSourceResolver } from './csrf-source-resolver.js';
import { EndpointMatcher } from './endpoint-matcher.js';
import { HeaderPolicy } from './header-policy.js';
import { Helpers } from './helpers.js';

export interface AuthDetectorDeps {
  extractor: FormExtractor;
  tokens: TokenDetector;
  body: BodyParser;
  headers?: HeaderPolicy;
  sources?: (capture: Capture) => CsrfSourceResolver;
}

interface TokenCandidate {
  location: CsrfToken['location'];
  name: string;
  value: string;
}

interface EndpointAuthState {
  readonly cookies: Set<string>;
  readonly headers: Set<string>;
  bearer: boolean;
  readonly csrf: Map<string, CsrfToken>;
}

export class AuthDetector {
  static readonly BEARER: RegExp = /^bearer[ \t]+\S/i;
  static readonly BODY_FIELD_KINDS: ReadonlySet<string> = new Set(['form', 'multipart', 'json']);

  readonly #tokens: TokenDetector;
  readonly #body: BodyParser;
  readonly #headers: HeaderPolicy;
  readonly #sources: (capture: Capture) => CsrfSourceResolver;

  constructor(deps: AuthDetectorDeps) {
    this.#tokens = deps.tokens;
    this.#body = deps.body;
    this.#headers = deps.headers ?? new HeaderPolicy();
    const headers = this.#headers;
    this.#sources = deps.sources ?? ((capture) => new CsrfSourceResolver(capture, { extractor: deps.extractor, tokens: deps.tokens, body: deps.body, headers }));
  }

  static create(): AuthDetector {
    const tokens = new TokenDetector();
    return new AuthDetector({ extractor: new FormExtractor({ tokens }), tokens, body: new BodyParser() });
  }

  detect(endpoints: Endpoint[], capture: Capture): void {
    const groups = new EndpointMatcher(endpoints, { body: this.#body }).group(capture.exchanges);
    let resolver: CsrfSourceResolver | undefined;
    const resolve = (): CsrfSourceResolver => (resolver ??= this.#sources(capture));
    for (const endpoint of endpoints) {
      const exchanges = groups.get(endpoint) ?? [];
      const state: EndpointAuthState = { cookies: new Set(), headers: new Set(), bearer: false, csrf: new Map() };
      for (const exchange of exchanges) this.#observe(state, exchange, resolve);
      this.#formTokens(state, endpoint);
      if (exchanges.length === 0) for (const name of AuthDetector.predictCookies(endpoint, capture)) state.cookies.add(name);
      endpoint.auth = {
        cookies: [...state.cookies].sort(Helpers.compare),
        headers: [...state.headers].sort(Helpers.compare),
        bearer: state.bearer,
        csrf: [...state.csrf.values()],
      };
    }
  }

  static predictCookies(endpoint: Endpoint, capture: Capture): string[] {
    const url = Helpers.httpUrl(endpoint.origin + endpoint.path);
    if (!url) return [];
    const host = url.hostname.toLowerCase();
    const end = Date.parse(capture.endedAt);
    const page = Helpers.httpUrl(endpoint.form?.pageUrl);
    const crossSite = page !== undefined && !Http.isSameSite(page.href, url.href);
    const names = capture.cookies
      .filter((cookie) => !(Number.isFinite(end) && CookieParser.isExpired(cookie, end)))
      .filter((cookie) => (cookie.hostOnly ? host === cookie.domain : CookieParser.domainMatches(host, cookie.domain)))
      .filter((cookie) => CookieParser.pathMatches(url.pathname, cookie.path))
      .filter((cookie) => !cookie.secure || Helpers.isPotentiallyTrustworthy(url))
      .filter((cookie) => !crossSite || cookie.sameSite === 'None' || (cookie.sameSite !== 'Strict' && Http.isSafeMethod(endpoint.method)))
      .map((cookie) => cookie.name);
    return Helpers.distinct(names);
  }

  #observe(state: EndpointAuthState, exchange: Exchange, resolve: () => CsrfSourceResolver): void {
    const headers = exchange.request.headers;
    for (const cookie of Http.parseCookieHeader(Http.getHeader(headers, 'cookie'))) if (cookie.name !== '') state.cookies.add(cookie.name);
    const candidates: TokenCandidate[] = [];
    for (const header of headers) {
      const name = header.name.toLowerCase();
      if (this.#headers.isAuth(name)) state.headers.add(name);
      if (name === 'authorization' && AuthDetector.BEARER.test(header.value.trim())) state.bearer = true;
      if (this.#headers.isCsrf(name)) candidates.push({ location: 'header', name, value: header.value });
    }
    const url = Helpers.httpUrl(exchange.request.url);
    if (url) {
      for (const [name, value] of url.searchParams) if (this.#tokens.isTokenField(name)) candidates.push({ location: 'query', name, value });
    }
    const body = this.#body.parse(exchange.request.body, Http.getHeader(headers, 'content-type'));
    if (AuthDetector.BODY_FIELD_KINDS.has(body.kind) && Json.isPlainObject(body.value)) {
      for (const [name, value] of Object.entries(body.value)) {
        const first = Array.isArray(value) ? value[0] : value;
        if (typeof first === 'string' && this.#tokens.isTokenField(name)) candidates.push({ location: 'body', name, value: first });
      }
    }
    for (const candidate of candidates) {
      const key = `${candidate.location}\u0000${candidate.name}`;
      const existing = state.csrf.get(key);
      if (existing && existing.source !== 'unknown') continue;
      const origin = candidate.value === '' ? { source: 'unknown' as const } : resolve().resolve(candidate.value, exchange);
      state.csrf.set(key, { location: candidate.location, name: candidate.name, ...origin });
    }
  }

  #formTokens(state: EndpointAuthState, endpoint: Endpoint): void {
    const form = endpoint.form;
    if (!form) return;
    const location: CsrfToken['location'] = endpoint.method === 'GET' ? 'query' : 'body';
    for (const name of form.tokenFields) {
      const key = `${location}\u0000${name}`;
      const existing = state.csrf.get(key);
      if (existing && existing.source !== 'unknown') continue;
      state.csrf.set(key, { location, name, source: 'hidden-field', sourceName: name, sourceUrl: form.pageUrl });
    }
  }
}
