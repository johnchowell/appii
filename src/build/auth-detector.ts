import { CREDENTIAL_COOKIE_ROLES } from '../model/index.js';
import type { Capture, CookieRole, CsrfToken, Endpoint, Exchange } from '../model/index.js';
import { CookieParser } from '../capture/index.js';
import { FormExtractor, TokenDetector } from '../forms/index.js';
import { Http, Json } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { CookieClassifier } from './cookie-classifier.js';
import { CsrfSourceResolver } from './csrf-source-resolver.js';
import { EndpointMatcher } from './endpoint-matcher.js';
import { HeaderPolicy } from './header-policy.js';
import { Helpers } from './helpers.js';
import { HtmlPages } from './html-pages.js';
import { PageDocuments } from './page-documents.js';
import { Redactor } from './redactor.js';
import type { TokenOrigin } from './csrf-source-resolver.js';

export interface AuthDetectorDeps {
  extractor: FormExtractor;
  tokens: TokenDetector;
  body: BodyParser;
  headers?: HeaderPolicy;
  documents?: PageDocuments;
  redactor?: Redactor;
  sources?: (capture: Capture) => CsrfSourceResolver;
  cookies?: CookieClassifier;
}

interface TokenCandidate {
  location: CsrfToken['location'];
  name: string;
  value: string;
  evidence: boolean;
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
  static readonly CREDENTIAL_ROLES: ReadonlySet<CookieRole> = new Set<CookieRole>(CREDENTIAL_COOKIE_ROLES);
  static readonly SUCCESS_MIN = 200;
  static readonly SUCCESS_MAX = 299;

  readonly #tokens: TokenDetector;
  readonly #body: BodyParser;
  readonly #headers: HeaderPolicy;
  readonly #redactor: Redactor;
  readonly #sources: (capture: Capture) => CsrfSourceResolver;
  readonly #cookies: CookieClassifier;

  constructor(deps: AuthDetectorDeps) {
    this.#tokens = deps.tokens;
    this.#cookies = deps.cookies ?? new CookieClassifier();
    this.#body = deps.body;
    this.#headers = deps.headers ?? new HeaderPolicy({ tokens: deps.tokens });
    this.#redactor = deps.redactor ?? new Redactor(true, { tokens: deps.tokens });
    const headers = this.#headers;
    const documents = deps.documents ?? new PageDocuments({ pages: new HtmlPages({ body: deps.body }), extractor: deps.extractor });
    this.#sources = deps.sources ?? ((capture) => new CsrfSourceResolver(capture, { tokens: deps.tokens, body: deps.body, documents, headers }));
  }

  static create(options: { redact?: boolean } = {}): AuthDetector {
    const tokens = new TokenDetector();
    const body = BodyParser.create();
    const extractor = new FormExtractor({ tokens });
    return new AuthDetector({
      extractor,
      tokens,
      body,
      headers: new HeaderPolicy({ tokens }),
      documents: new PageDocuments({ pages: new HtmlPages({ body }), extractor }),
      redactor: new Redactor(options.redact ?? true, { tokens }),
      cookies: new CookieClassifier(),
    });
  }

  detect(endpoints: Endpoint[], capture: Capture): void {
    const groups = new EndpointMatcher(endpoints, { body: this.#body }).group(capture.exchanges);
    let resolver: CsrfSourceResolver | undefined;
    const resolve = (): CsrfSourceResolver => (resolver ??= this.#sources(capture));
    for (const endpoint of endpoints) {
      const exchanges = (groups.get(endpoint) ?? []).filter((exchange) => Http.reachedServer(exchange));
      const state: EndpointAuthState = { cookies: new Set(), headers: new Set(), bearer: false, csrf: new Map() };
      for (const exchange of exchanges) this.#observe(state, exchange, resolve);
      this.#formTokens(state, endpoint);
      if (exchanges.length === 0) for (const name of AuthDetector.predictCookies(endpoint, capture)) state.cookies.add(name);
      endpoint.auth = {
        cookies: [...state.cookies].sort(Helpers.compare),
        headers: [...state.headers].sort(Helpers.compare),
        bearer: state.bearer,
        csrf: [...state.csrf.values()],
        ...(exchanges.some((exchange) => this.isAnonymous(exchange)) ? { anonymous: true } : {}),
      };
    }
  }

  isAnonymous(exchange: Exchange): boolean {
    const status = exchange.response?.status;
    if (status === undefined || status < AuthDetector.SUCCESS_MIN || status > AuthDetector.SUCCESS_MAX) return false;
    const headers = exchange.request.headers;
    if (headers.some((header) => this.#headers.isAuth(header.name))) return false;
    return !Http.parseCookieHeader(Http.getHeader(headers, 'cookie')).some((cookie) => AuthDetector.CREDENTIAL_ROLES.has(this.#cookies.classify(cookie.name)));
  }

  static predictCookies(endpoint: Endpoint, capture: Capture): string[] {
    const url = Helpers.httpUrl(endpoint.origin + endpoint.path);
    if (!url) return [];
    const host = url.hostname.toLowerCase();
    const end = Date.parse(capture.endedAt);
    const page = Helpers.httpUrl(endpoint.form?.pageUrl);
    const crossSite = page !== undefined && !Http.isSameSite(page.href, url.href);
    const partition = CookieParser.site((page ?? url).href);
    const names = capture.cookies
      .filter((cookie) => !(Number.isFinite(end) && CookieParser.isExpired(cookie, end)))
      .filter((cookie) => (cookie.hostOnly ? host === cookie.domain : CookieParser.domainMatches(host, cookie.domain)))
      .filter((cookie) => CookieParser.pathMatches(url.pathname, cookie.path))
      .filter((cookie) => !cookie.secure || Http.isPotentiallyTrustworthy(url))
      .filter((cookie) => CookieParser.sentIn(cookie, partition))
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
      if (this.#headers.isCsrf(name)) candidates.push({ location: 'header', name, value: header.value, evidence: !this.#tokens.isKnownCsrfHeader(name) });
    }
    const url = Helpers.httpUrl(exchange.request.url);
    if (url) {
      for (const [name, value] of url.searchParams) this.#field(candidates, 'query', name, value);
    }
    const body = this.#body.request(exchange.request);
    if (AuthDetector.BODY_FIELD_KINDS.has(body.kind) && Json.isPlainObject(body.value)) {
      for (const [name, value] of Object.entries(body.value)) {
        const first = Array.isArray(value) ? value[0] : value;
        if (typeof first === 'string') this.#field(candidates, 'body', name, first);
      }
    }
    for (const candidate of candidates) {
      const key = `${candidate.location}\u0000${candidate.name}`;
      const existing = state.csrf.get(key);
      if (existing && existing.source !== 'unknown') continue;
      const origin: TokenOrigin = candidate.value === '' ? { source: 'unknown' } : resolve().resolve(candidate.value, exchange);
      if (candidate.evidence && !this.#pageEvidence(candidate.name, origin)) continue;
      state.csrf.set(key, this.#token(candidate, origin));
    }
  }

  #field(candidates: TokenCandidate[], location: CsrfToken['location'], name: string, value: string): void {
    if (this.#tokens.isCsrfName(name)) candidates.push({ location, name, value, evidence: false });
    else if (this.#tokens.isHiddenTokenField(name)) candidates.push({ location, name, value, evidence: true });
  }

  #pageEvidence(name: string, origin: TokenOrigin): boolean {
    if (origin.source === 'meta') return true;
    if (origin.source === 'hidden-field') return origin.sourceName === name || this.#tokens.isHiddenTokenField(origin.sourceName ?? '');
    return origin.source === 'cookie' && this.#tokens.isCsrfName(origin.sourceName ?? '');
  }

  #token(candidate: TokenCandidate, origin: TokenOrigin): CsrfToken {
    const token: CsrfToken = { location: candidate.location, name: candidate.name, source: origin.source };
    if (origin.sourceName !== undefined) token.sourceName = origin.sourceName;
    if (origin.sourceUrl !== undefined) token.sourceUrl = this.#redactor.url(origin.sourceUrl);
    if (origin.sourceMethod !== undefined) token.sourceMethod = origin.sourceMethod;
    return token;
  }

  #formTokens(state: EndpointAuthState, endpoint: Endpoint): void {
    const form = endpoint.form;
    if (!form) return;
    const location: CsrfToken['location'] = endpoint.method === 'GET' ? 'query' : 'body';
    for (const name of form.tokenFields) {
      const key = `${location}\u0000${name}`;
      const existing = state.csrf.get(key);
      if (existing && existing.source !== 'unknown') continue;
      state.csrf.set(key, { location, name, source: 'hidden-field', sourceName: name, sourceUrl: this.#redactor.url(form.pageUrl) });
    }
  }
}
