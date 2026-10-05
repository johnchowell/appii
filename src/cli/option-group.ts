import type { ParseArgsOptionsConfig } from 'node:util';
import type { CliContext } from './cli-context.js';
import type { OptionValues } from './option-reader.js';

export interface OptionDoc {
  description: string;
  value?: string;
  flag?: string;
}

export type OptionDocs = Readonly<Record<string, OptionDoc>>;

export interface OptionGroup<T> {
  readonly options: ParseArgsOptionsConfig;
  readonly docs: OptionDocs;
  read(values: OptionValues, ctx: CliContext): T;
}
