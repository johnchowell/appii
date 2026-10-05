import type { ApiModel, BodyKind, BodyShape, Endpoint, EndpointResponse, FormField, ParamInfo } from '../model/index.js';
import { Curl, EndpointIndex, Json, Samples, Schema, Text } from '../shared/index.js';
import type { SampleText } from '../shared/index.js';
import { EndpointFormatter } from './endpoint-formatter.js';
import { BasePresenter } from './presenter.js';
import type { PresenterBlock, PresenterOptions } from './presenter.js';
import { SchemaTree } from './schema-tree.js';
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
  static readonly PARAM_COLUMNS: readonly TableColumn[] = [
    { header: 'NAME', flex: true, minWidth: 12 },
    { header: 'REQ' },
    { header: 'TYPE', flex: true, minWidth: 8 },
    { header: 'CONSTRAINTS', flex: true, wrap: true, minWidth: 12, optional: true, priority: 2 },
    { header: 'EXAMPLES', flex: true, wrap: true, minWidth: 10, optional: true, priority: 1 },
  ];
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

  static submitter(field: FormField): string {
    const parts = [field.name === '' ? '(unnamed)' : `${field.name}=${field.value}`];
    if (field.label !== undefined && field.label !== '') parts.push(`"${field.label}"`);
    if (field.formAction !== undefined) parts.push(`formaction ${field.formAction}`);
    if (field.formMethod !== undefined) parts.push(`formmethod ${field.formMethod}`);
    if (field.formEnctype !== undefined) parts.push(`formenctype ${field.formEnctype}`);
    if (field.formNoValidate === true) parts.push('novalidate');
    if (field.disabled) parts.push('disabled');
    return TextLayout.clean(parts.join(' '));
  }

  static exampleRequest(endpoint: Endpoint): { sample: Samples.RequestSample; cookie?: SampleText } {
    const sample = Samples.requestSample(endpoint);
    const cookie = Samples.cookieJar(endpoint);
    return cookie === undefined ? { sample } : { sample, cookie };
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
      this.#auth(endpoint),
      this.#responses(endpoint),
      this.#samples(endpoint),
      this.#curl(endpoint),
    ]);
  }

  #title(endpoint: Endpoint, number: number): string[] {
    const method = TextLayout.clean(endpoint.method);
    const plain = `${method} ${TextLayout.clean(endpoint.origin)}${TextLayout.clean(endpoint.path)}${endpoint.operationName === undefined ? '' : '#' + TextLayout.clean(endpoint.operationName)}`;
    const head =
      plain.length <= this.width
        ? [`${this.#format.method(endpoint)} ${this.ansi.bold(this.#format.url(endpoint))}`]
        : EndpointDetailPresenter.#chunks(plain, this.width).map((line, i) => (i === 0 && line.startsWith(method + ' ') ? this.ansi.method(method, method) + line.slice(method.length) : line));
    const facts = [
      this.ansi.bold(`#${number}`),
      `${this.ansi.dim('kind')} ${TextLayout.clean(endpoint.kind)}`,
      Text.plural(endpoint.count, 'hit'),
      endpoint.firstParty ? 'first-party' : 'third-party',
    ];
    if (endpoint.resourceTypes.length > 0) facts.push(`${this.ansi.dim('seen as')} ${TextLayout.clean(endpoint.resourceTypes.join(', '))}`);
    const names: Definition[] = [
      ['Name', TextLayout.clean(endpoint.name)],
      ['Id', TextLayout.clean(endpoint.id)],
    ];
    if (endpoint.operationName !== undefined) names.push(['Operation', TextLayout.clean(endpoint.operationName)]);
    return [...head, ...TextLayout.flow(facts, this.width), ...this.definitions(names)];
  }

  #params(title: string, params: readonly ParamInfo[]): PresenterBlock {
    if (params.length === 0) return undefined;
    const rows = params.map((param) => [
      TextLayout.clean(param.name),
      param.required ? 'yes' : this.ansi.dim('no'),
      TextLayout.clean(Schema.typeLabel(param.schema)),
      TextLayout.clean(SchemaTree.constraints(param.schema).join(', ')),
      TextLayout.clean(param.examples.slice(0, EndpointDetailPresenter.MAX_PARAM_EXAMPLES).join(', ')),
    ]);
    return [this.heading(title), this.table().render(EndpointDetailPresenter.PARAM_COLUMNS, rows)];
  }

  #requestBody(endpoint: Endpoint): PresenterBlock {
    const body = endpoint.requestBody;
    if (!body) return undefined;
    const lines = [this.heading('Request body'), ...this.definitions([['Type', EndpointDetailPresenter.#bodyType(body)]])];
    if (body.kind === 'graphql') {
      const query = EndpointDetailPresenter.#graphqlQuery(body);
      if (query !== undefined) lines.push(...this.definitions([['Query', TextLayout.clean(query)]]));
    }
    return [...lines, ...this.#schema(body)];
  }

  #form(endpoint: Endpoint): PresenterBlock {
    const form = endpoint.form;
    if (!form) return undefined;
    const names = [...new Set(form.fields.map((field) => field.name).filter((name) => name !== ''))];
    const entries: Definition[] = [
      ['Page', TextLayout.clean(form.pageUrl)],
      ['Selector', TextLayout.clean(form.selector)],
      ['Enctype', TextLayout.clean(form.enctype)],
      ['Fields', names.length > 0 ? TextLayout.clean(names.join(', ')) : 'none'],
      ['Token fields', form.tokenFields.length > 0 ? TextLayout.clean(form.tokenFields.join(', ')) : 'none'],
    ];
    if (form.submitters.length === 0) entries.push(['Submitters', 'none (implicit submission)']);
    form.submitters.forEach((submitter, i) => entries.push([`Submitter ${i + 1}`, EndpointDetailPresenter.submitter(submitter)]));
    return [this.heading('Form source'), ...this.definitions(entries)];
  }

  #auth(endpoint: Endpoint): PresenterBlock {
    const auth = endpoint.auth;
    const lines = [
      this.heading('Auth'),
      ...this.definitions([
        ['Cookies', auth.cookies.length > 0 ? TextLayout.clean(auth.cookies.join(', ')) : 'none'],
        ['Bearer', auth.bearer ? 'yes' : 'no'],
        ['Headers', auth.headers.length > 0 ? TextLayout.clean(auth.headers.join(', ')) : 'none'],
        ['CSRF', auth.csrf.length > 0 ? Text.plural(auth.csrf.length, 'token') : 'none'],
      ]),
    ];
    if (auth.csrf.length === 0) return lines;
    const rows = auth.csrf.map((token) => [
      TextLayout.clean(token.location),
      TextLayout.clean(token.name),
      TextLayout.clean(token.source),
      TextLayout.clean(token.sourceName ?? ''),
      TextLayout.clean(token.sourceUrl ?? ''),
    ]);
    return [...lines, this.table().render(EndpointDetailPresenter.CSRF_COLUMNS, rows)];
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
    const facts = [this.ansi.bold(this.ansi.status(response.status)), Text.plural(response.count, 'hit'), body ? EndpointDetailPresenter.#bodyType(body) : 'no body'];
    const lines = TextLayout.flow(facts, this.width);
    if (response.headers.length > 0) lines.push(...this.definitions([['Headers', TextLayout.clean(response.headers.join(', '))]]));
    if (body) lines.push(...this.#schema(body));
    return lines;
  }

  #schema(body: BodyShape): string[] {
    if (body.kind === 'empty') return [];
    if (!body.schema) return body.examples.length === 0 && EndpointDetailPresenter.STRUCTURED_KINDS.has(body.kind) ? [this.ansi.dim('Schema unknown (the body was not captured).')] : [];
    const rows = this.#tree.rows(body.schema).map((row) => [TextLayout.clean(row.path), TextLayout.clean(row.type), row.required ? 'yes' : this.ansi.dim('no'), TextLayout.clean(row.constraints)]);
    if (rows.length === 0) return [];
    return [this.table().render(EndpointDetailPresenter.SCHEMA_COLUMNS, rows)];
  }

  #samples(endpoint: Endpoint): PresenterBlock {
    if (endpoint.samples.length === 0) return undefined;
    const rows = endpoint.samples.map((sample) => [
      sample.status === undefined ? this.ansi.dim('-') : this.ansi.status(sample.status),
      TextLayout.clean(sample.url),
      TextLayout.clean(sample.startedAt),
    ]);
    return [this.heading('Samples'), this.table().render(EndpointDetailPresenter.SAMPLE_COLUMNS, rows)];
  }

  #curl(endpoint: Endpoint): PresenterBlock {
    const { sample, cookie } = EndpointDetailPresenter.exampleRequest(endpoint);
    const command = Curl.curlCommand(sample, { variables: 'shell', ...(cookie === undefined ? {} : { cookie }) });
    const names = Curl.placeholderNames(sample, cookie === undefined ? [] : [cookie]);
    const lines = [this.heading('Example request (curl)'), ...this.#shell.fold(command, this.width)];
    if (names.length > 0) lines.push('', ...TextLayout.flow(names, this.width, { prefix: this.ansi.dim('Variables:') + ' ', separator: ' ' }));
    return lines;
  }

  static #bodyType(body: BodyShape): string {
    const mime = TextLayout.clean(body.mimeType);
    const kind = TextLayout.clean(body.kind);
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
