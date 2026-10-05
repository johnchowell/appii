import { AppiiError, Fs, Json, Text } from '../shared/index.js';
import type { ApiModel } from '../model/index.js';
import { ModelValidator } from './model-validator.js';

export interface ModelStoreDeps {
  validator?: ModelValidator;
}

export interface ModelSaveOptions {
  private?: boolean;
}

export class ModelStore {
  static readonly VERSION = ModelValidator.VERSION;
  static readonly PRIVATE_MODE = 0o600;
  static readonly SHARED_MODE = 0o644;
  static readonly SUMMARY_PROBLEMS = 3;

  readonly #validator: ModelValidator;

  constructor(deps: ModelStoreDeps = {}) {
    this.#validator = deps.validator ?? new ModelValidator();
  }

  static looksLikeModel(value: unknown): boolean {
    return ModelValidator.looksLikeModel(value);
  }

  static serialize(model: ApiModel): string {
    return Text.toAscii(Json.prettyJson(model), 'escape') + '\n';
  }

  async load(path: string): Promise<ApiModel> {
    return this.parse(await Fs.readJson(path), path);
  }

  parse(value: unknown, path: string): ApiModel {
    if (Json.isPlainObject(value) && typeof value.version === 'number' && value.version !== ModelStore.VERSION && Array.isArray(value.endpoints)) {
      throw new AppiiError('BAD_INPUT', `${path} has unsupported API model version ${value.version}; this appii reads version ${ModelStore.VERSION}`);
    }
    const problems = this.#validator.validate(value);
    if (problems.length > 0) {
      throw new AppiiError('BAD_INPUT', `${path} is not a valid API model (api.json): ${ModelStore.#summary(problems)}`, { details: { problems } });
    }
    return value as ApiModel;
  }

  async save(path: string, model: ApiModel, options: ModelSaveOptions = {}): Promise<void> {
    const problems = this.#validator.validate(model);
    if (problems.length > 0) {
      throw new AppiiError('INTERNAL', `Refusing to save an invalid API model: ${ModelStore.#summary(problems)}`, { details: { problems } });
    }
    await Fs.writeFileAtomic(path, ModelStore.serialize(model), { mode: options.private === true ? ModelStore.PRIVATE_MODE : ModelStore.SHARED_MODE });
  }

  static #summary(problems: readonly string[]): string {
    const head = problems.slice(0, ModelStore.SUMMARY_PROBLEMS).join('; ');
    return problems.length > ModelStore.SUMMARY_PROBLEMS ? `${head}; and ${problems.length - ModelStore.SUMMARY_PROBLEMS} more` : head;
  }
}
