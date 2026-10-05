import type { Capture, Exchange } from '../model/index.js';
import { Http } from '../shared/index.js';
import { Helpers } from './helpers.js';

interface Hop {
  readonly url: string;
  readonly via?: number;
  readonly index: number;
}

export class OriginSelector {
  static readonly MAX_REDIRECTS = 50;
  static readonly PERMANENT_REDIRECTS: ReadonlySet<number> = new Set([301, 308]);

  static domainOf(url: string): string | undefined {
    const parsed = Helpers.httpUrl(url);
    return parsed ? Http.registrableDomain(parsed.hostname) : undefined;
  }

  static origins(capture: Capture): string[] {
    return Helpers.distinct(capture.exchanges.map((exchange) => Helpers.originOf(exchange.request.url)).filter((origin): origin is string => !!origin));
  }

  static startChain(capture: Capture): string[] {
    return OriginSelector.#hops(capture).map((hop) => hop.url);
  }

  static homeChain(capture: Capture): string[] {
    const hops = OriginSelector.#hops(capture);
    const [start] = hops;
    if (!start) return [];
    const home = OriginSelector.domainOf(start.url);
    const end = Math.max(...hops.map((hop) => hop.index));
    const laterHome = capture.exchanges.some((exchange, index) => index > end && exchange.resourceType === 'document' && OriginSelector.domainOf(exchange.request.url) === home);
    return hops.filter((hop, i) => i === 0 || OriginSelector.domainOf(hop.url) === home || OriginSelector.#moved(hop, home, laterHome)).map((hop) => hop.url);
  }

  static referenceDomains(capture: Capture): Set<string> {
    const domains = new Set<string>();
    for (const url of OriginSelector.homeChain(capture)) {
      const domain = OriginSelector.domainOf(url);
      if (domain) domains.add(domain);
    }
    if (domains.size > 0) return domains;
    const documents = capture.exchanges.filter((exchange) => exchange.resourceType === 'document').map((exchange) => Helpers.originOf(exchange.request.url));
    const all = capture.exchanges.map((exchange) => Helpers.originOf(exchange.request.url));
    const top = Helpers.mostFrequent(documents.filter((origin): origin is string => !!origin)) ?? Helpers.mostFrequent(all.filter((origin): origin is string => !!origin));
    const domain = top ? OriginSelector.domainOf(top) : undefined;
    if (domain) domains.add(domain);
    return domains;
  }

  static isFirstParty(origin: string, domains: ReadonlySet<string>): boolean {
    const domain = OriginSelector.domainOf(origin);
    return domain !== undefined && domains.has(domain);
  }

  static firstParty(capture: Capture): string[] {
    const domains = OriginSelector.referenceDomains(capture);
    const candidates = [...OriginSelector.origins(capture), ...OriginSelector.homeChain(capture).map((url) => Helpers.originOf(url))].filter(
      (origin): origin is string => !!origin,
    );
    return Helpers.distinct(candidates)
      .filter((origin) => OriginSelector.isFirstParty(origin, domains))
      .sort(Helpers.compare);
  }

  static primary(capture: Capture, chosen: readonly string[]): string {
    const allowed = new Set(chosen);
    const chain = OriginSelector.homeChain(capture).map((url) => Helpers.originOf(url));
    const documents = capture.exchanges
      .filter((exchange) => exchange.resourceType === 'document')
      .map((exchange) => Helpers.originOf(exchange.request.url))
      .filter((origin): origin is string => !!origin && allowed.has(origin));
    const all = capture.exchanges.map((exchange) => Helpers.originOf(exchange.request.url)).filter((origin): origin is string => !!origin && allowed.has(origin));
    const candidates = [...chain.reverse(), Helpers.mostFrequent(documents), Helpers.mostFrequent(all), chosen[0]];
    return candidates.find((origin): origin is string => origin !== undefined && allowed.has(origin)) ?? '';
  }

  static #moved(hop: Hop, home: string | undefined, laterHome: boolean): boolean {
    if (OriginSelector.#returnsTo(hop.url, home)) return false;
    if (hop.via !== undefined && OriginSelector.PERMANENT_REDIRECTS.has(hop.via)) return true;
    return !laterHome;
  }

  static #returnsTo(url: string, home: string | undefined): boolean {
    const parsed = Helpers.httpUrl(url);
    if (!parsed || home === undefined) return false;
    for (const value of parsed.searchParams.values()) {
      if (OriginSelector.domainOf(value) === home) return true;
    }
    return false;
  }

  static #hops(capture: Capture): Hop[] {
    const start = Helpers.httpUrl(capture.startUrl);
    if (!start) return [];
    const position = (exchange: Exchange | undefined): number => (exchange ? capture.exchanges.indexOf(exchange) : -1);
    let current: Exchange | undefined = capture.exchanges.find(
      (exchange) => exchange.resourceType === 'document' && Http.parseUrl(exchange.request.url)?.href === start.href,
    );
    const hops: Hop[] = [{ url: start.href, index: position(current) }];
    for (let count = 0; current && count < OriginSelector.MAX_REDIRECTS; count++) {
      const previous: Exchange = current;
      current = capture.exchanges.find((exchange) => exchange.redirectedFrom === previous.id);
      if (!current) break;
      const via = previous.response?.status;
      hops.push(via === undefined ? { url: current.request.url, index: position(current) } : { url: current.request.url, via, index: position(current) });
    }
    return hops;
  }
}
