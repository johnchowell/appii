import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliContext } from './cli-context.js';

export class Helpers {
  static readonly LIST_SEPARATOR: RegExp = /,/;
  static readonly DIRECTORY_SUFFIX: RegExp = /[\\/]$/;

  static splitList(values: readonly string[]): string[] {
    return values.flatMap((value) => value.split(Helpers.LIST_SEPARATOR)).map((part) => part.trim()).filter((part) => part !== '');
  }

  static async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  static overwriteMessage(explicit: string | undefined, defaultName: string, input = 'input file'): string {
    return explicit === undefined ? `the default output ${defaultName} is the ${input}; pass -o <file>` : `--out must not overwrite the ${input}`;
  }

  static async outputFile(ctx: CliContext, out: string | undefined, filename: string): Promise<string> {
    if (out === undefined) return ctx.resolve(filename);
    const path = ctx.resolve(out);
    return Helpers.DIRECTORY_SUFFIX.test(out) || (await Helpers.isDirectory(path)) ? join(path, filename) : path;
  }
}
