import type { Capture, Endpoint, EndpointLogin, Exchange, FormDescriptor, JsonSchema } from '../model/index.js';
import { CookieParser } from '../capture/index.js';
import { FormSchemaBuilder, LoginFormDetector, TokenDetector } from '../forms/index.js';
import type { LoginFields } from '../forms/index.js';
import { EndpointIndex, Http, Json, Schema, Text } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { CookieClassifier } from './cookie-classifier.js';
import { CredentialAnalyzer } from './credential-analyzer.js';
import type { CredentialInput, LoginSubmission } from './credential-analyzer.js';
import type { CredentialEvidence } from './credential-evidence.js';
import { EndpointMatcher } from './endpoint-matcher.js';
import { HeaderPolicy } from './header-policy.js';
import { Helpers } from './helpers.js';
import { HtmlPages } from './html-pages.js';
import { Redactor } from './redactor.js';

export interface EndpointRoleDetectorDeps {
  analyzer: CredentialAnalyzer;
  body: BodyParser;
  schemas: FormSchemaBuilder;
  parser: CookieParser;
}

export interface RoleContext {
  readonly evidence: CredentialEvidence;
  readonly input?: CredentialInput;
  readonly forms?: ReadonlyMap<FormDescriptor, readonly Endpoint[]>;
  readonly credentials?: (exchange: Exchange) => readonly string[];
}

interface LoginForms {
  readonly login: ReadonlyMap<Endpoint, LoginFields>;
  readonly other: ReadonlySet<Endpoint>;
}

interface Submitted {
  readonly exchange: Exchange;
  readonly submission: LoginSubmission;
  readonly cookies: readonly string[];
  readonly tokens: readonly string[];
}

interface Timeline {
  readonly positions: ReadonlyMap<Exchange, number>;
  readonly bearers: ReadonlyMap<string, number>;
}

export class EndpointRoleDetector {
  static readonly BEARER: RegExp = /^bearer[ \t]+(\S+)$/i;
  static readonly AUTHORIZATION = 'authorization';
  static readonly PATH_SEPARATOR = '.';
  static readonly MAX_DEPTH = 8;
  static readonly DOCUMENT = 'document';

  readonly #analyzer: CredentialAnalyzer;
  readonly #body: BodyParser;
  readonly #schemas: FormSchemaBuilder;
  readonly #parser: CookieParser;

  constructor(deps: EndpointRoleDetectorDeps) {
    this.#analyzer = deps.analyzer;
    this.#body = deps.body;
    this.#schemas = deps.schemas;
    this.#parser = deps.parser;
  }

  static create(): EndpointRoleDetector {
    const tokens = new TokenDetector();
    const body = BodyParser.create();
    const analyzer = new CredentialAnalyzer({ cookies: new CookieClassifier(), body, headers: new HeaderPolicy({ tokens }), redactor: new Redactor(true, { tokens }) });
    return new EndpointRoleDetector({ analyzer, body, schemas: new FormSchemaBuilder({ tokens }), parser: new CookieParser() });
  }

  detect(endpoints: Endpoint[], capture: Pick<Capture, 'exchanges'>, context: RoleContext): void {
    const groups = new EndpointMatcher(endpoints, { body: this.#body }).group(capture.exchanges);
    const timeline = EndpointRoleDetector.#timeline(capture.exchanges);
    const forms = this.#loginForms(endpoints, context.forms ?? new Map());
    const signOuts = this.signOuts(capture, context);
    for (const endpoint of endpoints) {
      delete endpoint.role;
      delete endpoint.login;
      const exchanges = (groups.get(endpoint) ?? []).filter((exchange) => Http.reachedServer(exchange));
      const login = this.#login(endpoint, exchanges, forms, timeline, context);
      if (login) {
        endpoint.role = 'login';
        endpoint.login = login;
      } else if (exchanges.some((exchange) => signOuts.has(exchange))) {
        endpoint.role = 'logout';
      }
    }
  }

  signOuts(capture: Pick<Capture, 'exchanges'>, context: RoleContext): Set<Exchange> {
    const delegated = this.#delegated(capture.exchanges, context);
    return new Set(capture.exchanges.filter((exchange) => Http.reachedServer(exchange) && this.#signsOut(exchange, context, delegated)));
  }

  #login(endpoint: Endpoint, exchanges: readonly Exchange[], forms: LoginForms, timeline: Timeline, context: RoleContext): EndpointLogin | undefined {
    const submitted = exchanges.flatMap((exchange) => {
      const submission = this.#analyzer.loginSubmission(exchange, context.input);
      return submission ? [this.#issued(exchange, submission, timeline, context.evidence)] : [];
    });
    const issuing = forms.other.has(endpoint) ? [] : submitted.filter((item) => item.cookies.length > 0 || item.tokens.length > 0);
    const linked = forms.login.get(endpoint);
    const form = linked !== undefined && (submitted.length > 0 || EndpointRoleDetector.#accepts(endpoint, linked.password)) ? linked : undefined;
    if (issuing.length === 0 && form === undefined) return undefined;
    const first = issuing[0] ?? submitted[0];
    const password = first?.submission.password ?? form?.password ?? '';
    const identifier = first ? (first.submission.identifier ?? EndpointRoleDetector.#sent(endpoint, form?.identifier)) : form?.identifier;
    const cookies = Helpers.distinct(issuing.flatMap((item) => item.cookies)).sort(Text.compare);
    const tokens = Helpers.distinct(issuing.flatMap((item) => item.tokens)).sort(Text.compare);
    return {
      evidence: issuing.length > 0 ? 'observed' : 'form',
      ...(identifier !== undefined ? { identifier } : {}),
      password,
      issues: { cookies, tokens },
    };
  }

  static #accepts(endpoint: Endpoint, name: string): boolean {
    if (endpoint.queryParams.some((param) => param.name === name)) return true;
    return [endpoint.requestBody, ...(endpoint.otherRequestBodies ?? [])].some((body) => EndpointRoleDetector.#hasProperty(body?.schema, name, EndpointRoleDetector.MAX_DEPTH));
  }

  static #hasProperty(schema: JsonSchema | undefined, name: string, depth: number): boolean {
    if (!schema || depth < 0) return false;
    const properties = Schema.properties(schema);
    if (Object.hasOwn(properties, name)) return true;
    const nested = [...Object.values(properties), ...Schema.variants(schema)];
    const items = Schema.items(schema);
    if (items) nested.push(items);
    return nested.some((child) => EndpointRoleDetector.#hasProperty(child, name, depth - 1));
  }

  static #sent(endpoint: Endpoint, name: string | undefined): string | undefined {
    if (name === undefined) return undefined;
    const body = Object.hasOwn(Schema.properties(endpoint.requestBody?.schema), name);
    return body || endpoint.queryParams.some((param) => param.name === name) ? name : undefined;
  }

  #issued(exchange: Exchange, submission: LoginSubmission, timeline: Timeline, evidence: CredentialEvidence): Submitted {
    const cookies = CredentialAnalyzer.setCookies(exchange)
      .filter((cookie) => cookie.value !== '' && evidence.isCredentialRole(cookie.name) && evidence.issued(cookie.name, cookie.value, exchange) === 'authenticated')
      .map((cookie) => cookie.name);
    return { exchange, submission, cookies: Helpers.distinct(cookies), tokens: this.#tokens(exchange, timeline) };
  }

  #tokens(exchange: Exchange, timeline: Timeline): string[] {
    const at = timeline.positions.get(exchange);
    if (at === undefined || timeline.bearers.size === 0 || !exchange.response?.body) return [];
    let parsed;
    try {
      parsed = this.#body.response(exchange.response);
    } catch {
      return [];
    }
    if (parsed.kind !== 'json') return [];
    const out: string[] = [];
    EndpointRoleDetector.#leaves(parsed.value, [], (path, value) => {
      const last = timeline.bearers.get(value);
      if (last !== undefined && last > at && path.length > 0) out.push(path.join(EndpointRoleDetector.PATH_SEPARATOR));
    });
    return Helpers.distinct(out);
  }

  static #leaves(value: unknown, path: readonly string[], visit: (path: readonly string[], value: string) => void): void {
    if (typeof value === 'string') {
      visit(path, value);
      return;
    }
    if (!Json.isPlainObject(value)) return;
    for (const [key, item] of Object.entries(value)) EndpointRoleDetector.#leaves(item, [...path, key], visit);
  }

  static #timeline(exchanges: readonly Exchange[]): Timeline {
    const ordered = CredentialAnalyzer.ordered(exchanges);
    const bearers = new Map<string, number>();
    ordered.forEach((exchange, at) => {
      const header = Http.getHeader(exchange.request.headers, EndpointRoleDetector.AUTHORIZATION);
      const token = header === undefined ? undefined : EndpointRoleDetector.BEARER.exec(header.trim())?.[1];
      if (token !== undefined) bearers.set(token, at);
    });
    return { positions: new Map(ordered.map((exchange, at) => [exchange, at])), bearers };
  }

  #loginForms(endpoints: readonly Endpoint[], forms: ReadonlyMap<FormDescriptor, readonly Endpoint[]>): LoginForms {
    const kept = new Set(endpoints);
    const login = new Map<Endpoint, LoginFields>();
    const other = new Set<Endpoint>();
    for (const [form, linked] of forms) {
      if (!LoginFormDetector.hasPassword(form)) continue;
      const fields = LoginFormDetector.detect(form);
      for (const endpoint of this.#defaultTargets(form, linked.filter((candidate) => kept.has(candidate)))) {
        if (fields) {
          if (!login.has(endpoint)) login.set(endpoint, fields);
        } else {
          other.add(endpoint);
        }
      }
    }
    for (const endpoint of login.keys()) other.delete(endpoint);
    return { login, other };
  }

  #defaultTargets(form: FormDescriptor, linked: readonly Endpoint[]): readonly Endpoint[] {
    const target = this.#schemas.target(form);
    const url = Helpers.httpUrl(target.url);
    if (!url) return linked;
    const matching = linked.filter((endpoint) => endpoint.method === target.method && endpoint.origin === url.origin && EndpointIndex.matchPath(endpoint.path, url.pathname) !== undefined);
    return matching.length > 0 ? matching : linked;
  }

  #signsOut(exchange: Exchange, context: RoleContext, delegated: ReadonlySet<string>): boolean {
    if (!CredentialAnalyzer.isSignOut(exchange)) return false;
    if (this.#revokes(exchange, context.evidence)) return true;
    if (exchange.resourceType === EndpointRoleDetector.DOCUMENT && delegated.has(HtmlPages.documentKey(exchange.request.url))) return false;
    return EndpointRoleDetector.#credentialed(exchange, context);
  }

  #delegated(exchanges: readonly Exchange[], context: RoleContext): Set<string> {
    const pages = new Set<string>();
    for (const exchange of exchanges) {
      if (exchange.pageUrl === undefined || !Http.reachedServer(exchange) || !CredentialAnalyzer.isSignOut(exchange)) continue;
      if (HtmlPages.documentKey(exchange.pageUrl) === HtmlPages.documentKey(exchange.request.url)) continue;
      if (this.#revokes(exchange, context.evidence) || EndpointRoleDetector.#credentialed(exchange, context)) pages.add(HtmlPages.documentKey(exchange.pageUrl));
    }
    return pages;
  }

  static #credentialed(exchange: Exchange, context: RoleContext): boolean {
    return (context.credentials?.(exchange).length ?? 0) > 0;
  }

  #revokes(exchange: Exchange, evidence: CredentialEvidence): boolean {
    const set = CredentialAnalyzer.setCookies(exchange).filter((cookie) => evidence.isCredentialRole(cookie.name));
    if (set.length === 0) return false;
    const sent = new Map(CredentialAnalyzer.sent(exchange).map((cookie) => [cookie.name, cookie.value]));
    const live = new Set(this.#parser.replay([exchange]).map((cookie) => cookie.name));
    return set.some((cookie) => cookie.value === '' || !live.has(cookie.name) || (sent.has(cookie.name) && sent.get(cookie.name) !== cookie.value));
  }
}
