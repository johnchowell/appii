import type { ApiModel, BodyKind, BodyShape, CsrfToken, Endpoint, EndpointResponse, FormField, ParamInfo } from '../model/index.js';
import { Ansi, Credentials, Curl, EndpointIndex, FormSource, Json, RequestBodies, Samples, Schema, Text } from '../shared/index.js';
import type { CookieRoles } from '../shared/index.js';
import { SessionGuide } from '../export/index.js';
import { EndpointFormatter } from './endpoint-formatter.js';
import { EndpointListPresenter } from './endpoint-list-presenter.js';
import { BasePresenter } from './presenter.js';
import type { PresenterBlock, PresenterOptions } from './presenter.js';
import { SchemaTree } from './schema-tree.js';
import type { SchemaTreeBranch, SchemaTreeRow } from './schema-tree.js';
import { ShellFolder } from './shell-folder.js';
import type { TableColumn } from './table-renderer.js';
import { TextLayout } from './text-layout.js';
import type { Definition } from './text-layout.js';

export interface EndpointDetailInput {
  model: ApiModel;
  ref: string | number;
}

export interface EndpointDetailPresenterDeps {
  formatter?: EndpointFormatter;
  tree?: SchemaTree;
  shell?: ShellFolder;
}

export class EndpointDetailPresenter extends BasePresenter<EndpointDetailInput> {
  static readonly JSON_LINES = ', JSON lines: one value per line';
  static readonly SELECTOR_NOTATION = 'Notation';
  static readonly FOUND_AFTER_LOGIN = 'its form was found only on pages loaded while logged in';
  static readonly PARAM_COLUMNS: readonly TableColumn[] = [
    { header: 'NAME', flex: true, minWidth: 12 },
    { header: 'REQ' },
    { header: 'TYPE', flex: true, minWidth: 8 },
    { header: 'CONSTRAINTS', flex: true, wrap: true, minWidth: 12, optional: true, priority: 2 },
    { header: 'EXAMPLES', flex: true, wrap: true, minWidth: 10, optional: true, priority: 1 },
  ];
  static readonly CONDITIONAL = 'if';
  static readonly BRANCH_INDENT = 2;
  static readonly NO_VALIDATION = 'no form validation';
  static readonly NO_OTHER_RULES = 'No other rules.';
  static readonly SCHEMA_COLUMNS: readonly TableColumn[] = [
    { header: 'FIELD', flex: true, minWidth: 12 },
    { header: 'TYPE', flex: true, minWidth: 8 },
    { header: 'REQ' },
    { header: 'CONSTRAINTS', flex: true, wrap: true, minWidth: 12, optional: true },
  ];
  static readonly CSRF_COLUMNS: readonly TableColumn[] = [
    { header: 'LOCATION' },
    { header: 'NAME', flex: true, minWidth: 8 },
    { header: 'SOURCE' },
    { header: 'SOURCE NAME', flex: true, minWidth: 8, optional: true, priority: 2 },
    { header: 'SOURCE URL', flex: true, wrap: true, minWidth: 12, optional: true, priority: 1 },
  ];
  static readonly BOUND_COLUMN: TableColumn = { header: 'BOUND TO', flex: true, wrap: true, minWidth: 8, optional: true, priority: 3 };
  static readonly SAMPLE_COLUMNS: readonly TableColumn[] = [
    { header: 'STATUS', align: 'right' },
    { header: 'URL', flex: true, wrap: true, minWidth: 16 },
    { header: 'STARTED', optional: true },
  ];
  static readonly MAX_PARAM_EXAMPLES = 3;
  static readonly STRUCTURED_KINDS: ReadonlySet<BodyKind> = new Set(['json', 'graphql', 'form', 'multipart']);

  readonly #format: EndpointFormatter;
  readonly #tree: SchemaTree;
  readonly #shell: ShellFolder;

  constructor(options: PresenterOptions = {}, deps: EndpointDetailPresenterDeps = {}) {
    super(options);
    this.#format = deps.formatter ?? new EndpointFormatter(this.ansi);
    this.#tree = deps.tree ?? new SchemaTree();
    this.#shell = deps.shell ?? new ShellFolder();
  }

  static create(options: PresenterOptions = {}): EndpointDetailPresenter {
    return new EndpointDetailPresenter(options, { formatter: new EndpointFormatter(BasePresenter.ansiFor(options)), tree: new SchemaTree(), shell: new ShellFolder() });
  }

  static submitter(field: FormField, ansi: Ansi = Ansi.plain): string {
    const parts = [field.name === '' ? '(unnamed)' : `${field.name}=${field.value}`];
    if (field.label !== undefined && field.label !== '') parts.push(`"${field.label}"`);
    if (field.formAction !== undefined) parts.push(`formaction ${field.formAction}`);
    if (field.formMethod !== undefined) parts.push(`formmethod ${field.formMethod}`);
    if (field.formEnctype !== undefined) parts.push(`formenctype ${field.formEnctype}`);
    if (field.formNoValidate === true) parts.push('novalidate');
    if (field.disabled) parts.push('disabled');
    return ansi.clean(parts.join(' '));
  }

  static exampleRequest(endpoint: Endpoint): Samples.RequestSample {
    return Samples.requestSample(endpoint);
  }

  render(input: EndpointDetailInput): string {
    const index = EndpointIndex.of(input.model);
    const endpoint = index.require(input.ref);
    return this.compose([
      this.#title(endpoint, index.numberOf(endpoint)),
      this.#params('Path parameters', endpoint.pathParams),
      this.#params('Query parameters', endpoint.queryParams),
      this.#params('Header parameters', endpoint.headerParams),
      this.#requestBody(endpoint),
      this.#form(endpoint),
      this.#auth(input.model, endpoint, Credentials.roles(input.model)),
      this.#responses(endpoint),
      this.#samples(endpoint),
      this.#curl(endpoint),
      this.#steps(input.model, endpoint),
    ]);
  }

  #title(endpoint: Endpoint, number: number): string[] {
    const method = this.ansi.clean(endpoint.method);
    const plain = `${method} ${this.ansi.clean(endpoint.origin)}${this.ansi.clean(endpoint.path)}${endpoint.operationName === undefined ? '' : '#' + this.ansi.clean(endpoint.operationName)}`;
    const head =
      plain.length <= this.width
        ? [`${this.#format.method(endpoint)} ${this.ansi.bold(this.#format.url(endpoint))}`]
        : EndpointDetailPresenter.#chunks(plain, this.width).map((line, i) => (i === 0 && line.startsWith(method + ' ') ? this.ansi.method(method, method) + line.slice(method.length) : line));
    const facts = [
      this.ansi.bold(`#${number}`),
      `${this.ansi.dim('kind')} ${this.ansi.clean(endpoint.kind)}`,
      Text.plural(endpoint.count, 'hit'),
      endpoint.firstParty ? 'first-party' : 'third-party',
    ];
    if (endpoint.resourceTypes.length > 0) facts.push(`${this.ansi.dim('seen as')} ${this.ansi.clean(endpoint.resourceTypes.join(', '))}`);
    const names: Definition[] = [
      ['Name', this.ansi.clean(endpoint.name)],
      ['Id', this.ansi.clean(endpoint.id)],
    ];
    if (endpoint.operationName !== undefined) names.push(['Operation', this.ansi.clean(endpoint.operationName)]);
    return [...head, ...TextLayout.flow(facts, this.width), ...this.definitions(names)];
  }

  #params(title: string, params: readonly ParamInfo[]): PresenterBlock {
    if (params.length === 0) return undefined;
    const rows = params.map((param) => [
      this.ansi.clean(param.name),
      param.required ? 'yes' : this.ansi.dim('no'),
      this.ansi.clean(Schema.typeLabel(param.schema)),
      this.ansi.clean(SchemaTree.constraints(param.schema).join(', ')),
      this.ansi.clean(param.examples.slice(0, EndpointDetailPresenter.MAX_PARAM_EXAMPLES).join(', ')),
    ]);
    return [this.heading(title), this.table().render(EndpointDetailPresenter.PARAM_COLUMNS, rows)];
  }

  #requestBody(endpoint: Endpoint): PresenterBlock {
    const bodies = [...(endpoint.requestBody ? [endpoint.requestBody] : []), ...(endpoint.otherRequestBodies ?? [])];
    if (bodies.length === 0) return undefined;
    return bodies.flatMap((body, i) => {
      const title = bodies.length === 1 ? 'Request body' : `Request body ${i + 1} of ${bodies.length}`;
      const lines = [...(i > 0 ? [''] : []), this.heading(title), ...this.definitions([['Type', EndpointDetailPresenter.#bodyType(body, this.ansi)]])];
      if (body.kind === 'graphql') {
        const query = EndpointDetailPresenter.#graphqlQuery(body);
        if (query !== undefined) lines.push(...this.definitions([['Query', this.ansi.clean(query)]]));
      }
      return [...lines, ...this.#schema(body)];
    });
  }

  #form(endpoint: Endpoint): PresenterBlock {
    const form = endpoint.form;
    if (!form) return undefined;
    const names = [...new Set(form.fields.map((field) => field.name).filter((name) => name !== ''))];
    const script = FormSource.isScript(form);
    const type = FormSource.contentType(endpoint);
    const sending: Definition[] = script
      ? [['Sent by', FormSource.SCRIPT_SENDER], ...(type !== undefined ? [['Sent as', this.ansi.clean(type)] as Definition] : [])]
      : [['Enctype', this.ansi.clean(form.enctype)]];
    const entries: Definition[] = [
      ['Page', this.ansi.clean(form.pageUrl)],
      ['Selector', this.ansi.clean(form.selector)],
      ...EndpointDetailPresenter.#selectorNote(form.selector),
      ...sending,
      ['Fields', names.length > 0 ? this.ansi.clean(names.join(', ')) : 'none'],
      ['Token fields', form.tokenFields.length > 0 ? this.ansi.clean(form.tokenFields.join(', ')) : 'none'],
    ];
    if (!script && form.submitters.length === 0) entries.push(['Submitters', 'none (implicit submission)']);
    if (!script) form.submitters.forEach((submitter, i) => entries.push([`Submitter ${i + 1}`, EndpointDetailPresenter.submitter(submitter, this.ansi)]));
    return [this.heading('Form source'), ...this.definitions(entries)];
  }

  static #selectorNote(selector: string): Definition[] {
    const note = FormSource.selectorNote(selector);
    return note === undefined ? [] : [[EndpointDetailPresenter.SELECTOR_NOTATION, note]];
  }

  static refusedExample(refusals: readonly number[]): string {
    return `Without credentials the server answered ${refusals.join(' and ')}. The credential it expects was not captured: add it with -H or -b.`;
  }

  static anonymous(endpoint: Endpoint, roles?: CookieRoles): string {
    const label = Credentials.anonymousLabel(endpoint);
    if (endpoint.auth.anonymous === 'allowed') return `${label}, a request without credentials was not refused`;
    if (endpoint.auth.anonymous === 'refused') {
      const refusals = Credentials.refusals(endpoint, roles);
      return `${label}, every request without credentials was refused${refusals.length > 0 ? ` (${refusals.join(', ')})` : ''}`;
    }
    return endpoint.count === 0 ? `${label}, no request was observed` : `${label}, every request seen carried credentials`;
  }

  static seen(endpoint: Endpoint, model?: Pick<ApiModel, 'endpoints' | 'forms'>): string {
    const seen = endpoint.auth.seen ?? [];
    if (seen.length > 0) return seen.join(', ');
    return model !== undefined && Credentials.foundAfterLogin(model, endpoint) ? `not observed; ${EndpointDetailPresenter.FOUND_AFTER_LOGIN}` : 'not observed';
  }

  static role(endpoint: Endpoint): string | undefined {
    if (endpoint.role === 'logout') return 'logout, signs out';
    if (endpoint.role !== 'login' || !endpoint.login) return undefined;
    if (endpoint.login.evidence === 'observed') return 'login, a submission issued a credential';
    return endpoint.count > 0 ? `login, ${EndpointListPresenter.NOTHING_ISSUED}` : `login, ${EndpointListPresenter.NOT_SUBMITTED}`;
  }

  #session(model: ApiModel, endpoint: Endpoint): Definition[] {
    const role = EndpointDetailPresenter.role(endpoint);
    if (role === undefined) return [];
    const entries: Definition[] = [['Role', this.ansi.clean(role)]];
    const login = endpoint.login;
    if (endpoint.role === 'login' && login) {
      const fields = [login.identifier === undefined ? 'identifier unknown' : `identifier ${login.identifier}`, `password ${login.password}`];
      entries.push(['Login fields', this.ansi.clean(fields.join(', '))], ['Issues', this.ansi.clean(EndpointListPresenter.issued(login)) || 'nothing observed yet']);
    } else {
      const revoked = EndpointListPresenter.revoked(model, endpoint);
      entries.push(['Revokes', revoked.length > 0 ? this.ansi.clean(revoked.map((name) => `cookie ${name}`).join(', ')) : 'no credential cookie change observed']);
    }
    return entries;
  }

  #auth(model: ApiModel, endpoint: Endpoint, roles: CookieRoles): PresenterBlock {
    const auth = endpoint.auth;
    const credentialCookies = new Set(Credentials.cookies(endpoint, roles));
    const others = auth.cookies.filter((name) => !credentialCookies.has(name));
    const lines = [
      this.heading('Auth'),
      ...this.definitions([
        ...this.#session(model, endpoint),
        ['Credentials', this.ansi.clean(Credentials.describe(endpoint, roles)) || 'none'],
        ['Anonymous', EndpointDetailPresenter.anonymous(endpoint, roles)],
        ['Seen', EndpointDetailPresenter.seen(endpoint, model)],
        ['Credential cookies', credentialCookies.size > 0 ? this.ansi.clean([...credentialCookies].join(', ')) : 'none'],
        ['Other cookies', others.length > 0 ? this.ansi.clean(others.join(', ')) + ' (sent by the browser; not credentials)' : 'none'],
        ['Bearer', auth.bearer ? 'yes' : 'no'],
        ['Headers', auth.headers.length > 0 ? this.ansi.clean(auth.headers.join(', ')) : 'none'],
        ['CSRF', auth.csrf.length > 0 ? Text.plural(auth.csrf.length, 'token') : 'none'],
      ]),
    ];
    if (auth.csrf.length === 0) return lines;
    const bound = auth.csrf.some((token) => (token.sessionCookies?.length ?? 0) > 0);
    const columns = bound ? [...EndpointDetailPresenter.CSRF_COLUMNS, EndpointDetailPresenter.BOUND_COLUMN] : EndpointDetailPresenter.CSRF_COLUMNS;
    const rows = auth.csrf.map((token) => {
      const row = [this.ansi.clean(token.location), this.ansi.clean(token.name), this.ansi.clean(token.source), this.ansi.clean(token.sourceName ?? ''), this.ansi.clean(token.sourceUrl ?? '')];
      if (bound) row.push(this.ansi.clean(EndpointDetailPresenter.boundTo(token)));
      return row;
    });
    return [...lines, this.table().render(columns, rows)];
  }

  static boundTo(token: CsrfToken): string {
    const cookies = token.sessionCookies ?? [];
    return cookies.length > 0 ? cookies.map((name) => `cookie ${name}`).join(', ') : '';
  }

  #steps(model: ApiModel, endpoint: Endpoint): PresenterBlock {
    const plain = (value: string): string => value;
    const guide = SessionGuide.create(model).steps(endpoint, { code: plain, url: plain }, BasePresenter.fileArgument(this.file, this.ansi));
    if (!guide) return undefined;
    const wrap = (text: string): string[] => TextLayout.wrap(this.ansi.clean(text), this.width);
    const lines = [this.heading(SessionGuide.TITLE), ...guide.steps.flatMap(wrap), ...wrap(guide.lead)];
    for (const command of guide.commands) lines.push(...this.#shell.fold(`  ${command}`, this.width));
    lines.push(...guide.notes.flatMap(wrap));
    return lines;
  }

  #responses(endpoint: Endpoint): PresenterBlock {
    const lines = [this.heading('Responses')];
    if (endpoint.responses.length === 0) {
      lines.push(endpoint.form ? 'No responses observed; this endpoint is known from a form.' : 'No responses observed.');
      return lines;
    }
    endpoint.responses.forEach((response, i) => {
      if (i > 0) lines.push('');
      lines.push(...this.#response(response));
    });
    return lines;
  }

  #response(response: EndpointResponse): string[] {
    const body = response.body;
    const facts = [this.ansi.bold(this.ansi.status(response.status)), Text.plural(response.count, 'hit'), body ? EndpointDetailPresenter.#bodyType(body, this.ansi) : 'no body'];
    const lines = TextLayout.flow(facts, this.width);
    if (response.headers.length > 0) lines.push(...this.definitions([['Headers', this.ansi.clean(response.headers.join(', '))]]));
    if (response.redirectTo !== undefined && response.redirectTo.length > 0) lines.push(...this.definitions([['Redirects to', this.ansi.clean(response.redirectTo.join(', '))]]));
    if (body) lines.push(...this.#schema(body));
    return lines;
  }

  #schema(body: BodyShape): string[] {
    if (body.kind === 'empty') return [];
    if (!body.schema) return body.examples.length === 0 && EndpointDetailPresenter.STRUCTURED_KINDS.has(body.kind) ? [this.ansi.dim('Schema unknown (the body was not captured).')] : [];
    const rows = this.#tree.rows(body.schema).map((row) => this.#schemaRow(row));
    if (rows.length === 0) return [];
    return [this.table().render(EndpointDetailPresenter.SCHEMA_COLUMNS, rows), ...this.#tree.branches(body.schema).flatMap((branch) => this.#branch(branch))];
  }

  #schemaRow(row: SchemaTreeRow): string[] {
    return [
      this.ansi.clean(row.path),
      this.ansi.clean(row.type),
      row.required ? 'yes' : row.requiredWhen ? EndpointDetailPresenter.CONDITIONAL : this.ansi.dim('no'),
      this.ansi.clean(row.constraints),
    ];
  }

  #branch(branch: SchemaTreeBranch): string[] {
    const notes = [branch.label === undefined ? '' : ` ("${branch.label}")`, branch.noValidate ? `, ${EndpointDetailPresenter.NO_VALIDATION}` : ''].join('');
    const title = TextLayout.wrap(this.ansi.clean(`When ${branch.condition}${notes}:`), this.width).map((line) => this.ansi.bold(line));
    const facts: Definition[] = [];
    if (branch.requires.length > 0) facts.push(['Requires', this.ansi.clean(branch.requires.join(', '))]);
    if (branch.excluded.length > 0) facts.push(['Not sent', this.ansi.clean(branch.excluded.join(', '))]);
    const lines = ['', ...title, ...this.definitions(facts, EndpointDetailPresenter.BRANCH_INDENT)];
    if (branch.rows.length > 0) lines.push(this.table().render(EndpointDetailPresenter.SCHEMA_COLUMNS, branch.rows.map((row) => this.#schemaRow(row))));
    if (facts.length === 0 && branch.rows.length === 0) lines.push(' '.repeat(EndpointDetailPresenter.BRANCH_INDENT) + EndpointDetailPresenter.NO_OTHER_RULES);
    return lines;
  }

  #samples(endpoint: Endpoint): PresenterBlock {
    if (endpoint.samples.length === 0) return undefined;
    const rows = endpoint.samples.map((sample) => [
      sample.status === undefined ? this.ansi.dim('-') : this.ansi.status(sample.status),
      this.ansi.clean(sample.url),
      this.ansi.clean(sample.startedAt),
    ]);
    return [this.heading('Samples'), this.table().render(EndpointDetailPresenter.SAMPLE_COLUMNS, rows)];
  }

  #curl(endpoint: Endpoint): PresenterBlock {
    const variants = RequestBodies.variants(endpoint);
    const primary = variants.length > 0 && endpoint.requestBody ? RequestBodies.mediaType(endpoint.requestBody) : undefined;
    const lines = this.#example(endpoint, primary);
    for (const variant of variants) lines.push('', ...this.#example(variant.endpoint, variant.mediaType));
    const refusals = Credentials.refusals(endpoint);
    if (refusals.length > 0) lines.push('', ...TextLayout.wrap(EndpointDetailPresenter.refusedExample(refusals), this.width));
    return lines;
  }

  #example(endpoint: Endpoint, mediaType: string | undefined): string[] {
    const sample = EndpointDetailPresenter.exampleRequest(endpoint);
    const command = Curl.curlCommand(sample, { variables: 'shell' });
    const names = Curl.placeholderNames(sample);
    const title = mediaType === undefined ? 'Example request (curl)' : `Example request (curl, ${this.ansi.clean(mediaType)})`;
    const lines = [this.heading(title), ...this.#shell.fold(command, this.width)];
    if (names.length > 0) lines.push('', ...TextLayout.flow(names, this.width, { prefix: this.ansi.dim('Variables:') + ' ', separator: ' ' }));
    return lines;
  }

  static #bodyType(body: BodyShape, ansi: Ansi): string {
    const mime = ansi.clean(body.mimeType);
    const kind = ansi.clean(body.kind) + (body.jsonLines === true ? EndpointDetailPresenter.JSON_LINES : '');
    return mime === '' ? kind : `${mime} (${kind})`;
  }

  static #graphqlQuery(body: BodyShape): string | undefined {
    for (const example of body.examples) {
      if (Json.isPlainObject(example) && typeof example.query === 'string') return example.query.replace(/\s+/g, ' ').trim();
    }
    return undefined;
  }

  static #chunks(text: string, width: number): string[] {
    const lines: string[] = [];
    for (let i = 0; i < text.length; i += width) lines.push(text.slice(i, i + width));
    return lines;
  }
}
