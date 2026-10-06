import type { ApiModel, CsrfToken, Endpoint } from '../model/index.js';
import { Credentials, Json } from '../shared/index.js';
import type { CookieRoles, Credential } from '../shared/index.js';
import { Helpers } from './helpers.js';
import type { TokenSourceMarkup } from './helpers.js';
import { OpenApiComponents } from './openapi-components.js';

export type SecurityRequirement = Record<string, string[]>;

export class OpenApiSecurity {
  static readonly BEARER_KEY = 'http:bearer';
  static readonly BEARER_NAME = 'bearerAuth';
  static readonly AUTHORIZATION = 'authorization';
  static readonly SCHEME_DESCRIPTIONS: Readonly<Record<string, string>> = Object.freeze({
    bearer: 'Bearer token in the Authorization header.',
    basic: 'HTTP Basic authentication: a user name and password in the Authorization header.',
  });
  static readonly MARKUP: TokenSourceMarkup = Object.freeze({ text: (value: string) => value, code: (value: string) => value, url: (value: string) => value });

  readonly #model: ApiModel;
  readonly #components: OpenApiComponents;
  readonly #roles: CookieRoles;

  constructor(model: ApiModel, components: OpenApiComponents) {
    this.#model = model;
    this.#components = components;
    this.#roles = Credentials.roles(model);
  }

  requirements(endpoint: Endpoint): SecurityRequirement[] {
    const csrf = endpoint.auth.csrf.filter((token) => token.location === 'header').map((token) => this.#csrfHeader(token));
    const alternatives: string[][] = [];
    for (const set of Credentials.sets(endpoint, this.#roles)) {
      const credentials = set.map((entry) => Credentials.parse(entry)).filter((credential): credential is Credential => credential !== undefined);
      const names = credentials.map((credential) => this.#scheme(credential));
      alternatives.push(credentials.some((credential) => credential.kind === Credentials.COOKIE) ? [...names, ...csrf] : names);
    }
    if (alternatives.length === 0 && csrf.length > 0) alternatives.push(csrf);
    const seen = new Set<string>();
    const out: SecurityRequirement[] = [];
    for (const names of alternatives) {
      if (names.length === 0) continue;
      const requirement = Object.fromEntries([...new Set(names)].map((name) => [name, [] as string[]]));
      const key = Json.stableStringify(requirement, 0);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(requirement);
    }
    if (out.length > 0 && Credentials.optional(endpoint)) out.push({});
    return out;
  }

  coveredHeaders(endpoint: Endpoint): Set<string> {
    const out = new Set<string>(Credentials.headers(endpoint, this.#roles));
    for (const name of endpoint.auth.headers) out.add(name.toLowerCase());
    for (const token of endpoint.auth.csrf) if (token.location === 'header') out.add(token.name.toLowerCase());
    if (endpoint.auth.bearer || Credentials.schemes(endpoint, this.#roles).length > 0 || (endpoint.auth.schemes ?? []).length > 0) out.add(OpenApiSecurity.AUTHORIZATION);
    return out;
  }

  #scheme(credential: Credential): string {
    if (credential.kind === Credentials.COOKIE) return this.#cookie(credential.name);
    if (credential.kind === Credentials.HEADER) return this.#header(credential.name);
    return this.#http(credential.name);
  }

  #cookie(name: string): string {
    const info = this.#model.cookies.find((cookie) => cookie.name === name && Credentials.ROLES.has(cookie.role)) ?? this.#model.cookies.find((cookie) => cookie.name === name);
    const flags = info
      ? [info.httpOnly ? 'HttpOnly' : '', info.secure ? 'Secure' : '', info.sameSite ? `SameSite=${info.sameSite}` : '', info.partitionKey ? `Partitioned to ${info.partitionKey}` : ''].filter(Boolean)
      : [];
    const role = info?.role ?? 'session';
    const kind = role === 'auth' ? 'Authentication' : role === 'session' ? 'Session' : 'Credential';
    const description = `${kind} cookie ${name}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}${info && info.setBy.length > 0 ? `, set by ${info.setBy.join(', ')}` : ''}.`;
    return this.#components.scheme(`cookie:${name}`, `${name} cookie`, { type: 'apiKey', in: 'cookie', name, description });
  }

  #csrfHeader(token: CsrfToken): string {
    const lower = token.name.toLowerCase();
    const description = `CSRF token sent in the ${token.name} header; the website takes it from ${Helpers.tokenSource(token, OpenApiSecurity.MARKUP)}.`;
    return this.#components.scheme(`header:${lower}`, `${lower} header`, { type: 'apiKey', in: 'header', name: token.name, description });
  }

  #header(name: string): string {
    return this.#components.scheme(`header:${name}`, `${name} header`, { type: 'apiKey', in: 'header', name, description: `Credential sent in the ${name} header.` });
  }

  #http(scheme: string): string {
    const lower = scheme.toLowerCase();
    if (lower === Credentials.BEARER) return this.#components.scheme(OpenApiSecurity.BEARER_KEY, OpenApiSecurity.BEARER_NAME, { type: 'http', scheme: 'bearer', description: OpenApiSecurity.SCHEME_DESCRIPTIONS.bearer ?? '' });
    const description = OpenApiSecurity.SCHEME_DESCRIPTIONS[lower] ?? `HTTP ${scheme} authentication in the Authorization header.`;
    return this.#components.scheme(`http:${lower}`, `${lower} auth`, { type: 'http', scheme: lower, description });
  }
}
