import type { ApiModel, CsrfToken, Endpoint } from '../model/index.js';
import { Credentials, Json } from '../shared/index.js';
import type { CookieRoles, Credential } from '../shared/index.js';
import { Helpers } from './helpers.js';
import type { TokenSourceMarkup } from './helpers.js';
import { LoginGuide } from './login-guide.js';
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
  readonly #guide: LoginGuide;
  readonly #operations: ReadonlyMap<string, string>;

  constructor(model: ApiModel, components: OpenApiComponents, operations: ReadonlyMap<string, string> = new Map()) {
    this.#model = model;
    this.#components = components;
    this.#roles = Credentials.roles(model);
    this.#guide = new LoginGuide(model);
    this.#operations = operations;
  }

  get guide(): LoginGuide {
    return this.#guide;
  }

  operation(endpoint: Endpoint): string {
    return LoginGuide.label(endpoint, this.#operations.get(endpoint.id));
  }

  get roles(): CookieRoles {
    return this.#roles;
  }

  requirements(endpoint: Endpoint): SecurityRequirement[] {
    if (LoginGuide.isLogin(endpoint)) return [];
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
    if (!LoginGuide.isLogin(endpoint)) for (const token of endpoint.auth.csrf) if (token.location === 'header') out.add(token.name.toLowerCase());
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
    const setters = this.#names(info?.setBy ?? []);
    const lines = [`${kind} cookie ${name}${flags.length > 0 ? ` (${flags.join(', ')})` : ''}${setters.length > 0 ? `, set by ${setters.join(', ')}` : ''}.`];
    const issuers = this.#endpoints(this.#model.cookies.filter((cookie) => cookie.name === name).flatMap((cookie) => cookie.issuedBy ?? []));
    const revokers = this.#endpoints(this.#model.cookies.filter((cookie) => cookie.name === name).flatMap((cookie) => cookie.revokedBy ?? []));
    lines.push(...this.#login(issuers));
    if (revokers.length > 0) lines.push(`The logout ${revokers.length === 1 ? 'operation' : 'operations'} ${revokers.map((endpoint) => this.operation(endpoint)).join(', ')} ${revokers.length === 1 ? 'revokes' : 'revoke'} it.`);
    return this.#components.scheme(`cookie:${name}`, `${name} cookie`, { type: 'apiKey', in: 'cookie', name, description: lines.join(' ') });
  }

  #names(ids: readonly string[]): string[] {
    const names = ids.map((id) => {
      const endpoint = this.#guide.endpoint(id);
      return endpoint === undefined ? id : this.operation(endpoint);
    });
    return [...new Set(names)];
  }

  #endpoints(ids: readonly string[]): Endpoint[] {
    const out: Endpoint[] = [];
    for (const id of ids) {
      const endpoint = this.#guide.endpoint(id);
      if (endpoint && !out.includes(endpoint)) out.push(endpoint);
    }
    return out;
  }

  #login(issuers: readonly Endpoint[]): string[] {
    if (issuers.length > 0) return [`The login ${issuers.length === 1 ? 'operation' : 'operations'} ${issuers.map((endpoint) => this.operation(endpoint)).join(', ')} ${issuers.length === 1 ? 'issues' : 'issue'} it.`];
    const logins = this.#guide.logins();
    if (logins.length === 0) return [];
    return [`The login ${logins.length === 1 ? 'operation is' : 'operations are'} ${logins.map((endpoint) => this.operation(endpoint)).join(', ')}; ${LoginGuide.UNKNOWN_ISSUE}.`];
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
    if (lower === Credentials.BEARER) {
      const issuers = this.#guide.logins().filter((endpoint) => (endpoint.login?.issues.tokens.length ?? 0) > 0);
      const lines = [OpenApiSecurity.SCHEME_DESCRIPTIONS.bearer ?? ''];
      for (const endpoint of issuers) {
        const fields = endpoint.login?.issues.tokens ?? [];
        lines.push(`The login operation ${this.operation(endpoint)} returns it in the response ${fields.length === 1 ? 'field' : 'fields'} ${fields.join(', ')}.`);
      }
      if (issuers.length === 0) lines.push(...this.#login([]));
      return this.#components.scheme(OpenApiSecurity.BEARER_KEY, OpenApiSecurity.BEARER_NAME, { type: 'http', scheme: 'bearer', description: lines.join(' ') });
    }
    const description = OpenApiSecurity.SCHEME_DESCRIPTIONS[lower] ?? `HTTP ${scheme} authentication in the Authorization header.`;
    return this.#components.scheme(`http:${lower}`, `${lower} auth`, { type: 'http', scheme: lower, description });
  }
}
