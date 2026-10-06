import type { Capture, Cookie, Exchange } from '../model/index.js';
import { CookieParser } from '../capture/index.js';
import { Http } from '../shared/index.js';
import { Helpers } from './helpers.js';

export interface CookieJarTimelineDeps {
  parser: CookieParser;
}

interface Timed {
  readonly exchange: Exchange;
  readonly start: number;
  readonly end: number;
}

export class CookieJarTimeline {
  static readonly DEFAULT_PATH = '/';

  readonly #capture: Capture;
  readonly #parser: CookieParser;
  readonly #timed: readonly Timed[];

  constructor(capture: Capture, deps: CookieJarTimelineDeps) {
    this.#capture = capture;
    this.#parser = deps.parser;
    this.#timed = capture.exchanges
      .filter((exchange) => Http.reachedServer(exchange))
      .map((exchange) => {
        const start = Helpers.startMs(exchange);
        return { exchange, start, end: start + Math.max(0, exchange.durationMs) };
      })
      .filter((timed) => Number.isFinite(timed.start));
  }

  static create(capture: Capture): CookieJarTimeline {
    return new CookieJarTimeline(capture, { parser: new CookieParser() });
  }

  jarAt(at: number, url: URL): Cookie[] {
    let base: Timed | undefined;
    for (const timed of this.#timed) {
      const target = Helpers.httpUrl(timed.exchange.request.url);
      if (target?.origin !== url.origin || timed.start > at) continue;
      if (!base || timed.start >= base.start) base = timed;
    }
    const since = base?.start ?? Number.NEGATIVE_INFINITY;
    const later = this.#timed.filter((timed) => (timed === base || timed.end > since) && timed.end <= at).sort((a, b) => a.end - b.end);
    const sent = base ? this.#sent(base.exchange, url) : [];
    const jar = later.length > 0 ? this.#parser.replay(later.map((timed) => timed.exchange), sent) : sent;
    return jar.filter((cookie) => !CookieParser.isExpired(cookie, at));
  }

  #sent(exchange: Exchange, url: URL): Cookie[] {
    const host = url.hostname.toLowerCase();
    return Http.parseCookieHeader(Http.getHeader(exchange.request.headers, 'cookie'))
      .filter((pair) => pair.name !== '')
      .map((pair) => {
        const known = this.#capture.cookies.filter((cookie) => cookie.name === pair.name && (cookie.hostOnly ? cookie.domain === host : CookieParser.domainMatches(host, cookie.domain)));
        const same = known.find((cookie) => cookie.value === pair.value) ?? known[0];
        if (same) return { ...same, value: pair.value };
        return { name: pair.name, value: pair.value, domain: host, path: CookieJarTimeline.DEFAULT_PATH, expires: null, httpOnly: false, secure: false, sameSite: 'Lax', hostOnly: true };
      });
  }
}
