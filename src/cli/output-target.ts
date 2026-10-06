import { Fs } from '../shared/index.js';
import type { CliContext } from './cli-context.js';
import { Helpers } from './helpers.js';
import { UsageError } from './usage-error.js';

export type OutputData = string | Iterable<string>;

export interface OutputWriteOptions {
  mode?: number;
}

export class OutputTarget {
  static readonly STDOUT = '-';
  static readonly STDOUT_LABEL = 'stdout';

  readonly path: string | undefined;
  readonly label: string;
  readonly #ctx: CliContext;

  constructor(ctx: CliContext, path: string | undefined) {
    this.#ctx = ctx;
    this.path = path;
    this.label = path === undefined ? OutputTarget.STDOUT_LABEL : ctx.display(path);
  }

  static isStdout(value: string | undefined): boolean {
    return value === OutputTarget.STDOUT;
  }

  static async of(ctx: CliContext, explicit: string | undefined, filename: string): Promise<OutputTarget> {
    return new OutputTarget(ctx, OutputTarget.isStdout(explicit) ? undefined : await Helpers.outputFile(ctx, explicit, filename));
  }

  static file(ctx: CliContext, path: string): OutputTarget {
    return new OutputTarget(ctx, path);
  }

  static refuseStdout(option: string, value: string | undefined, reason: string): void {
    if (OutputTarget.isStdout(value)) throw new UsageError(`${option} ${OutputTarget.STDOUT} is not supported: ${reason}`);
  }

  get stdout(): boolean {
    return this.path === undefined;
  }

  get saved(): string {
    return `${this.stdout ? 'written to' : 'saved to'} ${this.label}`;
  }

  async overwrites(input: string): Promise<boolean> {
    return this.path !== undefined && (await Fs.sameFile(this.path, input));
  }

  async write(data: OutputData, options: OutputWriteOptions = {}): Promise<void> {
    if (this.path !== undefined) {
      await Fs.writeFileAtomic(this.path, data, options);
      return;
    }
    for (const chunk of typeof data === 'string' ? [data] : data) this.#ctx.write(chunk);
  }

  report(text: string): void {
    if (this.stdout) this.#ctx.err(text);
    else this.#ctx.out(text);
  }
}
