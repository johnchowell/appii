import { Writable } from 'node:stream';
import { CliApp, CommandRegistry } from '../../src/cli/index.js';
import type { CliIo, CliSignal, CliSignals } from '../../src/cli/index.js';

export interface MemoryStreamOptions {
  isTTY?: boolean;
  columns?: number;
}

export class MemoryStream extends Writable {
  readonly chunks: string[] = [];
  isTTY?: boolean;
  columns?: number;

  constructor(options: MemoryStreamOptions = {}) {
    super();
    if (options.isTTY !== undefined) this.isTTY = options.isTTY;
    if (options.columns !== undefined) this.columns = options.columns;
  }

  override _write(chunk: Buffer | string, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(chunk.toString());
    callback();
  }

  get text(): string {
    return this.chunks.join('');
  }
}

export class FakeSignals implements CliSignals {
  readonly exits: number[] = [];
  readonly #listeners = new Map<CliSignal, Set<() => void>>();

  on(signal: CliSignal, listener: () => void): void {
    const set = this.#listeners.get(signal) ?? new Set();
    set.add(listener);
    this.#listeners.set(signal, set);
  }

  off(signal: CliSignal, listener: () => void): void {
    this.#listeners.get(signal)?.delete(listener);
  }

  exit(code: number): void {
    this.exits.push(code);
  }

  count(signal: CliSignal): number {
    return this.#listeners.get(signal)?.size ?? 0;
  }

  emit(signal: CliSignal): void {
    for (const listener of [...(this.#listeners.get(signal) ?? [])]) listener();
  }
}

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
}

export interface CliRunOptions {
  tty?: boolean;
  stderrTty?: boolean;
  columns?: number;
  env?: Record<string, string | undefined>;
  signals?: CliSignals;
  registry?: CommandRegistry;
}

export class CliHarness {
  readonly cwd: string;

  constructor(cwd: string) {
    this.cwd = cwd;
  }

  io(options: CliRunOptions = {}): { io: CliIo; stdout: MemoryStream; stderr: MemoryStream } {
    const stdout = new MemoryStream({
      ...(options.tty === undefined ? {} : { isTTY: options.tty }),
      ...(options.columns === undefined ? {} : { columns: options.columns }),
    });
    const stderr = new MemoryStream(options.stderrTty === undefined ? {} : { isTTY: options.stderrTty });
    const io: CliIo = { stdout, stderr, env: options.env ?? {}, cwd: this.cwd, signals: options.signals ?? new FakeSignals() };
    return { io, stdout, stderr };
  }

  async run(args: string[], options: CliRunOptions = {}): Promise<CliRun> {
    const { io, stdout, stderr } = this.io(options);
    const app = options.registry ? new CliApp(options.registry, io) : CliApp.create(io);
    const code = await app.run(args);
    return { code, stdout: stdout.text, stderr: stderr.text };
  }

  static lines(text: string): string[] {
    return text.split('\n');
  }

  static widest(text: string): number {
    return Math.max(0, ...CliHarness.lines(text).map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').length));
  }

  static isAscii(text: string): boolean {
    return /^[\x00-\x7f]*$/.test(text);
  }
}
