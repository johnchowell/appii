import type { ApiModel, BodyShape, Endpoint, EndpointResponse, ParamInfo } from '../model/index.js';
import { Credentials, Curl, EndpointIndex, Http, Json, RequestBodies, Schema, Text } from '../shared/index.js';
import type { ExportOptions } from './exporter.js';
import { Helpers } from './helpers.js';
import { SchemaFieldList } from './schema-field-list.js';

export interface HtmlEndpointContext {
  model: ApiModel;
  index: EndpointIndex;
  options: ExportOptions;
}

export interface HtmlEndpointRendererDeps {
  fields?: SchemaFieldList;
}

export class HtmlEndpointRenderer {
  static readonly MAX_JSON_CHARS = 20000;
  static readonly METHOD_CLASSES: ReadonlySet<string> = new Set(['get', 'post', 'put', 'patch', 'delete']);

  readonly #fields: SchemaFieldList;

  static create(): HtmlEndpointRenderer {
    return new HtmlEndpointRenderer({ fields: new SchemaFieldList() });
  }

  constructor(deps: HtmlEndpointRendererDeps = {}) {
    this.#fields = deps.fields ?? new SchemaFieldList();
  }

  static esc(value: unknown): string {
    return Text.escapeHtml(typeof value === 'string' ? value : String(value));
  }

  static methodBadge(method: string): string {
    const lower = method.toLowerCase();
    const cls = HtmlEndpointRenderer.METHOD_CLASSES.has(lower) ? ` ${lower}` : '';
    return `<span class="method${cls}">${HtmlEndpointRenderer.esc(method)}</span>`;
  }

  static statusClass(status: number): string {
    return status >= 200 && status < 600 ? `${Math.floor(status / 100)}xx` : 'other';
  }

  path(endpoint: Endpoint, model: ApiModel): string {
    const origin = endpoint.origin === model.primaryOrigin ? '' : `<span class="origin">${HtmlEndpointRenderer.esc(endpoint.origin)}</span>`;
    const parts = endpoint.path.split(/(\{[^}]+\})/g).map((part) => (/^\{[^}]+\}$/.test(part) ? `<span class="param">${HtmlEndpointRenderer.esc(part)}</span>` : HtmlEndpointRenderer.esc(part)));
    return `<span class="path">${origin}${parts.join('')}</span>`;
  }

  item(endpoint: Endpoint, ctx: HtmlEndpointContext): string {
    const number = ctx.index.numberOf(endpoint);
    const esc = HtmlEndpointRenderer.esc;
    const search = [endpoint.method, endpoint.origin + endpoint.path, endpoint.name, endpoint.id, endpoint.kind, endpoint.operationName ?? ''].join(' ').trim().toLowerCase();
    const statuses = EndpointIndex.statuses(endpoint)
      .map((status) => `<span class="badge status-${HtmlEndpointRenderer.statusClass(status)}" title="${esc(Http.reasonPhrase(status))}">${status}</span>`)
      .join(' ');
    const badges = [`<span class="badge">${esc(endpoint.kind)}</span>`, statuses];
    const roles = Credentials.roles(ctx.model);
    const refusals = Credentials.refusals(endpoint, roles);
    if (Credentials.sets(endpoint, roles).length > 0) badges.push(Credentials.optional(endpoint) ? '<span class="badge auth" title="credentials are optional">auth?</span>' : '<span class="badge auth">auth</span>');
    else if (refusals.length > 0) badges.push(`<span class="badge auth" title="answered ${refusals.join(' and ')} without credentials; the credential was not captured">${refusals.join('/')}${Credentials.UNKNOWN_MARK}</span>`);
    if (endpoint.auth.csrf.length > 0) badges.push('<span class="badge csrf">csrf</span>');
    if (endpoint.form) badges.push('<span class="badge">html form</span>');
    const summary = [
      `<span class="num">#${number}</span>`,
      HtmlEndpointRenderer.methodBadge(endpoint.method),
      this.path(endpoint, ctx.model),
      `<span class="name">${esc(endpoint.name)}</span>`,
      ...badges.filter((badge) => badge !== ''),
      `<span class="hits">${esc(Text.plural(endpoint.count, 'hit'))}</span>`,
    ].join(' ');
    return [
      `<li class="endpoint" id="endpoint-${number}" data-method="${esc(endpoint.method.toUpperCase())}" data-kind="${esc(endpoint.kind)}" data-search="${esc(search)}">`,
      `<details><summary>${summary}</summary>`,
      `<div class="detail">${this.detail(endpoint, ctx, number)}</div>`,
      '</details></li>',
    ].join('');
  }

  detail(endpoint: Endpoint, ctx: HtmlEndpointContext, number: number): string {
    const esc = HtmlEndpointRenderer.esc;
    const out: string[] = [];
    const meta: [string, string][] = [
      ['Endpoint', `#${number} <code>${esc(endpoint.name)}</code> (<code>${esc(endpoint.id)}</code>)`],
      ['URL', `<code>${esc(Helpers.base(ctx.model, endpoint, ctx.options) + endpoint.path)}</code>`],
      ['Kind', `${esc(endpoint.kind)}${endpoint.operationName ? ` (operation <code>${esc(endpoint.operationName)}</code>)` : ''}${endpoint.firstParty ? '' : ', third party'}`],
      ['Observed', endpoint.count > 0 ? esc(`${Text.plural(endpoint.count, 'time')}${endpoint.resourceTypes.length > 0 ? ` via ${endpoint.resourceTypes.join(', ')}` : ''}`) : 'not observed; inferred from an HTML form'],
    ];
    const credentials = Credentials.describe(endpoint, Credentials.roles(ctx.model));
    if (credentials !== '') meta.push(['Credentials', esc(credentials)]);
    if (endpoint.auth.cookies.length > 0) meta.push(['Cookies sent', endpoint.auth.cookies.map((name) => `<code>${esc(name)}</code>`).join(', ')]);
    if (endpoint.auth.bearer) meta.push(['Bearer', 'Authorization: Bearer token']);
    if (endpoint.auth.headers.length > 0) meta.push(['Auth headers', endpoint.auth.headers.map((name) => `<code>${esc(name)}</code>`).join(', ')]);
    for (const token of endpoint.auth.csrf) {
      const source = Helpers.tokenSource(token, { text: (value) => esc(value), code: (value) => `<code>${esc(value)}</code>`, url: (value) => `<code>${esc(Helpers.mapUrl(ctx.model, value, ctx.options))}</code>` });
      meta.push(['CSRF', `<code>${esc(token.name)}</code> in the ${esc(token.location)}, from ${source}`]);
    }
    if (endpoint.form) {
      const form = endpoint.form;
      const submitters = form.submitters.filter((s) => s.name !== '').map((s) => `<code>${esc(s.name)}=${esc(s.value)}</code>${s.formNoValidate ? ' (novalidate)' : ''}`);
      meta.push([
        'Form',
        `<code>${esc(form.selector)}</code> on <code>${esc(Helpers.mapUrl(ctx.model, form.pageUrl, ctx.options))}</code> (${esc(form.enctype)})${submitters.length > 0 ? `; submitters ${submitters.join(', ')}` : ''}`,
      ]);
    }
    if (endpoint.samples.length > 0) meta.push(['Samples', endpoint.samples.map((sample) => `<code>${esc(sample.url)}</code>${sample.status !== undefined ? ` ${sample.status}` : ''}`).join('<br>')]);
    out.push(`<dl class="meta">${meta.map(([key, value]) => `<dt>${esc(key)}</dt><dd>${value}</dd>`).join('')}</dl>`);
    const params = [...endpoint.pathParams, ...endpoint.queryParams, ...endpoint.headerParams];
    if (params.length > 0) out.push('<h3>Parameters</h3>', this.params(params));
    RequestBodies.shapes(endpoint).forEach((shape, i) => out.push(`<h3>Request body</h3>`, this.body(shape, i === 0 ? `request-${number}` : `request-${number}-${i}`)));
    if (endpoint.responses.length > 0) {
      out.push('<h3>Responses</h3>');
      endpoint.responses.forEach((response, i) => out.push(this.response(response, `response-${number}-${i}`)));
    }
    out.push('<h3>Example request</h3>', this.example(endpoint, ctx, `curl-${number}`));
    RequestBodies.variants(endpoint).forEach((variant, i) => {
      out.push(`<h3>Example request (<code>${esc(variant.mediaType)}</code>)</h3>`, this.example(variant.endpoint, ctx, `curl-${number}-${i + 1}`));
    });
    return out.join('');
  }

  example(endpoint: Endpoint, ctx: HtmlEndpointContext, id: string): string {
    const esc = HtmlEndpointRenderer.esc;
    const sample = Helpers.sample(ctx.model, endpoint, ctx.options);
    const curl = Curl.curlCommand(sample, { variables: 'shell' });
    const variables = Curl.placeholderNames(sample);
    const block = `<div class="copy-block"><button type="button" class="copy" data-target="${esc(id)}">Copy</button><pre id="${esc(id)}">\n${esc(curl)}</pre></div>`;
    return variables.length === 0 ? block : `${block}<p class="variables">${esc(Curl.VARIABLES_LABEL)} ${variables.map((name) => `<code>${esc(name)}</code>`).join(' ')}</p>`;
  }

  params(params: readonly ParamInfo[]): string {
    const esc = HtmlEndpointRenderer.esc;
    const rows = params.map((param) => {
      const examples = param.examples.map((example) => `<code>${esc(example)}</code>`).join(' ');
      return `<tr><td><code>${esc(param.name)}</code></td><td>${esc(param.in)}</td><td>${param.required ? 'yes' : 'no'}</td><td>${esc(Schema.typeLabel(param.schema))}</td><td>${esc(Schema.constraintSummary(param.schema, Schema.FULL_SUMMARY).join('; '))}</td><td>${examples}</td></tr>`;
    });
    return `<div class="scroll"><table><thead><tr><th>Name</th><th>In</th><th>Required</th><th>Type</th><th>Constraints</th><th>Examples</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`;
  }

  body(shape: BodyShape, id: string): string {
    const esc = HtmlEndpointRenderer.esc;
    const out = [`<p><code>${esc(shape.mimeType || '(unknown type)')}</code> (${esc(shape.jsonLines === true ? `${shape.kind}, ${Helpers.JSON_LINES_LABEL}` : shape.kind)})</p>`];
    const fields = this.#fields.rows(shape.schema);
    if (fields.length > 0) {
      const rows = fields.map(
        (field) =>
          `<tr><td><code>${esc(field.path)}</code></td><td>${esc(field.type)}</td><td>${esc(SchemaFieldList.requiredText(field))}</td><td>${esc(field.constraints.join('; '))}</td><td>${esc(field.description ?? '')}</td></tr>`,
      );
      out.push(`<div class="scroll"><table><thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Constraints</th><th>Label</th></tr></thead><tbody>${rows.join('')}</tbody></table></div>`);
    }
    if (shape.schema) out.push(`<details class="raw"><summary>JSON Schema</summary><pre id="${esc(id)}-schema">\n${esc(HtmlEndpointRenderer.#json(shape.schema))}</pre></details>`);
    const examples = shape.jsonLines === true && shape.examples.length > 0 ? [Text.truncate(Helpers.jsonLines(shape.examples), HtmlEndpointRenderer.MAX_JSON_CHARS)] : shape.examples;
    examples.forEach((example, i) => {
      const text = typeof example === 'string' ? example : HtmlEndpointRenderer.#json(example);
      out.push(`<details class="raw"><summary>Example ${i + 1}</summary><pre id="${esc(id)}-example-${i + 1}">\n${esc(text)}</pre></details>`);
    });
    return out.join('');
  }

  response(response: EndpointResponse, id: string): string {
    const esc = HtmlEndpointRenderer.esc;
    const head =
      `<p><span class="badge status-${HtmlEndpointRenderer.statusClass(response.status)}">${response.status}</span> ${esc(Http.reasonPhrase(response.status))}` +
      ` - ${esc(Text.plural(response.count, 'time'))}${response.headers.length > 0 ? `; headers ${response.headers.map((name) => `<code>${esc(name)}</code>`).join(', ')}` : ''}</p>`;
    return head + (response.body && response.body.kind !== 'empty' ? this.body(response.body, id) : '');
  }

  static #json(value: unknown): string {
    return Text.truncate(Json.printableJson(value), HtmlEndpointRenderer.MAX_JSON_CHARS);
  }
}
