import type { ApiModel, Endpoint, EndpointLogin, FormDescriptor } from '../model/index.js';
import { LoginFormDetector } from '../forms/index.js';
import { Ansi, Credentials, EndpointIndex, Http, Meta, Text } from '../shared/index.js';
import type { CookieRoles } from '../shared/index.js';
import { BarChart } from './bar-chart.js';
import { CookieListPresenter } from './cookie-list-presenter.js';
import { EndpointFormatter } from './endpoint-formatter.js';
import { BasePresenter } from './presenter.js';
import type { PresenterBlock, PresenterOptions } from './presenter.js';
import type { TableColumn } from './table-renderer.js';
import { TextLayout } from './text-layout.js';
import type { Definition } from './text-layout.js';

export interface EndpointListPresenterDeps {
  formatter?: EndpointFormatter;
}

export class EndpointListPresenter extends BasePresenter<ApiModel> {
  static readonly COLUMNS: readonly TableColumn[] = [
    { header: '#', align: 'right' },
    { header: 'METHOD' },
    { header: 'PATH', flex: true, minWidth: 32 },
    { header: 'QUERY', flex: true, minWidth: 12, maxWidth: 40, optional: true, priority: 3 },
    { header: 'BODY', flex: true, minWidth: 20, maxWidth: 48, optional: true, priority: 1 },
    { header: 'STATUS', flex: true, minWidth: 7, maxWidth: 32 },
    { header: 'AUTH', flex: true, minWidth: 11, optional: true, priority: 2 },
    { header: 'HITS', align: 'right' },
  ];
  static readonly TOP_HITS = 10;
  static readonly EXPORT_FORMAT = 'openapi';
  static readonly OPTIONAL_HINT = `a label ending in ${Credentials.OPTIONAL_MARK} means the endpoint also answered a request without those credentials`;
  static readonly UNTESTED_HINT = `a label ending in ${Credentials.UNTESTED_MARK} means no request without those credentials was seen, so anonymous access was not tested`;
  static readonly NOT_SUBMITTED = 'known from a form; not submitted yet';
  static readonly NOTHING_ISSUED = 'submitted, but no credential was issued';
  static readonly AUTHENTICATED_ONLY = 'seen only with a logged-in credential';
  static readonly FOUND_AFTER_LOGIN = 'found only on pages loaded while logged in; no request observed';
  static readonly REFUSED_ONLY = 'refused requests without credentials';
  static readonly SCRIPTED_FORM = 'has no action, so a script probably sends it';
  static readonly UNRECORDED_FORM = 'no request with its password was recorded';
  static readonly LOG_IN = 'or log in with --login';
  static readonly PROBE_FLAGS = '--headless --probe-login';
  static readonly PREDICTED_HINT = `a label ending in ${Credentials.PREDICTED_MARK} means the endpoint refused every request without credentials and was never requested logged in, so the credential is predicted from what its login issues`;
  static readonly REFUSED_HINT = `a status such as 401${Credentials.UNKNOWN_MARK} means the endpoint refused a request without credentials and the credential it expects was not captured`;

  readonly #format: EndpointFormatter;

  constructor(options: PresenterOptions = {}, deps: EndpointListPresenterDeps = {}) {
    super(options);
    this.#format = deps.formatter ?? new EndpointFormatter(this.ansi);
  }

  static create(options: PresenterOptions = {}): EndpointListPresenter {
    return new EndpointListPresenter(options, { formatter: new EndpointFormatter(BasePresenter.ansiFor(options)) });
  }

  static topByHits(endpoints: readonly Endpoint[], index: EndpointIndex, limit: number = EndpointListPresenter.TOP_HITS): Endpoint[] {
    return endpoints
      .filter((endpoint) => endpoint.count > 0)
      .sort((a, b) => b.count - a.count || index.numberOf(a) - index.numberOf(b))
      .slice(0, limit);
  }

  static statusTotals(endpoints: readonly Endpoint[]): Map<number, number> {
    const totals = new Map<number, number>();
    for (const endpoint of endpoints) for (const response of endpoint.responses) totals.set(response.status, (totals.get(response.status) ?? 0) + response.count);
    return new Map([...totals].sort(([a], [b]) => a - b));
  }

  static groups(endpoints: readonly Endpoint[]): Map<string, Endpoint[]> {
    const groups = new Map<string, Endpoint[]>();
    for (const endpoint of endpoints) {
      const group = groups.get(endpoint.origin);
      if (group) group.push(endpoint);
      else groups.set(endpoint.origin, [endpoint]);
    }
    return groups;
  }

  render(model: ApiModel): string {
    const index = EndpointIndex.of(model);
    const endpoints = this.filter.apply(model);
    const groups = EndpointListPresenter.groups(endpoints);
    const total = model.endpoints.length;
    const count = this.filter.active ? `${endpoints.length} of ${Text.plural(total, 'endpoint')}` : Text.plural(total, 'endpoint');
    const [only] = groups.size === 1 ? [...groups] : [];
    const where = only === undefined ? '' : ` at ${only[0]}${EndpointListPresenter.#thirdParty(only[1]) ? ' (third-party)' : ''}`;
    const header = [this.heading(`${model.name || 'API'}: ${count}${where}`)];
    if (this.filter.active) header.push(this.ansi.dim(this.ansi.clean(`Filter: ${this.filter.describe().join(', ')}`)));
    if (endpoints.length === 0) {
      return this.compose([header.join('\n'), total === 0 ? 'No endpoints in this model.' : 'No endpoints match the filter.']);
    }
    const roles = Credentials.roles(model);
    const notes: string[] = [];
    const credentialed = endpoints.filter((endpoint) => Credentials.sets(endpoint, roles).length > 0);
    if (credentialed.some((endpoint) => endpoint.auth.anonymous === 'allowed')) notes.push(EndpointListPresenter.OPTIONAL_HINT);
    if (credentialed.some((endpoint) => Credentials.untested(endpoint))) notes.push(EndpointListPresenter.UNTESTED_HINT);
    if (credentialed.some((endpoint) => Credentials.predicted(endpoint) && endpoint.auth.anonymous === 'refused')) notes.push(EndpointListPresenter.PREDICTED_HINT);
    if (endpoints.some((endpoint) => Credentials.refusals(endpoint, roles).length > 0)) notes.push(EndpointListPresenter.REFUSED_HINT);
    return this.compose([header.join('\n'), ...this.#tables(model, groups, index), this.#chart(endpoints, index), this.#statuses(endpoints), this.#session(model, endpoints, index), this.#hints(notes)]);
  }

  #tables(model: ApiModel, groups: ReadonlyMap<string, readonly Endpoint[]>, index: EndpointIndex): PresenterBlock[] {
    const columns = EndpointListPresenter.COLUMNS;
    const roles = Credentials.roles(model);
    const rows = new Map<Endpoint, string[]>([...groups.values()].flat().map((endpoint) => [endpoint, this.#row(endpoint, index, roles)]));
    const table = this.table();
    const layout = table.layout(columns, [...rows.values()]);
    const render = (group: readonly Endpoint[]): string => table.render(columns, group.map((endpoint) => rows.get(endpoint) ?? []), layout);
    const blocks: PresenterBlock[] =
      groups.size === 1
        ? [...groups.values()].map(render)
        : [...groups].map(([origin, group]) => {
            const note = `(${Text.plural(group.length, 'endpoint')}${EndpointListPresenter.#thirdParty(group) ? ', third-party' : ''})`;
            const title = TextLayout.fit(`${this.ansi.bold(this.ansi.clean(origin))} ${this.ansi.dim(note)}`, this.width);
            return [title, render(group)];
          });
    if (layout.hidden.length > 0) {
      const names = layout.hidden.map((i) => columns[i]?.header ?? '').join(', ');
      blocks.push(TextLayout.wrap(`Columns hidden to fit ${this.width} characters: ${names}`, this.width).map((line) => this.ansi.dim(line)));
    }
    return blocks;
  }

  #row(endpoint: Endpoint, index: EndpointIndex, roles: CookieRoles): string[] {
    const statuses = this.#format.statuses(endpoint);
    return [
      String(index.numberOf(endpoint)),
      this.#format.method(endpoint),
      this.#format.path(endpoint),
      this.#format.query(endpoint),
      this.#format.body(endpoint),
      statuses === '' ? this.ansi.dim('-') : statuses,
      this.#format.auth(endpoint, roles),
      String(endpoint.count),
    ];
  }

  static #thirdParty(group: readonly Endpoint[]): boolean {
    return group.every((endpoint) => !endpoint.firstParty);
  }

  #chart(endpoints: readonly Endpoint[], index: EndpointIndex): PresenterBlock {
    const top = EndpointListPresenter.topByHits(endpoints, index);
    if (top.length === 0) return undefined;
    const numberWidth = Math.max(...top.map((endpoint) => String(index.numberOf(endpoint)).length));
    const methodWidth = Math.max(...top.map((endpoint) => this.ansi.clean(endpoint.method).length));
    const items = top.map((endpoint) => ({
      label: `${String(index.numberOf(endpoint)).padStart(numberWidth)} ${Ansi.padEnd(this.#format.method(endpoint), methodWidth)} ${this.#format.path(endpoint)}`,
      value: endpoint.count,
    }));
    const chart = new BarChart({ ansi: this.ansi, width: this.width }).render(items);
    return [this.ansi.bold(`Top ${Text.plural(top.length, 'endpoint')} by hits`), chart];
  }

  #statuses(endpoints: readonly Endpoint[]): PresenterBlock {
    const totals = EndpointListPresenter.statusTotals(endpoints);
    if (totals.size === 0) return undefined;
    const items = [...totals].map(([status, hits]) => `${this.ansi.status(status)} x${hits}`);
    return TextLayout.flow(items, this.width, { prefix: this.ansi.bold('Statuses:') + ' ' });
  }

  static loginSummary(login: EndpointLogin, submitted: boolean): string {
    const fields = [login.identifier, login.password].filter((name): name is string => name !== undefined && name !== '');
    const issued = EndpointListPresenter.issued(login);
    const state = login.evidence === 'observed' && issued !== '' ? `issues ${issued}` : submitted ? EndpointListPresenter.NOTHING_ISSUED : EndpointListPresenter.NOT_SUBMITTED;
    return `${fields.length > 0 ? `with ${fields.join(' and ')}, ` : ''}${state}`;
  }

  static issued(login: EndpointLogin): string {
    const parts = [...login.issues.cookies.map((name) => `cookie ${name}`), ...login.issues.tokens.map((path) => `bearer token from ${path}`)];
    return parts.join(' and ');
  }

  static unlinkedLogins(model: ApiModel): FormDescriptor[] {
    const logins = new Set(model.endpoints.filter((endpoint) => endpoint.role === 'login').map((endpoint) => endpoint.id));
    return model.forms.filter((form) => LoginFormDetector.isLogin(form) && !(form.endpoints ?? []).some((id) => logins.has(id)));
  }

  static loginForm(model: ApiModel, form: FormDescriptor): string {
    const fields = LoginFormDetector.detect(form);
    const names = [fields?.identifier, fields?.password].filter((name): name is string => name !== undefined && name !== '');
    const where = `on ${EndpointListPresenter.#place(model, form.pageUrl)}${names.length > 0 ? ` (${names.join(', ')})` : ''}`;
    const record = EndpointListPresenter.recordLogin(form.pageUrl);
    if (form.explicitAction === false) return `${where} ${EndpointListPresenter.SCRIPTED_FORM}; ${record}`;
    return `${where} submits to ${form.method} ${EndpointListPresenter.#place(model, form.action)}, but ${EndpointListPresenter.UNRECORDED_FORM}; ${record}`;
  }

  static recordLogin(pageUrl: string): string {
    return `record its request without an account with ${Meta.APP_NAME} capture ${BasePresenter.shellWord(pageUrl)} ${EndpointListPresenter.PROBE_FLAGS}, ${EndpointListPresenter.LOG_IN}`;
  }

  static #place(model: ApiModel, value: string): string {
    const url = Http.parseUrl(value);
    if (!url) return value;
    return url.origin === model.primaryOrigin ? `${url.pathname}${url.search}` : `${url.origin}${url.pathname}${url.search}`;
  }

  static revoked(model: ApiModel, endpoint: Endpoint): string[] {
    return [...new Set(model.cookies.filter((cookie) => cookie.revokedBy?.includes(endpoint.id) === true).map((cookie) => cookie.name))];
  }

  #session(model: ApiModel, endpoints: readonly Endpoint[], index: EndpointIndex): PresenterBlock {
    const entries: Definition[] = [];
    const where = (endpoint: Endpoint): string => this.ansi.clean(`#${index.numberOf(endpoint)} ${endpoint.method} ${endpoint.path}`);
    for (const endpoint of endpoints) {
      if (endpoint.role !== 'login' || !endpoint.login) continue;
      entries.push(['Login', `${where(endpoint)} ${this.ansi.clean(EndpointListPresenter.loginSummary(endpoint.login, endpoint.count > 0))}`]);
    }
    if (!this.filter.active) for (const form of EndpointListPresenter.unlinkedLogins(model)) entries.push(['Login form', this.ansi.clean(EndpointListPresenter.loginForm(model, form))]);
    for (const endpoint of endpoints) {
      if (endpoint.role !== 'logout') continue;
      const revoked = EndpointListPresenter.revoked(model, endpoint);
      entries.push(['Logout', `${where(endpoint)}${revoked.length > 0 ? this.ansi.clean(`, revokes ${revoked.map((name) => `cookie ${name}`).join(' and ')}`) : ''}`]);
    }
    const refused = endpoints.filter((endpoint) => endpoint.auth.anonymous === 'refused').map((endpoint) => index.numberOf(endpoint));
    if (refused.length > 0) entries.push(['Login needed', `${CookieListPresenter.ranges(refused)} (${EndpointListPresenter.REFUSED_ONLY})`]);
    const authenticated = endpoints.filter((endpoint) => Credentials.authenticatedOnly(endpoint)).map((endpoint) => index.numberOf(endpoint));
    const found = endpoints.filter((endpoint) => Credentials.foundAfterLogin(model, endpoint)).map((endpoint) => index.numberOf(endpoint));
    const after = [
      ...(authenticated.length > 0 ? [`${CookieListPresenter.ranges(authenticated)} (${EndpointListPresenter.AUTHENTICATED_ONLY})`] : []),
      ...(found.length > 0 ? [`${CookieListPresenter.ranges(found)} (${EndpointListPresenter.FOUND_AFTER_LOGIN})`] : []),
    ];
    if (after.length > 0) entries.push(['After login', after.join('; ')]);
    return entries.length > 0 ? this.definitions(entries) : undefined;
  }

  #hints(notes: readonly string[]): string[] {
    if (!this.hints) return [];
    const file = BasePresenter.fileArgument(this.file, this.ansi);
    const entries: [string, string][] = notes.length > 0 ? [['Auth', notes.join('; ')]] : [];
    entries.push(['Details', this.command(`list ${file} --show <#>`)], ['Export', this.command(`export ${file} --format ${EndpointListPresenter.EXPORT_FORMAT}`)]);
    return this.definitions(entries);
  }
}
