import type { ApiModel, Endpoint, Exchange } from '../model/index.js';
import { HarConverter } from '../capture/index.js';
import type { Har } from '../capture/index.js';
import { AppiiError, Json } from '../shared/index.js';
import { ExchangeSanitizer } from './exchange-sanitizer.js';
import { BaseExporter } from './exporter.js';
import type { ExportFormat, ExportOptions } from './exporter.js';

export interface HarExporterDeps {
  har?: HarConverter;
  sanitizer?: (redact: boolean) => ExchangeSanitizer;
}

export class HarExporter extends BaseExporter {
  readonly format: ExportFormat = 'har';
  readonly extension = 'har';
  readonly mimeType = 'application/json';
  readonly description = 'HAR 1.2 archive with the captured sample exchanges of the selected endpoints';

  readonly #har: HarConverter;
  readonly #sanitizer: (redact: boolean) => ExchangeSanitizer;

  static create(): HarExporter {
    return new HarExporter({ har: HarConverter.create(), sanitizer: (redact: boolean) => ExchangeSanitizer.create({ redact }) });
  }

  constructor(deps: HarExporterDeps = {}) {
    super();
    this.#har = deps.har ?? new HarConverter();
    this.#sanitizer = deps.sanitizer ?? ((redact: boolean) => ExchangeSanitizer.create({ redact }));
  }

  exchanges(endpoints: readonly Endpoint[], options: ExportOptions): Exchange[] {
    const capture = options.capture;
    if (!capture) {
      throw new AppiiError('BAD_INPUT', 'The har export needs the capture (capture.json or a HAR file), not only api.json');
    }
    const wanted = new Set(endpoints.flatMap((endpoint) => endpoint.samples.map((sample) => sample.exchangeId)));
    const sanitizer = this.#sanitizer(options.redact ?? true);
    return capture.exchanges.filter((exchange) => wanted.has(exchange.id)).map((exchange) => sanitizer.sanitize(exchange));
  }

  archive(endpoints: readonly Endpoint[], options: ExportOptions): Har {
    return this.#har.toHar(this.exchanges(endpoints, options));
  }

  protected render(_model: ApiModel, endpoints: Endpoint[], options: ExportOptions): string {
    return Json.asciiJson(this.archive(endpoints, options)) + '\n';
  }

  protected override filename(_model: ApiModel): string {
    return 'capture.har';
  }
}
