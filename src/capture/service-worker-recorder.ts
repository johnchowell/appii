import type { Exchange } from '../model/index.js';
import type { BodyBudget } from './body-budget.js';
import { Helpers } from './helpers.js';
import type { TargetChannel } from './target-channel.js';
import { WorkerNetworkLog } from './worker-network-log.js';
import type { WorkerRequest } from './worker-network-log.js';

export interface ServiceWorkerRecorderOptions {
  budget: BodyBudget;
  captureBodies: boolean;
  readTimeoutMs: number;
  flushTimeoutMs: number;
  bufferBytes: number;
  resourceBufferBytes: number;
  emit: (exchange: Exchange) => void;
  hasPageRequest: (method: string, url: string, startMs: number) => boolean;
}

interface WorkerTarget {
  active: WorkerNetworkLog | undefined;
  standby: TargetChannel[];
}

export class ServiceWorkerRecorder {
  static readonly MATCH_TOLERANCE_MS = 1000;

  readonly #options: ServiceWorkerRecorderOptions;
  readonly #targets = new Map<string, WorkerTarget>();
  readonly #requests: WorkerRequest[] = [];
  readonly #aliases = new Map<string, string>();
  readonly #logs = new Set<WorkerNetworkLog>();

  constructor(options: ServiceWorkerRecorderOptions) {
    this.#options = options;
  }

  async attach(channel: TargetChannel): Promise<void> {
    const targetId = channel.target.targetId;
    let target = this.#targets.get(targetId);
    if (!target) {
      target = { active: undefined, standby: [] };
      this.#targets.set(targetId, target);
    }
    channel.onClose(() => this.#detached(targetId, channel));
    if (target.active) {
      target.standby.push(channel);
      return;
    }
    await this.#activate(target, channel);
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

  get busy(): boolean {
    return [...this.#logs].some((log) => log.busy);
  }

  async settled(): Promise<void> {
    await Promise.allSettled([...this.#logs].map((log) => log.settled()));
  }

  finish(): void {
    for (const target of this.#targets.values()) {
      target.active?.finish();
      target.active = undefined;
      target.standby.length = 0;
    }
    this.#targets.clear();
  }

  flush(): void {
    for (const request of [...this.#requests]) if (request.settled) this.#settle(request, request.exchange, true);
  }

  clear(): void {
    this.#requests.length = 0;
    this.#aliases.clear();
  }

  async #activate(target: WorkerTarget, channel: TargetChannel): Promise<void> {
    const options = this.#options;
    const log = new WorkerNetworkLog(channel, {
      budget: options.budget,
      captureBodies: options.captureBodies,
      readTimeoutMs: options.readTimeoutMs,
      flushTimeoutMs: options.flushTimeoutMs,
      bufferBytes: options.bufferBytes,
      resourceBufferBytes: options.resourceBufferBytes,
      onRequest: (request) => {
        this.#requests.push(request);
      },
      onExchange: (request, exchange) => this.#settle(request, exchange, false),
    });
    target.active = log;
    this.#logs.add(log);
    const started = await log.start();
    if (started || target.active !== log) return;
    target.active = undefined;
    this.#logs.delete(log);
    const next = target.standby.shift();
    if (next && !next.closed) await this.#activate(target, next);
  }

  #detached(targetId: string, channel: TargetChannel): void {
    const target = this.#targets.get(targetId);
    if (!target) return;
    if (target.active?.channel === channel) {
      const log = target.active;
      log.finish();
      void log.settled().finally(() => this.#logs.delete(log));
      target.active = undefined;
      const next = target.standby.find((candidate) => !candidate.closed);
      target.standby = target.standby.filter((candidate) => candidate !== next && !candidate.closed);
      if (next) void this.#activate(target, next);
    } else {
      target.standby = target.standby.filter((candidate) => candidate !== channel);
    }
    if (!target.active && target.standby.length === 0) this.#targets.delete(targetId);
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
