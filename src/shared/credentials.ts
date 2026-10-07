import { CREDENTIAL_COOKIE_ROLES } from '../model/index.js';
import type { AnonymousAccess, ApiModel, CookieRole, Endpoint, SeenState } from '../model/index.js';
import { EndpointIndex } from './endpoints.js';
import { parseUrl } from './http.js';

export type CredentialKind = 'cookie' | 'header' | 'http';

export interface Credential {
  readonly kind: CredentialKind;
  readonly name: string;
}

export type CookieRoles = ReadonlyMap<string, ReadonlySet<CookieRole>>;

export class Credentials {
  static readonly COOKIE: CredentialKind = 'cookie';
  static readonly HEADER: CredentialKind = 'header';
  static readonly HTTP: CredentialKind = 'http';
  static readonly BEARER = 'bearer';
  static readonly BASIC = 'basic';
  static readonly AUTHORIZATION = 'authorization';
  static readonly ENTRY: RegExp = /^(?:cookie:[^\r\n]+|header:[!#$%&'*+.^_`|~0-9A-Za-z-]+|http:[!#$%&'*+.^_`|~0-9A-Za-z-]+)$/;
  static readonly AUTH_SCHEME: RegExp = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)[ \t]+\S/;
  static readonly ROLES: ReadonlySet<CookieRole> = new Set<CookieRole>(CREDENTIAL_COOKIE_ROLES);
  static readonly KINDS: ReadonlySet<string> = new Set<CredentialKind>(['cookie', 'header', 'http']);
  static readonly OPTIONAL_MARK = '?';
  static readonly UNTESTED_MARK = '~';
  static readonly UNKNOWN_MARK = '?';
  static readonly ANONYMOUS_LABELS: Readonly<Record<AnonymousAccess, string>> = Object.freeze({ allowed: 'allowed', refused: 'refused', untested: 'not tested' });
  static readonly UNTESTED_NOTE = 'anonymous access not tested';
  static readonly OPTIONAL_NOTE = 'optional';
  static readonly REFUSAL_STATUSES: ReadonlySet<number> = new Set([401, 403]);
  static readonly AUTHENTICATED: SeenState = 'authenticated';

  static entry(kind: CredentialKind, name: string): string {
    return `${kind}:${kind === Credentials.COOKIE ? name : name.toLowerCase()}`;
  }

  static parse(entry: string): Credential | undefined {
    const colon = entry.indexOf(':');
    const kind = entry.slice(0, colon);
    if (colon <= 0 || !Credentials.KINDS.has(kind)) return undefined;
    return { kind: kind as CredentialKind, name: entry.slice(colon + 1) };
  }

  static scheme(authorization: string): string | undefined {
    return Credentials.AUTH_SCHEME.exec(authorization.trim())?.[1]?.toLowerCase();
  }

  static roles(model: Pick<ApiModel, 'cookies'>): Map<string, Set<CookieRole>> {
    const roles = new Map<string, Set<CookieRole>>();
    for (const cookie of model.cookies) {
      const set = roles.get(cookie.name) ?? new Set<CookieRole>();
      set.add(cookie.role);
      roles.set(cookie.name, set);
    }
    return roles;
  }

  static isCredentialCookie(name: string, roles: CookieRoles | undefined): boolean {
    if (!roles) return true;
    return [...(roles.get(name) ?? [])].some((role) => Credentials.ROLES.has(role));
  }

  static sets(endpoint: Endpoint, roles?: CookieRoles): string[][] {
    const auth = endpoint.auth;
    if (auth.sets !== undefined) return auth.sets.map((set) => [...set]);
    const set = new Set<string>();
    for (const name of auth.cookies) if (Credentials.isCredentialCookie(name, roles)) set.add(Credentials.entry(Credentials.COOKIE, name));
    if (auth.bearer) set.add(Credentials.entry(Credentials.HTTP, Credentials.BEARER));
    for (const scheme of auth.schemes ?? []) set.add(Credentials.entry(Credentials.HTTP, scheme));
    for (const name of auth.headers) {
      const lower = name.toLowerCase();
      if (lower === Credentials.AUTHORIZATION && (auth.bearer || (auth.schemes ?? []).length > 0)) continue;
      set.add(Credentials.entry(Credentials.HEADER, lower));
    }
    return set.size === 0 ? [] : [[...set].sort()];
  }

  static all(endpoint: Endpoint, roles?: CookieRoles): Credential[] {
    const seen = new Set<string>();
    const out: Credential[] = [];
    for (const set of Credentials.sets(endpoint, roles)) {
      for (const entry of set) {
        const credential = Credentials.parse(entry);
        if (!credential || seen.has(entry)) continue;
        seen.add(entry);
        out.push(credential);
      }
    }
    return out;
  }

  static cookies(endpoint: Endpoint, roles?: CookieRoles): string[] {
    return Credentials.#names(endpoint, Credentials.COOKIE, roles);
  }

  static headers(endpoint: Endpoint, roles?: CookieRoles): string[] {
    return Credentials.#names(endpoint, Credentials.HEADER, roles);
  }

  static schemes(endpoint: Endpoint, roles?: CookieRoles): string[] {
    return Credentials.#names(endpoint, Credentials.HTTP, roles);
  }

  static authenticatedOnly(endpoint: Endpoint): boolean {
    const seen = endpoint.auth.seen ?? [];
    return seen.length === 1 && seen[0] === Credentials.AUTHENTICATED;
  }

  static loggedInOnly(endpoint: Endpoint): boolean {
    return endpoint.count > 0 && (Credentials.authenticatedOnly(endpoint) || endpoint.auth.anonymous === 'refused');
  }

  static foundAfterLogin(model: Pick<ApiModel, 'endpoints' | 'forms'>, endpoint: Endpoint): boolean {
    const form = endpoint.form;
    if (endpoint.count > 0 || !form) return false;
    const linked = model.forms.filter((candidate) => candidate.endpoints?.includes(endpoint.id) === true).flatMap((candidate) => candidate.pages ?? [candidate.pageUrl]);
    return [...new Set([form.pageUrl, ...linked])].every((page) => {
      const url = parseUrl(page);
      if (!url) return false;
      const loads = model.endpoints.filter(
        (candidate) => candidate.method.toUpperCase() === EndpointIndex.PAGE_LOAD_METHOD && candidate.origin === url.origin && EndpointIndex.matchPath(candidate.path, url.pathname) !== undefined,
      );
      return loads.length > 0 && loads.every((load) => Credentials.loggedInOnly(load));
    });
  }

  static optional(endpoint: Endpoint): boolean {
    return endpoint.auth.anonymous !== 'refused';
  }

  static untested(endpoint: Endpoint): boolean {
    return endpoint.auth.anonymous === 'untested';
  }

  static anonymousLabel(endpoint: Endpoint): string {
    return Credentials.ANONYMOUS_LABELS[endpoint.auth.anonymous];
  }

  static required(endpoint: Endpoint, roles?: CookieRoles): boolean {
    return Credentials.sets(endpoint, roles).length > 0 && !Credentials.optional(endpoint);
  }

  static refusals(endpoint: Endpoint, roles?: CookieRoles): number[] {
    if (endpoint.auth.anonymous !== 'refused' || Credentials.sets(endpoint, roles).length > 0) return [];
    return EndpointIndex.statuses(endpoint);
  }

  static refusalNote(endpoint: Endpoint, roles?: CookieRoles): string {
    const statuses = Credentials.refusals(endpoint, roles);
    return statuses.length === 0 ? '' : `required, not captured (answered ${statuses.join(' and ')} without credentials)`;
  }

  static label(credential: Credential): string {
    if (credential.kind === Credentials.HTTP) return credential.name;
    return `${credential.kind} ${credential.name}`;
  }

  static kinds(endpoint: Endpoint, roles?: CookieRoles): string[] {
    const credentials = Credentials.all(endpoint, roles);
    const out: string[] = [];
    if (credentials.some((credential) => credential.kind === Credentials.COOKIE)) out.push(Credentials.COOKIE);
    for (const credential of credentials) if (credential.kind === Credentials.HTTP && !out.includes(credential.name)) out.push(credential.name);
    if (credentials.some((credential) => credential.kind === Credentials.HEADER)) out.push(Credentials.HEADER);
    if (out.length === 0) {
      const refusals = Credentials.refusals(endpoint, roles);
      return refusals.length === 0 ? [] : [refusals.join('/') + Credentials.UNKNOWN_MARK];
    }
    const marker = Credentials.untested(endpoint) ? Credentials.UNTESTED_MARK : Credentials.optional(endpoint) ? Credentials.OPTIONAL_MARK : '';
    return out.map((kind) => kind + marker);
  }

  static describe(endpoint: Endpoint, roles?: CookieRoles): string {
    const sets = Credentials.sets(endpoint, roles).map((set) =>
      set
        .map((entry) => Credentials.parse(entry))
        .filter((credential): credential is Credential => credential !== undefined)
        .map((credential) => Credentials.label(credential))
        .join(' + '),
    );
    if (sets.length === 0) return Credentials.refusalNote(endpoint, roles);
    const text = sets.join(' or ');
    if (Credentials.untested(endpoint)) return `${text} (${Credentials.UNTESTED_NOTE})`;
    return Credentials.optional(endpoint) ? `${text} (${Credentials.OPTIONAL_NOTE})` : text;
  }

  static exampleCookies(endpoint: Endpoint, roles?: CookieRoles): string[] {
    const wanted = new Set(Credentials.cookies(endpoint, roles));
    for (const token of endpoint.auth.csrf) {
      if (token.source === 'cookie' && token.sourceName !== undefined && token.sourceName !== '') wanted.add(token.sourceName);
      for (const name of token.sessionCookies ?? []) wanted.add(name);
    }
    const ordered = endpoint.auth.cookies.filter((name) => wanted.has(name));
    for (const name of wanted) if (!ordered.includes(name)) ordered.push(name);
    return ordered;
  }

  static #names(endpoint: Endpoint, kind: CredentialKind, roles: CookieRoles | undefined): string[] {
    return Credentials.all(endpoint, roles)
      .filter((credential) => credential.kind === kind)
      .map((credential) => credential.name);
  }
}
