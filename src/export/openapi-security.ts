import type { ApiModel, CookieRole, CsrfToken, Endpoint } from '../model/index.js';
import { Json } from '../shared/index.js';
import { Helpers } from './helpers.js';
import { OpenApiComponents } from './openapi-components.js';

export type SecurityRequirement = Record<string, string[]>;

export class OpenApiSecurity {
  static readonly BEARER_KEY = 'http:bearer';
  static readonly BEARER_NAME = 'bearerAuth';
  static readonly AUTHORIZATION = 'authorization';

  readonly #model: ApiModel;
  readonly #components: OpenApiComponents;
  readonly #roles: Map<string, Set<CookieRole>>;

  constructor(model: ApiModel, components: OpenApiComponents) {
    this.#model = model;
    this.#components = components;
    this.#roles = Helpers.cookieRoles(model);
  }

  requirements(endpoint: Endpoint): SecurityRequirement[] {
    const cookies = Helpers.authCookies(this.#model, endpoint, this.#roles).map((name) => this.#cookie(name));
    const csrf = endpoint.auth.csrf.filter((token) => token.location === 'header').map((token) => this.#csrfHeader(token));
    const headers = this.#authHeaders(endpoint).map((name) => this.#header(name));
    const alternatives: string[][] = [];
    if (endpoint.auth.bearer) alternatives.push([this.#bearer(), ...headers]);
    if (cookies.length > 0) alternatives.push([...cookies, ...csrf, ...headers]);
    if (!endpoint.auth.bearer && cookies.length === 0 && csrf.length + headers.length > 0) alternatives.push([...csrf, ...headers]);
    const seen = new Set<string>();
    const out: SecurityRequirement[] = [];
    for (const names of alternatives) {
      const requirement = Object.fromEntries([...new Set(names)].map((name) => [name, [] as string[]]));
      const key = Json.stableStringify(requirement, 0);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(requirement);
    }
    return out;
  }

  coveredHeaders(endpoint: Endpoint): Set<string> {
    const out = new Set<string>(this.#authHeaders(endpoint));
    for (const token of endpoint.auth.csrf) if (token.location === 'header') out.add(token.name.toLowerCase());
    if (endpoint.auth.bearer) out.add(OpenApiSecurity.AUTHORIZATION);
    return out;
  }

  #authHeaders(endpoint: Endpoint): string[] {
    return [...new Set(endpoint.auth.headers.map((name) => name.toLowerCase()))].filter((name) => !(endpoint.auth.bearer && name === OpenApiSecurity.AUTHORIZATION));
  }

  #cookie(name: string): string {
    const info = this.#model.cookies.find((cookie) => cookie.name === name && Helpers.AUTH_ROLES.has(cookie.role));
    const flags = info ? [info.httpOnly ? 'HttpOnly' : '', info.secure ? 'Secure' : '', info.sameSite ? `SameSite=${info.sameSite}` : ''].filter(Boolean) : [];
    const role = info?.role ?? 'session';
    const description = `${role === 'auth' ? 'Authentication' : 'Session'} cookie ${name}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}${info && info.setBy.length > 0 ? `, set by ${info.setBy.join(', ')}` : ''}.`;
    return this.#components.scheme(`cookie:${name}`, `${name} cookie`, { type: 'apiKey', in: 'cookie', name, description });
  }

  #csrfHeader(token: CsrfToken): string {
    const lower = token.name.toLowerCase();
    const source = token.sourceName ? `${token.source} ${token.sourceName}` : token.source;
    const description = `CSRF token sent in the ${token.name} header; the website takes it from ${source}${token.sourceUrl ? ` (${token.sourceUrl})` : ''}.`;
    return this.#components.scheme(`header:${lower}`, `${lower} header`, { type: 'apiKey', in: 'header', name: token.name, description });
  }

  #header(name: string): string {
    return this.#components.scheme(`header:${name}`, `${name} header`, { type: 'apiKey', in: 'header', name, description: `Credential sent in the ${name} header.` });
  }

  #bearer(): string {
    return this.#components.scheme(OpenApiSecurity.BEARER_KEY, OpenApiSecurity.BEARER_NAME, { type: 'http', scheme: 'bearer', description: 'Bearer token in the Authorization header.' });
  }
}
