import type { BrowserContext, Request } from 'playwright';

export interface NetworkIdleMonitorOptions {
  stalledAfterMs?: number;
}

interface IdleWaiter {
  readonly idleMs: number;
  readonly resolve: () => void;
  timer?: NodeJS.Timeout;
}

export class NetworkIdleMonitor {
  static readonly LONG_LIVED_TYPES: ReadonlySet<string> = new Set(['eventsource', 'websocket']);
  static readonly DEFAULT_STALLED_AFTER_MS = 30000;

  readonly #stalledAfterMs: number;
  readonly #busy = new Map<Request, NodeJS.Timeout>();
  readonly #waiters = new Set<IdleWaiter>();
  #context: BrowserContext | undefined;

  constructor(options: NetworkIdleMonitorOptions = {}) {
    this.#stalledAfterMs = options.stalledAfterMs ?? NetworkIdleMonitor.DEFAULT_STALLED_AFTER_MS;
  }

  get inflight(): number {
    return this.#busy.size;
  }

  attach(context: BrowserContext): void {
    if (this.#context) return;
    this.#context = context;
    context.on('request', this.#onRequest);
    context.on('requestfinished', this.#onDone);
    context.on('requestfailed', this.#onDone);
  }

  detach(): void {
    const context = this.#context;
    if (context) {
      context.off('request', this.#onRequest);
      context.off('requestfinished', this.#onDone);
      context.off('requestfailed', this.#onDone);
    }
    this.#context = undefined;
    for (const timer of this.#busy.values()) clearTimeout(timer);
    this.#busy.clear();
    for (const waiter of this.#waiters) clearTimeout(waiter.timer);
    this.#waiters.clear();
  }

  waitForIdle(idleMs: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const waiter: IdleWaiter = { idleMs: Math.max(0, idleMs), resolve };
      this.#waiters.add(waiter);
      this.#update();
    });
  }

  readonly #onRequest = (request: Request): void => {
    if (NetworkIdleMonitor.LONG_LIVED_TYPES.has(request.resourceType())) return;
    const timer = setTimeout(() => this.#onDone(request), this.#stalledAfterMs);
    timer.unref();
    this.#busy.set(request, timer);
    this.#update();
  };

  readonly #onDone = (request: Request): void => {
    const timer = this.#busy.get(request);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.#busy.delete(request);
    this.#update();
  };

  #update(): void {
    const idle = this.#busy.size === 0;
    for (const waiter of this.#waiters) {
      if (!idle) {
        clearTimeout(waiter.timer);
        waiter.timer = undefined;
      } else if (waiter.timer === undefined) {
        waiter.timer = setTimeout(() => {
          this.#waiters.delete(waiter);
          waiter.resolve();
        }, waiter.idleMs);
      }
    }
  }
}
