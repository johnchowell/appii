import type { Endpoint } from '../model/index.js';
import { Ansi, EndpointIndex, Schema } from '../shared/index.js';
import { TextLayout } from './text-layout.js';

export class EndpointFormatter {
  static readonly MAX_BODY_FIELDS = 3;
  static readonly PATH_PARAM: RegExp = /\{[^{}]+\}/g;
  static readonly AUTH_ORDER: readonly string[] = ['cookie', 'bearer', 'header', 'csrf'];

  readonly #ansi: Ansi;

  constructor(ansi: Ansi = Ansi.plain) {
    this.#ansi = ansi;
  }

  static authLabels(endpoint: Endpoint): string[] {
    const auth = endpoint.auth;
    const labels = new Set<string>();
    if (auth.cookies.length > 0) labels.add('cookie');
    if (auth.bearer) labels.add('bearer');
    if (auth.headers.some((name) => !(auth.bearer && name.toLowerCase() === 'authorization'))) labels.add('header');
    if (auth.csrf.length > 0) labels.add('csrf');
    return EndpointFormatter.AUTH_ORDER.filter((label) => labels.has(label));
  }

  static bodyFields(endpoint: Endpoint): string[] {
    const shape = endpoint.requestBody;
    if (!shape) return [];
    if (shape.kind === 'graphql') {
      const variables = Schema.properties(Schema.properties(shape.schema).variables);
      return Object.keys(variables).map((name) => '$' + name);
    }
    return Object.keys(Schema.properties(shape.schema));
  }

  method(endpoint: Endpoint): string {
    const method = TextLayout.clean(endpoint.method);
    return this.#ansi.method(method, method);
  }

  path(endpoint: Endpoint): string {
    const path = TextLayout.clean(endpoint.path).replace(EndpointFormatter.PATH_PARAM, (param) => this.#ansi.cyan(param));
    return endpoint.operationName === undefined ? path : path + this.#ansi.magenta('#' + TextLayout.clean(endpoint.operationName));
  }

  url(endpoint: Endpoint): string {
    return TextLayout.clean(endpoint.origin) + this.path(endpoint);
  }

  query(endpoint: Endpoint): string {
    return endpoint.queryParams.map((param) => TextLayout.clean(param.name) + (param.required ? '*' : '')).join(', ');
  }

  body(endpoint: Endpoint): string {
    const shape = endpoint.requestBody;
    if (!shape || shape.kind === 'empty') return '';
    const kind = TextLayout.clean(shape.kind);
    const fields = EndpointFormatter.bodyFields(endpoint);
    if (fields.length > 0) {
      const shown = fields.slice(0, EndpointFormatter.MAX_BODY_FIELDS).map((name) => TextLayout.clean(name));
      const more = fields.length - shown.length;
      return `${kind}: ${shown.join(', ')}${more > 0 ? this.#ansi.dim(` +${more}`) : ''}`;
    }
    const type = Schema.typeLabel(shape.schema);
    return shape.kind === 'graphql' || type === 'any' || type === 'object' ? kind : `${kind}: ${TextLayout.clean(type)}`;
  }

  statuses(endpoint: Endpoint): string {
    return EndpointIndex.statuses(endpoint)
      .map((status) => this.#ansi.status(status))
      .join(' ');
  }

  auth(endpoint: Endpoint): string {
    return EndpointFormatter.authLabels(endpoint).join(',');
  }
}
