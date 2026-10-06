import { ModelBuilder, ModelStore, Redactor } from '../build/index.js';
import type { BuildOptions } from '../build/index.js';
import { PresenterFactory } from '../present/index.js';
import { Text } from '../shared/index.js';
import type { ApiModel, Capture, SourceCapture } from '../model/index.js';
import type { CliContext } from './cli-context.js';
import type { OutputTarget } from './output-target.js';

export interface BuildRequest {
  out: OutputTarget;
  source?: string;
  sources?: readonly SourceCapture[];
  options: BuildOptions;
  hints?: boolean;
}

export interface BuildStepDeps {
  builder?: (options: BuildOptions) => ModelBuilder;
  models?: ModelStore;
}

export class BuildStep {
  readonly #builder: (options: BuildOptions) => ModelBuilder;
  readonly #models: ModelStore;

  constructor(deps: BuildStepDeps = {}) {
    this.#builder = deps.builder ?? ((options: BuildOptions) => ModelBuilder.create(options));
    this.#models = deps.models ?? new ModelStore();
  }

  static create(): BuildStep {
    return new BuildStep({ builder: (options) => ModelBuilder.create(options), models: ModelStore.create() });
  }

  build(capture: Capture, options: BuildOptions, source?: string, sources: readonly SourceCapture[] = []): ApiModel {
    const model = this.#builder(options).build(capture);
    const captures = sources.length > 1 ? BuildStep.#listed(sources, options) : undefined;
    if (source === undefined && captures === undefined) return model;
    return { ...model, source: { ...model.source, ...(source === undefined ? {} : { file: source }), ...(captures === undefined ? {} : { captures }) } };
  }

  async run(capture: Capture, request: BuildRequest, ctx: CliContext): Promise<ApiModel> {
    const model = this.build(capture, request.options, request.source, request.sources);
    await request.out.write(this.#models.text(model), { mode: ModelStore.mode({ private: request.options.redact === false }) });
    request.out.report(this.report(model, request.out, ctx, request.hints ?? true));
    return model;
  }

  static #listed(sources: readonly SourceCapture[], options: BuildOptions): SourceCapture[] {
    const redactor = Redactor.create({ redact: options.redact ?? true });
    return sources.map((source) => (source.startUrl === undefined ? { ...source } : { ...source, startUrl: redactor.url(source.startUrl) }));
  }

  report(model: ApiModel, out: OutputTarget, ctx: CliContext, hints = true): string {
    const presenters = new PresenterFactory(ctx.presenterOptions({ file: out.label, hints: hints && !out.stdout }));
    const endpoints = Text.plural(model.endpoints.length, 'endpoint');
    const wrote = ctx.ansi.clean(out.stdout ? `Wrote the API model to ${out.label} (${endpoints})` : `Wrote ${out.label} (${endpoints})`);
    return [wrote, presenters.summary().render(model), presenters.list().render(model)].join('\n\n');
  }
}
