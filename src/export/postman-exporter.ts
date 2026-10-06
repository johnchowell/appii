import { createHash } from 'node:crypto';
import type { ApiModel, Endpoint } from '../model/index.js';
import { EndpointIndex, Json, Meta, RequestBodies, SampleText, Samples, Text } from '../shared/index.js';
import { BaseExporter } from './exporter.js';
import type { ExportFormat, ExportOptions } from './exporter.js';
import { Helpers } from './helpers.js';
import { LoginGuide } from './login-guide.js';
import { PostmanPathVariables } from './postman-path-variables.js';
import { PostmanRequestBuilder } from './postman-request-builder.js';
import type { PostmanObject } from './postman-request-builder.js';
import { PostmanTokenScripts } from './postman-token-scripts.js';
import type { ScriptPlan } from './postman-token-scripts.js';

export interface PostmanDescriptionContext {
  readonly guide: LoginGuide;
  readonly scripts: ScriptPlan;
  readonly sources: ReadonlyMap<string, Endpoint>;
  readonly folders: ReadonlyMap<string, readonly Endpoint[]>;
  readonly placeholders: ReadonlySet<string>;
}

export interface PostmanExporterDeps {
  requests?: PostmanRequestBuilder;
  scripts?: PostmanTokenScripts;
}

export class PostmanExporter extends BaseExporter {
  static readonly SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';
  static readonly BASE_VARIABLE = 'baseUrl';
  static readonly LOGOUT_FOLDER = 'logout';

  readonly format: ExportFormat = 'postman';
  readonly extension = 'json';
  readonly mimeType = 'application/json';
  readonly description = 'Postman Collection v2.1 with folders, variables and saved example responses';

  readonly #requests: PostmanRequestBuilder;
  readonly #scripts: PostmanTokenScripts;

  static create(): PostmanExporter {
    return new PostmanExporter({ requests: new PostmanRequestBuilder(), scripts: new PostmanTokenScripts() });
  }

  constructor(deps: PostmanExporterDeps = {}) {
    super();
    this.#requests = deps.requests ?? new PostmanRequestBuilder();
    this.#scripts = deps.scripts ?? new PostmanTokenScripts();
  }

  static collectionId(model: ApiModel, endpoints: readonly Endpoint[]): string {
    const hash = createHash('sha1')
      .update([model.name, model.primaryOrigin, ...endpoints.map((endpoint) => endpoint.key)].join('\n'))
      .digest();
    hash[6] = ((hash[6] ?? 0) & 0x0f) | 0x50;
    hash[8] = ((hash[8] ?? 0) & 0x3f) | 0x80;
    const hex = hash.subarray(0, 16).toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
  }

  variables(model: ApiModel, endpoints: readonly Endpoint[]): Map<string, string> {
    const origins = Helpers.origins(model, endpoints);
    const taken = new Set<string>();
    const out = new Map<string, string>();
    origins.forEach((origin, i) => {
      if (i === 0) {
        taken.add(PostmanExporter.BASE_VARIABLE);
        out.set(origin, PostmanExporter.BASE_VARIABLE);
        return;
      }
      let host = origin;
      try {
        host = new URL(origin).host;
      } catch {
        host = origin;
      }
      out.set(origin, Text.uniqueName(Text.camelCase(`${PostmanExporter.BASE_VARIABLE} ${host}`), taken));
    });
    return out;
  }

  collection(model: ApiModel, endpoints: Endpoint[], options: ExportOptions = {}): Record<string, unknown> {
    const opts = Helpers.normalizeOptions(options);
    const index = EndpointIndex.of(model);
    const origins = this.variables(model, endpoints);
    const folders = new Map<string, PostmanObject[]>();
    const placeholders = new Set<string>();
    for (const endpoint of endpoints) {
      for (const each of [endpoint, ...RequestBodies.variants(endpoint).map((variant) => variant.endpoint)]) {
        for (const name of Samples.placeholderNames(Helpers.sample(model, each, opts, { cookie: false }))) placeholders.add(name);
      }
    }
    const pathVariables = PostmanPathVariables.create([...origins.values(), ...placeholders]);
    const guide = new LoginGuide(model);
    const scripts = this.#scripts.plan(model, endpoints);
    const sources = new Map<string, Endpoint>();
    for (const user of endpoints) {
      for (const token of user.auth.csrf) {
        const page = PostmanTokenScripts.source(model, user, token, endpoints);
        const stored = page === undefined ? undefined : scripts.get(page)?.some((target) => target.variable === PostmanTokenScripts.variable(token));
        if (page !== undefined && page !== user && stored === true) sources.set(`${user.id} ${token.name}`, page);
      }
    }
    const layout = PostmanExporter.folders(endpoints, sources);
    for (const [group, members] of layout) {
      for (const endpoint of PostmanExporter.order(members, sources)) {
        const variable = origins.get(endpoint.origin) ?? PostmanExporter.BASE_VARIABLE;
        const items = this.#requests.items(endpoint, { model, index, options: opts, variable, pathVariables, guide, scripts, sources });
        folders.set(group, [...(folders.get(group) ?? []), ...items]);
      }
    }
    const variable: PostmanObject[] = [];
    for (const [origin, name] of origins) {
      variable.push({ key: name, value: Helpers.originBase(model, origin, opts), type: 'string', description: `Base URL for ${origin}` });
    }
    const inputs = new Map(guide.logins(endpoints).flatMap((login) => Samples.loginInputs(login).map(([name, label]): [string, string] => [SampleText.placeholderName(name), `${label} for ${Helpers.summary(login)}; no default`])));
    for (const name of [...placeholders].sort()) {
      const description = inputs.get(name);
      variable.push(description === undefined ? { key: name, value: '', type: 'string' } : { key: name, value: '', type: 'string', description: description.charAt(0).toUpperCase() + description.slice(1) });
    }
    variable.push(...pathVariables.entries());
    return {
      info: {
        _postman_id: PostmanExporter.collectionId(model, endpoints),
        name: Helpers.title(model, opts),
        description: this.#description(model, endpoints, { guide, scripts, sources, folders: layout, placeholders }),
        schema: PostmanExporter.SCHEMA,
      },
      item: [...folders].map(([name, item]) => ({ name, item })),
      variable,
    };
  }

  static folders(endpoints: readonly Endpoint[], sources: ReadonlyMap<string, Endpoint>): Map<string, Endpoint[]> {
    const grouped = new Map<string, Endpoint[]>();
    const logouts = endpoints.filter((endpoint) => LoginGuide.isLogout(endpoint));
    const tail: Endpoint[] = [];
    for (const endpoint of endpoints) {
      if (logouts.includes(endpoint)) continue;
      const group = Helpers.group(endpoint);
      if (logouts.length > 0 && group === PostmanExporter.LOGOUT_FOLDER) tail.push(endpoint);
      else grouped.set(group, [...(grouped.get(group) ?? []), endpoint]);
    }
    const pages = PostmanExporter.#loginPages(endpoints, sources);
    const rank = (members: readonly Endpoint[]): number => (members.some((endpoint) => LoginGuide.isLogin(endpoint)) ? 1 : members.some((endpoint) => pages.has(endpoint)) ? 0 : 2);
    const ordered = [...grouped].map((entry, at) => ({ entry, at })).sort((a, b) => rank(a.entry[1]) - rank(b.entry[1]) || a.at - b.at).map((item) => item.entry);
    const out = new Map(ordered);
    if (logouts.length > 0) out.set(PostmanExporter.LOGOUT_FOLDER, [...tail, ...logouts]);
    return out;
  }

  static order(members: readonly Endpoint[], sources: ReadonlyMap<string, Endpoint>): Endpoint[] {
    const pages = PostmanExporter.#loginPages(members, sources);
    const rank = (endpoint: Endpoint): number => (LoginGuide.isLogin(endpoint) ? 1 : pages.has(endpoint) ? 0 : 2);
    return members.map((endpoint, at) => ({ endpoint, at })).sort((a, b) => rank(a.endpoint) - rank(b.endpoint) || a.at - b.at).map((entry) => entry.endpoint);
  }

  static #loginPages(endpoints: readonly Endpoint[], sources: ReadonlyMap<string, Endpoint>): Set<Endpoint> {
    const logins = endpoints.filter((endpoint) => LoginGuide.isLogin(endpoint));
    return new Set(logins.flatMap((login) => login.auth.csrf.flatMap((token) => sources.get(`${login.id} ${token.name}`) ?? [])));
  }

  protected render(model: ApiModel, endpoints: Endpoint[], options: ExportOptions): string {
    return Json.asciiJson(this.collection(model, endpoints, options)) + '\n';
  }

  protected override filename(_model: ApiModel): string {
    return 'postman_collection.json';
  }

  #description(model: ApiModel, endpoints: readonly Endpoint[], ctx: PostmanDescriptionContext): string {
    const lines = [`Generated by ${Meta.APP_NAME} ${Meta.appVersion()} from ${Text.plural(model.source.exchanges, 'captured exchange')} (${Text.plural(endpoints.length, 'endpoint')}).`];
    if (model.source.startUrl) lines.push(`Start URL: ${model.source.startUrl}`);
    const label = (endpoint: Endpoint): string => `"${Helpers.summary(endpoint)}" (${endpoint.method} ${endpoint.path})`;
    const folderOf = (endpoint: Endpoint): string => [...ctx.folders].find(([, members]) => members.includes(endpoint))?.[0] ?? Helpers.group(endpoint);
    const logins = ctx.guide.logins(endpoints);
    const inputs = new Set<string>();
    for (const login of logins) {
      const names = Samples.loginInputs(login).map(([name]) => SampleText.placeholderName(name));
      for (const name of names) inputs.add(name);
      const set = names.length === 0 ? '' : ` Set the collection ${names.length === 1 ? 'variable' : 'variables'} ${names.map((name) => `{{${name}}}`).join(' and ')} first; ${names.length === 1 ? 'it has' : 'they have'} no default.`;
      lines.push(`Log in with ${label(login)} in the folder "${folderOf(login)}".${set}`);
    }
    const stored = new Set<string>();
    const scripts: string[] = [];
    for (const [page, targets] of ctx.scripts) {
      for (const target of targets) stored.add(target.variable);
      scripts.push(`${label(page)} stores ${targets.map((target) => `the CSRF token ${target.token.name} in {{${target.variable}}}`).join(' and ')}`);
    }
    for (const login of logins) {
      const tokens = LoginGuide.tokens(login);
      if (tokens.length === 0) continue;
      stored.add(PostmanRequestBuilder.BEARER_VARIABLE);
      scripts.push(`${label(login)} stores the bearer token from the response field ${tokens.join(' or ')} in {{${PostmanRequestBuilder.BEARER_VARIABLE}}}`);
    }
    if (scripts.length > 0) lines.push(`Test scripts fill variables from the responses: ${scripts.join('; ')}.`);
    const jar = logins.some((login) => (login.login?.issues.cookies.length ?? 0) > 0 || LoginGuide.tokens(login).length === 0);
    lines.push(`The Postman cookie jar keeps the cookies that the site sets${jar ? ', so the requests sent after the login are logged in' : ''}.`);
    const logout = ctx.guide.logouts(endpoints)[0];
    const sourced = logins.some((login) => login.auth.csrf.some((token) => ctx.sources.has(`${login.id} ${token.name}`)));
    const first = sourced ? 'the login and the page that holds its CSRF token come first' : 'the login comes first';
    const last = logout === undefined ? '' : `the logout requests come last, in the folder "${folderOf(logout)}"`;
    if (logins.length > 0 && last !== '') lines.push(`In a Collection Runner run ${first} and ${last}, so the requests between them are logged in.`);
    else if (logins.length > 0) lines.push(`In a Collection Runner run ${first}, so the requests after it are logged in.`);
    else if (last !== '') lines.push(`In a Collection Runner run ${last}.`);
    const open = [...ctx.placeholders].sort().filter((name) => !stored.has(name) && !inputs.has(name));
    if (open.length > 0) lines.push(`Variables without a default, to fill in before sending: ${open.map((name) => `{{${name}}}`).join(', ')}.`);
    return lines.join('\n\n');
  }
}
