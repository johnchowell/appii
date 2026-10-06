import type { ApiModel, Endpoint, Exchange, FormDescriptor } from '../model/index.js';
import { HarConverter } from '../capture/index.js';
import { FormLinker } from '../build/index.js';
import type { Har } from '../capture/index.js';
import { AppiiError, Json } from '../shared/index.js';
import { ExchangeSanitizer } from './exchange-sanitizer.js';
import type { SanitizeContext } from './exchange-sanitizer.js';
import { BaseExporter } from './exporter.js';
import type { ExportFormat, ExportOptions } from './exporter.js';
import { HarPostDataWriter } from './har-post-data-writer.js';

export interface HarExporterDeps {
  har?: HarConverter;
  sanitizer?: (redact: boolean) => ExchangeSanitizer;
  postData?: HarPostDataWriter;
}

export interface OwnedExchange {
  exchange: Exchange;
  endpoint: Endpoint;
}

export class HarExporter extends BaseExporter {
  readonly format: ExportFormat = 'har';
  readonly extension = 'har';
  readonly mimeType = 'application/json';
  readonly description = 'HAR 1.2 archive with the captured sample exchanges of the selected endpoints';

  readonly #har: HarConverter;
  readonly #sanitizer: (redact: boolean) => ExchangeSanitizer;
  readonly #postData: HarPostDataWriter;

  static create(): HarExporter {
    return new HarExporter({ har: HarConverter.create(), sanitizer: (redact: boolean) => ExchangeSanitizer.create({ redact }), postData: HarPostDataWriter.create() });
  }

  constructor(deps: HarExporterDeps = {}) {
    super();
    this.#har = deps.har ?? new HarConverter();
    this.#sanitizer = deps.sanitizer ?? ((redact: boolean) => ExchangeSanitizer.create({ redact }));
    this.#postData = deps.postData ?? HarPostDataWriter.create();
  }

  exchanges(endpoints: readonly Endpoint[], options: ExportOptions, forms: readonly FormDescriptor[] = []): Exchange[] {
    return this.owned(endpoints, options, forms).map((item) => item.exchange);
  }

  owned(endpoints: readonly Endpoint[], options: ExportOptions, forms: readonly FormDescriptor[] = []): OwnedExchange[] {
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
      return owner ? [{ exchange: sanitizer.sanitize(exchange, context(owner)), endpoint: owner }] : [];
    });
  }

  archive(endpoints: readonly Endpoint[], options: ExportOptions, forms: readonly FormDescriptor[] = []): Har {
    const owned = this.owned(endpoints, options, forms).map((item) => ({ exchange: this.#postData.textExchange(item.exchange), endpoint: item.endpoint }));
    const har = this.#har.toHar(owned.map((item) => item.exchange));
    const byId = new Map(owned.map((item) => [item.exchange.id, item]));
    for (const entry of har.log.entries) {
      const item = entry._appiiId === undefined ? undefined : byId.get(entry._appiiId);
      const postData = entry.request.postData;
      if (item && postData) entry.request.postData = this.#postData.postData(postData, item.exchange, item.endpoint.form?.charset);
    }
    return har;
  }

  protected render(model: ApiModel, endpoints: Endpoint[], options: ExportOptions): string {
    return Json.asciiJson(this.archive(endpoints, options, model.forms)) + '\n';
  }

  protected override filename(_model: ApiModel): string {
    return 'capture.har';
  }
}
