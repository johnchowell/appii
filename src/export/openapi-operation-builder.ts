import { BodyParser } from '../build/index.js';
import type { ApiModel, BodyKind, BodyShape, Endpoint, EndpointResponse, JsonSchema } from '../model/index.js';
import { EndpointIndex, Http, Json, Schema, Text } from '../shared/index.js';
import { Helpers } from './helpers.js';
import type { TokenSourceMarkup } from './helpers.js';
import { OpenApiComponents } from './openapi-components.js';
import { OpenApiSchemaAdapter } from './openapi-schema-adapter.js';
import type { OpenApiSecurity } from './openapi-security.js';

export interface OperationContext {
  model: ApiModel;
  index: EndpointIndex;
  key: string;
  operationId: string;
  renames: ReadonlyMap<string, string>;
  components: OpenApiComponents;
  security: OpenApiSecurity;
}

export interface OpenApiOperationBuilderDeps {
  schemas?: OpenApiSchemaAdapter;
}

export type OpenApiObject = Record<string, unknown>;

export class OpenApiOperationBuilder {
  static readonly IGNORED_HEADERS: ReadonlySet<string> = new Set(['accept', 'content-type', 'authorization']);
  static readonly STRING_KINDS: ReadonlySet<BodyKind> = new Set<BodyKind>(['html', 'text']);
  static readonly EXAMPLE_KINDS: ReadonlySet<BodyKind> = new Set<BodyKind>(['json', 'graphql', 'form', 'multipart']);
  static readonly SET_COOKIE_PREFIX = 'set-cookie: ';
  static readonly MARKUP: TokenSourceMarkup = Object.freeze({ text: (value: string) => value, code: (value: string) => `\`${value}\``, url: (value: string) => value });
  static readonly COMPLEX_TYPES: ReadonlySet<string> = new Set(['object', 'array']);
  static readonly JSON_LINES_KEY = 'x-appii-json-lines';
  static readonly JSON_LINES_NOTE = 'The body is JSON lines: one JSON value per line. The schema describes the list of these values.';
  static readonly FILE_EXAMPLE_NOTE = 'A file part shows the name of the file that was sent; its media type is in the encoding of the part.';

  readonly #schemas: OpenApiSchemaAdapter;

  static create(): OpenApiOperationBuilder {
    return new OpenApiOperationBuilder({ schemas: new OpenApiSchemaAdapter() });
  }

  constructor(deps: OpenApiOperationBuilderDeps = {}) {
    this.#schemas = deps.schemas ?? new OpenApiSchemaAdapter();
  }

  build(endpoint: Endpoint, ctx: OperationContext): OpenApiObject {
    const operation: OpenApiObject = {
      operationId: ctx.operationId,
      summary: Helpers.summary(endpoint),
      description: this.description(endpoint),
      tags: [Helpers.group(endpoint)],
    };
    const parameters = this.parameters(endpoint, ctx);
    if (parameters.length > 0) operation.parameters = parameters;
    const body = this.requestBody(endpoint, ctx);
    if (body) operation.requestBody = body;
    operation.responses = this.responses(endpoint, ctx);
    operation.security = ctx.security.requirements(endpoint);
    if (endpoint.auth.csrf.length > 0) operation['x-appii-csrf'] = Json.clone(endpoint.auth.csrf);
    if (endpoint.form) operation['x-appii-form'] = { pageUrl: endpoint.form.pageUrl, selector: endpoint.form.selector, enctype: endpoint.form.enctype };
    if (endpoint.kind === 'graphql' && endpoint.operationName !== undefined) operation['x-appii-graphql-operations'] = [endpoint.operationName];
    operation['x-appii-endpoint'] = { id: endpoint.id, number: ctx.index.numberOf(endpoint), kind: endpoint.kind, count: endpoint.count, firstParty: endpoint.firstParty };
    return operation;
  }

  description(endpoint: Endpoint): string {
    const lines: string[] = [];
    lines.push(
      endpoint.count > 0
        ? `Observed ${Text.plural(endpoint.count, 'time')} in the captured traffic (${endpoint.kind}).`
        : `Not observed in the captured traffic; inferred from an HTML form (${endpoint.kind}).`,
    );
    if (endpoint.form) lines.push(`Submitted by the form \`${endpoint.form.selector}\` on ${endpoint.form.pageUrl} (${endpoint.form.enctype}).`);
    for (const token of endpoint.auth.csrf) {
      lines.push(`CSRF token \`${token.name}\` (${token.location}) comes from ${Helpers.tokenSource(token, OpenApiOperationBuilder.MARKUP)}.`);
    }
    if (endpoint.auth.cookies.length > 0) lines.push(`Cookies sent: ${endpoint.auth.cookies.map((name) => `\`${name}\``).join(', ')}.`);
    return lines.join('\n\n');
  }

  parameters(endpoint: Endpoint, ctx: OperationContext): OpenApiObject[] {
    const out: OpenApiObject[] = [];
    const seen = new Set<string>();
    const add = (parameter: OpenApiObject): void => {
      const key = `${String(parameter.in)}:${String(parameter.in === 'header' ? String(parameter.name).toLowerCase() : parameter.name)}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(parameter);
    };
    const pathNames = Helpers.pathParams(ctx.key);
    for (const param of endpoint.pathParams) {
      const name = ctx.renames.get(param.name) ?? param.name;
      if (!pathNames.includes(name)) continue;
      add({ name, in: 'path', required: true, schema: this.#schemas.param(param) });
    }
    for (const name of pathNames) add({ name, in: 'path', required: true, schema: { type: 'string' } });
    for (const param of endpoint.queryParams) add({ name: param.name, in: 'query', required: param.required, schema: this.#schemas.param(param) });
    for (const token of endpoint.auth.csrf) {
      if (token.location !== 'query') continue;
      add({ name: token.name, in: 'query', required: true, description: 'CSRF token.', schema: { type: 'string' } });
    }
    const covered = ctx.security.coveredHeaders(endpoint);
    for (const param of endpoint.headerParams) {
      const lower = param.name.toLowerCase();
      if (OpenApiOperationBuilder.IGNORED_HEADERS.has(lower) || covered.has(lower)) continue;
      add({ name: param.name, in: 'header', required: param.required, schema: this.#schemas.param(param) });
    }
    return out;
  }

  requestBody(endpoint: Endpoint, ctx: OperationContext): OpenApiObject | undefined {
    const shapes = Helpers.requestBodies(endpoint);
    if (shapes.length === 0) return undefined;
    const content: OpenApiObject = {};
    shapes.forEach((shape, i) => Json.setOwn(content, Helpers.mediaType(shape), this.#requestMedia(endpoint, shape, i === 0 ? 'request' : `request ${shape.kind}`, ctx)));
    const out: OpenApiObject = { required: true, content };
    if (shapes.some((shape) => shape.jsonLines === true)) out.description = OpenApiOperationBuilder.JSON_LINES_NOTE;
    return out;
  }

  #requestMedia(endpoint: Endpoint, shape: BodyShape, label: string, ctx: OperationContext): OpenApiObject {
    const media: OpenApiObject = {};
    const form = shape.kind === 'form' || shape.kind === 'multipart';
    let schema = shape.schema ? this.#schemas.request(shape.schema, form) : OpenApiOperationBuilder.#fallback(shape.kind);
    if (schema && endpoint.kind === 'graphql') schema = this.#schemas.graphql(schema, endpoint.operationName);
    if (schema) media.schema = OpenApiOperationBuilder.#lines(shape, this.#maybeRef(`${endpoint.name} ${label}`, schema, ctx));
    const examples = this.#examples(shape, endpoint.kind === 'graphql' ? endpoint.operationName : undefined);
    if (examples) media.examples = examples;
    if (form && shape.schema) {
      const encoding = this.encoding(shape.schema, shape.kind === 'multipart');
      if (Object.keys(encoding).length > 0) media.encoding = encoding;
    }
    if (shape.jsonLines === true) media[OpenApiOperationBuilder.JSON_LINES_KEY] = true;
    return media;
  }

  static #lines(shape: BodyShape, schema: JsonSchema): JsonSchema {
    return shape.jsonLines === true ? { type: 'array', items: schema } : schema;
  }

  encoding(schema: JsonSchema, multipart: boolean): OpenApiObject {
    const out: OpenApiObject = {};
    for (const [name, property] of Object.entries(Schema.properties(schema))) {
      const array = Schema.primaryType(property) === 'array';
      const element = array ? (Schema.items(property) ?? {}) : property;
      if (multipart && Schema.isFileSchema(element)) {
        Json.setOwn(out, name, { contentType: OpenApiOperationBuilder.fileContentType(element) ?? OpenApiOperationBuilder.fileContentType(property) ?? 'application/octet-stream' });
      } else if (array) {
        Json.setOwn(out, name, multipart ? { contentType: 'text/plain' } : { style: 'form', explode: true });
      }
    }
    return out;
  }

  responses(endpoint: Endpoint, ctx: OperationContext): OpenApiObject {
    const out: OpenApiObject = {};
    for (const response of endpoint.responses) {
      if (!Helpers.isHttpStatus(response.status)) continue;
      const key = String(response.status);
      if (Object.hasOwn(out, key)) continue;
      out[key] = this.#response(endpoint, response, ctx);
    }
    if (Object.keys(out).length === 0) out.default = { description: 'No response was captured for this endpoint.' };
    return out;
  }

  static fileContentType(schema: JsonSchema): string | undefined {
    const accept = schema['x-html-accept'];
    if (typeof accept === 'string') {
      const types = accept
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter((token) => Helpers.MEDIA_RANGE.test(token));
      if (types.length > 0) return [...new Set(types)].join(', ');
    }
    return typeof schema.contentMediaType === 'string' ? schema.contentMediaType : undefined;
  }

  #response(endpoint: Endpoint, response: EndpointResponse, ctx: OperationContext): OpenApiObject {
    const body = response.body;
    const reason = Http.reasonPhrase(response.status);
    const out: OpenApiObject = { description: body?.jsonLines === true ? `${reason}. ${OpenApiOperationBuilder.JSON_LINES_NOTE}` : reason };
    const headers = OpenApiOperationBuilder.#headers(response.headers);
    if (Object.keys(headers).length > 0) out.headers = headers;
    if (body && body.kind !== 'empty') {
      const media: OpenApiObject = {};
      const schema = body.schema ? this.#schemas.response(body.schema) : OpenApiOperationBuilder.#fallback(body.kind);
      if (schema) media.schema = OpenApiOperationBuilder.#lines(body, this.#maybeRef(`${endpoint.name} response ${response.status}`, schema, ctx));
      const examples = this.#examples(body, undefined);
      if (examples) media.examples = examples;
      if (body.jsonLines === true) media[OpenApiOperationBuilder.JSON_LINES_KEY] = true;
      out.content = { [Helpers.mediaType(body)]: media };
    }
    return out;
  }

  #examples(shape: BodyShape, name: string | undefined): OpenApiObject | undefined {
    if (!OpenApiOperationBuilder.EXAMPLE_KINDS.has(shape.kind) || shape.examples.length === 0) return undefined;
    const out: OpenApiObject = {};
    if (shape.jsonLines === true) {
      Json.setOwn(out, name ?? 'example1', { value: Json.clone(shape.examples) });
      return out;
    }
    shape.examples.forEach((value, i) => {
      const key = name !== undefined && shape.examples.length === 1 ? name : `${name ?? 'example'}${i + 1}`;
      const files = shape.kind === 'multipart' && OpenApiOperationBuilder.#hasFiles(value);
      const example: OpenApiObject = { value: files ? OpenApiOperationBuilder.#fileNames(value) : Json.clone(value) };
      if (files) example.description = OpenApiOperationBuilder.FILE_EXAMPLE_NOTE;
      Json.setOwn(out, key, example);
    });
    return out;
  }

  static #hasFiles(value: unknown): boolean {
    return Json.isPlainObject(value) && Object.values(value).some((item) => (Array.isArray(item) ? item : [item]).some((each) => BodyParser.isUploadedFile(each)));
  }

  static #fileNames(value: unknown): unknown {
    if (!Json.isPlainObject(value)) return Json.clone(value);
    const name = (item: unknown): unknown => (BodyParser.isUploadedFile(item) ? item.filename : Json.clone(item));
    const out: OpenApiObject = {};
    for (const [key, item] of Object.entries(value)) Json.setOwn(out, key, Array.isArray(item) ? item.map(name) : name(item));
    return out;
  }

  #maybeRef(base: string, schema: JsonSchema, ctx: OperationContext): JsonSchema {
    const type = Schema.primaryType(schema);
    const complex = type !== undefined && OpenApiOperationBuilder.COMPLEX_TYPES.has(type) && Object.keys(schema).length > 1;
    return complex ? ctx.components.schema(base, schema) : schema;
  }

  static #headers(names: readonly string[]): OpenApiObject {
    const out: OpenApiObject = {};
    const cookies: string[] = [];
    for (const raw of names) {
      const name = raw.toLowerCase();
      if (name.startsWith(OpenApiOperationBuilder.SET_COOKIE_PREFIX)) {
        cookies.push(raw.slice(OpenApiOperationBuilder.SET_COOKIE_PREFIX.length));
        continue;
      }
      if (name === 'content-type' || name === 'set-cookie') continue;
      if (name === 'location') out.Location = { description: 'Redirect target.', schema: { type: 'string', format: 'uri-reference' } };
      else Json.setOwn(out, raw, { schema: { type: 'string' } });
    }
    if (cookies.length > 0 || names.some((name) => name.toLowerCase() === 'set-cookie')) {
      out['Set-Cookie'] = { description: cookies.length > 0 ? `Sets the cookies ${cookies.join(', ')}.` : 'Sets cookies.', schema: { type: 'string' } };
    }
    return out;
  }

  static #fallback(kind: BodyKind): JsonSchema | undefined {
    if (OpenApiOperationBuilder.STRING_KINDS.has(kind)) return { type: 'string' };
    if (kind === 'json' || kind === 'graphql') return {};
    if (kind === 'form' || kind === 'multipart') return { type: 'object' };
    return undefined;
  }
}
