import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { CacheKind } from '../model/index.js';
import { Http } from '../shared/index.js';
import type {
  CdpDataReceived,
  CdpLoadingFailed,
  CdpLoadingFinished,
  CdpPostData,
  CdpRequest,
  CdpRequestWillBeSent,
  CdpResponseBody,
  CdpResponseReceived,
  CdpServedFromCache,
  CdpTargetInfo,
} from './cdp-network-types.js';
import { Helpers } from './helpers.js';
import { SessionConnection } from './session-connection.js';
import type { NetworkConnection } from './session-connection.js';
import { TargetChannel } from './target-channel.js';

export interface TapRecord {
  readonly requestId: string;
  connection: NetworkConnection;
  readonly method: string;
  readonly url: string;
  readonly wallTime: number;
  readonly timestamp: number;
  readonly bodyPending: boolean;
  readonly ended: Promise<void>;
  startTime: number;
  memoryCache: boolean;
  cache: CacheKind | undefined;
  fromServiceWorker: boolean;
  serviceWorkerSource: string | undefined;
  dataLength: number;
  responded: boolean;
  state: 'loading' | 'finished' | 'failed' | 'redirected';
  claimed: boolean;
}

export interface PageNetworkTapOptions {
  bufferBytes?: number;
  resourceBufferBytes?: number;
  onWorker?: (channel: TargetChannel) => Promise<void>;
}

interface LiveRecord {
  readonly record: TapRecord;
  readonly end: () => void;
}

interface AttachedEvent {
  sessionId: string;
  targetInfo: CdpTargetInfo;
}

interface DetachedEvent {
  sessionId?: string;
}

interface TargetMessageEvent {
  sessionId?: string;
  message: string;
}

export interface TapTarget {
  readonly type: string;
  readonly url: string;
}

export class PageNetworkTap {
  static readonly MAX_KEPT = 2000;
  static readonly MS_PER_SECOND = 1000;
  static readonly LATIN1_MAX = 0xff;
  static readonly ASCII_MAX = 0x7f;
  static readonly DEFAULT_BUFFER_BYTES = 256 * 1024 * 1024;
  static readonly DEFAULT_RESOURCE_BUFFER_BYTES = 64 * 1024 * 1024;
  static readonly PREPARE_TIMEOUT_MS = 5000;
  static readonly SERVICE_WORKER = 'service_worker';
  static readonly NETWORK_CHILDREN: ReadonlySet<string> = new Set(['iframe', 'worker']);

  readonly #root: SessionConnection;
  readonly #options: PageNetworkTapOptions;
  readonly #live = new Map<string, LiveRecord>();
  readonly #kept: TapRecord[] = [];
  readonly #channels = new Set<TargetChannel>();
  readonly #preparing = new Set<Promise<void>>();
  #closed = false;

  constructor(session: CDPSession, options: PageNetworkTapOptions = {}) {
    this.#root = new SessionConnection(session);
    this.#options = options;
    this.#watch(this.#root);
  }

  static async open(context: BrowserContext, page: Page, options: PageNetworkTapOptions = {}): Promise<PageNetworkTap | undefined> {
    let session: CDPSession;
    try {
      session = await context.newCDPSession(page);
    } catch {
      return undefined;
    }
    const tap = new PageNetworkTap(session, options);
    try {
      await tap.#prepare(tap.#root);
      return tap;
    } catch {
      await tap.close();
      return undefined;
    }
  }

  static async enable(connection: Pick<NetworkConnection, 'send'>, options: PageNetworkTapOptions = {}): Promise<void> {
    const buffers = {
      maxTotalBufferSize: options.bufferBytes ?? PageNetworkTap.DEFAULT_BUFFER_BYTES,
      maxResourceBufferSize: options.resourceBufferBytes ?? PageNetworkTap.DEFAULT_RESOURCE_BUFFER_BYTES,
      enableDurableMessages: true,
    };
    try {
      await connection.send('Network.enable', buffers);
    } catch {
      await connection.send('Network.enable');
    }
  }

  static targetFilter(workers: boolean): { type?: string; exclude: boolean }[] {
    const children = [...PageNetworkTap.NETWORK_CHILDREN].map((type) => ({ type, exclude: false }));
    return [...(workers ? [{ type: PageNetworkTap.SERVICE_WORKER, exclude: false }] : []), ...children, { exclude: true }];
  }

  static bytes(text: string, expectedLength: number | undefined): Uint8Array | undefined {
    let wide = false;
    let ascii = true;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if (code > PageNetworkTap.LATIN1_MAX) wide = true;
      else if (code > PageNetworkTap.ASCII_MAX) ascii = false;
    }
    const utf8 = Buffer.from(text, 'utf8');
    if (wide || ascii) return expectedLength === undefined || utf8.length <= expectedLength ? utf8 : undefined;
    const latin1 = Buffer.from(text, 'latin1');
    const candidates = Http.utf8Text(latin1) === undefined ? [latin1, utf8] : [utf8];
    if (expectedLength !== undefined) {
      const exact = candidates.find((candidate) => candidate.length === expectedLength);
      if (exact) return exact;
      return candidates.length === 1 && utf8.length < expectedLength ? utf8 : undefined;
    }
    return candidates.length === 1 ? candidates[0] : undefined;
  }

  claim(method: string, url: string, startTime: number): TapRecord | undefined {
    const candidates = [...this.#kept, ...[...this.#live.values()].map((live) => live.record)].filter((r) => !r.claimed && r.method === method && r.url === url);
    if (candidates.length === 0) return undefined;
    const exact = startTime > 0 ? candidates.find((r) => r.startTime === startTime) : undefined;
    const chosen = exact ?? candidates.reduce((best, r) => (r.wallTime < best.wallTime ? r : best));
    chosen.claimed = true;
    const index = this.#kept.indexOf(chosen);
    if (index >= 0) this.#kept.splice(index, 1);
    return chosen;
  }

  async postData(record: TapRecord): Promise<string | undefined> {
    if (this.#closed) return undefined;
    const result = await record.connection.send<CdpPostData>('Network.getRequestPostData', { requestId: record.requestId });
    return result.postData;
  }

  async responseBody(record: TapRecord): Promise<Buffer | undefined> {
    if (record.state === 'loading' && !record.responded) return undefined;
    await record.ended;
    if (this.#closed || record.state !== 'finished') return undefined;
    const result = await record.connection.send<CdpResponseBody>('Network.getResponseBody', { requestId: record.requestId });
    return Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8');
  }

  async ready(): Promise<TapTarget[]> {
    while (this.#preparing.size > 0) await Promise.all([...this.#preparing]);
    return [...this.#channels].filter((channel) => !channel.closed).map((channel) => ({ type: channel.target.type, url: channel.target.url }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const live of this.#live.values()) live.end();
    this.#live.clear();
    this.#kept.length = 0;
    for (const channel of this.#channels) channel.close();
    this.#channels.clear();
    await this.#root.detach().catch(() => undefined);
  }

  async #prepare(connection: NetworkConnection): Promise<void> {
    await PageNetworkTap.enable(connection, this.#options);
    const filter = PageNetworkTap.targetFilter(this.#options.onWorker !== undefined);
    await connection.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: false, filter }).catch(() => undefined);
  }

  #watch(connection: NetworkConnection): Map<string, TargetChannel> {
    const children = new Map<string, TargetChannel>();
    connection.on((method, params) => {
      if (this.#closed) return;
      switch (method) {
        case 'Network.requestWillBeSent':
          this.#onRequest(connection, params as unknown as CdpRequestWillBeSent);
          break;
        case 'Network.requestServedFromCache': {
          const record = this.#record(connection, (params as unknown as CdpServedFromCache).requestId);
          if (!record) break;
          record.memoryCache = true;
          record.cache = 'memory';
          record.startTime = record.wallTime * PageNetworkTap.MS_PER_SECOND;
          break;
        }
        case 'Network.responseReceived':
          this.#onResponse(connection, params as unknown as CdpResponseReceived);
          break;
        case 'Network.dataReceived': {
          const event = params as unknown as CdpDataReceived;
          const record = this.#record(connection, event.requestId);
          if (record) record.dataLength += event.dataLength;
          break;
        }
        case 'Network.loadingFinished':
          this.#end(connection, (params as unknown as CdpLoadingFinished).requestId, 'finished');
          break;
        case 'Network.loadingFailed':
          this.#end(connection, (params as unknown as CdpLoadingFailed).requestId, 'failed');
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

  #attached(parent: NetworkConnection, children: Map<string, TargetChannel>, event: AttachedEvent): void {
    const channel = new TargetChannel(parent, event.sessionId, event.targetInfo);
    children.set(event.sessionId, channel);
    this.#channels.add(channel);
    channel.onClose(() => {
      if (!this.#closed) this.#forget(channel);
    });
    let prepare: Promise<unknown> = Promise.resolve();
    if (PageNetworkTap.NETWORK_CHILDREN.has(event.targetInfo.type)) {
      const nested = this.#watch(channel);
      channel.onClose(() => {
        for (const child of nested.values()) child.close();
        nested.clear();
      });
      prepare = this.#prepare(channel);
    } else if (event.targetInfo.type === PageNetworkTap.SERVICE_WORKER && this.#options.onWorker) {
      prepare = this.#options.onWorker(channel);
    }
    const ready = Helpers.settle(prepare, PageNetworkTap.PREPARE_TIMEOUT_MS)
      .finally(() => channel.resume())
      .then(
        () => undefined,
        () => undefined,
      );
    this.#preparing.add(ready);
    void ready.finally(() => this.#preparing.delete(ready));
  }

  #forget(channel: TargetChannel): void {
    this.#channels.delete(channel);
    for (const live of [...this.#live.values()]) if (live.record.connection === channel) this.#end(channel, live.record.requestId, 'failed');
  }

  #onRequest(connection: NetworkConnection, event: CdpRequestWillBeSent): void {
    const key = PageNetworkTap.#key(connection, event.requestId);
    const previous = this.#live.get(key);
    const redirect = event.redirectResponse;
    if (previous && redirect) {
      if (redirect.timing && !previous.record.memoryCache) previous.record.startTime = PageNetworkTap.#startTime(redirect.timing.requestTime, previous.record);
      this.#end(connection, event.requestId, 'redirected');
    }
    this.#live.set(key, PageNetworkTap.#create(connection, event.requestId, event.request, event.wallTime, event.timestamp));
  }

  #onResponse(connection: NetworkConnection, event: CdpResponseReceived): void {
    const record = this.#record(connection, event.requestId);
    if (!record) return;
    const response = event.response;
    record.responded = true;
    if (record.cache === undefined && response.fromPrefetchCache) record.cache = 'prefetch';
    else if (record.cache === undefined && response.fromDiskCache) record.cache = 'disk';
    record.fromServiceWorker = response.fromServiceWorker === true;
    record.serviceWorkerSource = response.serviceWorkerResponseSource;
    const timing = response.timing;
    if (timing && !record.memoryCache) record.startTime = PageNetworkTap.#startTime(timing.requestTime, record);
  }

  #record(connection: NetworkConnection, requestId: string): TapRecord | undefined {
    return this.#find(connection, requestId)?.live.record;
  }

  #find(connection: NetworkConnection, requestId: string): { key: string; live: LiveRecord } | undefined {
    const key = PageNetworkTap.#key(connection, requestId);
    const own = this.#live.get(key);
    if (own) return { key, live: own };
    for (const [other, live] of this.#live) {
      if (live.record.requestId !== requestId) continue;
      this.#live.delete(other);
      live.record.connection = connection;
      this.#live.set(key, live);
      return { key, live };
    }
    return undefined;
  }

  #end(connection: NetworkConnection, requestId: string, state: TapRecord['state']): void {
    const found = this.#find(connection, requestId);
    if (!found) return;
    const { key, live } = found;
    this.#live.delete(key);
    live.record.state = state;
    live.end();
    if (live.record.claimed) return;
    this.#kept.push(live.record);
    if (this.#kept.length > PageNetworkTap.MAX_KEPT) this.#kept.splice(0, this.#kept.length - PageNetworkTap.MAX_KEPT);
  }

  static #key(connection: NetworkConnection, requestId: string): string {
    return `${connection.key}\u0000${requestId}`;
  }

  static #startTime(requestTime: number, record: TapRecord): number {
    return (requestTime - record.timestamp + record.wallTime) * PageNetworkTap.MS_PER_SECOND;
  }

  static #create(connection: NetworkConnection, requestId: string, request: CdpRequest, wallTime: number, timestamp: number): LiveRecord {
    const entries = request.postDataEntries;
    const inline = entries !== undefined && entries.length > 0 && entries.every((entry) => entry.bytes !== undefined);
    let end: () => void = () => undefined;
    const ended = new Promise<void>((resolve) => {
      end = resolve;
    });
    const record: TapRecord = {
      requestId,
      connection,
      method: request.method,
      url: request.url + (request.urlFragment ?? ''),
      wallTime,
      timestamp,
      bodyPending: request.hasPostData === true && !inline,
      ended,
      startTime: wallTime * PageNetworkTap.MS_PER_SECOND,
      memoryCache: false,
      cache: undefined,
      fromServiceWorker: false,
      serviceWorkerSource: undefined,
      dataLength: 0,
      responded: false,
      state: 'loading',
      claimed: false,
    };
    return { record, end };
  }
}
