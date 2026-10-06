import { SEEN_STATES } from '../model/index.js';
import type { AnonymousAccess, Capture, Cookie, CookieRole, CsrfToken, Endpoint, Exchange, SeenState } from '../model/index.js';
import { CookieParser } from '../capture/index.js';
import { FormExtractor, TokenDetector } from '../forms/index.js';
import { Credentials, Http, Json, Text } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { CookieClassifier } from './cookie-classifier.js';
import { CookieJarTimeline } from './cookie-jar-timeline.js';
import { CredentialAnalyzer } from './credential-analyzer.js';
import { CredentialEvidence } from './credential-evidence.js';
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
  analyzer?: CredentialAnalyzer;
  parser?: CookieParser;
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
  readonly schemes: Set<string>;
  bearer: boolean;
  readonly csrf: Map<string, CsrfToken>;
}

interface CredentialSets {
  readonly sets: string[][];
  readonly anonymous: AnonymousAccess;
  readonly seen: SeenState[];
}

export class AuthDetector {
  static readonly BEARER: RegExp = /^bearer[ \t]+\S/i;
  static readonly BODY_FIELD_KINDS: ReadonlySet<string> = new Set(['form', 'multipart', 'json']);
  static readonly PROXY_AUTHORIZATION = 'proxy-authorization';
  static readonly EVIDENCE_EXCLUDED_ROLES: ReadonlySet<CookieRole> = new Set<CookieRole>(['preference', 'tracking', 'csrf']);
  static readonly LOGIN_ROLE = 'login';
  static readonly ALLOWED: AnonymousAccess = 'allowed';
  static readonly REFUSED: AnonymousAccess = 'refused';
  static readonly UNTESTED: AnonymousAccess = 'untested';

  readonly #tokens: TokenDetector;
  readonly #body: BodyParser;
  readonly #headers: HeaderPolicy;
  readonly #redactor: Redactor;
  readonly #sources: (capture: Capture) => CsrfSourceResolver;
  readonly #cookies: CookieClassifier;
  readonly #analyzer: CredentialAnalyzer;
  readonly #documents: PageDocuments;
  readonly #parser: CookieParser;

  constructor(deps: AuthDetectorDeps) {
    this.#tokens = deps.tokens;
    this.#cookies = deps.cookies ?? new CookieClassifier();
    this.#body = deps.body;
    this.#headers = deps.headers ?? new HeaderPolicy({ tokens: deps.tokens });
    this.#redactor = deps.redactor ?? new Redactor(true, { tokens: deps.tokens });
    this.#analyzer = deps.analyzer ?? new CredentialAnalyzer({ cookies: this.#cookies, body: deps.body, headers: this.#headers, redactor: this.#redactor });
    const headers = this.#headers;
    const documents = deps.documents ?? new PageDocuments({ pages: new HtmlPages({ body: deps.body }), extractor: deps.extractor });
    this.#documents = documents;
    this.#parser = deps.parser ?? new CookieParser();
    this.#sources = deps.sources ?? ((capture) => new CsrfSourceResolver(capture, { tokens: deps.tokens, body: deps.body, documents, headers }));
  }

  static create(options: { redact?: boolean } = {}): AuthDetector {
    const tokens = new TokenDetector();
    const body = BodyParser.create();
    const extractor = new FormExtractor({ tokens });
    const headers = new HeaderPolicy({ tokens });
    const redactor = new Redactor(options.redact ?? true, { tokens });
    const cookies = new CookieClassifier();
    return new AuthDetector({
      extractor,
      tokens,
      body,
      headers,
      documents: new PageDocuments({ pages: new HtmlPages({ body }), extractor }),
      redactor,
      cookies,
      analyzer: new CredentialAnalyzer({ cookies, body, headers, redactor }),
      parser: new CookieParser(),
    });
  }

  detect(endpoints: Endpoint[], capture: Capture, evidence: CredentialEvidence = this.#analyzer.analyze(capture)): void {
    const groups = new EndpointMatcher(endpoints, { body: this.#body }).group(capture.exchanges);
    let resolver: CsrfSourceResolver | undefined;
    const resolve = (): CsrfSourceResolver => (resolver ??= this.#sources(capture));
    let timeline: CookieJarTimeline | undefined;
    const jar = (): CookieJarTimeline => (timeline ??= new CookieJarTimeline(capture, { parser: this.#parser }));
    for (const endpoint of endpoints) {
      const exchanges = (groups.get(endpoint) ?? []).filter((exchange) => Http.reachedServer(exchange));
      const state: EndpointAuthState = { cookies: new Set(), headers: new Set(), schemes: new Set(), bearer: false, csrf: new Map() };
      for (const exchange of exchanges) this.#observe(state, exchange, resolve, evidence);
      const predicted = exchanges.length === 0 ? this.#predicted(endpoint, capture, jar) : [];
      for (const cookie of predicted.flat()) state.cookies.add(cookie.name);
      const sessions = exchanges.length > 0 ? exchanges.flatMap((exchange) => CredentialAnalyzer.sent(exchange)) : predicted.flat();
      this.#formTokens(state, endpoint, Helpers.distinct(sessions.filter((cookie) => evidence.isCredentialRole(cookie.name)).map((cookie) => cookie.name)).sort(Text.compare), resolve);
      const found = exchanges.length > 0 ? this.#credentialSets(exchanges, evidence) : AuthDetector.#predictedSets(predicted, evidence);
      endpoint.auth = {
        cookies: [...state.cookies].sort(Text.compare),
        headers: [...state.headers].sort(Text.compare),
        bearer: state.bearer,
        csrf: [...state.csrf.values()],
        anonymous: endpoint.role === AuthDetector.LOGIN_ROLE && exchanges.length > 0 ? AuthDetector.ALLOWED : found.anonymous,
        ...(found.seen.length > 0 ? { seen: found.seen } : {}),
        ...(state.schemes.size > 0 ? { schemes: [...state.schemes].sort(Text.compare) } : {}),
        sets: found.sets,
      };
    }
  }

  isAnonymous(exchange: Exchange, evidence: CredentialEvidence): boolean {
    return exchange.response !== undefined && !evidence.isFailure(exchange) && this.credentialSet(exchange, evidence).length === 0;
  }

  credentialSet(exchange: Exchange, evidence: CredentialEvidence, evidenced: ReadonlySet<string> = new Set()): string[] {
    const out = new Set<string>();
    for (const cookie of CredentialAnalyzer.sent(exchange)) {
      if (evidence.isCredential(cookie.name, cookie.value, exchange) || evidenced.has(CredentialEvidence.key(cookie.name, cookie.value))) out.add(Credentials.entry(Credentials.COOKIE, cookie.name));
    }
    for (const header of exchange.request.headers) {
      const lower = header.name.toLowerCase();
      if (lower === AuthDetector.PROXY_AUTHORIZATION || header.value.trim() === '') continue;
      if (lower === Credentials.AUTHORIZATION) {
        const scheme = Credentials.scheme(header.value);
        out.add(scheme === undefined ? Credentials.entry(Credentials.HEADER, lower) : Credentials.entry(Credentials.HTTP, scheme));
      } else if (this.#headers.isAuth(lower)) {
        out.add(Credentials.entry(Credentials.HEADER, lower));
      }
    }
    return [...out].sort(Text.compare);
  }

  #credentialSets(exchanges: readonly Exchange[], evidence: CredentialEvidence): CredentialSets {
    const successes = exchanges.filter((exchange) => CredentialEvidence.isSuccess(exchange));
    const failures = exchanges.filter((exchange) => evidence.isFailure(exchange));
    const evidenced = this.#evidenced(successes, failures, evidence);
    const settled = exchanges.filter((exchange) => !failures.includes(exchange));
    const tier = successes.length > 0 ? successes : settled.length > 0 ? settled : exchanges;
    const sets = new Map<string, string[]>();
    for (const exchange of tier) {
      const set = this.credentialSet(exchange, evidence, evidenced);
      if (set.length > 0) sets.set(JSON.stringify(set), set);
    }
    const states = new Set<SeenState>();
    const unauthenticated: Exchange[] = [];
    for (const exchange of exchanges) {
      const authenticated = this.credentialSet(exchange, evidence, evidenced).length > 0;
      states.add(authenticated ? 'authenticated' : 'anonymous');
      if (!authenticated && exchange.response !== undefined) unauthenticated.push(exchange);
    }
    const anonymous =
      unauthenticated.length === 0 ? AuthDetector.UNTESTED : unauthenticated.some((exchange) => !evidence.isFailure(exchange)) ? AuthDetector.ALLOWED : AuthDetector.REFUSED;
    return {
      sets: [...sets.values()].sort((a, b) => a.length - b.length || Text.compare(a.join(' '), b.join(' '))),
      anonymous,
      seen: SEEN_STATES.filter((state) => states.has(state)),
    };
  }

  #evidenced(successes: readonly Exchange[], failures: readonly Exchange[], evidence: CredentialEvidence): Set<string> {
    if (successes.length === 0 || failures.length === 0) return new Set();
    const failed = new Set(failures.flatMap((exchange) => CredentialAnalyzer.sent(exchange).map((cookie) => CredentialEvidence.key(cookie.name, cookie.value))));
    const candidate = (cookie: { name: string; value: string }, exchange: Exchange): boolean =>
      cookie.value !== '' &&
      !AuthDetector.EVIDENCE_EXCLUDED_ROLES.has(evidence.role(cookie.name)) &&
      evidence.generation(cookie.name, cookie.value, exchange) !== 'anonymous' &&
      !failed.has(CredentialEvidence.key(cookie.name, cookie.value));
    const names = new Set(successes.flatMap((exchange) => CredentialAnalyzer.sent(exchange).filter((cookie) => candidate(cookie, exchange)).map((cookie) => cookie.name)));
    for (const name of [...names]) if (successes.some((exchange) => !CredentialAnalyzer.sent(exchange).some((cookie) => cookie.name === name))) names.delete(name);
    return new Set(
      successes.flatMap((exchange) =>
        CredentialAnalyzer.sent(exchange)
          .filter((cookie) => names.has(cookie.name) && candidate(cookie, exchange))
          .map((cookie) => CredentialEvidence.key(cookie.name, cookie.value)),
      ),
    );
  }

  static #predictedSets(predicted: readonly (readonly Cookie[])[], evidence: CredentialEvidence): CredentialSets {
    const sets = new Map<string, string[]>();
    for (const cookies of predicted) {
      const set = Helpers.distinct(cookies.filter((cookie) => evidence.isCredential(cookie.name, cookie.value)).map((cookie) => Credentials.entry(Credentials.COOKIE, cookie.name))).sort(Text.compare);
      if (set.length > 0) sets.set(JSON.stringify(set), set);
    }
    return { sets: [...sets.values()].sort((a, b) => a.length - b.length || Text.compare(a.join(' '), b.join(' '))), anonymous: AuthDetector.UNTESTED, seen: [] };
  }

  static predictCookies(endpoint: Endpoint, capture: Capture): string[] {
    const detector = AuthDetector.create();
    return Helpers.distinct(detector.#predicted(endpoint, capture, () => new CookieJarTimeline(capture, { parser: detector.#parser })).flat().map((cookie) => cookie.name));
  }

  #predicted(endpoint: Endpoint, capture: Capture, jar: () => CookieJarTimeline): Cookie[][] {
    const url = Helpers.httpUrl(endpoint.origin + endpoint.path);
    if (!url) return [];
    const moments = this.#sightings(endpoint, capture);
    if (moments.length === 0) return [AuthDetector.#sendable(endpoint, url, capture.cookies, Date.parse(capture.endedAt))];
    return moments.map((at) => AuthDetector.#sendable(endpoint, url, jar().jarAt(at, url), at));
  }

  #sightings(endpoint: Endpoint, capture: Capture): number[] {
    const form = endpoint.form;
    if (!form) return [];
    const page = HtmlPages.documentKey(form.pageUrl);
    const documents = [...this.#documents.of(capture).filter((document) => document.page.source === 'snapshot'), ...this.#documents.served(capture)];
    const times = documents
      .filter((document) => HtmlPages.documentKey(this.#redactor.url(document.page.url)) === page && document.forms.some((candidate) => candidate.selector === form.selector))
      .map((document) => document.page.at)
      .filter((at) => Number.isFinite(at));
    return Helpers.distinct(times).sort((a, b) => a - b);
  }

  static #sendable(endpoint: Endpoint, url: URL, jar: readonly Cookie[], at: number): Cookie[] {
    const host = url.hostname.toLowerCase();
    const page = Helpers.httpUrl(endpoint.form?.pageUrl);
    const crossSite = page !== undefined && !Http.isSameSite(page.href, url.href);
    const partition = CookieParser.site((page ?? url).href);
    return jar
      .filter((cookie) => !(Number.isFinite(at) && CookieParser.isExpired(cookie, at)))
      .filter((cookie) => (cookie.hostOnly ? host === cookie.domain : CookieParser.domainMatches(host, cookie.domain)))
      .filter((cookie) => CookieParser.pathMatches(url.pathname, cookie.path))
      .filter((cookie) => !cookie.secure || Http.isPotentiallyTrustworthy(url))
      .filter((cookie) => CookieParser.sentIn(cookie, partition))
      .filter((cookie) => !crossSite || cookie.sameSite === 'None' || (cookie.sameSite !== 'Strict' && Http.isSafeMethod(endpoint.method)));
  }

  #observe(state: EndpointAuthState, exchange: Exchange, resolve: () => CsrfSourceResolver, evidence: CredentialEvidence): void {
    const headers = exchange.request.headers;
    const sent = CredentialAnalyzer.sent(exchange);
    for (const cookie of sent) state.cookies.add(cookie.name);
    const sessions = Helpers.distinct(sent.filter((cookie) => evidence.isCredentialRole(cookie.name)).map((cookie) => cookie.name)).sort(Text.compare);
    const candidates: TokenCandidate[] = [];
    for (const header of headers) {
      const name = header.name.toLowerCase();
      if (this.#headers.isAuth(name)) state.headers.add(name);
      if (name === 'authorization' && AuthDetector.BEARER.test(header.value.trim())) state.bearer = true;
      const scheme = name === 'authorization' ? Credentials.scheme(header.value) : undefined;
      if (scheme !== undefined) state.schemes.add(scheme);
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
      state.csrf.set(key, this.#token(candidate, origin, sessions));
    }
  }

  #field(candidates: TokenCandidate[], location: CsrfToken['location'], name: string, value: string): void {
    if (this.#tokens.isCsrfName(name)) candidates.push({ location, name, value, evidence: false });
    else if (this.#tokens.isHiddenTokenField(name)) candidates.push({ location, name, value, evidence: true });
  }

  #pageEvidence(name: string, origin: TokenOrigin): boolean {
    if (origin.page?.kind === 'meta') return true;
    if (origin.page?.kind === 'hidden-field') return origin.page.name === name || this.#tokens.isHiddenTokenField(origin.page.name);
    return origin.source === 'cookie' && this.#tokens.isCsrfName(origin.sourceName ?? '');
  }

  #token(candidate: TokenCandidate, origin: TokenOrigin, sessions: readonly string[]): CsrfToken {
    const token: CsrfToken = { location: candidate.location, name: candidate.name, source: origin.source };
    if (origin.sourceName !== undefined) token.sourceName = origin.sourceName;
    if (origin.sourceUrl !== undefined) token.sourceUrl = this.#redactor.url(origin.sourceUrl);
    if (origin.sourceMethod !== undefined) token.sourceMethod = origin.sourceMethod;
    if (origin.source !== 'cookie' && sessions.length > 0) token.sessionCookies = [...sessions];
    return token;
  }

  #formTokens(state: EndpointAuthState, endpoint: Endpoint, sessions: readonly string[], resolve: () => CsrfSourceResolver): void {
    const form = endpoint.form;
    if (!form) return;
    const location: CsrfToken['location'] = endpoint.method === 'GET' ? 'query' : 'body';
    const page = HtmlPages.documentKey(form.pageUrl);
    const onPage = (url: string): boolean => HtmlPages.documentKey(this.#redactor.url(url)) === page;
    for (const name of form.tokenFields) {
      const key = `${location}\u0000${name}`;
      const existing = state.csrf.get(key);
      if (existing && existing.source !== 'unknown') continue;
      const origin = resolve().formToken(name, onPage) ?? { source: 'hidden-field', sourceName: name, sourceUrl: form.pageUrl };
      state.csrf.set(key, this.#token({ location, name, value: '', evidence: false }, origin, sessions));
    }
  }
}
