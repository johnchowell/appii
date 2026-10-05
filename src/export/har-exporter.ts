import type { ApiModel, Endpoint, Exchange, FormDescriptor } from '../model/index.js';
import { HarConverter } from '../capture/index.js';
import { FormLinker } from '../build/index.js';
import type { Har } from '../capture/index.js';
import { AppiiError, Json } from '../shared/index.js';
import { ExchangeSanitizer } from './exchange-sanitizer.js';
import type { SanitizeContext } from './exchange-sanitizer.js';
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

  exchanges(endpoints: readonly Endpoint[], options: ExportOptions, forms: readonly FormDescriptor[] = []): Exchange[] {
    const capture = options.capture;
    if (!capture) {
      throw new AppiiError('BAD_INPUT', 'The har export needs the capture (capture.json or a HAR file), not only api.json');
    }
    const owners = new Map<string, Endpoint>();
    for (const endpoint of endpoints) for (const sample of endpoint.samples) if (!owners.has(sample.exchangeId)) owners.set(sample.exchangeId, endpoint);
    const sanitizer = this.#sanitizer(options.redact ?? true);
    const contexts = new Map<Endpoint, SanitizeContext>();
    const context = (endpoint: Endpoint): SanitizeContext => {
      let found = contexts.get(endpoint);
      if (!found) {
        found = { secrets: FormLinker.endpointSecrets(endpoint, forms), ...(endpoint.form ? { formEnctype: endpoint.form.enctype, formCharset: endpoint.form.charset } : {}) };
        contexts.set(endpoint, found);
      }
      return found;
    };
    return capture.exchanges.flatMap((exchange) => {
      const owner = owners.get(exchange.id);
      return owner ? [sanitizer.sanitize(exchange, context(owner))] : [];
    });
  }

  archive(endpoints: readonly Endpoint[], options: ExportOptions, forms: readonly FormDescriptor[] = []): Har {
    return this.#har.toHar(this.exchanges(endpoints, options, forms));
  }

  protected render(model: ApiModel, endpoints: Endpoint[], options: ExportOptions): string {
    return Json.asciiJson(this.archive(endpoints, options, model.forms)) + '\n';
  }

  protected override filename(_model: ApiModel): string {
    return 'capture.har';
  }
}
