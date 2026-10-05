import type { CdpTargetInfo } from './cdp-network-types.js';
import type { ConnectionListener, NetworkConnection } from './session-connection.js';

export interface ChannelParent {
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
}

interface PendingReply {
  readonly method: string;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

interface ChannelMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message?: string };
}

export class TargetChannel implements NetworkConnection {
  static readonly RESUME = 'Runtime.runIfWaitingForDebugger';

  readonly sessionId: string;
  readonly key: string;
  readonly target: Readonly<CdpTargetInfo>;
  readonly #parent: ChannelParent;
  readonly #listeners = new Set<ConnectionListener>();
  readonly #closeListeners = new Set<() => void>();
  readonly #replies = new Map<number, PendingReply>();
  #nextId = 1;
  #resumed: Promise<void> | undefined;
  #closed = false;

  constructor(parent: ChannelParent, sessionId: string, target: CdpTargetInfo) {
    this.#parent = parent;
    this.sessionId = sessionId;
    this.key = sessionId;
    this.target = { targetId: target.targetId, type: target.type, url: target.url };
  }

  get closed(): boolean {
    return this.#closed;
  }

  send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    if (this.#closed) return Promise.reject(new Error(`The ${this.target.type} session is closed`));
    const id = this.#nextId++;
    const reply = new Promise<T>((resolve, reject) => {
      this.#replies.set(id, { method, resolve: resolve as (value: unknown) => void, reject });
    });
    this.#parent.send('Target.sendMessageToTarget', { sessionId: this.sessionId, message: JSON.stringify({ id, method, params }) }).catch((err: unknown) => {
      const pending = this.#replies.get(id);
      if (!pending) return;
      this.#replies.delete(id);
      pending.reject(err instanceof Error ? err : new Error(String(err)));
    });
    return reply;
  }

  resume(): Promise<void> {
    this.#resumed ??= this.send(TargetChannel.RESUME).then(
      () => undefined,
      () => undefined,
    );
    return this.#resumed;
  }

  on(listener: ConnectionListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onClose(listener: () => void): void {
    if (this.#closed) listener();
    else this.#closeListeners.add(listener);
  }

  receive(message: string): void {
    let parsed: ChannelMessage;
    try {
      parsed = JSON.parse(message) as ChannelMessage;
    } catch {
      return;
    }
    if (typeof parsed.id === 'number') {
      const pending = this.#replies.get(parsed.id);
      if (!pending) return;
      this.#replies.delete(parsed.id);
      if (parsed.error) pending.reject(new Error(`${pending.method}: ${parsed.error.message ?? 'protocol error'}`));
      else pending.resolve(parsed.result);
      return;
    }
    if (typeof parsed.method !== 'string') return;
    const params = parsed.params ?? {};
    for (const listener of [...this.#listeners]) {
      try {
        listener(parsed.method, params);
      } catch {
        continue;
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#replies.values()) pending.reject(new Error(`The ${this.target.type} session is closed`));
    this.#replies.clear();
    this.#listeners.clear();
    const listeners = [...this.#closeListeners];
    this.#closeListeners.clear();
    for (const listener of listeners) {
      try {
        listener();
      } catch {
        continue;
      }
    }
  }
}
