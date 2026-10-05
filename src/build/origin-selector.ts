import type { Capture, Exchange } from '../model/index.js';
import { Http } from '../shared/index.js';
import { Helpers } from './helpers.js';

export class OriginSelector {
  static readonly MAX_REDIRECTS = 50;

  static domainOf(url: string): string | undefined {
    const parsed = Helpers.httpUrl(url);
    return parsed ? Http.registrableDomain(parsed.hostname) : undefined;
  }

  static origins(capture: Capture): string[] {
    return Helpers.distinct(capture.exchanges.map((exchange) => Helpers.originOf(exchange.request.url)).filter((origin): origin is string => !!origin));
  }

  static startChain(capture: Capture): string[] {
    const start = Helpers.httpUrl(capture.startUrl);
    if (!start) return [];
    const chain = [start.href];
    let current: Exchange | undefined = capture.exchanges.find(
      (exchange) => exchange.resourceType === 'document' && Http.parseUrl(exchange.request.url)?.href === start.href,
    );
    for (let hops = 0; current && hops < OriginSelector.MAX_REDIRECTS; hops++) {
      const id: string = current.id;
      current = capture.exchanges.find((exchange) => exchange.redirectedFrom === id);
      if (current) chain.push(current.request.url);
    }
    return chain;
  }

  static referenceDomains(capture: Capture): Set<string> {
    const domains = new Set<string>();
    for (const url of OriginSelector.startChain(capture)) {
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
    const candidates = [...OriginSelector.origins(capture), ...OriginSelector.startChain(capture).map((url) => Helpers.originOf(url))].filter(
      (origin): origin is string => !!origin,
    );
    return Helpers.distinct(candidates)
      .filter((origin) => OriginSelector.isFirstParty(origin, domains))
      .sort(Helpers.compare);
  }

  static primary(capture: Capture, chosen: readonly string[]): string {
    const allowed = new Set(chosen);
    const chain = OriginSelector.startChain(capture).map((url) => Helpers.originOf(url));
    const documents = capture.exchanges
      .filter((exchange) => exchange.resourceType === 'document')
      .map((exchange) => Helpers.originOf(exchange.request.url))
      .filter((origin): origin is string => !!origin && allowed.has(origin));
    const all = capture.exchanges.map((exchange) => Helpers.originOf(exchange.request.url)).filter((origin): origin is string => !!origin && allowed.has(origin));
    const candidates = [...chain.reverse(), Helpers.mostFrequent(documents), Helpers.mostFrequent(all), chosen[0]];
    return candidates.find((origin): origin is string => origin !== undefined && allowed.has(origin)) ?? '';
  }
}
