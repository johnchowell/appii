import { CREDENTIAL_COOKIE_ROLES } from '../model/index.js';
import type { CookieRole, Exchange } from '../model/index.js';
import { Http } from '../shared/index.js';

export type CookieGeneration = 'authenticated' | 'anonymous';

export interface GenerationEvent {
  readonly at: number;
  readonly generation: CookieGeneration;
}

export interface CredentialEvidenceData {
  readonly roles: ReadonlyMap<string, CookieRole>;
  readonly generations: ReadonlyMap<string, readonly GenerationEvent[]>;
  readonly positions: ReadonlyMap<Exchange, number>;
  readonly loginPages: ReadonlySet<string>;
  readonly classify: (name: string) => CookieRole;
}

export class CredentialEvidence {
  static readonly CREDENTIAL_ROLES: ReadonlySet<CookieRole> = new Set<CookieRole>(CREDENTIAL_COOKIE_ROLES);
  static readonly FAILURE_STATUSES: ReadonlySet<number> = new Set([401, 403]);
  static readonly REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
  static readonly SUCCESS_MIN = 200;
  static readonly SUCCESS_MAX = 299;
  static readonly SIGN_IN: RegExp = /(?:^|[^a-z])(?:log|sign)[-_.]?(?:in|on)(?:[^a-z]|$)/i;

  readonly #data: CredentialEvidenceData;

  constructor(data: CredentialEvidenceData) {
    this.#data = data;
  }

  static key(name: string, value: string): string {
    return `${name}\u0000${value}`;
  }

  static isSuccess(exchange: Exchange): boolean {
    const status = exchange.response?.status;
    return status !== undefined && status >= CredentialEvidence.SUCCESS_MIN && status <= CredentialEvidence.SUCCESS_MAX;
  }

  role(name: string): CookieRole {
    return this.#data.roles.get(name) ?? this.#data.classify(name);
  }

  isCredentialRole(name: string): boolean {
    return CredentialEvidence.CREDENTIAL_ROLES.has(this.role(name));
  }

  generation(name: string, value: string, exchange?: Exchange): CookieGeneration | undefined {
    const events = this.#data.generations.get(CredentialEvidence.key(name, value)) ?? [];
    const at = exchange === undefined ? undefined : this.#data.positions.get(exchange);
    const preceding = at === undefined ? events : events.filter((event) => event.at < at);
    return (preceding[preceding.length - 1] ?? events[0])?.generation;
  }

  issued(name: string, value: string, exchange: Exchange): CookieGeneration | undefined {
    const at = this.#data.positions.get(exchange);
    if (at === undefined) return undefined;
    return (this.#data.generations.get(CredentialEvidence.key(name, value)) ?? []).find((event) => event.at === at)?.generation;
  }

  isCredential(name: string, value: string, exchange?: Exchange): boolean {
    return value !== '' && this.isCredentialRole(name) && this.generation(name, value, exchange) !== 'anonymous';
  }

  static loginPage(url: URL, pages: ReadonlySet<string>): boolean {
    return pages.has(url.origin + url.pathname) || CredentialEvidence.SIGN_IN.test(Http.decodeComponent(url.pathname));
  }

  static redirectTarget(exchange: Exchange): URL | undefined {
    const response = exchange.response;
    if (!response || !CredentialEvidence.REDIRECT_STATUSES.has(response.status)) return undefined;
    const location = Http.getHeader(response.headers, 'location');
    return location === undefined ? undefined : Http.parseUrl(location, exchange.request.url);
  }

  isLoginPage(url: URL): boolean {
    return CredentialEvidence.loginPage(url, this.#data.loginPages);
  }

  static failed(exchange: Exchange, pages: ReadonlySet<string>): boolean {
    const response = exchange.response;
    if (!response) return false;
    if (CredentialEvidence.FAILURE_STATUSES.has(response.status)) return true;
    const target = CredentialEvidence.redirectTarget(exchange);
    const source = Http.parseUrl(exchange.request.url);
    return target !== undefined && CredentialEvidence.loginPage(target, pages) && !(source !== undefined && CredentialEvidence.loginPage(source, pages));
  }

  isFailure(exchange: Exchange): boolean {
    return CredentialEvidence.failed(exchange, this.#data.loginPages);
  }
}
