import type { ApiModel, Capture, Endpoint, Exchange, FormDescriptor } from '../model/index.js';
import { HarConverter } from '../capture/index.js';
import { FormLinker, SecretCollector } from '../build/index.js';
import type { SecretValues } from '../build/index.js';
import type { Har } from '../capture/index.js';
import { AppiiError, FormSource, Http, Json } from '../shared/index.js';
import { ExchangeSanitizer } from './exchange-sanitizer.js';
import type { SanitizeContext } from './exchange-sanitizer.js';
import { BaseExporter } from './exporter.js';
import type { ExportFormat, ExportOptions } from './exporter.js';
import { HarPostDataWriter } from './har-post-data-writer.js';

export interface HarExporterDeps {
  har?: HarConverter;
  sanitizer?: (redact: boolean) => ExchangeSanitizer;
  postData?: HarPostDataWriter;
  secrets?: (redact: boolean) => SecretCollector;
  forms?: (redact: boolean) => FormLinker;
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
  readonly #secrets: (redact: boolean) => SecretCollector;
  readonly #forms: (redact: boolean) => FormLinker;

  static create(): HarExporter {
    return new HarExporter({
      har: HarConverter.create(),
      sanitizer: (redact: boolean) => ExchangeSanitizer.create({ redact }),
      postData: HarPostDataWriter.create(),
      secrets: (redact: boolean) => SecretCollector.create({ redact }),
      forms: (redact: boolean) => FormLinker.create({ redact }),
    });
  }

  constructor(deps: HarExporterDeps = {}) {
    super();
    this.#har = deps.har ?? new HarConverter();
    this.#sanitizer = deps.sanitizer ?? ((redact: boolean) => ExchangeSanitizer.create({ redact }));
    this.#postData = deps.postData ?? HarPostDataWriter.create();
    this.#secrets = deps.secrets ?? ((redact: boolean) => SecretCollector.create({ redact }));
    this.#forms = deps.forms ?? ((redact: boolean) => FormLinker.create({ redact }));
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
    const redact = options.redact ?? true;
    const sanitizer = this.#sanitizer(redact);
    sanitizer.useValues(this.#secretValues(capture, forms, redact));
    const contexts = new Map<Endpoint, SanitizeContext>();
    const context = (endpoint: Endpoint): SanitizeContext => {
      let found = contexts.get(endpoint);
      if (!found) {
        const form = endpoint.form && !FormSource.isScript(endpoint.form) ? endpoint.form : undefined;
        found = { secrets: FormLinker.endpointSecrets(endpoint, forms), ...(form ? { formEnctype: form.enctype, formCharset: form.charset } : {}) };
        contexts.set(endpoint, found);
      }
      return found;
    };
    return capture.exchanges.flatMap((exchange) => {
      const owner = owners.get(exchange.id);
      return owner ? [{ exchange: sanitizer.sanitize(exchange, context(owner)), endpoint: owner }] : [];
    });
  }

  #secretValues(capture: Capture, forms: readonly FormDescriptor[], redact: boolean): SecretValues {
    const linker = this.#forms(redact);
    const names = new Set([...linker.secretFields(capture), ...FormLinker.secretNames(forms)]);
    const exchanges = Http.recorded(capture.exchanges);
    const recorded = exchanges.length === capture.exchanges.length ? capture : { ...capture, exchanges };
    return this.#secrets(redact).collect(recorded, names, undefined, linker.credentialInput(capture));
  }

  archive(endpoints: readonly Endpoint[], options: ExportOptions, forms: readonly FormDescriptor[] = []): Har {
    const owned = this.owned(endpoints, options, forms);
    const har = this.#har.toHar(owned.map((item) => item.exchange));
    const byId = new Map(owned.map((item) => [item.exchange.id, item]));
    for (const entry of har.log.entries) {
      const item = entry._appiiId === undefined ? undefined : byId.get(entry._appiiId);
      const postData = entry.request.postData;
      if (item && postData) entry.request.postData = this.#postData.postData(postData, item.exchange, FormSource.isScript(item.endpoint.form) ? undefined : item.endpoint.form?.charset);
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
