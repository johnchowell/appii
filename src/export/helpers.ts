import { CREDENTIAL_COOKIE_ROLES } from '../model/index.js';
import type { ApiModel, CookieRole, CsrfToken, Endpoint, JsonSchema } from '../model/index.js';
import { AppiiError, EndpointIndex, Http, Samples, Schema, Text } from '../shared/index.js';
import type { ExportOptions } from './exporter.js';

export interface TokenSourceMarkup {
  text(value: string): string;
  code(value: string): string;
  url(value: string): string;
}

export interface PathSegment {
  text: string;
  param: boolean;
}

export class Helpers {
  static readonly GROUP_PREFIXES: RegExp = /^(?:api|apis|rest|rpc|json|ajax|public|v[0-9]+(?:\.[0-9]+)*)$/i;
  static readonly ROOT_GROUP = 'root';
  static readonly AUTH_ROLES: ReadonlySet<CookieRole> = new Set<CookieRole>(CREDENTIAL_COOKIE_ROLES);
  static readonly BASE_URL_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:']);
  static readonly UNSAFE_PATTERN_CLIENT = 'The generated TypeScript client does not check it unless the unsafePatterns option is true.';

  static normalizeOptions(options: ExportOptions): ExportOptions {
    const out: ExportOptions = { ...options };
    if (options.baseUrl !== undefined) out.baseUrl = Helpers.baseUrl(options.baseUrl);
    if (options.title !== undefined) {
      const title = options.title.trim();
      if (title === '') delete out.title;
      else out.title = title;
    }
    return out;
  }

  static baseUrl(value: string): string {
    let url: URL;
    try {
      url = new URL(value.trim());
    } catch {
      throw new AppiiError('BAD_INPUT', `Invalid base URL '${value}': expected an absolute http(s) URL`);
    }
    if (!Helpers.BASE_URL_SCHEMES.has(url.protocol)) {
      throw new AppiiError('BAD_INPUT', `Invalid base URL '${value}': only http and https are supported`);
    }
    if (url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
      throw new AppiiError('BAD_INPUT', `Invalid base URL '${value}': query, fragment and credentials are not allowed`);
    }
    return url.href.replace(/\/+$/, '');
  }

  static base(model: ApiModel, endpoint: Endpoint, options: ExportOptions): string {
    return Helpers.originBase(model, endpoint.origin, options);
  }

  static originBase(model: ApiModel, origin: string, options: ExportOptions): string {
    return origin === model.primaryOrigin && options.baseUrl !== undefined ? options.baseUrl : origin;
  }

  static mapUrl(model: ApiModel, url: string, options: ExportOptions): string {
    if (options.baseUrl === undefined || model.primaryOrigin === '') return url;
    if (url === model.primaryOrigin) return options.baseUrl;
    return url.startsWith(model.primaryOrigin + '/') ? options.baseUrl + url.slice(model.primaryOrigin.length) : url;
  }

  static tokenSource(token: CsrfToken, markup: TokenSourceMarkup): string {
    const head = token.sourceName ? `${markup.text(token.source)} ${markup.code(token.sourceName)}` : markup.text(token.source);
    if (token.sourceUrl === undefined) return head;
    const method = EndpointIndex.tokenRequest(token);
    const where = markup.url(token.sourceUrl);
    return method === undefined ? `${head} on ${where}` : `${head} of ${markup.text(method)} ${where}`;
  }

  static sample(model: ApiModel, endpoint: Endpoint, options: ExportOptions, extra: Samples.SampleOptions = {}): Samples.RequestSample {
    return Samples.requestSample(endpoint, { baseUrl: Helpers.base(model, endpoint, options), ...extra });
  }

  static title(model: ApiModel, options: ExportOptions): string {
    return options.title ?? (model.name || 'API');
  }

  static segments(path: string): PathSegment[] {
    return path
      .split('/')
      .filter((part) => part !== '')
      .map((part) => ({ text: part, param: /^\{[^}]+\}$/.test(part) }));
  }

  static pathParams(path: string): string[] {
    return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1] ?? '');
  }

  static group(endpoint: Endpoint): string {
    const literals = Helpers.segments(endpoint.path).filter((segment) => !segment.param);
    const meaningful = literals.find((segment) => !Helpers.GROUP_PREFIXES.test(segment.text));
    const chosen = meaningful ?? literals[0];
    return chosen ? Http.decodeComponent(chosen.text) : Helpers.ROOT_GROUP;
  }

  static summary(endpoint: Endpoint): string {
    if (endpoint.kind === 'graphql' && endpoint.operationName) return `GraphQL ${endpoint.operationName}`;
    const words = Text.words(endpoint.name);
    if (words.length === 0) return `${endpoint.method} ${endpoint.path}`;
    const text = words.join(' ');
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  static isHttpStatus(status: number): boolean {
    return Number.isInteger(status) && status >= 100 && status <= 599;
  }

  static typed(value: string, schema: JsonSchema | undefined): unknown {
    const type = Schema.primaryType(schema);
    if ((type === 'integer' || type === 'number') && /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][-+]?[0-9]+)?$/.test(value)) {
      const parsed = Number(value);
      if (Number.isFinite(parsed) && (type === 'number' || Number.isInteger(parsed))) return parsed;
    }
    if (type === 'boolean' && (value === 'true' || value === 'false')) return value === 'true';
    return value;
  }

  static examples(values: readonly string[], schema: JsonSchema | undefined): unknown[] {
    const out: unknown[] = [];
    for (const value of values) {
      if (Samples.isRedacted(value)) continue;
      const typed = Helpers.typed(value, schema);
      if (!out.some((existing) => Object.is(existing, typed))) out.push(typed);
    }
    return out;
  }

  static cookieRoles(model: ApiModel): Map<string, Set<CookieRole>> {
    const roles = new Map<string, Set<CookieRole>>();
    for (const cookie of model.cookies) {
      const set = roles.get(cookie.name) ?? new Set<CookieRole>();
      set.add(cookie.role);
      roles.set(cookie.name, set);
    }
    return roles;
  }

  static authCookies(model: ApiModel, endpoint: Endpoint, roles: ReadonlyMap<string, ReadonlySet<CookieRole>> = Helpers.cookieRoles(model)): string[] {
    return endpoint.auth.cookies.filter((name) => [...(roles.get(name) ?? [])].some((role) => Helpers.AUTH_ROLES.has(role)));
  }

  static origins(model: ApiModel, endpoints: readonly Endpoint[]): string[] {
    const seen = new Set<string>();
    if (model.primaryOrigin !== '' && endpoints.some((endpoint) => endpoint.origin === model.primaryOrigin)) seen.add(model.primaryOrigin);
    for (const endpoint of endpoints) seen.add(endpoint.origin);
    return [...seen];
  }

  static fence(content: string): string {
    let longest = 0;
    for (const match of content.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    return '`'.repeat(Math.max(3, longest + 1));
  }
}
