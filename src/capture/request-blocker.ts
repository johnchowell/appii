import type { BrowserContext, Page } from 'playwright';
import { AppiiError, Text } from '../shared/index.js';
import type { CdpRequestPaused, CdpTargetInfo } from './cdp-network-types.js';
import { Helpers } from './helpers.js';
import type { RootConnection, TargetChannelFactory } from './page-network-tap.js';
import { SessionConnection } from './session-connection.js';
import type { NetworkConnection } from './session-connection.js';
import { TargetChannel } from './target-channel.js';

export interface BlockedRequest {
  readonly method: string;
  readonly url: string;
}

export interface RequestBlockerDeps {
  channels?: TargetChannelFactory;
}

interface AttachedEvent {
  sessionId: string;
  targetInfo: CdpTargetInfo;
  waitingForDebugger?: boolean;
}

interface DetachedEvent {
  sessionId?: string;
}

interface TargetMessageEvent {
  sessionId?: string;
  message: string;
}

export class RequestBlocker {
  static readonly PATTERNS: readonly { urlPattern: string; requestStage: string }[] = [{ urlPattern: '*', requestStage: 'Request' }];
  static readonly ERROR_REASON = 'BlockedByClient';
  static readonly WATCHED_CHILDREN: readonly string[] = ['iframe', 'service_worker'];
  static readonly PREPARE_TIMEOUT_MS = 5000;
  static readonly FRAME = 'iframe';

  readonly blocked: BlockedRequest[] = [];
  readonly #root: RootConnection;
  readonly #channelFactory: TargetChannelFactory;
  readonly #channels = new Set<TargetChannel>();
  readonly #preparing = new Set<Promise<void>>();
  readonly #failures: string[] = [];
  #closed = false;

  constructor(root: RootConnection, deps: RequestBlockerDeps = {}) {
    this.#root = root;
    this.#channelFactory = deps.channels ?? ((parent, sessionId, target) => new TargetChannel(parent, sessionId, target));
    this.#watch(root);
  }

  static create(root: RootConnection): RequestBlocker {
    return new RequestBlocker(root, { channels: (parent, sessionId, target) => new TargetChannel(parent, sessionId, target) });
  }

  static async start(context: BrowserContext, page: Page): Promise<RequestBlocker> {
    let connection: SessionConnection;
    try {
      connection = new SessionConnection(await context.newCDPSession(page));
    } catch (err) {
      throw new AppiiError('CAPTURE', `Cannot stop the requests of the page: ${Text.errorMessage(err, { firstLine: true })}`, { cause: err });
    }
    const blocker = RequestBlocker.create(connection);
    try {
      await blocker.#enable();
    } catch (err) {
      await blocker.stop();
      throw err;
    }
    return blocker;
  }

  static autoAttach(): Record<string, unknown> {
    const filter = [...RequestBlocker.WATCHED_CHILDREN.map((type) => ({ type, exclude: false })), { exclude: true }];
    return { autoAttach: true, waitForDebuggerOnStart: true, flatten: false, filter };
  }

  isBlocked(method: string, url: string): boolean {
    const key = Helpers.withoutFragment(url);
    return this.blocked.some((request) => request.method === method && Helpers.withoutFragment(request.url) === key);
  }

  async stop(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const channels = [...this.#channels];
    this.#channels.clear();
    await Promise.allSettled(channels.map((channel) => channel.send('Fetch.disable')));
    await Promise.allSettled(channels.map((channel) => channel.detach()));
    await this.#root.send('Fetch.disable').catch(() => undefined);
    await this.#root.detach().catch(() => undefined);
  }

  async #enable(): Promise<void> {
    await this.#root.send('Fetch.enable', { patterns: RequestBlocker.PATTERNS });
    await this.#root.send('Target.setAutoAttach', RequestBlocker.autoAttach());
    while (this.#preparing.size > 0) await Promise.all([...this.#preparing]);
    if (this.#failures.length > 0) {
      throw new AppiiError('CAPTURE', `Cannot stop the requests of ${this.#failures.join(', ')}, so the login form was not probed`);
    }
  }

  #watch(connection: NetworkConnection): Map<string, TargetChannel> {
    const children = new Map<string, TargetChannel>();
    connection.on((method, params) => {
      switch (method) {
        case 'Fetch.requestPaused':
          void this.#block(connection, params as unknown as CdpRequestPaused);
          break;
        case 'Target.attachedToTarget':
          this.#attached(connection, children, params as unknown as AttachedEvent);
          break;
        case 'Target.detachedFromTarget': {
          const id = (params as unknown as DetachedEvent).sessionId;
          if (id === undefined) break;
          const channel = children.get(id);
          children.delete(id);
          if (channel) this.#channels.delete(channel);
          channel?.close();
          break;
        }
        case 'Target.receivedMessageFromTarget': {
          const event = params as unknown as TargetMessageEvent;
          if (event.sessionId !== undefined) children.get(event.sessionId)?.receive(event.message);
          break;
        }
        default:
          break;
      }
    });
    return children;
  }

  async #block(connection: NetworkConnection, event: CdpRequestPaused): Promise<void> {
    this.blocked.push({ method: event.request.method, url: event.request.url });
    await connection.send('Fetch.failRequest', { requestId: event.requestId, errorReason: RequestBlocker.ERROR_REASON }).catch(() => undefined);
  }

  #attached(parent: NetworkConnection, children: Map<string, TargetChannel>, event: AttachedEvent): void {
    const channel = this.#channelFactory(parent, event.sessionId, event.targetInfo);
    children.set(event.sessionId, channel);
    this.#channels.add(channel);
    const nested = this.#watch(channel);
    channel.onClose(() => {
      for (const child of nested.values()) child.close();
      nested.clear();
    });
    const prepare = (async (): Promise<void> => {
      await channel.send('Fetch.enable', { patterns: RequestBlocker.PATTERNS });
      if (event.targetInfo.type === RequestBlocker.FRAME) await channel.send('Target.setAutoAttach', RequestBlocker.autoAttach());
    })();
    const ready = Helpers.settle(
      prepare.then(
        () => true,
        () => false,
      ),
      RequestBlocker.PREPARE_TIMEOUT_MS,
    ).then(async (blocking) => {
      if (blocking === true) await channel.resume();
      else if (event.waitingForDebugger !== true) this.#failures.push(`the ${event.targetInfo.type} ${event.targetInfo.url}`);
    });
    this.#preparing.add(ready);
    void ready.finally(() => this.#preparing.delete(ready));
  }
}
