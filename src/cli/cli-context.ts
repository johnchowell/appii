import { isAbsolute, relative, resolve } from 'node:path';
import { Ansi } from '../shared/index.js';
import { TextLayout } from '../present/index.js';
import type { PresenterOptions } from '../present/index.js';
import { ProcessSignals } from './process-signals.js';
import type { CliSignals } from './process-signals.js';
import { StatusLine } from './status-line.js';

export interface CliIo {
  stdout: NodeJS.WritableStream & { columns?: number; isTTY?: boolean };
  stderr: NodeJS.WritableStream & { columns?: number; isTTY?: boolean };
  env: Record<string, string | undefined>;
  cwd: string;
  signals?: CliSignals;
}

export interface CliContextOptions {
  color?: boolean;
  width?: number;
}

export interface CliContextDeps {
  status?: StatusLine;
  signals?: CliSignals;
}

export class CliContext {
  static readonly DEFAULT_WIDTH = 100;
  static readonly NO_COLOR_VARIABLE = 'NO_COLOR';

  readonly io: CliIo;
  readonly ansi: Ansi;
  readonly width: number;
  readonly color: boolean;
  readonly signals: CliSignals;
  readonly #options: Readonly<CliContextOptions>;
  readonly #status: StatusLine;

  constructor(io: CliIo, options: CliContextOptions = {}, deps: CliContextDeps = {}) {
    this.io = io;
    this.#options = CliContext.#defined(options);
    this.color = options.color ?? CliContext.autoColor(io);
    this.width = options.width === undefined ? CliContext.autoWidth(io) : TextLayout.checkWidth(options.width);
    this.ansi = this.color ? Ansi.color : Ansi.plain;
    this.signals = deps.signals ?? io.signals ?? new ProcessSignals();
    this.#status = deps.status ?? new StatusLine(io.stderr);
  }

  static autoColor(io: Pick<CliIo, 'stdout' | 'env'>): boolean {
    const noColor = io.env[CliContext.NO_COLOR_VARIABLE];
    return io.stdout.isTTY === true && (noColor === undefined || noColor === '');
  }

  static autoWidth(io: Pick<CliIo, 'stdout'>): number {
    const columns = io.stdout.columns;
    return typeof columns === 'number' && Number.isInteger(columns) && columns > 0 ? columns : CliContext.DEFAULT_WIDTH;
  }

  get options(): Readonly<CliContextOptions> {
    return this.#options;
  }

  get interactive(): boolean {
    return this.#status.enabled;
  }

  out(text: string): void {
    this.#status.clear();
    this.io.stdout.write(text + '\n');
  }

  err(text: string): void {
    this.#status.clear();
    this.io.stderr.write(text + '\n');
  }

  write(content: string): void {
    this.#status.clear();
    this.io.stdout.write(content);
  }

  get progressWidth(): number {
    const columns = this.io.stderr.columns;
    return typeof columns === 'number' && Number.isInteger(columns) && columns > 0 ? Math.min(columns, this.width) : this.width;
  }

  progress(text: string): void {
    if (text === '') {
      this.#status.clear();
      return;
    }
    this.#status.show(TextLayout.fit(TextLayout.clean(text), Math.max(1, this.progressWidth - 1)));
  }

  withOptions(options: CliContextOptions): CliContext {
    return new CliContext(this.io, { ...this.#options, ...CliContext.#defined(options) }, { status: this.#status, signals: this.signals });
  }

  resolve(path: string): string {
    return resolve(this.io.cwd, path);
  }

  display(path: string): string {
    const absolute = this.resolve(path);
    const rel = relative(this.io.cwd, absolute);
    if (rel === '') return '.';
    if (rel === '..' || rel.startsWith('../') || rel.startsWith('..\\') || isAbsolute(rel)) return absolute;
    return rel;
  }

  presenterOptions(extra: PresenterOptions = {}): PresenterOptions {
    return { color: this.color, width: this.width, ...extra };
  }

  static #defined(options: CliContextOptions): CliContextOptions {
    const out: CliContextOptions = {};
    if (options.color !== undefined) out.color = options.color;
    if (options.width !== undefined) out.width = options.width;
    return out;
  }
}
