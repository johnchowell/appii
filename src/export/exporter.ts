import type { ApiModel, Capture, Endpoint } from '../model/index.js';
import { AppiiError, EndpointIndex, Text } from '../shared/index.js';
import { Helpers } from './helpers.js';

export type ExportFormat = 'openapi' | 'openapi-yaml' | 'postman' | 'curl' | 'typescript' | 'har' | 'html' | 'markdown' | 'json';

export interface ExportOptions {
  capture?: Capture;
  endpoints?: string[];
  baseUrl?: string;
  title?: string;
  redact?: boolean;
}

export interface ExportResult {
  format: ExportFormat;
  filename: string;
  mimeType: string;
  content: string;
  endpointCount: number;
}

export interface Exporter {
  readonly format: ExportFormat;
  readonly extension: string;
  readonly mimeType: string;
  readonly description: string;
  export(model: ApiModel, options?: ExportOptions): ExportResult;
}

export abstract class BaseExporter implements Exporter {
  abstract readonly format: ExportFormat;
  abstract readonly extension: string;
  abstract readonly mimeType: string;
  abstract readonly description: string;

  export(model: ApiModel, options: ExportOptions = {}): ExportResult {
    const normalized = Helpers.normalizeOptions(options);
    const endpoints = EndpointIndex.of(model).select(normalized.endpoints);
    const content = this.render(model, endpoints, normalized);
    if (!Text.isAscii(content)) {
      throw new AppiiError('INTERNAL', `The ${this.format} exporter produced non-ASCII output`, { details: { format: this.format } });
    }
    return { format: this.format, filename: this.filename(model), mimeType: this.mimeType, content, endpointCount: endpoints.length };
  }

  protected abstract render(model: ApiModel, endpoints: Endpoint[], options: ExportOptions): string;

  protected filename(model: ApiModel): string {
    return `${Text.kebabCase(model.name) || 'api'}.${this.extension}`;
  }
}
