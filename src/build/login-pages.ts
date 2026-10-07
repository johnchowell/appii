import type { Exchange } from '../model/index.js';
import { LoginFormDetector } from '../forms/index.js';
import { Http } from '../shared/index.js';
import { Helpers } from './helpers.js';
import type { PageDocument } from './page-documents.js';

interface Observation {
  readonly at: number;
  readonly login: boolean;
  readonly document?: Exchange;
}

interface Timed {
  readonly exchange: Exchange;
  readonly at: number;
}

export class LoginPages {
  static readonly SIGN_IN: RegExp = /(?:^|[^a-z])(?:log|sign)[-_.]?(?:in|on)(?:[^a-z]|$)/i;
  static readonly REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
  static readonly NAVIGATION = 'document';
  static readonly MAX_HOPS = 20;

  readonly #observations: ReadonlyMap<string, readonly Observation[]>;
  readonly #timed: readonly Timed[];
  readonly #followed: ReadonlyMap<string, Exchange>;
  readonly #positions: ReadonlyMap<Exchange, number>;
  readonly #led = new Map<Exchange, boolean>();

  constructor(documents: readonly PageDocument[], exchanges: readonly Exchange[]) {
    this.#timed = Http.recorded(exchanges)
      .map((exchange, index) => ({ exchange, index, at: Helpers.startMs(exchange) }))
      .sort((a, b) => LoginPages.#order(a.at, b.at) || a.index - b.index)
      .map(({ exchange, at }) => ({ exchange, at }));
    this.#positions = new Map(this.#timed.map(({ exchange }, at) => [exchange, at]));
    this.#followed = new Map(this.#timed.flatMap(({ exchange }): [string, Exchange][] => (exchange.redirectedFrom === undefined ? [] : [[exchange.redirectedFrom, exchange]])));
    this.#observations = this.#observe(documents);
  }

  static none(): LoginPages {
    return new LoginPages([], []);
  }

  static key(url: URL): string {
    return url.origin + url.pathname;
  }

  static isSignIn(url: URL): boolean {
    return LoginPages.SIGN_IN.test(Http.decodeComponent(url.pathname));
  }

  static redirectTarget(exchange: Exchange): URL | undefined {
    const response = exchange.response;
    if (!response || !LoginPages.REDIRECT_STATUSES.has(response.status)) return undefined;
    const location = Http.getHeader(response.headers, 'location');
    return location === undefined ? undefined : Http.parseUrl(location, exchange.request.url);
  }

  ledTo(exchange: Exchange): boolean {
    const known = this.#led.get(exchange);
    if (known !== undefined) return known;
    const led = this.#ledTo(exchange, 0);
    this.#led.set(exchange, led);
    return led;
  }

  isSource(exchange: Exchange): boolean {
    const url = Http.parseUrl(exchange.request.url);
    if (!url) return false;
    return LoginPages.isSignIn(url) || this.#stateAt(LoginPages.key(url), Helpers.startMs(exchange)) === true;
  }

  #ledTo(exchange: Exchange, hops: number): boolean {
    const target = LoginPages.redirectTarget(exchange);
    if (!target) return false;
    if (LoginPages.isSignIn(target)) return true;
    const next = this.#next(exchange, target);
    if (next && LoginPages.redirectTarget(next) && hops < LoginPages.MAX_HOPS) return this.#ledTo(next, hops + 1);
    const shown = next ? this.#shown(next) : undefined;
    return shown ?? this.#stateAt(LoginPages.key(target), Helpers.startMs(exchange)) === true;
  }

  #next(exchange: Exchange, target: URL): Exchange | undefined {
    const followed = this.#followed.get(exchange.id);
    if (followed) return followed;
    const key = LoginPages.key(target);
    const from = this.#positions.get(exchange);
    const later = from === undefined ? [] : this.#timed.slice(from + 1);
    return later.find((timed) => {
      const url = Http.parseUrl(timed.exchange.request.url);
      return url !== undefined && LoginPages.key(url) === key;
    })?.exchange;
  }

  #shown(exchange: Exchange): boolean | undefined {
    const url = Http.parseUrl(exchange.request.url);
    if (!url) return undefined;
    const own = (this.#observations.get(LoginPages.key(url)) ?? []).filter((observation) => observation.document === exchange);
    return own.length === 0 ? undefined : own.some((observation) => observation.login);
  }

  #stateAt(key: string, at: number): boolean | undefined {
    const list = this.#observations.get(key) ?? [];
    const before = list.filter((observation) => observation.at <= at);
    return (before[before.length - 1] ?? list[0])?.login;
  }

  #observe(documents: readonly PageDocument[]): Map<string, Observation[]> {
    const byId = new Map(this.#timed.map((timed) => [timed.exchange.id, timed.exchange]));
    const navigations = new Map<string, Timed[]>();
    for (const timed of this.#timed) {
      if (timed.exchange.resourceType !== LoginPages.NAVIGATION) continue;
      const url = Http.parseUrl(timed.exchange.request.url);
      if (!url) continue;
      const key = LoginPages.key(url);
      const list = navigations.get(key) ?? [];
      list.push(timed);
      navigations.set(key, list);
    }
    const out = new Map<string, Observation[]>();
    for (const { page, forms } of documents) {
      const url = Http.parseUrl(page.url);
      if (!url) continue;
      const key = LoginPages.key(url);
      const login = forms.some((form) => LoginFormDetector.isLogin(form));
      const document = page.exchange !== undefined ? byId.get(page.exchange) : (navigations.get(key) ?? []).filter((timed) => timed.at <= page.at).at(-1)?.exchange;
      const list = out.get(key) ?? [];
      list.push(document === undefined ? { at: page.at, login } : { at: page.at, login, document });
      out.set(key, list);
    }
    for (const list of out.values()) list.sort((a, b) => LoginPages.#order(a.at, b.at));
    return out;
  }

  static #order(a: number, b: number): number {
    const left = Number.isFinite(a) ? a : Number.POSITIVE_INFINITY;
    const right = Number.isFinite(b) ? b : Number.POSITIVE_INFINITY;
    return left === right ? 0 : left < right ? -1 : 1;
  }
}
