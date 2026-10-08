import type { ApiModel, Endpoint, EndpointLogin } from '../model/index.js';
import { Credentials } from '../shared/index.js';
import type { CookieRoles } from '../shared/index.js';

export type EndpointLabel = (endpoint: Endpoint) => string;

export type CodeMarkup = (value: string) => string;

export type TextMarkup = (value: string) => string;

export class LoginGuide {
  static readonly LOGIN = 'login';
  static readonly LOGOUT = 'logout';
  static readonly LOGIN_LABEL = 'Login';
  static readonly LOGOUT_LABEL = 'Logout';
  static readonly NOT_SUBMITTED = 'known from a form; not submitted yet';
  static readonly UNKNOWN_ISSUE = 'the capture did not show which credential it issues';
  static readonly NOT_EXPORTED = 'not in this export; add it with --endpoints';
  static readonly ANONYMOUS_NOTES: Readonly<Record<string, string>> = Object.freeze({
    allowed: 'allowed: a request without credentials was answered',
    refused: 'refused: every request without credentials failed',
    untested: 'not tested: no request without credentials was captured',
  });

  readonly #model: ApiModel;
  readonly #roles: CookieRoles;
  readonly #byId: ReadonlyMap<string, Endpoint>;
  readonly #exported: ReadonlySet<string>;

  constructor(model: ApiModel, exported: readonly Endpoint[] = model.endpoints) {
    this.#model = model;
    this.#roles = Credentials.roles(model);
    this.#byId = new Map(model.endpoints.map((endpoint) => [endpoint.id, endpoint]));
    this.#exported = new Set(exported.map((endpoint) => endpoint.id));
  }

  exported(endpoint: Endpoint): boolean {
    return this.#exported.has(endpoint.id);
  }

  reference(endpoint: Endpoint, label: EndpointLabel, text: TextMarkup = (value) => value): string {
    return this.exported(endpoint) ? label(endpoint) : text(LoginGuide.missing(endpoint));
  }

  static missing(endpoint: Endpoint): string {
    return `${endpoint.method} ${endpoint.path} (${LoginGuide.NOT_EXPORTED} ${endpoint.name})`;
  }

  get roles(): CookieRoles {
    return this.#roles;
  }

  static isLogin(endpoint: Endpoint): boolean {
    return endpoint.role === LoginGuide.LOGIN;
  }

  static isLogout(endpoint: Endpoint): boolean {
    return endpoint.role === LoginGuide.LOGOUT;
  }

  static anonymousNote(endpoint: Endpoint): string {
    return LoginGuide.ANONYMOUS_NOTES[endpoint.auth.anonymous] ?? endpoint.auth.anonymous;
  }

  static fields(login: EndpointLogin, code: CodeMarkup): string {
    const parts: string[] = [];
    if (login.identifier !== undefined) parts.push(`the user name in ${code(login.identifier)}`);
    if (login.password !== '') parts.push(`the password in ${code(login.password)}`);
    return parts.join(' and ');
  }

  static issues(login: EndpointLogin, code: CodeMarkup): string {
    const parts: string[] = [];
    if (login.issues.cookies.length > 0) parts.push(`the ${login.issues.cookies.length === 1 ? 'cookie' : 'cookies'} ${login.issues.cookies.map(code).join(', ')}`);
    if (login.issues.tokens.length > 0) {
      parts.push(`the bearer token in the response ${login.issues.tokens.length === 1 ? 'field' : 'fields'} ${login.issues.tokens.map(code).join(', ')}`);
    }
    return parts.join(' and ');
  }

  static tokens(endpoint: Endpoint): readonly string[] {
    return LoginGuide.isLogin(endpoint) ? (endpoint.login?.issues.tokens ?? []) : [];
  }

  static issued(login: EndpointLogin): boolean {
    return login.issues.cookies.length > 0 || login.issues.tokens.length > 0;
  }

  logins(endpoints: readonly Endpoint[] = this.#model.endpoints): Endpoint[] {
    return endpoints.filter((endpoint) => LoginGuide.isLogin(endpoint));
  }

  logouts(endpoints: readonly Endpoint[] = this.#model.endpoints): Endpoint[] {
    return endpoints.filter((endpoint) => LoginGuide.isLogout(endpoint));
  }

  endpoint(id: string): Endpoint | undefined {
    return this.#byId.get(id);
  }

  revokes(endpoint: Endpoint): string[] {
    return [...new Set(this.#model.cookies.filter((cookie) => (cookie.revokedBy ?? []).includes(endpoint.id)).map((cookie) => cookie.name))];
  }

  issuers(endpoint: Endpoint): Endpoint[] {
    const out = new Set<Endpoint>();
    for (const name of Credentials.cookies(endpoint, this.#roles)) {
      for (const cookie of this.#model.cookies) {
        if (cookie.name !== name) continue;
        for (const id of cookie.issuedBy ?? []) {
          const login = this.#byId.get(id);
          if (login) out.add(login);
        }
      }
    }
    if (endpoint.auth.bearer || Credentials.schemes(endpoint, this.#roles).includes(Credentials.BEARER)) {
      for (const login of this.logins()) if ((login.login?.issues.tokens.length ?? 0) > 0) out.add(login);
    }
    return [...out];
  }

  needsLogin(endpoint: Endpoint): boolean {
    if (LoginGuide.isLogin(endpoint) || endpoint.auth.anonymous === 'allowed') return false;
    return Credentials.sets(endpoint, this.#roles).length > 0 || Credentials.refusals(endpoint, this.#roles).length > 0;
  }

  summary(endpoint: Endpoint, code: CodeMarkup): string | undefined {
    if (LoginGuide.isLogout(endpoint)) {
      const revoked = this.revokes(endpoint);
      return revoked.length === 0 ? 'ends the session.' : `revokes the ${revoked.length === 1 ? 'cookie' : 'cookies'} ${revoked.map(code).join(', ')}.`;
    }
    const login = LoginGuide.isLogin(endpoint) ? endpoint.login : undefined;
    if (!login) return undefined;
    const fields = LoginGuide.fields(login, code);
    const sends = fields === '' ? '' : `sends ${fields}`;
    if (LoginGuide.issued(login)) return `${[sends, `issues ${LoginGuide.issues(login, code)}`].filter((part) => part !== '').join(', and ')}.`;
    const note = endpoint.count === 0 ? LoginGuide.NOT_SUBMITTED : LoginGuide.UNKNOWN_ISSUE;
    return `${sends === '' ? note : `${sends}; ${note}`}.`;
  }

  describe(endpoint: Endpoint, code: CodeMarkup): string | undefined {
    const summary = this.summary(endpoint, code);
    return summary === undefined ? undefined : `${LoginGuide.roleLabel(endpoint)}: ${summary}`;
  }

  static roleLabel(endpoint: Endpoint): string {
    return LoginGuide.isLogout(endpoint) ? LoginGuide.LOGOUT_LABEL : LoginGuide.LOGIN_LABEL;
  }

  hint(endpoint: Endpoint, label: EndpointLabel, text: TextMarkup = (value) => value): string | undefined {
    if (!this.needsLogin(endpoint)) return undefined;
    const issuers = this.issuers(endpoint);
    const chosen = issuers.length > 0 ? issuers : this.logins();
    if (chosen.length === 0) return undefined;
    const names = chosen.map((login) => this.reference(login, label, text));
    return `Log in first with ${names.join(' or ')}${issuers.length > 0 ? '' : ', which the capture did not show issuing this credential'}.`;
  }

  static label(endpoint: Endpoint, name: string | undefined): string {
    return name === undefined ? `${endpoint.method} ${endpoint.path}` : `${name} (${endpoint.method} ${endpoint.path})`;
  }
}
