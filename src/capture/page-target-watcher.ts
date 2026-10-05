import type { BrowserContext, Page } from 'playwright';
import type { CdpTargetInfo } from './cdp-network-types.js';
import { PageNetworkTap } from './page-network-tap.js';
import type { PageNetworkTapOptions, RootConnection, TargetChannelFactory } from './page-network-tap.js';
import { SessionConnection } from './session-connection.js';
import { TargetChannel } from './target-channel.js';

export type ChannelTapOpener = (root: RootConnection, options: PageNetworkTapOptions) => Promise<PageNetworkTap | undefined>;

export interface PageTargetWatcherDeps {
  channels?: TargetChannelFactory;
  taps?: ChannelTapOpener;
}

interface TargetEvent {
  targetInfo: CdpTargetInfo;
}

interface TargetIdEvent {
  targetId: string;
}

interface SessionEvent {
  sessionId?: string;
  message?: string;
}

interface AttachResult {
  sessionId: string;
}

interface TargetInfoResult {
  targetInfo: CdpTargetInfo;
}

export class PageTargetWatcher {
  static readonly PAGE = 'page';

  readonly #root: RootConnection;
  readonly #options: PageNetworkTapOptions;
  readonly #channelFactory: TargetChannelFactory;
  readonly #openTap: ChannelTapOpener;
  readonly #channels = new Map<string, TargetChannel>();
  readonly #taps = new Map<string, Promise<PageNetworkTap | undefined>>();
  readonly #taken = new Set<string>();
  readonly #unsubscribe: () => void;
  #closed = false;

  constructor(root: RootConnection, options: PageNetworkTapOptions, deps: PageTargetWatcherDeps = {}) {
    this.#root = root;
    this.#options = options;
    this.#channelFactory = deps.channels ?? ((parent, sessionId, target) => new TargetChannel(parent, sessionId, target));
    this.#openTap = deps.taps ?? PageNetworkTap.attach;
    this.#unsubscribe = root.on(this.#onEvent);
  }

  static create(root: RootConnection, options: PageNetworkTapOptions): PageTargetWatcher {
    return new PageTargetWatcher(root, options, { channels: (parent, sessionId, target) => new TargetChannel(parent, sessionId, target), taps: PageNetworkTap.attach });
  }

  static async start(context: BrowserContext, options: PageNetworkTapOptions): Promise<PageTargetWatcher | undefined> {
    const browser = context.browser();
    if (!browser) return undefined;
    let root: SessionConnection;
    try {
      root = new SessionConnection(await browser.newBrowserCDPSession());
    } catch {
      return undefined;
    }
    const watcher = PageTargetWatcher.create(root, options);
    try {
      await root.send('Target.setDiscoverTargets', { discover: true, filter: [{ type: PageTargetWatcher.PAGE, exclude: false }, { exclude: true }] });
      return watcher;
    } catch {
      await watcher.close();
      return undefined;
    }
  }

  static async targetId(context: BrowserContext, page: Page): Promise<string | undefined> {
    try {
      const session = await context.newCDPSession(page);
      try {
        const result = await new SessionConnection(session).send<TargetInfoResult>('Target.getTargetInfo');
        return result.targetInfo.targetId;
      } finally {
        await session.detach().catch(() => undefined);
      }
    } catch {
      return undefined;
    }
  }

  take(targetId: string): Promise<PageNetworkTap | undefined> | undefined {
    const tap = this.#taps.get(targetId);
    this.#taps.delete(targetId);
    this.#taken.add(targetId);
    return tap;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#unsubscribe();
    const pending = [...this.#taps.values()];
    this.#taps.clear();
    await Promise.allSettled(pending.map((tap) => tap.then((opened) => opened?.close())));
    for (const channel of this.#channels.values()) channel.close();
    this.#channels.clear();
    await this.#root.detach().catch(() => undefined);
  }

  readonly #onEvent = (method: string, params: Record<string, unknown>): void => {
    if (this.#closed) return;
    switch (method) {
      case 'Target.targetCreated': {
        const info = (params as unknown as TargetEvent).targetInfo;
        if (info.type === PageTargetWatcher.PAGE && !this.#taps.has(info.targetId) && !this.#taken.has(info.targetId)) this.#taps.set(info.targetId, this.#attach(info));
        break;
      }
      case 'Target.targetDestroyed': {
        const id = (params as unknown as TargetIdEvent).targetId;
        this.#taken.delete(id);
        this.#discard(id);
        break;
      }
      case 'Target.receivedMessageFromTarget': {
        const event = params as unknown as SessionEvent;
        if (event.sessionId !== undefined && event.message !== undefined) this.#channels.get(event.sessionId)?.receive(event.message);
        break;
      }
      case 'Target.detachedFromTarget': {
        const id = (params as unknown as SessionEvent).sessionId;
        const channel = id === undefined ? undefined : this.#channels.get(id);
        if (!channel || id === undefined) break;
        this.#channels.delete(id);
        channel.close();
        break;
      }
      default:
        break;
    }
  };

  async #attach(info: CdpTargetInfo): Promise<PageNetworkTap | undefined> {
    let attached: AttachResult;
    try {
      attached = await this.#root.send<AttachResult>('Target.attachToTarget', { targetId: info.targetId, flatten: false });
    } catch {
      return undefined;
    }
    const channel = this.#channelFactory(this.#root, attached.sessionId, info);
    this.#channels.set(attached.sessionId, channel);
    channel.onClose(() => {
      if (this.#channels.get(attached.sessionId) === channel) this.#channels.delete(attached.sessionId);
    });
    if (this.#closed) {
      await channel.detach();
      return undefined;
    }
    return this.#openTap(channel, this.#options);
  }

  #discard(targetId: string): void {
    const tap = this.#taps.get(targetId);
    if (!tap) return;
    this.#taps.delete(targetId);
    void tap.then((opened) => opened?.close());
  }
}
