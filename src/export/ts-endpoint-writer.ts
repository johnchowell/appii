import type { ApiModel, CsrfToken, Endpoint, EndpointResponse, JsonSchema, ParamInfo } from '../model/index.js';
import { CharsetEncoder, EndpointIndex, Http, Json, Samples, Schema, Text } from '../shared/index.js';
import { FormRuleCompiler } from './form-rule-compiler.js';
import type { CompiledVariant } from './form-rule-compiler.js';
import { Helpers } from './helpers.js';
import { TsClientRuntime } from './ts-client-runtime.js';
import { TsLiteralWriter } from './ts-literal-writer.js';
import { TsTypeWriter } from './ts-type-writer.js';

export interface TsEndpointContext {
  model: ApiModel;
  taken: Set<string>;
  methods: ReadonlyMap<string, string>;
  endpoints: readonly Endpoint[];
  sources: ReadonlySet<string>;
}

export interface TsEndpointCode {
  method: string;
  declarations: string[];
  spec: string;
  validator?: string;
  member: string;
}

export interface TsEndpointWriterDeps {
  types?: TsTypeWriter;
  literals?: TsLiteralWriter;
  rules?: FormRuleCompiler;
}

interface RequestMember {
  name: string;
  type: string;
  required: boolean;
}

interface FormCode {
  spec: Record<string, unknown>;
  defaults: Record<string, unknown>;
}

export class TsEndpointWriter {
  static readonly NO_CONTENT_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);
  static readonly SKIPPED_HEADERS: ReadonlySet<string> = new Set(['cookie', 'content-type', 'content-length', 'host', 'authorization', 'origin', 'referer']);
  static readonly GRAPHQL_DEFAULTS: readonly string[] = ['operationName', 'query', 'extensions'];
  static readonly BINARY_BODY = 'Blob | ArrayBuffer | Uint8Array | string';
  static readonly HEADER_INDEX = '[name: string]: string | undefined;';
  static readonly METHOD_SUFFIX = 'Endpoint';
  static readonly FETCHED_SOURCE_METHOD = 'GET';
  static readonly TEXT_PLAIN = 'text/plain';
  static readonly NAVIGATE_TYPES: ReadonlySet<string> = new Set(['document']);
  static readonly CORS_TYPES: ReadonlySet<string> = new Set(['fetch', 'xhr', 'eventsource']);
  static readonly HIGH_BYTE = 0x80;
  static readonly HIGH_BYTES = 0x80;
  static readonly UNMAPPED = '\ufffd';

  readonly #types: TsTypeWriter;
  readonly #literals: TsLiteralWriter;
  readonly #rules: FormRuleCompiler;

  static create(): TsEndpointWriter {
    return new TsEndpointWriter({ types: new TsTypeWriter(), literals: new TsLiteralWriter(), rules: FormRuleCompiler.create() });
  }

  constructor(deps: TsEndpointWriterDeps = {}) {
    this.#types = deps.types ?? new TsTypeWriter();
    this.#literals = deps.literals ?? new TsLiteralWriter();
    this.#rules = deps.rules ?? FormRuleCompiler.create();
  }

  static pascal(name: string): string {
    const pascal = Text.pascalCase(name).replace(/^_+/, '');
    return pascal === '' ? TsEndpointWriter.METHOD_SUFFIX : /^[0-9]/.test(pascal) ? TsEndpointWriter.METHOD_SUFFIX + pascal : pascal;
  }

  static tokenKey(endpoint: Endpoint): string {
    return `${endpoint.method.toUpperCase()} ${endpoint.origin}${endpoint.path}`;
  }

  static storedSource(token: CsrfToken): boolean {
    const method = token.sourceMethod?.toUpperCase();
    return token.source !== 'cookie' && method !== undefined && method !== TsEndpointWriter.FETCHED_SOURCE_METHOD;
  }

  static sourceEndpoint(token: CsrfToken, endpoints: readonly Endpoint[]): Endpoint | undefined {
    if (!TsEndpointWriter.storedSource(token) || token.sourceUrl === undefined) return undefined;
    const url = Http.parseUrl(token.sourceUrl);
    if (!url) return undefined;
    const method = token.sourceMethod?.toUpperCase();
    return endpoints.find((endpoint) => endpoint.method.toUpperCase() === method && endpoint.origin === url.origin && EndpointIndex.matchPath(endpoint.path, url.pathname) !== undefined);
  }

  tokenSources(endpoints: readonly Endpoint[]): Set<string> {
    const out = new Set<string>();
    for (const endpoint of endpoints) {
      for (const token of endpoint.auth.csrf) {
        const source = TsEndpointWriter.sourceEndpoint(token, endpoints);
        if (source) out.add(source.id);
      }
    }
    return out;
  }

  methodName(endpoint: Endpoint, members: Set<string>): string {
    const valid = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(endpoint.name) && !TsClientRuntime.CLIENT_MEMBERS.includes(endpoint.name);
    const base = valid ? endpoint.name : Text.camelCase(`${endpoint.name} ${TsEndpointWriter.METHOD_SUFFIX}`).replace(/^_+/, '') || 'endpoint';
    return Text.uniqueName(TsClientRuntime.CLIENT_MEMBERS.includes(base) ? base + TsEndpointWriter.METHOD_SUFFIX : base, members);
  }

  write(endpoint: Endpoint, ctx: TsEndpointContext): TsEndpointCode {
    const pascal = TsEndpointWriter.pascal(endpoint.name);
    const name = (suffix: string): string => Text.uniqueName(pascal + suffix, ctx.taken);
    const method = ctx.methods.get(endpoint.id) ?? this.methodName(endpoint, new Set(TsClientRuntime.CLIENT_MEMBERS));
    const declarations: string[] = [];
    const members: RequestMember[] = [];
    const params = this.#paramsSchema(endpoint);
    if (params) {
      const type = name('Params');
      declarations.push(this.#types.declaration(type, params));
      members.push({ name: 'params', type, required: true });
    }
    const query = this.#querySchema(endpoint);
    if (query) {
      const type = name('Query');
      declarations.push(this.#types.declaration(type, query));
      members.push({ name: 'query', type, required: Schema.requiredSet(query).size > 0 });
    }
    const body = this.#body(endpoint);
    let bodyType: string | undefined;
    if (body) {
      bodyType = name('Body');
      declarations.push(body.schema ? this.#types.declaration(bodyType, body.schema) : `export type ${bodyType} = ${body.type};`);
      members.push({ name: 'body', type: bodyType, required: body.required });
    }
    const headerType = name('Headers');
    declarations.push(`export interface ${headerType} ${this.#headers(endpoint)}`);
    members.push({ name: 'headers', type: headerType, required: false });
    const requestType = name('Request');
    declarations.push(
      `export interface ${requestType} {\n${members.map((member) => `  ${member.name}${member.required ? '' : '?'}: ${member.type};`).join('\n')}\n}`,
    );
    const responseType = name('Response');
    declarations.push(...this.#responses(endpoint, responseType, name));
    const specName = Text.uniqueName(`${Text.camelCase(pascal)}Spec`, ctx.taken);
    const spec = `const ${specName}: EndpointSpec = ${this.#literals.write(this.spec(endpoint, ctx))};`;
    const optional = members.every((member) => !member.required);
    const member = [
      `  async ${method}(request: ${requestType}${optional ? ' = {}' : ''}): Promise<${responseType}> {`,
      `    return (await this.send(${specName}, request)) as ${responseType};`,
      '  }',
    ].join('\n');
    const code: TsEndpointCode = { method, declarations, spec, member };
    if (endpoint.form) {
      const target = endpoint.method === 'GET' ? members.find((m) => m.name === 'query')?.type : bodyType;
      const validator = Text.uniqueName(`validate${pascal}`, ctx.taken);
      code.validator = [
        `export function ${validator}(input: ${target ? `Partial<${target}>` : 'Record<string, unknown>'} = {}, options: ValidateOptions = {}): FieldError[] {`,
        `  return AppiiForms.validate(${specName}, input, options.unsafePatterns === true);`,
        '}',
      ].join('\n');
    }
    return code;
  }

  spec(endpoint: Endpoint, ctx: TsEndpointContext): Record<string, unknown> {
    const httpMethod = endpoint.method.toUpperCase();
    const spec: Record<string, unknown> = {
      name: endpoint.name,
      method: httpMethod,
      origin: endpoint.origin,
      path: endpoint.path,
      mode: TsEndpointWriter.mode(endpoint),
      headers: this.#headerDefaults(endpoint),
      query: {},
    };
    const page = TsEndpointWriter.page(endpoint);
    if (page !== undefined) spec.page = page;
    if (ctx.sources.has(endpoint.id)) spec.tokenKey = TsEndpointWriter.tokenKey(endpoint);
    const form = endpoint.form ? this.#form(endpoint, ctx.model) : undefined;
    if (form && httpMethod === 'GET') spec.query = form.defaults;
    const shape = endpoint.requestBody;
    if (shape && shape.kind !== 'empty') {
      const body: Record<string, unknown> = { kind: shape.kind, mimeType: shape.mimeType };
      const defaults = form && httpMethod !== 'GET' ? form.defaults : this.#graphqlDefaults(endpoint);
      if (defaults && Object.keys(defaults).length > 0) body.defaults = defaults;
      spec.body = body;
    }
    spec.csrf = endpoint.auth.csrf.map((token) => this.#csrf(token, endpoint, ctx));
    if (form) spec.form = form.spec;
    return spec;
  }

  static page(endpoint: Endpoint): string | undefined {
    if (endpoint.form) return endpoint.form.pageUrl;
    if (TsEndpointWriter.mode(endpoint) === 'navigate') return undefined;
    const counts = new Map<string, number>();
    for (const sample of endpoint.samples) {
      if (sample.pageUrl !== undefined && Http.parseUrl(sample.pageUrl)) counts.set(sample.pageUrl, (counts.get(sample.pageUrl) ?? 0) + 1);
    }
    let best: string | undefined;
    let most = 0;
    for (const [url, count] of counts) {
      if (count > most) {
        best = url;
        most = count;
      }
    }
    return best;
  }

  static mode(endpoint: Endpoint): 'navigate' | 'cors' | 'no-cors' {
    const types = endpoint.resourceTypes;
    if (types.some((type) => TsEndpointWriter.NAVIGATE_TYPES.has(type)) || (types.length === 0 && endpoint.form)) return 'navigate';
    if (types.some((type) => TsEndpointWriter.CORS_TYPES.has(type))) return 'cors';
    return types.length === 0 ? 'cors' : 'no-cors';
  }

  static charset(label: string): Record<string, unknown> {
    const encoder = CharsetEncoder.for(label);
    if (encoder.utf8) return { name: 'UTF-8' };
    const out: Record<string, unknown> = { name: label };
    const table = encoder.exact ? CharsetEncoder.singleByteTable(encoder.name) : undefined;
    if (table) {
      const high = Array.from({ length: TsEndpointWriter.HIGH_BYTES }, () => TsEndpointWriter.UNMAPPED);
      for (const [cp, byte] of table) {
        const slot = byte - TsEndpointWriter.HIGH_BYTE;
        if (slot >= 0 && slot < high.length && high[slot] === TsEndpointWriter.UNMAPPED) high[slot] = String.fromCodePoint(cp);
      }
      out.high = high.join('');
    }
    return out;
  }

  #form(endpoint: Endpoint, model: ApiModel): FormCode | undefined {
    const form = endpoint.form;
    if (!form) return undefined;
    const query = endpoint.method.toUpperCase() === 'GET';
    const compiled = query ? { ...this.#rules.compileParams(endpoint.queryParams), variants: [] } : this.#rules.compileSchema(endpoint.requestBody?.schema);
    const descriptor = model.forms.find((candidate) => candidate.selector === form.selector && candidate.pageUrl === form.pageUrl);
    const root = endpoint.requestBody?.schema?.['x-html-novalidate'] === true;
    const noValidate = descriptor ? descriptor.noValidate : root && form.submitters[0]?.formNoValidate !== true;
    const submitters = form.submitters
      .filter((submitter) => !submitter.disabled)
      .map((submitter) => {
        const out: Record<string, unknown> = { name: submitter.name, value: submitter.value, noValidate: submitter.formNoValidate === true };
        const extra = query ? undefined : TsEndpointWriter.#actionQuery(endpoint, submitter.formAction);
        if (extra && Object.keys(extra).length > 0) out.query = extra;
        return out;
      });
    const spec: Record<string, unknown> = {
      target: query ? 'query' : 'body',
      noValidate,
      enctype: query ? 'application/x-www-form-urlencoded' : form.enctype,
      charset: TsEndpointWriter.charset(form.charset),
      page: form.pageUrl,
    };
    if (descriptor) {
      const identity: Record<string, unknown> = { index: descriptor.index };
      if (descriptor.id !== undefined && descriptor.id !== '') identity.id = descriptor.id;
      if (descriptor.name !== undefined && descriptor.name !== '') identity.name = descriptor.name;
      spec.form = identity;
    }
    spec.rules = compiled.rules;
    spec.fields = compiled.fields;
    spec.submitters = submitters;
    if (compiled.variants.length > 0) spec.variants = compiled.variants.map((variant) => TsEndpointWriter.#variant(variant));
    return { defaults: compiled.defaults, spec };
  }

  static #variant(variant: CompiledVariant): Record<string, unknown> {
    return { when: variant.when, noValidate: variant.noValidate, rules: variant.rules, fields: variant.fields, defaults: variant.defaults };
  }

  #csrf(token: CsrfToken, endpoint: Endpoint, ctx: TsEndpointContext): Record<string, unknown> {
    const out: Record<string, unknown> = { location: token.location, name: token.name, source: token.source };
    if (token.sourceName !== undefined) out.sourceName = token.sourceName;
    if (token.sourceUrl !== undefined) out.sourceUrl = token.sourceUrl;
    else if (token.source !== 'cookie' && endpoint.form) out.sourceUrl = endpoint.form.pageUrl;
    if (token.sourceMethod !== undefined) out.sourceMethod = token.sourceMethod.toUpperCase();
    if (TsEndpointWriter.storedSource(token)) {
      const source = TsEndpointWriter.sourceEndpoint(token, ctx.endpoints);
      const url = token.sourceUrl === undefined ? undefined : Http.parseUrl(token.sourceUrl);
      if (source) {
        out.sourceKey = TsEndpointWriter.tokenKey(source);
        const call = ctx.methods.get(source.id);
        if (call !== undefined) out.sourceCall = call;
      } else {
        out.sourceKey = `${String(token.sourceMethod).toUpperCase()} ${url ? url.origin + url.pathname : (token.sourceUrl ?? '')}`;
      }
    }
    if (token.source === 'cookie' && token.sourceName !== undefined) {
      const seed = TsEndpointWriter.#seed(ctx.model, token.sourceName);
      if (seed !== undefined) out.seed = seed;
    }
    return out;
  }

  static #seed(model: ApiModel, cookie: string): string | undefined {
    const ids = model.cookies.filter((info) => info.name === cookie).flatMap((info) => info.setBy);
    for (const id of ids) {
      const setter = model.endpoints.find((endpoint) => endpoint.id === id);
      if (setter && setter.method.toUpperCase() === 'GET' && Helpers.pathParams(setter.path).length === 0 && setter.queryParams.every((param) => !param.required)) {
        return setter.origin + setter.path;
      }
    }
    return undefined;
  }

  static #actionQuery(endpoint: Endpoint, action: string | undefined): Record<string, string> | undefined {
    const url = action === undefined ? undefined : Http.parseUrl(action);
    if (!url || url.origin !== endpoint.origin || url.search === '') return undefined;
    const out: [string, string][] = [];
    for (const [name, value] of url.searchParams) if (!out.some(([existing]) => existing === name)) out.push([name, value]);
    return Object.fromEntries(out);
  }

  #headerDefaults(endpoint: Endpoint): Record<string, string> {
    const csrf = new Set(endpoint.auth.csrf.filter((token) => token.location === 'header').map((token) => token.name.toLowerCase()));
    const out: [string, string][] = [];
    for (const param of endpoint.headerParams) {
      const lower = param.name.toLowerCase();
      if (!param.required || csrf.has(lower) || TsEndpointWriter.SKIPPED_HEADERS.has(lower)) continue;
      const example = param.examples.find((value) => !Samples.isRedacted(value));
      if (example !== undefined) out.push([lower, example]);
    }
    return Object.fromEntries(out);
  }

  #graphqlDefaults(endpoint: Endpoint): Record<string, unknown> | undefined {
    if (endpoint.kind !== 'graphql') return undefined;
    const example = endpoint.requestBody?.examples[0];
    if (!Json.isPlainObject(example)) return undefined;
    const out: [string, unknown][] = [];
    for (const key of TsEndpointWriter.GRAPHQL_DEFAULTS) {
      const value = example[key];
      if (value === undefined || JSON.stringify(value).includes('<redacted>')) continue;
      out.push([key, Json.clone(value)]);
    }
    return Object.fromEntries(out);
  }

  #paramsSchema(endpoint: Endpoint): JsonSchema | undefined {
    const names = Helpers.pathParams(endpoint.path);
    if (names.length === 0) return undefined;
    const properties = names.map((name): [string, JsonSchema] => [name, endpoint.pathParams.find((param) => param.name === name)?.schema ?? { type: 'string' }]);
    return { type: 'object', properties: Object.fromEntries(properties), required: names };
  }

  #querySchema(endpoint: Endpoint): JsonSchema | undefined {
    const params: ParamInfo[] = [...endpoint.queryParams];
    const csrf = endpoint.auth.csrf.filter((token) => token.location === 'query');
    for (const token of csrf) {
      if (!params.some((param) => param.name === token.name)) params.push({ name: token.name, in: 'query', required: false, schema: { type: 'string' }, examples: [] });
    }
    if (params.length === 0) return undefined;
    const tokens = new Set(csrf.map((token) => token.name));
    const required = params.filter((param) => param.required && !tokens.has(param.name) && !this.#rules.isAutoFilled(param.schema)).map((param) => param.name);
    return { type: 'object', properties: Object.fromEntries(params.map((param) => [param.name, param.schema])), required };
  }

  static #textPlainForm(endpoint: Endpoint): boolean {
    const shape = endpoint.requestBody;
    return endpoint.form?.enctype === TsEndpointWriter.TEXT_PLAIN && shape?.kind === 'text' && Schema.primaryType(shape.schema) === 'object';
  }

  #body(endpoint: Endpoint): { schema?: JsonSchema; type: string; required: boolean } | undefined {
    const shape = endpoint.requestBody;
    const method = endpoint.method.toUpperCase();
    if (!shape || shape.kind === 'empty' || method === 'GET' || method === 'HEAD') return undefined;
    const textPlain = TsEndpointWriter.#textPlainForm(endpoint);
    if ((shape.kind === 'text' || shape.kind === 'html') && !textPlain) return { type: 'string', required: true };
    if (shape.kind === 'binary') return { type: TsEndpointWriter.BINARY_BODY, required: true };
    if (!shape.schema) return { type: 'unknown', required: false };
    const tokens = new Set(endpoint.auth.csrf.filter((token) => token.location === 'body').map((token) => token.name));
    const graphql = new Set(Object.keys(this.#graphqlDefaults(endpoint) ?? {}));
    const form = shape.kind === 'form' || shape.kind === 'multipart' || textPlain;
    const properties = Schema.properties(shape.schema);
    const required = [...Schema.requiredSet(shape.schema)].filter((key) => {
      const property = properties[key];
      if (tokens.has(key) || graphql.has(key)) return false;
      return !(form && property && this.#rules.isAutoFilled(property));
    });
    const schema: JsonSchema = { ...shape.schema, required };
    const objectLike = Schema.primaryType(shape.schema) === 'object';
    return { schema, type: this.#types.type(schema), required: objectLike ? required.length > 0 : true };
  }

  #headers(endpoint: Endpoint): string {
    const csrf = new Set(endpoint.auth.csrf.filter((token) => token.location === 'header').map((token) => token.name.toLowerCase()));
    const defaults = this.#headerDefaults(endpoint);
    const lines: string[] = [];
    const seen = new Set<string>();
    for (const param of endpoint.headerParams) {
      const lower = param.name.toLowerCase();
      if (seen.has(lower) || TsEndpointWriter.SKIPPED_HEADERS.has(lower)) continue;
      seen.add(lower);
      const required = param.required && !csrf.has(lower) && defaults[lower] === undefined;
      lines.push(`  ${Text.propertyKey(lower)}${required ? '' : '?'}: string;`);
    }
    for (const name of csrf) {
      if (seen.has(name)) continue;
      seen.add(name);
      lines.push(`  ${Text.propertyKey(name)}?: string;`);
    }
    lines.push(`  ${TsEndpointWriter.HEADER_INDEX}`);
    return `{\n${lines.join('\n')}\n}`;
  }

  #responses(endpoint: Endpoint, typeName: string, name: (suffix: string) => string): string[] {
    const declarations: string[] = [];
    const head = endpoint.method.toUpperCase() === 'HEAD';
    const statuses: number[] = [];
    const members: string[] = [];
    for (const response of endpoint.responses) {
      if (!Helpers.isHttpStatus(response.status) || response.status < 200 || statuses.includes(response.status)) continue;
      statuses.push(response.status);
      const data = head ? 'undefined' : this.#dataType(response, () => name(`Response${response.status}`), declarations);
      members.push(`ApiResponse<${response.status}, ${data}>`);
    }
    members.push(statuses.length > 0 ? `ApiResponse<Exclude<HttpStatus, ${statuses.join(' | ')}>, unknown>` : 'ApiResponse<HttpStatus, unknown>');
    declarations.push(`export type ${typeName} =\n${members.map((member) => `  | ${member}`).join('\n')};`);
    return declarations;
  }

  #dataType(response: EndpointResponse, name: () => string, declarations: string[]): string {
    const body = response.body;
    if (!body) return TsEndpointWriter.NO_CONTENT_STATUSES.has(response.status) ? 'undefined' : 'unknown';
    switch (body.kind) {
      case 'empty':
        return 'undefined';
      case 'html':
      case 'text':
      case 'form':
        return 'string';
      case 'binary':
      case 'multipart':
        return 'Uint8Array';
      default: {
        if (!body.schema) return 'unknown';
        const type = this.#types.type(body.schema);
        if (type === 'unknown') return type;
        const declared = name();
        declarations.push(this.#types.declaration(declared, body.schema));
        return declared;
      }
    }
  }
}
