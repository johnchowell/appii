import type { Exchange } from '../model/index.js';
import { Helpers } from './helpers.js';

export interface ServiceWorkerRecorderOptions {
  emit: (exchange: Exchange) => void;
  hasPageRequest: (method: string, url: string, startMs: number) => boolean;
}

export interface WorkerRequest {
  readonly method: string;
  readonly url: string;
  readonly startMs: number;
  readonly done: Promise<Exchange | undefined>;
  exchange: Exchange | undefined;
  settled: boolean;
  claimed: boolean;
}

export class ServiceWorkerRecorder {
  static readonly MATCH_TOLERANCE_MS = 1000;

  readonly #options: ServiceWorkerRecorderOptions;
  readonly #requests: WorkerRequest[] = [];
  readonly #resolvers = new WeakMap<WorkerRequest, (exchange: Exchange | undefined) => void>();
  readonly #aliases = new Map<string, string>();

  constructor(options: ServiceWorkerRecorderOptions) {
    this.#options = options;
  }

  static create(options: ServiceWorkerRecorderOptions): ServiceWorkerRecorder {
    return new ServiceWorkerRecorder(options);
  }

  track(method: string, url: string, startMs: number): WorkerRequest {
    let resolve: (exchange: Exchange | undefined) => void = () => undefined;
    const done = new Promise<Exchange | undefined>((settle) => {
      resolve = settle;
    });
    const request: WorkerRequest = { method, url, startMs, done, exchange: undefined, settled: false, claimed: false };
    this.#resolvers.set(request, resolve);
    this.#requests.push(request);
    return request;
  }

  settle(request: WorkerRequest, exchange: Exchange | undefined): void {
    if (request.settled) return;
    request.exchange = exchange;
    request.settled = true;
    this.#resolvers.get(request)?.(exchange);
    this.#resolvers.delete(request);
    this.#settle(request, exchange, false);
  }

  claim(method: string, url: string, fromMs: number, toMs: number): WorkerRequest | undefined {
    const key = Helpers.withoutFragment(url);
    const tolerance = ServiceWorkerRecorder.MATCH_TOLERANCE_MS;
    let chosen: WorkerRequest | undefined;
    for (const request of this.#requests) {
      if (request.claimed || request.method !== method || Helpers.withoutFragment(request.url) !== key) continue;
      if (request.startMs < fromMs - tolerance || request.startMs > toMs + tolerance) continue;
      if (!chosen || request.startMs < chosen.startMs) chosen = request;
    }
    if (!chosen) return undefined;
    chosen.claimed = true;
    this.#requests.splice(this.#requests.indexOf(chosen), 1);
    return chosen;
  }

  alias(workerId: string, pageId: string): void {
    this.#aliases.set(workerId, pageId);
  }

  release(): void {
    for (const request of [...this.#requests]) if (request.settled) this.#settle(request, request.exchange, false);
  }

  flush(): void {
    for (const request of [...this.#requests]) if (request.settled) this.#settle(request, request.exchange, true);
  }

  clear(): void {
    this.#requests.length = 0;
    this.#aliases.clear();
  }

  #settle(request: WorkerRequest, exchange: Exchange | undefined, force: boolean): void {
    if (request.claimed) return;
    const index = this.#requests.indexOf(request);
    if (index < 0) return;
    if (exchange && !force && this.#options.hasPageRequest(request.method, request.url, request.startMs)) return;
    this.#requests.splice(index, 1);
    if (!exchange) return;
    const from = exchange.redirectedFrom;
    const alias = from === undefined ? undefined : this.#aliases.get(from);
    this.#options.emit(alias === undefined ? exchange : { ...exchange, redirectedFrom: alias });
  }
}
