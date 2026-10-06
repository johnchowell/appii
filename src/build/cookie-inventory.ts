import type { Capture, Cookie, CookieInfo, CookieRole, Endpoint, Exchange } from '../model/index.js';
import { CookieParser } from '../capture/index.js';
import { Http, Text } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { CookieClassifier } from './cookie-classifier.js';
import type { CredentialEvidence } from './credential-evidence.js';
import { EndpointMatcher } from './endpoint-matcher.js';
import { Helpers } from './helpers.js';
import { Redactor } from './redactor.js';

export interface CookieInventoryOptions {
  redact?: boolean;
}

export interface CookieInventoryDeps {
  classifier: CookieClassifier;
  parser: CookieParser;
  redactor: Redactor;
  body?: BodyParser;
}

interface Entry {
  cookie: Cookie;
  readonly final: boolean;
  readonly stub: boolean;
  live: boolean;
  readonly setBy: Set<Endpoint>;
  readonly usedBy: Set<Endpoint>;
  readonly revokedBy: Set<Endpoint>;
}

export class CookieInventory {
  static readonly SECRET_ROLES: ReadonlySet<CookieRole> = new Set<CookieRole>(['session', 'auth', 'csrf']);
  static readonly LOGOUT_ROLE = 'logout';

  readonly #classifier: CookieClassifier;
  readonly #parser: CookieParser;
  readonly #redactor: Redactor;
  readonly #body: BodyParser;

  constructor(deps: CookieInventoryDeps) {
    this.#classifier = deps.classifier;
    this.#parser = deps.parser;
    this.#redactor = deps.redactor;
    this.#body = deps.body ?? new BodyParser();
  }

  static create(options: CookieInventoryOptions = {}): CookieInventory {
    return new CookieInventory({ classifier: new CookieClassifier(), parser: new CookieParser(), redactor: Redactor.create({ redact: options.redact ?? true }) });
  }

  static applies(cookie: Cookie, url: URL): boolean {
    const host = url.hostname.toLowerCase();
    const domainOk = cookie.hostOnly ? host === cookie.domain : CookieParser.domainMatches(host, cookie.domain);
    return domainOk && CookieParser.pathMatches(url.pathname, cookie.path);
  }

  build(capture: Capture, endpoints: Endpoint[], origins?: readonly string[], evidence?: CredentialEvidence): CookieInfo[] {
    const matcher = new EndpointMatcher(endpoints, { body: this.#body });
    const matched = new Map<Exchange, Endpoint | undefined>();
    const endpointOf = (exchange: Exchange): Endpoint | undefined => {
      if (!matched.has(exchange)) matched.set(exchange, matcher.match(exchange));
      return matched.get(exchange);
    };
    const entries = new Map<string, Entry>();
    const byName = new Map<string, Entry[]>();
    const add = (key: string, entry: Entry): Entry => {
      entries.set(key, entry);
      const list = byName.get(entry.cookie.name);
      if (list) list.push(entry);
      else byName.set(entry.cookie.name, [entry]);
      return entry;
    };
    for (const cookie of capture.cookies) {
      add(CookieParser.key(cookie), { cookie, final: true, stub: false, live: true, setBy: new Set(), usedBy: new Set(), revokedBy: new Set() });
    }
    const served = capture.exchanges.filter((exchange) => Http.reachedServer(exchange));
    for (const exchange of served) this.#observeSet(exchange, entries, add, endpointOf, evidence);
    for (const exchange of served) CookieInventory.#observeSent(exchange, byName, add, endpointOf);
    for (const endpoint of endpoints) {
      if (endpoint.count > 0) continue;
      const url = Helpers.httpUrl(endpoint.origin + endpoint.path);
      if (!url) continue;
      for (const name of endpoint.auth.cookies) {
        for (const entry of byName.get(name) ?? []) if (CookieInventory.applies(entry.cookie, url)) entry.usedBy.add(endpoint);
      }
    }
    const order = new Map(endpoints.map((endpoint, i) => [endpoint, i]));
    const hosts = Helpers.distinct((origins ?? endpoints.map((endpoint) => endpoint.origin)).map((origin) => Helpers.httpUrl(origin)?.hostname.toLowerCase()))
      .filter((host): host is string => host !== undefined);
    return [...entries.values()]
      .filter((entry) => CookieInventory.#relevant(entry, hosts))
      .sort((a, b) => CookieInventory.#compare(a.cookie, b.cookie))
      .map((entry) => this.#info(entry, order, evidence));
  }

  #observeSet(
    exchange: Exchange,
    entries: Map<string, Entry>,
    add: (key: string, entry: Entry) => Entry,
    endpointOf: (exchange: Exchange) => Endpoint | undefined,
    evidence: CredentialEvidence | undefined,
  ): void {
    const response = exchange.response;
    if (!response) return;
    const lines = Http.getHeaderAll(response.headers, 'set-cookie')
      .flatMap((value) => value.split('\n'))
      .filter((line) => line.trim() !== '');
    if (lines.length === 0) return;
    const survivors = new Map(this.#parser.replay([exchange]).map((cookie) => [CookieParser.key(cookie), cookie]));
    const endpoint = endpointOf(exchange);
    const partition = CookieParser.context(exchange).partition;
    for (const line of lines) {
      const parsed = this.#parser.parse(line, exchange.request.url, partition);
      if (!parsed) continue;
      const key = CookieParser.key(parsed);
      const live = survivors.get(key);
      let entry = entries.get(key);
      if (!entry) entry = add(key, { cookie: live ?? parsed, final: false, stub: false, live: live !== undefined, setBy: new Set(), usedBy: new Set(), revokedBy: new Set() });
      else if (!entry.final) {
        if (live) {
          entry.cookie = live;
          entry.live = true;
        } else if (!entry.live) {
          entry.cookie = parsed;
        }
      }
      if (endpoint) entry.setBy.add(endpoint);
      if (endpoint?.role === CookieInventory.LOGOUT_ROLE && evidence?.isCredentialRole(parsed.name) === true) {
        if (live === undefined || parsed.value === '' || evidence.issued(parsed.name, parsed.value, exchange) === 'anonymous') entry.revokedBy.add(endpoint);
      }
    }
  }

  static #observeSent(
    exchange: Exchange,
    byName: Map<string, Entry[]>,
    add: (key: string, entry: Entry) => Entry,
    endpointOf: (exchange: Exchange) => Endpoint | undefined,
  ): void {
    const header = Http.getHeader(exchange.request.headers, 'cookie');
    const url = Helpers.httpUrl(exchange.request.url);
    if (header === undefined || !url) return;
    const endpoint = endpointOf(exchange);
    const partition = CookieParser.context(exchange).partition;
    for (const { name, value } of Http.parseCookieHeader(header)) {
      const known = (byName.get(name) ?? []).filter((entry) => CookieInventory.applies(entry.cookie, url) && CookieParser.sentIn(entry.cookie, partition));
      if (known.length === 0) {
        const cookie: Cookie = {
          name,
          value,
          domain: url.hostname.toLowerCase(),
          path: '/',
          expires: null,
          httpOnly: false,
          secure: false,
          sameSite: null,
          hostOnly: true,
        };
        known.push(add(CookieParser.key(cookie), { cookie, final: false, stub: true, live: true, setBy: new Set(), usedBy: new Set(), revokedBy: new Set() }));
      }
      if (endpoint) for (const entry of known) entry.usedBy.add(endpoint);
    }
  }

  static #relevant(entry: Entry, hosts: readonly string[]): boolean {
    if (hosts.length === 0 || entry.setBy.size > 0 || entry.usedBy.size > 0) return true;
    const { cookie } = entry;
    return hosts.some((host) => (cookie.hostOnly ? host === cookie.domain : CookieParser.domainMatches(host, cookie.domain)));
  }

  static #compare(a: Cookie, b: Cookie): number {
    return (
      Text.compare(a.domain, b.domain) ||
      Text.compare(a.name, b.name) ||
      Text.compare(a.path, b.path) ||
      Number(a.hostOnly) - Number(b.hostOnly) ||
      Text.compare(a.partitionKey ?? '', b.partitionKey ?? '')
    );
  }

  #info(entry: Entry, order: ReadonlyMap<Endpoint, number>, evidence: CredentialEvidence | undefined): CookieInfo {
    const { cookie } = entry;
    const role = evidence ? evidence.role(cookie.name) : this.#classifier.classify(cookie.name);
    const ids = (set: ReadonlySet<Endpoint>): string[] =>
      [...set].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0)).map((endpoint) => endpoint.id);
    const issuedBy = ids(new Set([...entry.setBy].filter((endpoint) => endpoint.login?.issues.cookies.includes(cookie.name) === true)));
    const revokedBy = ids(entry.revokedBy);
    return {
      name: cookie.name,
      domain: cookie.hostOnly ? cookie.domain : `.${cookie.domain}`,
      path: cookie.path,
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
      sameSite: cookie.sameSite,
      ...(cookie.partitionKey !== undefined ? { partitionKey: cookie.partitionKey } : {}),
      session: cookie.expires === null,
      expires: CookieInventory.#expires(cookie.expires),
      role,
      setBy: ids(entry.setBy),
      usedBy: ids(entry.usedBy),
      ...(issuedBy.length > 0 ? { issuedBy } : {}),
      ...(revokedBy.length > 0 ? { revokedBy } : {}),
      valueExample: role === 'preference' || !this.#redactor.enabled ? cookie.value : Text.redact(cookie.value, CookieInventory.SECRET_ROLES.has(role) || Redactor.looksSecret(cookie.value)),
    };
  }

  static #expires(expires: number | null): string | null {
    if (expires === null || !Number.isFinite(expires)) return null;
    const date = new Date(expires * 1000);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
}
