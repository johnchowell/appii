import { ModelStore } from '../../build/index.js';
import { CaptureMerger } from '../../capture/index.js';
import { ExporterRegistry } from '../../export/index.js';
import type { ExportOptions } from '../../export/index.js';
import { AppiiError, EndpointIndex, Meta, Text } from '../../shared/index.js';
import type { ApiModel, Capture } from '../../model/index.js';
import type { CliContext } from '../cli-context.js';
import { Command } from '../command.js';
import type { CommandDeps, CommandSpec } from '../command.js';
import { ExitCode } from '../exit-code.js';
import { ExportFormatsPresenter } from '../export-formats-presenter.js';
import { Helpers } from '../helpers.js';
import { InputLoader } from '../input-loader.js';
import { OptionReader } from '../option-reader.js';
import type { OptionValues } from '../option-reader.js';
import { OutputTarget } from '../output-target.js';
import { UsageError } from '../usage-error.js';

export interface ExportCommandDeps extends CommandDeps {
  registry?: ExporterRegistry;
  loader?: InputLoader;
  merger?: CaptureMerger;
}

export class ExportCommand extends Command {
  static readonly HAR_FORMAT = 'har';

  readonly spec: CommandSpec;
  readonly #registry: ExporterRegistry;
  readonly #loader: InputLoader;
  readonly #merger: CaptureMerger;

  constructor(deps: ExportCommandDeps = {}) {
    super(deps);
    this.#registry = deps.registry ?? ExporterRegistry.default();
    this.#loader = deps.loader ?? InputLoader.create();
    this.#merger = deps.merger ?? new CaptureMerger();
    const app = Meta.APP_NAME;
    this.spec = {
      name: 'export',
      summary: 'Export to OpenAPI, Postman, curl, a TypeScript client, HAR, HTML, Markdown or JSON',
      usage: `${app} export <api.json|capture.json|file.har> --format <format> [options]\n${app} export --formats`,
      options: {
        format: { type: 'string', short: 'f' },
        out: { type: 'string', short: 'o' },
        endpoints: { type: 'string', multiple: true },
        capture: { type: 'string', multiple: true },
        'base-url': { type: 'string' },
        title: { type: 'string' },
        redact: { type: 'boolean' },
        formats: { type: 'boolean' },
      },
      allowPositionals: true,
      docs: {
        format: { value: 'format', description: `One of ${this.#formats().join(', ')}` },
        out: { value: 'file', description: 'Output file, an existing directory, or - for stdout (default: the format file name, e.g. openapi.json)' },
        endpoints: { value: 'refs', description: 'Only these endpoints: list numbers, ids or names, comma separated' },
        capture: { value: 'file', description: 'The capture.json or HAR file with the recorded traffic, for --format har from an api.json; repeat it for a model built from several captures' },
        'base-url': { value: 'url', description: 'Use this base URL instead of the captured primary origin' },
        title: { value: 'title', description: 'Document title (default: the API name)' },
        redact: { flag: '--no-redact', description: 'Keep secret values when building from a capture and in HAR exports' },
        formats: { description: 'List the export formats' },
      },
      examples: [
        `${app} export api.json --format openapi`,
        `${app} export api.json --format typescript -o src/api-client.ts`,
        `${app} export api.json --format curl --endpoints 3,getItem -o -`,
        `${app} export capture.json --format har`,
      ],
    };
  }

  static create(): ExportCommand {
    return new ExportCommand({ registry: ExporterRegistry.default(), loader: InputLoader.create(), merger: CaptureMerger.create() });
  }

  static matchesCapture(model: ApiModel, endpoints: readonly string[] | undefined, capture: Capture): boolean {
    const ids = new Set(capture.exchanges.map((exchange) => exchange.id));
    const selected = EndpointIndex.of(model).select(endpoints);
    return selected.some((endpoint) => endpoint.samples.some((sample) => ids.has(sample.exchangeId)));
  }

  protected async execute(values: OptionValues, positionals: string[], ctx: CliContext): Promise<number> {
    if (OptionReader.boolean(values, 'formats') === true) {
      this.expectArguments(positionals, 0);
      ctx.out(new ExportFormatsPresenter(ctx.presenterOptions()).render(this.#registry));
      return ExitCode.OK;
    }
    const file = this.argument(positionals, 0, '<api.json|capture.json|file.har>');
    this.expectArguments(positionals, 1);
    const format = OptionReader.string(values, 'format');
    if (format === undefined) throw new UsageError(`missing --format <format> (one of ${this.#formats().join(', ')})`);
    if (!this.#registry.has(format)) throw this.#unknownFormat(format);
    const exporter = this.#registry.get(format);
    const redact = OptionReader.boolean(values, 'redact') ?? true;
    const out = OptionReader.string(values, 'out');
    const captureFiles = OptionReader.strings(values, 'capture');
    const base = ExportCommand.#options(values, redact);
    const input = ctx.resolve(file);
    const loaded = await this.#loader.load(input, { redact });
    const capture = captureFiles.length === 0 ? loaded.capture : await this.#captures(captureFiles, ctx);
    if (exporter.format === ExportCommand.HAR_FORMAT && capture === undefined) {
      throw new AppiiError('BAD_INPUT', `The ${exporter.format} format needs the recorded traffic: add --capture <capture.json|file.har>, or export from the capture file itself`);
    }
    const options: ExportOptions = capture === undefined ? base : { ...base, capture };
    const result = exporter.export(loaded.model, options);
    if (exporter.format === ExportCommand.HAR_FORMAT && capture !== undefined && !ExportCommand.matchesCapture(loaded.model, options.endpoints, capture)) {
      const named = captureFiles.length === 0 ? file : captureFiles.join(', ');
      ctx.err(ctx.ansi.clean(`warning: ${named} ${captureFiles.length > 1 ? 'hold' : 'holds'} none of the sample requests of the exported endpoints; was ${file} built from ${captureFiles.length > 1 ? 'them' : 'it'}?`));
    }
    const target = await OutputTarget.of(ctx, out, result.filename);
    if (await target.overwrites(input)) throw new UsageError(Helpers.overwriteMessage(out, result.filename));
    await target.write(result.content, redact ? {} : { mode: ModelStore.PRIVATE_MODE });
    if (!target.stdout) ctx.out(ctx.ansi.clean(`Wrote ${target.label} (${result.format}, ${Text.plural(result.endpointCount, 'endpoint')})`));
    return ExitCode.OK;
  }

  async #captures(files: readonly string[], ctx: CliContext): Promise<Capture> {
    const inputs = [];
    for (const file of files) inputs.push({ capture: await this.#loader.capture(ctx.resolve(file)), file });
    return this.#merger.merge(inputs).capture;
  }

  #formats(): string[] {
    return this.#registry.list().map((exporter) => exporter.format);
  }

  #unknownFormat(format: string): UsageError {
    const formats = this.#formats();
    const names = [...formats, ...Object.keys(ExporterRegistry.ALIASES).filter((alias) => this.#registry.has(alias))];
    const guess = Text.closest(format.trim(), names);
    const hint = guess === undefined ? '' : `; did you mean '${guess}'?`;
    return new UsageError(`--format must be one of ${formats.join(', ')}; got '${format}'${hint}`, { details: { format, formats } });
  }

  static #options(values: OptionValues, redact: boolean): ExportOptions {
    const options: ExportOptions = { redact };
    const endpoints = OptionReader.list(values, 'endpoints');
    const baseUrl = OptionReader.string(values, 'base-url');
    const title = OptionReader.string(values, 'title');
    if (endpoints.length > 0) options.endpoints = endpoints;
    if (baseUrl !== undefined) options.baseUrl = baseUrl;
    if (title !== undefined) options.title = title;
    return options;
  }
}
