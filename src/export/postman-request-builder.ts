import type { ApiModel, BodyShape, Endpoint, EndpointResponse } from '../model/index.js';
import { EndpointIndex, Http, Json, Samples, Schema } from '../shared/index.js';
import type { ExportOptions } from './exporter.js';
import { Helpers } from './helpers.js';

export type PostmanObject = Record<string, unknown>;

export interface PostmanItemContext {
  model: ApiModel;
  index: EndpointIndex;
  options: ExportOptions;
  variable: string;
}

interface QueryPair {
  key: string;
  value: string;
}

export class PostmanRequestBuilder {
  static readonly LANGUAGES: Readonly<Record<string, string>> = { json: 'json', graphql: 'json', html: 'html', text: 'text' };
  static readonly PREVIEW: Readonly<Record<string, string>> = { json: 'json', graphql: 'json', html: 'html', text: 'text' };

  item(endpoint: Endpoint, ctx: PostmanItemContext): PostmanObject {
    const sample = Samples.requestSample(endpoint, { baseUrl: `{{${ctx.variable}}}` });
    const request = this.request(endpoint, sample, ctx);
    const responses = endpoint.responses
      .filter((response) => Helpers.isHttpStatus(response.status))
      .map((response) => this.response(response, request));
    return { name: Helpers.summary(endpoint), request, response: responses };
  }

  request(endpoint: Endpoint, sample: Samples.RequestSample, ctx: PostmanItemContext): PostmanObject {
    const request: PostmanObject = {
      method: endpoint.method,
      header: sample.headers.map((header) => ({ key: header.name, value: header.value, type: 'text' })),
      url: this.url(endpoint, sample, ctx.variable),
      description: this.description(endpoint, ctx),
    };
    const body = this.body(sample);
    if (body) request.body = body;
    return request;
  }

  url(endpoint: Endpoint, sample: Samples.RequestSample, variable: string): PostmanObject {
    const host = `{{${variable}}}`;
    const rest = sample.url.startsWith(host) ? sample.url.slice(host.length) : sample.url;
    const queryStart = rest.indexOf('?');
    const samplePath = queryStart < 0 ? rest : rest.slice(0, queryStart);
    const pairs = queryStart < 0 ? [] : PostmanRequestBuilder.#pairs(rest.slice(queryStart + 1));
    const templateParts = endpoint.path.slice(1).split('/');
    const sampleParts = samplePath.slice(1).split('/');
    const variables: PostmanObject[] = [];
    const path = templateParts.map((part, i) => {
      const match = /^\{([^}]+)\}$/.exec(part);
      if (!match) return part;
      const name = match[1] ?? '';
      const param = endpoint.pathParams.find((p) => p.name === name);
      const raw = sampleParts[i] ?? '';
      const entry: PostmanObject = { key: name, value: Samples.hasPlaceholder(raw) ? raw : Helpers.decode(raw) };
      if (param) entry.description = Schema.typeLabel(param.schema);
      variables.push(entry);
      return `:${name}`;
    });
    const query: PostmanObject[] = [];
    const used = new Set<string>();
    for (const param of endpoint.queryParams) {
      const found = pairs.find((pair) => pair.key === param.name);
      used.add(param.name);
      const entry: PostmanObject = { key: param.name, value: found?.value ?? '', description: Schema.typeLabel(param.schema) };
      if (!param.required) entry.disabled = true;
      query.push(entry);
    }
    for (const pair of pairs) if (!used.has(pair.key)) query.push({ key: pair.key, value: pair.value });
    const enabled = query.filter((entry) => entry.disabled !== true);
    const raw =
      host +
      (path.length === 1 && path[0] === '' ? '/' : '/' + path.join('/')) +
      (enabled.length > 0 ? '?' + enabled.map((entry) => `${PostmanRequestBuilder.#encode(String(entry.key))}=${PostmanRequestBuilder.#encode(String(entry.value))}`).join('&') : '');
    const url: PostmanObject = { raw, host: [host], path };
    if (query.length > 0) url.query = query;
    if (variables.length > 0) url.variable = variables;
    return url;
  }

  body(sample: Samples.RequestSample): PostmanObject | undefined {
    const body = sample.body;
    if (!body || body.value === undefined) return undefined;
    switch (body.kind) {
      case 'form':
        return { mode: 'urlencoded', urlencoded: PostmanRequestBuilder.#entries(body.value).map(([key, value]) => ({ key, value: PostmanRequestBuilder.#text(value), type: 'text' })) };
      case 'multipart':
        return {
          mode: 'formdata',
          formdata: PostmanRequestBuilder.#entries(body.value).map(([key, value]) =>
            Json.isPlainObject(value) && typeof value.filename === 'string'
              ? { key, type: 'file', src: value.filename }
              : { key, value: PostmanRequestBuilder.#text(value), type: 'text' },
          ),
        };
      case 'binary':
        return { mode: 'file', file: {} };
      default: {
        const raw = typeof body.value === 'string' ? body.value : Helpers.json(body.value);
        return { mode: 'raw', raw, options: { raw: { language: PostmanRequestBuilder.LANGUAGES[body.kind] ?? 'text' } } };
      }
    }
  }

  response(response: EndpointResponse, request: PostmanObject): PostmanObject {
    const shape = response.body;
    const header = shape && shape.mimeType !== '' ? [{ key: 'Content-Type', value: shape.mimeType }] : [];
    const originalRequest = Json.clone(request);
    delete originalRequest.description;
    return {
      name: `${response.status} ${Http.reasonPhrase(response.status)}`,
      originalRequest,
      status: Http.reasonPhrase(response.status),
      code: response.status,
      _postman_previewlanguage: shape ? (PostmanRequestBuilder.PREVIEW[shape.kind] ?? 'text') : 'text',
      header,
      cookie: [],
      body: PostmanRequestBuilder.#responseBody(shape),
    };
  }

  description(endpoint: Endpoint, ctx: PostmanItemContext): string {
    const lines = [`**${endpoint.method} ${endpoint.path}** - endpoint ${ctx.index.numberOf(endpoint)}, \`${endpoint.name}\` (${endpoint.kind}).`];
    if (endpoint.count === 0) lines.push('Inferred from an HTML form; no request was captured.');
    else lines.push(`Observed ${endpoint.count} time${endpoint.count === 1 ? '' : 's'}; statuses ${Helpers.statuses(endpoint).join(', ') || 'none'}.`);
    if (endpoint.form) lines.push(`Form \`${endpoint.form.selector}\` on ${Helpers.mapUrl(ctx.model, endpoint.form.pageUrl, ctx.options)}.`);
    for (const token of endpoint.auth.csrf) {
      const source = token.sourceName ? `${token.source} \`${token.sourceName}\`` : token.source;
      lines.push(`CSRF token \`${token.name}\` (${token.location}) from ${source}${token.sourceUrl ? ` on ${Helpers.mapUrl(ctx.model, token.sourceUrl, ctx.options)}` : ''}.`);
    }
    if (endpoint.auth.cookies.length > 0) lines.push(`Cookies: ${endpoint.auth.cookies.map((name) => `\`${name}\``).join(', ')}.`);
    return lines.join('\n\n');
  }

  static #responseBody(shape: BodyShape | undefined): string {
    if (!shape || shape.kind === 'empty') return '';
    const example = shape.examples[0];
    if (example !== undefined) return typeof example === 'string' ? example : Helpers.json(example);
    if (shape.kind === 'json' || shape.kind === 'graphql') {
      const value = Samples.bodySample(shape);
      return value === undefined || value === null ? '' : Helpers.json(value);
    }
    return '';
  }

  static #entries(value: unknown): [string, unknown][] {
    if (!Json.isPlainObject(value)) return [];
    const out: [string, unknown][] = [];
    for (const [key, item] of Object.entries(value)) {
      if (item === undefined) continue;
      for (const each of Array.isArray(item) ? item : [item]) out.push([key, each]);
    }
    return out;
  }

  static #text(value: unknown): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  }

  static #pairs(query: string): QueryPair[] {
    return query
      .split('&')
      .filter((part) => part !== '')
      .map((part) => {
        const eq = part.indexOf('=');
        const key = eq < 0 ? part : part.slice(0, eq);
        const value = eq < 0 ? '' : part.slice(eq + 1);
        return { key: PostmanRequestBuilder.#decodeQuery(key), value: PostmanRequestBuilder.#decodeQuery(value) };
      });
  }

  static #decodeQuery(text: string): string {
    return Samples.hasPlaceholder(text) ? text : Helpers.decode(text.replace(/\+/g, ' '));
  }

  static #encode(text: string): string {
    return Samples.hasPlaceholder(text) ? text : encodeURIComponent(text);
  }
}
