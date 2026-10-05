import { ModelBuilder, ModelStore } from '../build/index.js';
import type { BuildOptions } from '../build/index.js';
import { PresenterFactory, TextLayout } from '../present/index.js';
import { Text } from '../shared/index.js';
import type { ApiModel, Capture } from '../model/index.js';
import type { CliContext } from './cli-context.js';

export interface BuildRequest {
  out: string;
  source?: string;
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

  build(capture: Capture, options: BuildOptions, source?: string): ApiModel {
    const model = this.#builder(options).build(capture);
    return source === undefined ? model : { ...model, source: { ...model.source, file: source } };
  }

  async run(capture: Capture, request: BuildRequest, ctx: CliContext): Promise<ApiModel> {
    const model = this.build(capture, request.options, request.source);
    await this.#models.save(request.out, model, { private: request.options.redact === false });
    ctx.out(this.report(model, request.out, ctx, request.hints ?? true));
    return model;
  }

  report(model: ApiModel, out: string, ctx: CliContext, hints = true): string {
    const file = ctx.display(out);
    const presenters = new PresenterFactory(ctx.presenterOptions({ file, hints }));
    const wrote = TextLayout.clean(`Wrote ${file} (${Text.plural(model.endpoints.length, 'endpoint')})`);
    return [wrote, presenters.summary().render(model), presenters.list().render(model)].join('\n\n');
  }
}
