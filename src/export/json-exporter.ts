import type { ApiModel, Endpoint } from '../model/index.js';
import { EndpointIndex, Json } from '../shared/index.js';
import { BaseExporter } from './exporter.js';
import type { ExportFormat, ExportOptions } from './exporter.js';

export class JsonExporter extends BaseExporter {
  readonly format: ExportFormat = 'json';
  readonly extension = 'json';
  readonly mimeType = 'application/json';
  readonly description = 'The API model (api.json) as pretty-printed JSON';

  model(model: ApiModel, endpoints: readonly Endpoint[]): ApiModel {
    return EndpointIndex.subset(model, endpoints);
  }

  protected render(model: ApiModel, endpoints: Endpoint[], _options: ExportOptions): string {
    return Json.asciiJson(this.model(model, endpoints)) + '\n';
  }

  protected override filename(_model: ApiModel): string {
    return 'api.json';
  }
}
