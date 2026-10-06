import type { Endpoint } from '../model/index.js';
import { Ansi, Credentials, EndpointIndex, Schema } from '../shared/index.js';
import type { CookieRoles } from '../shared/index.js';
import { SchemaTree } from './schema-tree.js';

export class EndpointFormatter {
  static readonly MAX_BODY_FIELDS = 3;
  static readonly PATH_PARAM: RegExp = /\{[^{}]+\}/g;
  static readonly CSRF_LABEL = 'csrf';

  readonly #ansi: Ansi;

  constructor(ansi: Ansi = Ansi.plain) {
    this.#ansi = ansi;
  }

  static authLabels(endpoint: Endpoint, roles?: CookieRoles): string[] {
    const labels = [...(endpoint.role === undefined ? [] : [endpoint.role]), ...Credentials.kinds(endpoint, roles)];
    if (endpoint.auth.csrf.length > 0) labels.push(EndpointFormatter.CSRF_LABEL);
    return labels;
  }

  static bodyFields(endpoint: Endpoint): string[] {
    const shape = endpoint.requestBody;
    if (!shape) return [];
    if (shape.kind === 'graphql') {
      const variables = Schema.properties(Schema.properties(shape.schema).variables);
      return Object.keys(variables).map((name) => '$' + name);
    }
    return SchemaTree.fieldNames(shape.schema);
  }

  method(endpoint: Endpoint): string {
    const method = this.#ansi.clean(endpoint.method);
    return this.#ansi.method(method, method);
  }

  path(endpoint: Endpoint): string {
    const path = this.#ansi.clean(endpoint.path).replace(EndpointFormatter.PATH_PARAM, (param) => this.#ansi.cyan(param));
    return endpoint.operationName === undefined ? path : path + this.#ansi.magenta('#' + this.#ansi.clean(endpoint.operationName));
  }

  url(endpoint: Endpoint): string {
    return this.#ansi.clean(endpoint.origin) + this.path(endpoint);
  }

  query(endpoint: Endpoint): string {
    return endpoint.queryParams.map((param) => this.#ansi.clean(param.name) + (param.required ? '*' : '')).join(', ');
  }

  body(endpoint: Endpoint): string {
    const shape = endpoint.requestBody;
    if (!shape || shape.kind === 'empty') return '';
    const kind = this.#ansi.clean(shape.kind);
    const fields = EndpointFormatter.bodyFields(endpoint);
    if (fields.length > 0) {
      const shown = fields.slice(0, EndpointFormatter.MAX_BODY_FIELDS).map((name) => this.#ansi.clean(name));
      const more = fields.length - shown.length;
      return `${kind}: ${shown.join(', ')}${more > 0 ? this.#ansi.dim(` +${more}`) : ''}`;
    }
    const type = Schema.typeLabel(shape.schema);
    return shape.kind === 'graphql' || type === 'any' || type === 'object' ? kind : `${kind}: ${this.#ansi.clean(type)}`;
  }

  statuses(endpoint: Endpoint): string {
    return EndpointIndex.statuses(endpoint)
      .map((status) => this.#ansi.status(status))
      .join(' ');
  }

  auth(endpoint: Endpoint, roles?: CookieRoles): string {
    return EndpointFormatter.authLabels(endpoint, roles).join(',');
  }
}
