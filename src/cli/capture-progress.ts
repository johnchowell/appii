import { Text } from '../shared/index.js';
import type { Exchange } from '../model/index.js';
import type { CliContext } from './cli-context.js';

export interface CaptureProgressOptions {
  intervalMs?: number;
  now?: () => number;
}

export class CaptureProgress {
  static readonly INTERVAL_MS = 100;
  static readonly FAILED_STATUS = 'failed';

  readonly #ctx: CliContext;
  readonly #intervalMs: number;
  readonly #now: () => number;
  #count = 0;
  #drawnAt = Number.NEGATIVE_INFINITY;

  constructor(ctx: CliContext, options: CaptureProgressOptions = {}) {
    this.#ctx = ctx;
    this.#intervalMs = options.intervalMs ?? CaptureProgress.INTERVAL_MS;
    this.#now = options.now ?? Date.now;
  }

  static line(count: number, exchange: Exchange): string {
    const status = exchange.response ? String(exchange.response.status) : CaptureProgress.FAILED_STATUS;
    return `Recording: ${Text.plural(count, 'request')}, last ${exchange.request.method} ${status} ${exchange.request.url}`;
  }

  get count(): number {
    return this.#count;
  }

  record(exchange: Exchange): void {
    this.#count++;
    if (!this.#ctx.interactive) return;
    const now = this.#now();
    if (now - this.#drawnAt < this.#intervalMs) return;
    this.#drawnAt = now;
    this.#ctx.progress(CaptureProgress.line(this.#count, exchange));
  }

  finish(): void {
    this.#ctx.progress('');
  }
}
