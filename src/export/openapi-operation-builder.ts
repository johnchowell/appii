import type { ApiModel, BodyKind, BodyShape, Endpoint, EndpointResponse, JsonSchema } from '../model/index.js';
import { EndpointIndex, Http, Json, Schema, Text } from '../shared/index.js';
import { Helpers } from './helpers.js';
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
  static readonly DEFAULT_MEDIA: Readonly<Record<BodyKind, string>> = {
    json: 'application/json',
    form: 'application/x-www-form-urlencoded',
    multipart: 'multipart/form-data',
    graphql: 'application/json',
    html: 'text/html',
    text: 'text/plain',
    binary: 'application/octet-stream',
    empty: 'application/octet-stream',
  };
  static readonly STRING_KINDS: ReadonlySet<BodyKind> = new Set<BodyKind>(['html', 'text']);
  static readonly EXAMPLE_KINDS: ReadonlySet<BodyKind> = new Set<BodyKind>(['json', 'graphql', 'form', 'multipart']);
  static readonly MEDIA_RANGE: RegExp = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+\/[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
  static readonly SET_COOKIE_PREFIX = 'set-cookie: ';
  static readonly COMPLEX_TYPES: ReadonlySet<string> = new Set(['object', 'array']);

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
      const source = token.sourceName ? `${token.source} \`${token.sourceName}\`` : token.source;
      lines.push(`CSRF token \`${token.name}\` (${token.location}) comes from ${source}${token.sourceUrl ? ` on ${token.sourceUrl}` : ''}.`);
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
    const shape = endpoint.requestBody;
    if (!shape || shape.kind === 'empty') return undefined;
    const media: OpenApiObject = {};
    const form = shape.kind === 'form' || shape.kind === 'multipart';
    let schema = shape.schema ? this.#schemas.request(shape.schema, form) : OpenApiOperationBuilder.#fallback(shape.kind);
    if (schema && endpoint.kind === 'graphql') schema = this.#schemas.graphql(schema, endpoint.operationName);
    if (schema) media.schema = this.#maybeRef(`${endpoint.name} request`, schema, ctx);
    const examples = this.#examples(shape, endpoint.kind === 'graphql' ? endpoint.operationName : undefined);
    if (examples) media.examples = examples;
    if (form && shape.schema) {
      const encoding = this.encoding(shape.schema, shape.kind === 'multipart');
      if (Object.keys(encoding).length > 0) media.encoding = encoding;
    }
    return { required: true, content: { [OpenApiOperationBuilder.mediaType(shape)]: media } };
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

  static mediaType(shape: BodyShape): string {
    const essence = Http.mimeEssence(shape.mimeType);
    return OpenApiOperationBuilder.MEDIA_RANGE.test(essence) ? essence : OpenApiOperationBuilder.DEFAULT_MEDIA[shape.kind];
  }

  static fileContentType(schema: JsonSchema): string | undefined {
    const accept = schema['x-html-accept'];
    if (typeof accept === 'string') {
      const types = accept
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter((token) => OpenApiOperationBuilder.MEDIA_RANGE.test(token));
      if (types.length > 0) return [...new Set(types)].join(', ');
    }
    return typeof schema.contentMediaType === 'string' ? schema.contentMediaType : undefined;
  }

  #response(endpoint: Endpoint, response: EndpointResponse, ctx: OperationContext): OpenApiObject {
    const out: OpenApiObject = { description: Http.reasonPhrase(response.status) };
    const headers = OpenApiOperationBuilder.#headers(response.headers);
    if (Object.keys(headers).length > 0) out.headers = headers;
    const body = response.body;
    if (body && body.kind !== 'empty') {
      const media: OpenApiObject = {};
      const schema = body.schema ? this.#schemas.response(body.schema) : OpenApiOperationBuilder.#fallback(body.kind);
      if (schema) media.schema = this.#maybeRef(`${endpoint.name} response ${response.status}`, schema, ctx);
      const examples = this.#examples(body, undefined);
      if (examples) media.examples = examples;
      out.content = { [OpenApiOperationBuilder.mediaType(body)]: media };
    }
    return out;
  }

  #examples(shape: BodyShape, name: string | undefined): OpenApiObject | undefined {
    if (!OpenApiOperationBuilder.EXAMPLE_KINDS.has(shape.kind) || shape.examples.length === 0) return undefined;
    const out: OpenApiObject = {};
    shape.examples.forEach((value, i) => {
      const key = name !== undefined && shape.examples.length === 1 ? name : `${name ?? 'example'}${i + 1}`;
      Json.setOwn(out, key, { value: Json.clone(value) });
    });
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
