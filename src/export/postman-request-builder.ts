import type { ApiModel, BodyShape, Endpoint, EndpointResponse } from '../model/index.js';
import { CharsetEncoder, Credentials, EndpointIndex, Http, Json, SampleText, Samples, Schema, Text } from '../shared/index.js';
import type { SampleRenderer } from '../shared/index.js';
import type { ExportOptions } from './exporter.js';
import { Helpers } from './helpers.js';

export type PostmanObject = Record<string, unknown>;

export interface PostmanItemContext {
  model: ApiModel;
  index: EndpointIndex;
  options: ExportOptions;
  variable: string;
}

export class PostmanRequestBuilder {
  static readonly LANGUAGES: Readonly<Record<string, string>> = { json: 'json', graphql: 'json', html: 'html', text: 'text' };
  static readonly PREVIEW: Readonly<Record<string, string>> = { json: 'json', graphql: 'json', html: 'html', text: 'text' };
  static readonly JSON_INDENT = 2;
  static readonly VARIABLE_OPEN = '{{';
  static readonly DISABLED_NOTE = 'Disabled because Postman reads "{{" as the start of a variable.';
  static readonly RENDERER: SampleRenderer = Object.freeze({
    literal: (text: string): string => text,
    placeholder: (name: string): string => `{{${name}}}`,
  });

  items(endpoint: Endpoint, ctx: PostmanItemContext): PostmanObject[] {
    return [this.item(endpoint, ctx), ...Helpers.bodyVariants(endpoint).map((variant) => this.item(variant.endpoint, ctx, ` (${variant.mediaType})`))];
  }

  item(endpoint: Endpoint, ctx: PostmanItemContext, suffix = ''): PostmanObject {
    const sample = Samples.requestSample(endpoint, { cookie: false });
    const request = this.request(endpoint, sample, ctx);
    const responses = endpoint.responses
      .filter((response) => Helpers.isHttpStatus(response.status))
      .map((response) => this.response(response, request));
    return { name: Helpers.summary(endpoint) + suffix, request, response: responses };
  }

  request(endpoint: Endpoint, sample: Samples.RequestSample, ctx: PostmanItemContext): PostmanObject {
    const request: PostmanObject = {
      method: endpoint.method,
      header: sample.headers.map((header) => PostmanRequestBuilder.entry(header.name, header.value, { type: 'text' })),
      url: this.url(endpoint, sample, ctx.variable),
      description: this.description(endpoint, ctx),
    };
    const body = this.body(sample);
    if (body) request.body = body;
    if (sample.user) {
      request.auth = {
        type: 'basic',
        basic: [
          { key: 'username', value: `{{${Samples.BASIC_USER}}}`, type: 'string' },
          { key: 'password', value: `{{${Samples.BASIC_PASSWORD}}}`, type: 'string' },
        ],
      };
    }
    return request;
  }

  url(endpoint: Endpoint, sample: Samples.RequestSample, variable: string): PostmanObject {
    const host = `{{${variable}}}`;
    const values = new Map(sample.pathParams.map((param) => [param.name, PostmanRequestBuilder.urlText(param.value)]));
    const variables: PostmanObject[] = [];
    const path = endpoint.path
      .slice(1)
      .split('/')
      .map((part) => {
        const whole = /^\{([^{}]+)\}$/.exec(part);
        if (!whole) return part.replace(/\{([^{}]+)\}/g, (_match: string, name: string) => values.get(name) ?? '');
        const name = whole[1] ?? '';
        const param = endpoint.pathParams.find((p) => p.name === name);
        const entry: PostmanObject = { key: name, value: values.get(name) ?? '' };
        if (param) entry.description = Schema.typeLabel(param.schema);
        variables.push(entry);
        return `:${name}`;
      });
    const sent = new Map(sample.query.map((entry) => [entry.name, PostmanRequestBuilder.urlText(entry.value)]));
    const query: PostmanObject[] = [];
    const listed = new Set<string>();
    for (const param of endpoint.queryParams) {
      if (listed.has(param.name)) continue;
      listed.add(param.name);
      const value = sent.get(param.name);
      const example = param.examples.find((candidate) => !Samples.isRedacted(candidate));
      const entry: PostmanObject = {
        key: encodeURIComponent(param.name),
        value: value ?? (example === undefined ? '' : encodeURIComponent(example)),
        description: Schema.typeLabel(param.schema),
      };
      if (!param.required || value === undefined) entry.disabled = true;
      query.push(entry);
    }
    for (const [name, value] of sent) if (!listed.has(name)) query.push({ key: encodeURIComponent(name), value });
    const enabled = query.filter((entry) => entry.disabled !== true);
    const raw =
      host +
      (path.length === 1 && path[0] === '' ? '/' : '/' + path.join('/')) +
      (enabled.length > 0 ? '?' + enabled.map((entry) => `${String(entry.key)}=${String(entry.value)}`).join('&') : '');
    const url: PostmanObject = { raw, host: [host], path };
    if (query.length > 0) url.query = query;
    if (variables.length > 0) url.variable = variables;
    return url;
  }

  body(sample: Samples.RequestSample): PostmanObject | undefined {
    const body = sample.body;
    if (!body || body.value === undefined) return undefined;
    if ((body.kind === 'form' || body.kind === 'multipart') && Samples.isRecord(body.value)) {
      const entries = Samples.formEntries(body.value);
      if (body.kind === 'form') return { mode: 'urlencoded', urlencoded: entries.map((entry) => PostmanRequestBuilder.entry(entry.name, entry.value, { type: 'text' })) };
      return {
        mode: 'formdata',
        formdata: entries.map((entry) =>
          entry.file ? { key: entry.name, type: 'file', src: entry.value.toString() } : PostmanRequestBuilder.entry(entry.name, entry.value, { type: 'text' }),
        ),
      };
    }
    if (body.kind === 'binary') return { mode: 'file', file: {} };
    const json = !(body.value instanceof SampleText);
    const text = json ? Samples.jsonText(body.value, { indent: PostmanRequestBuilder.JSON_INDENT, escape: PostmanRequestBuilder.jsonEscape }) : SampleText.of(body.value as SampleText);
    const out: PostmanObject = { mode: 'raw', raw: PostmanRequestBuilder.text(text), options: { raw: { language: PostmanRequestBuilder.LANGUAGES[body.kind] ?? 'text' } } };
    if (PostmanRequestBuilder.resolvable(text)) out.disabled = true;
    return out;
  }

  static text(value: SampleText): string {
    return value.render(PostmanRequestBuilder.RENDERER);
  }

  static urlText(value: SampleText): string {
    return PostmanRequestBuilder.text(value.mapLiterals(encodeURIComponent));
  }

  static resolvable(value: SampleText | string): boolean {
    return SampleText.of(value).parts.some((part) => part.kind === 'literal' && part.text.includes(PostmanRequestBuilder.VARIABLE_OPEN));
  }

  static jsonEscape(content: string): string {
    return Text.toAscii(content, 'escape').replace(/[{}]/g, (brace) => (brace === '{' ? '\\u007b' : '\\u007d'));
  }

  static entry(key: string, value: SampleText, extra: PostmanObject = {}): PostmanObject {
    if (!PostmanRequestBuilder.resolvable(key) && !PostmanRequestBuilder.resolvable(value)) return { key, value: PostmanRequestBuilder.text(value), ...extra };
    return {
      key,
      value: '',
      ...extra,
      disabled: true,
      description: `${PostmanRequestBuilder.DISABLED_NOTE} Captured value: ${value.toString()}`,
    };
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
    else lines.push(`Observed ${endpoint.count} time${endpoint.count === 1 ? '' : 's'}; statuses ${EndpointIndex.statuses(endpoint).join(', ') || 'none'}.`);
    if (endpoint.form) lines.push(`Form \`${endpoint.form.selector}\` on ${Helpers.mapUrl(ctx.model, endpoint.form.pageUrl, ctx.options)}.`);
    if (endpoint.form && !CharsetEncoder.for(endpoint.form.charset).utf8) {
      lines.push(`The website encodes this form in ${endpoint.form.charset}. Postman uses UTF-8, so the bytes of non-ASCII values are different.`);
    }
    for (const token of endpoint.auth.csrf) {
      const source = Helpers.tokenSource(token, { text: (value) => value, code: (value) => `\`${value}\``, url: (value) => Helpers.mapUrl(ctx.model, value, ctx.options) });
      lines.push(`CSRF token \`${token.name}\` (${token.location}) from ${source}.`);
    }
    const credentials = Credentials.describe(endpoint, Credentials.roles(ctx.model));
    if (credentials !== '') lines.push(`Credentials: ${credentials}.`);
    if (endpoint.auth.cookies.length > 0) lines.push(`Cookies sent: ${endpoint.auth.cookies.map((name) => `\`${name}\``).join(', ')}.`);
    return lines.join('\n\n');
  }

  static #responseBody(shape: BodyShape | undefined): string {
    if (!shape || shape.kind === 'empty') return '';
    if (shape.jsonLines === true) return Helpers.jsonLines(shape.examples);
    const example = shape.examples[0];
    if (example !== undefined) return typeof example === 'string' ? example : Json.asciiJson(example);
    if (shape.kind === 'json' || shape.kind === 'graphql') {
      const value = Samples.plainValue(Samples.bodySample(shape));
      return value === undefined || value === null ? '' : Json.asciiJson(value);
    }
    return '';
  }
}
