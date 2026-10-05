import type { ApiModel, Endpoint } from '../model/index.js';
import { EndpointIndex, Json, Meta, Text } from '../shared/index.js';
import { BaseExporter } from './exporter.js';
import type { ExportFormat, ExportOptions } from './exporter.js';
import { Helpers } from './helpers.js';
import { OpenApiComponents } from './openapi-components.js';
import { OpenApiOperationBuilder } from './openapi-operation-builder.js';
import type { OpenApiObject } from './openapi-operation-builder.js';
import { OpenApiOperationMerger } from './openapi-operation-merger.js';
import { OpenApiPathPlanner } from './openapi-path-planner.js';
import { OpenApiSecurity } from './openapi-security.js';

export interface OpenApiExporterDeps {
  planner?: OpenApiPathPlanner;
  operations?: OpenApiOperationBuilder;
  merger?: OpenApiOperationMerger;
}

export class OpenApiExporter extends BaseExporter {
  static readonly OPENAPI_VERSION = '3.1.0';
  static readonly API_VERSION = '1.0.0';

  readonly format: ExportFormat = 'openapi';
  readonly extension: string = 'json';
  readonly mimeType: string = 'application/vnd.oai.openapi+json';
  readonly description: string = 'OpenAPI 3.1 document (JSON)';

  readonly #planner: OpenApiPathPlanner;
  readonly #operations: OpenApiOperationBuilder;
  readonly #merger: OpenApiOperationMerger;

  static create(): OpenApiExporter {
    return new OpenApiExporter({ planner: new OpenApiPathPlanner(), operations: OpenApiOperationBuilder.create(), merger: new OpenApiOperationMerger() });
  }

  constructor(deps: OpenApiExporterDeps = {}) {
    super();
    this.#planner = deps.planner ?? new OpenApiPathPlanner();
    this.#operations = deps.operations ?? new OpenApiOperationBuilder();
    this.#merger = deps.merger ?? new OpenApiOperationMerger();
  }

  document(model: ApiModel, endpoints: Endpoint[], options: ExportOptions = {}): Record<string, unknown> {
    const opts = Helpers.normalizeOptions(options);
    const index = EndpointIndex.of(model);
    const components = new OpenApiComponents();
    const security = new OpenApiSecurity(model, components);
    const primary = model.primaryOrigin || endpoints[0]?.origin || '';
    const top = primary === '' ? '' : Helpers.originBase(model, primary, opts);
    const result = this.#planner.plan(endpoints, { base: (origin) => Helpers.originBase(model, origin, opts) });
    const operationIds = new Set<string>();
    const reserved = new Set(endpoints.map((endpoint) => endpoint.name));
    const paths: Record<string, OpenApiObject> = {};
    const tags: string[] = [];
    for (const plan of result.plans) {
      const built = plan.endpoints.map((endpoint) =>
        this.#operations.build(endpoint, {
          model,
          index,
          key: plan.key,
          operationId: Text.uniqueName(endpoint.name || 'operation', operationIds),
          renames: plan.renames,
          components,
          security,
        }),
      );
      const first = plan.endpoints[0];
      let operation = built[0] ?? {};
      if (built.length > 1 && first) {
        const merged = Text.uniqueName(Text.camelCase(`${first.method} ${first.path}`) || 'graphql', new Set([...reserved, ...operationIds]));
        operationIds.add(merged);
        operation = this.#merger.merge(built, {
          operationId: merged,
          summary: `GraphQL ${first.path}`,
          operationNames: plan.endpoints.map((endpoint) => endpoint.operationName ?? endpoint.name),
          components,
        });
      }
      if (plan.server !== top) operation.servers = [{ url: plan.server }];
      for (const tag of Array.isArray(operation.tags) ? operation.tags : []) if (typeof tag === 'string' && !tags.includes(tag)) tags.push(tag);
      const item = paths[plan.key] ?? {};
      paths[plan.key] = item;
      item[plan.method] = operation;
    }
    const document: Record<string, unknown> = {
      openapi: OpenApiExporter.OPENAPI_VERSION,
      info: { title: Helpers.title(model, opts), version: OpenApiExporter.API_VERSION, description: this.#description(model, result.skipped.length) },
    };
    if (top !== '') document.servers = OpenApiExporter.#servers(primary, top);
    if (tags.length > 0) document.tags = tags.map((name) => ({ name }));
    document.paths = paths;
    const componentsObject = components.toObject();
    if (componentsObject) document.components = componentsObject;
    document['x-appii'] = { version: Meta.appVersion(), generatedAt: model.generatedAt, primaryOrigin: model.primaryOrigin, origins: [...model.origins] };
    if (result.skipped.length > 0) {
      document['x-appii-unrepresented'] = result.skipped.map((endpoint) => ({
        operationId: endpoint.name,
        method: endpoint.method,
        url: endpoint.origin + endpoint.path,
        reason: !OpenApiPathPlanner.METHODS.has(endpoint.method.toLowerCase())
          ? `OpenAPI 3.1 has no field for the ${endpoint.method} method`
          : OpenApiPathPlanner.isPathTemplate(endpoint.path)
            ? 'Another operation already uses this method and path template'
            : 'The path is not a valid OpenAPI path template',
      }));
    }
    return document;
  }

  protected render(model: ApiModel, endpoints: Endpoint[], options: ExportOptions): string {
    return Json.asciiJson(this.document(model, endpoints, options)) + '\n';
  }

  protected override filename(_model: ApiModel): string {
    return 'openapi.json';
  }

  static #servers(primary: string, top: string): Record<string, string>[] {
    const servers = [{ url: top, description: top === primary ? 'Captured origin' : 'Base URL' }];
    if (top !== primary) servers.push({ url: primary, description: 'Captured origin' });
    return servers;
  }

  #description(model: ApiModel, skipped: number): string {
    const source = model.source;
    const span = source.capturedFrom && source.capturedTo ? ` between ${source.capturedFrom} and ${source.capturedTo}` : '';
    const lines = [`Inferred by ${Meta.APP_NAME} ${Meta.appVersion()} from ${Text.plural(source.exchanges, 'captured HTTP exchange')}${span}.`];
    if (source.startUrl) lines.push(`Start URL: ${source.startUrl}`);
    if (skipped > 0) lines.push(`${Text.plural(skipped, 'operation')} that OpenAPI 3.1 cannot represent ${skipped === 1 ? 'is' : 'are'} listed in x-appii-unrepresented.`);
    return lines.join('\n\n');
  }
}
