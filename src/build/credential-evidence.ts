import { CREDENTIAL_COOKIE_ROLES } from '../model/index.js';
import type { CookieRole, Exchange } from '../model/index.js';
import { Http } from '../shared/index.js';

export type CookieGeneration = 'authenticated' | 'anonymous';

export interface CredentialEvidenceData {
  readonly roles: ReadonlyMap<string, CookieRole>;
  readonly generations: ReadonlyMap<string, CookieGeneration>;
  readonly loginPages: ReadonlySet<string>;
  readonly classify: (name: string) => CookieRole;
}

export class CredentialEvidence {
  static readonly CREDENTIAL_ROLES: ReadonlySet<CookieRole> = new Set<CookieRole>(CREDENTIAL_COOKIE_ROLES);
  static readonly FAILURE_STATUSES: ReadonlySet<number> = new Set([401, 403]);
  static readonly REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
  static readonly SUCCESS_MIN = 200;
  static readonly SUCCESS_MAX = 299;

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

  generation(name: string, value: string): CookieGeneration | undefined {
    return this.#data.generations.get(CredentialEvidence.key(name, value));
  }

  isCredential(name: string, value: string): boolean {
    return value !== '' && this.isCredentialRole(name) && this.generation(name, value) !== 'anonymous';
  }

  isLoginPage(url: URL): boolean {
    return this.#data.loginPages.has(url.origin + url.pathname);
  }

  isFailure(exchange: Exchange): boolean {
    const response = exchange.response;
    if (!response) return false;
    if (CredentialEvidence.FAILURE_STATUSES.has(response.status)) return true;
    if (!CredentialEvidence.REDIRECT_STATUSES.has(response.status)) return false;
    const location = Http.getHeader(response.headers, 'location');
    const target = location === undefined ? undefined : Http.parseUrl(location, exchange.request.url);
    const source = Http.parseUrl(exchange.request.url);
    return target !== undefined && this.isLoginPage(target) && !(source !== undefined && this.isLoginPage(source));
  }
}
