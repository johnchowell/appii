import type { CDPSession } from 'playwright';

export type ConnectionListener = (method: string, params: Record<string, unknown>) => void;

export interface NetworkConnection {
  readonly key: string;
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  on(listener: ConnectionListener): () => void;
}

type SessionSend = (method: string, params?: Record<string, unknown>) => Promise<unknown>;
type SessionOn = (event: string, handler: (params: Record<string, unknown>) => void) => unknown;

export class SessionConnection implements NetworkConnection {
  static readonly ROOT_KEY = 'page';
  static readonly EVENTS: readonly string[] = [
    'Network.requestWillBeSent',
    'Network.requestWillBeSentExtraInfo',
    'Network.responseReceivedExtraInfo',
    'Network.requestServedFromCache',
    'Network.responseReceived',
    'Network.dataReceived',
    'Network.loadingFinished',
    'Network.loadingFailed',
    'Target.attachedToTarget',
    'Target.detachedFromTarget',
    'Target.receivedMessageFromTarget',
    'Target.targetCreated',
    'Target.targetDestroyed',
  ];

  readonly key = SessionConnection.ROOT_KEY;
  readonly #session: CDPSession;

  constructor(session: CDPSession) {
    this.#session = session;
  }

  send<T>(method: string, params?: Record<string, unknown>): Promise<T> {
    const send = this.#session.send as unknown as SessionSend;
    return send.call(this.#session, method, params) as Promise<T>;
  }

  on(listener: ConnectionListener): () => void {
    const on = this.#session.on as unknown as SessionOn;
    const off = this.#session.off as unknown as SessionOn;
    const handlers = SessionConnection.EVENTS.map((event): [string, (params: Record<string, unknown>) => void] => [event, (params) => listener(event, params ?? {})]);
    for (const [event, handler] of handlers) on.call(this.#session, event, handler);
    return () => {
      for (const [event, handler] of handlers) off.call(this.#session, event, handler);
    };
  }

  async detach(): Promise<void> {
    await this.#session.detach();
  }
}
