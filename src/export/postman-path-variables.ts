import type { ParamInfo } from '../model/index.js';
import { SampleText, Schema, Text } from '../shared/index.js';

export interface PostmanPathVariable {
  readonly key: string;
  readonly name: string;
  readonly type: string;
  readonly value: string;
}

export class PostmanPathVariables {
  static readonly SAFE_KEY: RegExp = /^[A-Za-z0-9_.-]+$/;
  static readonly SEPARATOR = '_';
  static readonly DESCRIPTION_SUFFIX = 'path parameter';

  readonly #taken: Set<string>;
  readonly #variables: PostmanPathVariable[] = [];

  static create(taken: Iterable<string> = []): PostmanPathVariables {
    return new PostmanPathVariables(taken);
  }

  constructor(taken: Iterable<string> = []) {
    this.#taken = new Set(taken);
  }

  key(name: string, param: ParamInfo | undefined, value: string): string {
    const type = Schema.typeLabel(param?.schema);
    const known = this.#variables.find((variable) => variable.name === name && variable.type === type);
    if (known) return known.key;
    const base = PostmanPathVariables.SAFE_KEY.test(name) ? name : SampleText.placeholderName(name);
    const key = Text.uniqueName(base, this.#taken, PostmanPathVariables.SEPARATOR);
    this.#variables.push({ key, name, type, value });
    return key;
  }

  entries(): Record<string, unknown>[] {
    return this.#variables.map((variable) => ({ key: variable.key, value: variable.value, type: 'string', description: `${variable.type} ${PostmanPathVariables.DESCRIPTION_SUFFIX}` }));
  }
}
