import { basename } from 'node:path';
import { CaptureStore } from '../capture/index.js';
import { ModelBuilder } from '../build/index.js';
import type { BuildOptions } from '../build/index.js';
import { Fs } from '../shared/index.js';
import type { ApiModel, Capture } from '../model/index.js';
import { ModelStore } from './model-store.js';

export type InputKind = 'model' | 'capture' | 'har';

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
    return new InputLoader({ store: new CaptureStore(), models: new ModelStore(), builder: (options) => ModelBuilder.create(options) });
  }

  async load(path: string, buildOptions: BuildOptions = {}): Promise<LoadedInput> {
    const value = await Fs.readJson(path);
    if (ModelStore.looksLikeModel(value)) return { model: this.#models.parse(value, path), kind: 'model' };
    const kind: InputKind = CaptureStore.isHar(value) ? 'har' : 'capture';
    const capture = await this.#store.load(path);
    const model = this.#builder(buildOptions).build(capture);
    return { model: { ...model, source: { ...model.source, file: basename(path) } }, capture, kind };
  }

  capture(path: string): Promise<Capture> {
    return this.#store.load(path);
  }
}
