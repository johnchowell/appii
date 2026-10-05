import type { ApiModel } from '../model/index.js';
import { AppiiError } from '../shared/index.js';
import { CurlExporter } from './curl-exporter.js';
import type { ExportOptions, ExportResult, Exporter } from './exporter.js';
import { HarExporter } from './har-exporter.js';
import { HtmlExporter } from './html-exporter.js';
import { JsonExporter } from './json-exporter.js';
import { MarkdownExporter } from './markdown-exporter.js';
import { OpenApiExporter } from './openapi-exporter.js';
import { OpenApiYamlExporter } from './openapi-yaml-exporter.js';
import { PostmanExporter } from './postman-exporter.js';
import { TypeScriptExporter } from './typescript-exporter.js';

export class ExporterRegistry {
  static readonly ALIASES: Readonly<Record<string, string>> = Object.freeze({
    oas: 'openapi',
    'openapi-json': 'openapi',
    swagger: 'openapi',
    yaml: 'openapi-yaml',
    yml: 'openapi-yaml',
    'openapi-yml': 'openapi-yaml',
    sh: 'curl',
    bash: 'curl',
    shell: 'curl',
    ts: 'typescript',
    client: 'typescript',
    md: 'markdown',
    report: 'html',
    model: 'json',
    'postman-collection': 'postman',
  });

  readonly #exporters = new Map<string, Exporter>();

  static default(): ExporterRegistry {
    return new ExporterRegistry()
      .register(OpenApiExporter.create())
      .register(OpenApiYamlExporter.create())
      .register(PostmanExporter.create())
      .register(new CurlExporter())
      .register(TypeScriptExporter.create())
      .register(HarExporter.create())
      .register(HtmlExporter.create())
      .register(MarkdownExporter.create())
      .register(new JsonExporter());
  }

  static normalize(format: string): string {
    const lower = format.trim().toLowerCase();
    return Object.hasOwn(ExporterRegistry.ALIASES, lower) ? (ExporterRegistry.ALIASES[lower] ?? lower) : lower;
  }

  register(exporter: Exporter): this {
    this.#exporters.set(exporter.format, exporter);
    return this;
  }

  has(format: string): boolean {
    return this.#exporters.has(ExporterRegistry.normalize(format));
  }

  get(format: string): Exporter {
    const exporter = this.#exporters.get(ExporterRegistry.normalize(format));
    if (exporter) return exporter;
    const formats = [...this.#exporters.keys()];
    throw new AppiiError('BAD_INPUT', `Unknown export format '${format}'. Available formats: ${formats.join(', ')}`, { details: { format, formats } });
  }

  list(): Exporter[] {
    return [...this.#exporters.values()];
  }

  export(model: ApiModel, format: string, options: ExportOptions = {}): ExportResult {
    return this.get(format).export(model, options);
  }
}
