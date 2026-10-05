import { basename } from 'node:path';
import { CaptureStore } from '../capture/index.js';
import type { StoredKind } from '../capture/index.js';
import { ModelBuilder, ModelStore } from '../build/index.js';
import type { BuildOptions } from '../build/index.js';
import type { ApiModel, Capture } from '../model/index.js';

export type InputKind = StoredKind;

export interface LoadedInput {
  model: ApiModel;
  capture?: Capture;
  kind: InputKind;
}

export interface InputLoaderDeps {
  store?: CaptureStore;
  models?: ModelStore;
  builder?: (options: BuildOptions) => ModelBuilder;
}

export class InputLoader {
  readonly #store: CaptureStore;
  readonly #models: ModelStore;
  readonly #builder: (options: BuildOptions) => ModelBuilder;

  constructor(deps: InputLoaderDeps = {}) {
    this.#store = deps.store ?? new CaptureStore();
    this.#models = deps.models ?? new ModelStore();
    this.#builder = deps.builder ?? ((options: BuildOptions) => ModelBuilder.create(options));
  }

  static create(): InputLoader {
    return new InputLoader({ store: CaptureStore.create(), models: ModelStore.create(), builder: (options) => ModelBuilder.create(options) });
  }

  async load(path: string, buildOptions: BuildOptions = {}): Promise<LoadedInput> {
    const input = await this.#store.read(path);
    if (input.kind === 'model') return { model: this.#models.parse(input.value, path), kind: input.kind };
    const model = this.#builder(buildOptions).build(input.capture);
    return { model: { ...model, source: { ...model.source, file: basename(path) } }, capture: input.capture, kind: input.kind };
  }

  capture(path: string): Promise<Capture> {
    return this.#store.load(path);
  }
}
