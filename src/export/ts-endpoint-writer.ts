import type { ApiModel, BodyShape, CsrfToken, Endpoint, EndpointResponse, JsonSchema, ParamInfo } from '../model/index.js';
import { CharsetEncoder, Credentials, EndpointIndex, Http, Json, RequestBodies, Samples, Schema, SingleByteIndexes, Text } from '../shared/index.js';
import type { CookieRoles } from '../shared/index.js';
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
  responseTypes?: ReadonlyMap<string, string>;
}

export interface TsEndpointCode {
  method: string;
  declarations: string[];
  spec: string;
  validator?: string;
  member: string;
}

export interface TsBodyCode {
  schema?: JsonSchema;
  type: string;
  required: boolean;
}

export interface TsResponseCode {
  declarations: string[];
  follow: string;
  manual?: string;
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
  static readonly SKIPPED_HEADERS: ReadonlySet<string> = new Set(['cookie', 'content-type', 'content-length', 'host', 'origin', 'referer']);
  static readonly CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['authorization']);
  static readonly AUTHORIZATION = 'authorization';
  static readonly REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
  static readonly FIRST_TYPED_STATUS = 200;
  static readonly CLIENT_REDIRECT_PARAMETER = 'R';
  static readonly GRAPHQL_DEFAULTS: readonly string[] = ['operationName', 'query', 'extensions'];
  static readonly BINARY_BODY = 'Blob | ArrayBuffer | Uint8Array | string';
  static readonly HEADER_INDEX = '[name: string]: string | undefined;';
  static readonly METHOD_SUFFIX = 'Endpoint';
  static readonly TEXT_PLAIN = 'text/plain';
  static readonly NAVIGATE_TYPES: ReadonlySet<string> = new Set(['document']);
  static readonly CORS_TYPES: ReadonlySet<string> = new Set(['fetch', 'xhr', 'eventsource']);
  static readonly UNMAPPED = 0xfffd;

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

  tokenSources(endpoints: readonly Endpoint[]): Set<string> {
    const out = new Set<string>();
    for (const endpoint of endpoints) {
      for (const token of endpoint.auth.csrf) {
        const source = EndpointIndex.tokenSource(token, endpoints);
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
    const headerType = name('Headers');
    const headers = this.#headers(endpoint);
    declarations.push(`export interface ${headerType} ${headers.body}`);
    const shared: RequestMember[] = [...members, { name: 'headers', type: headerType, required: headers.required }];
    if (endpoint.auth.bearer) shared.push({ name: 'accessToken', type: 'string', required: false });
    const variants = TsEndpointWriter.#bodyless(endpoint) ? [] : RequestBodies.variants(endpoint);
    const body = this.#body(endpoint);
    let bodyType: string | undefined;
    const requestMembers = [...shared];
    if (body) {
      bodyType = name('Body');
      declarations.push(body.schema ? this.#types.declaration(bodyType, body.schema) : `export type ${bodyType} = ${body.type};`);
      if (variants.length > 0 && endpoint.requestBody) requestMembers.unshift({ name: 'contentType', type: Text.jsString(RequestBodies.mediaType(endpoint.requestBody)), required: false });
      requestMembers.push({ name: 'body', type: bodyType, required: body.required });
    }
    const requestType = name('Request');
    declarations.push(TsEndpointWriter.#interface(requestType, requestMembers));
    const requestTypes = [requestType];
    for (const variant of variants) {
      const kind = TsEndpointWriter.pascal(variant.shape.kind);
      const code = this.#body(variant.endpoint);
      const variantMembers: RequestMember[] = [{ name: 'contentType', type: Text.jsString(variant.mediaType), required: true }, ...shared];
      if (code) {
        const type = name(`${kind}Body`);
        declarations.push(code.schema ? this.#types.declaration(type, code.schema) : `export type ${type} = ${code.type};`);
        variantMembers.push({ name: 'body', type, required: code.required });
      }
      const variantType = name(`${kind}Request`);
      declarations.push(TsEndpointWriter.#interface(variantType, variantMembers));
      requestTypes.push(variantType);
    }
    const responses = this.#responses(endpoint, ctx.responseTypes?.get(endpoint.id) ?? name('Response'), name, this.#redirectTargets(endpoint, ctx));
    declarations.push(...responses.declarations);
    const specName = Text.uniqueName(`${Text.camelCase(pascal)}Spec`, ctx.taken);
    const spec = `const ${specName}: EndpointSpec = ${this.#literals.write(this.spec(endpoint, ctx))};`;
    const optional = requestMembers.every((member) => !member.required);
    const result = responses.manual === undefined ? responses.follow : `ResponseFor<${TsEndpointWriter.CLIENT_REDIRECT_PARAMETER}, ${responses.follow}, ${responses.manual}>`;
    const docs = TsEndpointWriter.#docs(endpoint, Credentials.roles(ctx.model));
    const member = [
      ...docs.map((line) => `  ${line}`),
      `  async ${method}(request: ${requestTypes.join(' | ')}${optional ? ' = {}' : ''}): Promise<${result}> {`,
      `    return (await this.send(${specName}, request)) as ${result};`,
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

  static #interface(name: string, members: readonly RequestMember[]): string {
    return `export interface ${name} {\n${members.map((member) => `  ${member.name}${member.required ? '' : '?'}: ${member.type};`).join('\n')}\n}`;
  }

  static #bodyless(endpoint: Endpoint): boolean {
    const method = endpoint.method.toUpperCase();
    return method === 'GET' || method === 'HEAD';
  }

  static #docs(endpoint: Endpoint, roles: CookieRoles): string[] {
    const lines: string[] = [];
    const cookies = Credentials.cookies(endpoint, roles);
    if (cookies.length > 0) {
      const names = cookies.join(', ');
      lines.push(
        Credentials.optional(endpoint)
          ? `Sends the credential cookie ${names} when the client has it; the server also answered without it.`
          : `Needs the credential cookie ${names}: log in through this client first (its cookie jar keeps the cookie) or pass it in the cookies option.`,
      );
    }
    const refusals = Credentials.refusals(endpoint, roles);
    if (refusals.length > 0) lines.push(`The server answered ${refusals.join(' and ')} to a request without credentials; the credential it expects was not captured. Pass it in the headers or cookies option.`);
    if (Samples.basicAuth(endpoint)) lines.push("Needs HTTP Basic credentials: set the authorization header to 'Basic ' followed by the base64 of user:password.");
    if (endpoint.auth.bearer) {
      lines.push(
        endpoint.auth.anonymous === true
          ? 'Sends a bearer token when the client has one: accessToken in the client options or in the request.'
          : 'Needs a bearer token: accessToken in the client options or in the request, or the authorization header. Without one it throws MissingCredentialError.',
      );
    }
    const redirects = TsEndpointWriter.#typedStatuses(endpoint).filter((status) => TsEndpointWriter.REDIRECT_STATUSES.has(status));
    if (redirects.length > 0) {
      lines.push(`The server answered ${redirects.join(', ')} with a redirect. The client follows it and returns the final response; with redirect: 'manual' it returns the ${redirects.length === 1 ? 'redirect' : 'redirects'}.`);
    }
    if (lines.length === 0) return [];
    return ['/**', ...lines.map((line) => ` * ${line}`), ' */'];
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
      if (shape.jsonLines === true) body.jsonLines = true;
      const defaults = form && httpMethod !== 'GET' ? form.defaults : this.#graphqlDefaults(endpoint);
      if (defaults && Object.keys(defaults).length > 0) body.defaults = defaults;
      spec.body = body;
    }
    const variants = TsEndpointWriter.#bodyless(endpoint) ? [] : RequestBodies.variants(endpoint);
    if (variants.length > 0 && shape) spec.bodies = [shape, ...variants.map((variant) => variant.shape)].map((each) => TsEndpointWriter.#bodySpec(each));
    if (endpoint.auth.bearer) spec.bearer = endpoint.auth.anonymous === true ? 'optional' : 'required';
    const lines = endpoint.responses.filter((response) => response.body?.jsonLines === true).map((response) => response.status);
    if (lines.length > 0) spec.jsonLines = lines;
    spec.csrf = endpoint.auth.csrf.map((token) => this.#csrf(token, endpoint, ctx));
    if (form) spec.form = form.spec;
    return spec;
  }

  static #bodySpec(shape: BodyShape): Record<string, unknown> {
    const out: Record<string, unknown> = { kind: shape.kind, mimeType: shape.mimeType, contentType: RequestBodies.mediaType(shape) };
    if (shape.jsonLines === true) out.jsonLines = true;
    return out;
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
    return { name: CharsetEncoder.for(label).utf8 ? 'UTF-8' : label };
  }

  static index(label: string): [string, string] | undefined {
    const encoder = CharsetEncoder.for(label);
    const points = encoder.utf8 || !encoder.exact ? undefined : SingleByteIndexes.codePoints(encoder.name);
    if (points === undefined) return undefined;
    return [encoder.name, points.map((cp) => String.fromCharCode(cp ?? TsEndpointWriter.UNMAPPED)).join('')];
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
    if (EndpointIndex.tokenRequest(token) !== undefined) {
      const source = EndpointIndex.tokenSource(token, ctx.endpoints);
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
      if (!param.required || csrf.has(lower) || TsEndpointWriter.SKIPPED_HEADERS.has(lower) || TsEndpointWriter.CREDENTIAL_HEADERS.has(lower)) continue;
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

  #body(endpoint: Endpoint): TsBodyCode | undefined {
    const shape = endpoint.requestBody;
    if (!shape || shape.kind === 'empty' || TsEndpointWriter.#bodyless(endpoint)) return undefined;
    if (shape.jsonLines === true) {
      const schema: JsonSchema = { type: 'array', items: shape.schema ?? {} };
      return { schema, type: this.#types.type(schema), required: true };
    }
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

  #headers(endpoint: Endpoint): { body: string; required: boolean } {
    const csrf = new Set(endpoint.auth.csrf.filter((token) => token.location === 'header').map((token) => token.name.toLowerCase()));
    const defaults = this.#headerDefaults(endpoint);
    const lines: string[] = [];
    const seen = new Set<string>();
    let anyRequired = false;
    if (endpoint.auth.bearer) {
      seen.add(TsEndpointWriter.AUTHORIZATION);
      lines.push(`  ${TsEndpointWriter.AUTHORIZATION}?: string;`);
    }
    for (const param of endpoint.headerParams) {
      const lower = param.name.toLowerCase();
      if (seen.has(lower) || TsEndpointWriter.SKIPPED_HEADERS.has(lower)) continue;
      seen.add(lower);
      const required = param.required && !csrf.has(lower) && defaults[lower] === undefined;
      anyRequired = anyRequired || required;
      lines.push(`  ${Text.propertyKey(lower)}${required ? '' : '?'}: string;`);
    }
    for (const name of csrf) {
      if (seen.has(name)) continue;
      seen.add(name);
      lines.push(`  ${Text.propertyKey(name)}?: string;`);
    }
    lines.push(`  ${TsEndpointWriter.HEADER_INDEX}`);
    return { body: `{\n${lines.join('\n')}\n}`, required: anyRequired };
  }

  static #typedStatuses(endpoint: Endpoint): number[] {
    return EndpointIndex.statuses(endpoint).filter((status) => Helpers.isHttpStatus(status) && status >= TsEndpointWriter.FIRST_TYPED_STATUS);
  }

  responseTypeNames(endpoints: readonly Endpoint[], taken: Set<string>): Map<string, string> {
    return new Map(endpoints.map((endpoint) => [endpoint.id, Text.uniqueName(TsEndpointWriter.pascal(endpoint.name) + 'Response', taken)]));
  }

  static followMethod(method: string, status: number): string {
    const upper = method.toUpperCase();
    if ((status === 301 || status === 302) && upper === 'POST') return 'GET';
    if (status === 303 && upper !== 'GET' && upper !== 'HEAD') return 'GET';
    return upper;
  }

  #redirectTargets(endpoint: Endpoint, ctx: TsEndpointContext): string[] {
    const names = new Set<string>();
    for (const response of endpoint.responses) {
      if (!TsEndpointWriter.REDIRECT_STATUSES.has(response.status)) continue;
      const method = TsEndpointWriter.followMethod(endpoint.method, response.status);
      for (const target of response.redirectTo ?? []) {
        const url = Http.parseUrl(target);
        const found = url && ctx.endpoints.find((candidate) => candidate.method.toUpperCase() === method && candidate.origin === url.origin && EndpointIndex.matchPath(candidate.path, url.pathname) !== undefined);
        if (!found || found === endpoint || found.responses.some((each) => TsEndpointWriter.REDIRECT_STATUSES.has(each.status))) return [];
        const name = ctx.responseTypes?.get(found.id);
        if (name === undefined) return [];
        names.add(name);
      }
    }
    return [...names];
  }

  #responses(endpoint: Endpoint, typeName: string, name: (suffix: string) => string, targets: readonly string[] = []): TsResponseCode {
    const declarations: string[] = [];
    const head = endpoint.method.toUpperCase() === 'HEAD';
    const members = new Map<number, string>();
    for (const status of TsEndpointWriter.#typedStatuses(endpoint)) {
      const response = endpoint.responses.find((candidate) => candidate.status === status);
      if (!response) continue;
      const data = head ? 'undefined' : this.#dataType(response, () => name(`Response${status}`), declarations);
      members.set(status, `ApiResponse<${status}, ${data}>`);
    }
    const union = (statuses: readonly number[]): string => {
      const typed = statuses.map((status) => members.get(status) ?? '');
      typed.push(statuses.length > 0 ? `ApiResponse<Exclude<HttpStatus, ${statuses.join(' | ')}>, unknown>` : 'ApiResponse<HttpStatus, unknown>');
      return typed.map((member) => `  | ${member}`).join('\n');
    };
    const all = [...members.keys()];
    const final = all.filter((status) => !TsEndpointWriter.REDIRECT_STATUSES.has(status));
    if (final.length === all.length) {
      declarations.push(`export type ${typeName} =\n${union(all)};`);
      return { declarations, follow: typeName };
    }
    const manual = name('ManualResponse');
    const follow = targets.length > 0 && endpoint.responses.every((response) => response.redirectTo !== undefined || !TsEndpointWriter.REDIRECT_STATUSES.has(response.status))
      ? [...final.map((status) => `  | ${members.get(status) ?? ''}`), ...targets.map((target) => `  | ${target}`)].join('\n')
      : union(final);
    declarations.push(`export type ${typeName} =\n${follow};`, `export type ${manual} =\n${union(all)};`);
    return { declarations, follow: typeName, manual };
  }

  #dataType(response: EndpointResponse, name: () => string, declarations: string[]): string {
    const body = response.body;
    if (!body) return TsEndpointWriter.NO_CONTENT_STATUSES.has(response.status) ? 'undefined' : 'unknown';
    if (body.jsonLines === true) {
      const declared = name();
      declarations.push(this.#types.declaration(declared, { type: 'array', items: body.schema ?? {} }));
      return declared;
    }
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
