import type { ApiModel, Endpoint } from '../model/index.js';
import type { ExportFormat, ExportOptions } from './exporter.js';
import { OpenApiExporter } from './openapi-exporter.js';
import { OpenApiOperationBuilder } from './openapi-operation-builder.js';
import { OpenApiOperationMerger } from './openapi-operation-merger.js';
import { OpenApiPathPlanner } from './openapi-path-planner.js';
import type { OpenApiExporterDeps } from './openapi-exporter.js';
import { YamlWriter } from './yaml-writer.js';

export interface OpenApiYamlExporterDeps extends OpenApiExporterDeps {
  yaml?: YamlWriter;
}

export class OpenApiYamlExporter extends OpenApiExporter {
  override readonly format: ExportFormat = 'openapi-yaml';
  override readonly extension: string = 'yaml';
  override readonly mimeType: string = 'application/vnd.oai.openapi';
  override readonly description: string = 'OpenAPI 3.1 document (YAML)';

  readonly #yaml: YamlWriter;

  static override create(): OpenApiYamlExporter {
    return new OpenApiYamlExporter({ planner: new OpenApiPathPlanner(), operations: OpenApiOperationBuilder.create(), merger: new OpenApiOperationMerger(), yaml: new YamlWriter() });
  }

  constructor(deps: OpenApiYamlExporterDeps = {}) {
    super(deps);
    this.#yaml = deps.yaml ?? new YamlWriter();
  }

  protected override render(model: ApiModel, endpoints: Endpoint[], options: ExportOptions): string {
    return this.#yaml.stringify(this.document(model, endpoints, options));
  }

  protected override filename(_model: ApiModel): string {
    return 'openapi.yaml';
  }
}
