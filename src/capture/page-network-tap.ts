import { createHash } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import type { CacheKind } from '../model/index.js';
import { Http, Text } from '../shared/index.js';
import type {
  CdpDataReceived,
  CdpFrameTree,
  CdpLoadingFailed,
  CdpLoadingFinished,
  CdpPostData,
  CdpRequest,
  CdpRequestWillBeSent,
  CdpResourceContent,
  CdpResponse,
  CdpResponseBody,
  CdpResponseReceived,
  CdpScriptParsed,
  CdpScriptSource,
  CdpServedFromCache,
  CdpTargetInfo,
  CdpTiming,
} from './cdp-network-types.js';
import { Helpers } from './helpers.js';
import { SessionConnection } from './session-connection.js';
import type { NetworkConnection } from './session-connection.js';
import { TargetChannel } from './target-channel.js';
import type { ChannelParent } from './target-channel.js';

export interface TapRecord {
  readonly requestId: string;
  connection: NetworkConnection;
  readonly method: string;
  readonly url: string;
  readonly signature: string;
  readonly wallTime: number;
  readonly timestamp: number;
  readonly bodyPending: boolean;
  readonly ended: Promise<void>;
  startTime: number;
  timing: string | undefined;
  status: number | undefined;
  memoryCache: boolean;
  cache: CacheKind | undefined;
  fromServiceWorker: boolean;
  serviceWorkerSource: string | undefined;
  dataLength: number;
  responded: boolean;
  state: 'loading' | 'finished' | 'failed' | 'redirected';
  claimed: boolean;
  body: Promise<TapBody | undefined> | undefined;
  postData: Promise<string | undefined> | undefined;
}

export interface TapBody {
  readonly bytes: Buffer;
  readonly text: boolean;
}

export interface TapQuery {
  readonly method: string;
  readonly url: string;
  readonly startTime: number;
  readonly signature?: string;
  readonly timing?: string;
}

export interface TapTiming {
  readonly dnsStart?: number;
  readonly dnsEnd?: number;
  readonly connectStart?: number;
  readonly sslStart?: number;
  readonly connectEnd?: number;
  readonly sendStart?: number;
  readonly receiveHeadersEnd?: number;
}

export interface PageNetworkTapOptions {
  bufferBytes?: number;
  resourceBufferBytes?: number;
  bodies?: boolean;
  onWorker?: (channel: TargetChannel) => Promise<void>;
}

export interface RootConnection extends NetworkConnection {
  detach(): Promise<void>;
}

export type TargetChannelFactory = (parent: ChannelParent, sessionId: string, target: CdpTargetInfo) => TargetChannel;

export interface PageNetworkTapDeps {
  channels?: TargetChannelFactory;
}

interface LiveRecord {
  readonly record: TapRecord;
  readonly end: () => void;
}

interface ClaimWaiter {
  readonly query: TapQuery;
  readonly arrive: (record: TapRecord | undefined) => void;
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
  static readonly SESSION_LAG_MS = 2000;
  static readonly SERVICE_WORKER = 'service_worker';
  static readonly WORKER = 'worker';
  static readonly SCRIPT_PARSED = 'Debugger.scriptParsed';
  static readonly SCRIPT_METHOD = 'GET';
  static readonly NETWORK_CHILDREN: ReadonlySet<string> = new Set(['iframe', PageNetworkTap.WORKER]);
  static readonly BODYLESS_METHODS: ReadonlySet<string> = new Set(['HEAD']);
  static readonly TIMING_FIELDS: readonly (keyof TapTiming)[] = ['dnsStart', 'dnsEnd', 'connectStart', 'sslStart', 'connectEnd', 'sendStart', 'receiveHeadersEnd'];
  static readonly UNSET_TIMING = -1;
  static readonly SIGNATURE_HASH = 'sha256';

  readonly #root: RootConnection;
  readonly #options: PageNetworkTapOptions;
  readonly #channelFactory: TargetChannelFactory;
  readonly #live = new Map<string, LiveRecord>();
  readonly #kept: TapRecord[] = [];
  readonly #channels = new Set<TargetChannel>();
  readonly #preparing = new Set<Promise<void>>();
  readonly #waiters: ClaimWaiter[] = [];
  #closed = false;

  constructor(root: RootConnection, options: PageNetworkTapOptions = {}, deps: PageNetworkTapDeps = {}) {
    this.#root = root;
    this.#options = options;
    this.#channelFactory = deps.channels ?? ((parent, sessionId, target) => new TargetChannel(parent, sessionId, target));
    this.#watch(this.#root);
  }

  static create(root: RootConnection, options: PageNetworkTapOptions = {}): PageNetworkTap {
    return new PageNetworkTap(root, options, { channels: (parent, sessionId, target) => new TargetChannel(parent, sessionId, target) });
  }

  static async open(context: BrowserContext, page: Page, options: PageNetworkTapOptions = {}): Promise<PageNetworkTap | undefined> {
    let connection: SessionConnection;
    try {
      connection = new SessionConnection(await context.newCDPSession(page));
    } catch {
      return undefined;
    }
    return PageNetworkTap.attach(connection, options);
  }

  static async attach(root: RootConnection, options: PageNetworkTapOptions = {}): Promise<PageNetworkTap | undefined> {
    const tap = PageNetworkTap.create(root, options);
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

  static signature(headers: Readonly<Record<string, string>>, postData: Uint8Array | null | undefined): string {
    const pairs = Object.entries(headers)
      .map(([name, value]): [string, string] => [name.toLowerCase(), value])
      .sort((a, b) => Text.compare(a[0], b[0]) || Text.compare(a[1], b[1]));
    const hash = createHash(PageNetworkTap.SIGNATURE_HASH).update(JSON.stringify(pairs));
    if (postData && postData.length > 0) hash.update('\n').update(postData);
    return hash.digest('base64');
  }

  static timingKey(timing: TapTiming | undefined): string | undefined {
    if (!timing) return undefined;
    const values = PageNetworkTap.TIMING_FIELDS.map((field) => timing[field] ?? PageNetworkTap.UNSET_TIMING);
    if (values.every((value) => value === PageNetworkTap.UNSET_TIMING)) return undefined;
    return values.join(',');
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

  claim(query: TapQuery): TapRecord | undefined {
    const chosen = this.#choose(query);
    if (!chosen) return undefined;
    chosen.claimed = true;
    const index = this.#kept.indexOf(chosen);
    if (index >= 0) this.#kept.splice(index, 1);
    return chosen;
  }

  prefetch(query: TapQuery): void {
    if (this.#closed || this.#options.bodies === false) return;
    const record = this.#choose(query);
    if (!record || record.body !== undefined || record.state === 'failed' || record.state === 'redirected') return;
    record.body = this.#read(record);
  }

  #choose(query: TapQuery): TapRecord | undefined {
    const all = [...this.#kept, ...[...this.#live.values()].map((live) => live.record)];
    let candidates = all.filter((r) => PageNetworkTap.#matches(query, r));
    if (query.timing !== undefined) {
      candidates = candidates.filter((r) => r.timing === undefined || r.timing === query.timing);
      const exact = candidates.filter((r) => r.timing === query.timing);
      if (exact.length > 0) candidates = exact;
    }
    if (candidates.length === 0) return undefined;
    return candidates.reduce((best, r) => (PageNetworkTap.#closer(r, best, query.startTime) ? r : best));
  }

  async claimWhenSeen(query: TapQuery, timeoutMs: number): Promise<TapRecord | undefined> {
    const found = this.claim(query);
    if (found || this.#closed) return found;
    const started = Date.now();
    const arrived = await this.#arrival(query, timeoutMs);
    if (!arrived) return undefined;
    await Helpers.settle(arrived.ended, Math.max(0, timeoutMs - (Date.now() - started)));
    return this.claim(query);
  }

  async postData(record: TapRecord): Promise<string | undefined> {
    const early = record.postData === undefined ? undefined : await record.postData;
    if (early !== undefined || this.#closed) return early;
    return this.#readPostData(record);
  }

  async #readPostData(record: TapRecord): Promise<string | undefined> {
    try {
      const result = await record.connection.send<CdpPostData>('Network.getRequestPostData', { requestId: record.requestId });
      return result.postData;
    } catch {
      return undefined;
    }
  }

  async responseBody(record: TapRecord): Promise<TapBody | undefined> {
    const prefetched = record.body === undefined ? undefined : await record.body;
    if (prefetched) return prefetched;
    if (record.state === 'loading' && !record.responded) {
      const caughtUp = await Helpers.settle(record.ended.then(() => true), PageNetworkTap.SESSION_LAG_MS);
      if (caughtUp !== true) return this.#closed ? undefined : this.#workerScript(record);
    } else {
      await record.ended;
    }
    if (record.state !== 'finished') return undefined;
    const body = await (record.body ?? (this.#closed ? Promise.resolve(undefined) : this.#read(record)));
    return body ?? (this.#closed ? undefined : this.#workerScript(record));
  }

  async documentBody(url: string): Promise<TapBody | undefined> {
    if (this.#closed) return undefined;
    const tree = await this.#root.send<CdpFrameTree>('Page.getFrameTree');
    const frame = tree.frameTree.frame;
    if (Helpers.withoutFragment(frame.url) !== Helpers.withoutFragment(url)) return undefined;
    await this.#root.send('Page.enable');
    const content = await this.#root.send<CdpResourceContent>('Page.getResourceContent', { frameId: frame.id, url: frame.url });
    return { bytes: Buffer.from(content.content, content.base64Encoded ? 'base64' : 'utf8'), text: !content.base64Encoded };
  }

  async ready(): Promise<TapTarget[]> {
    while (this.#preparing.size > 0) await Promise.all([...this.#preparing]);
    return [...this.#channels].filter((channel) => !channel.closed).map((channel) => ({ type: channel.target.type, url: channel.target.url }));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const waiter of [...this.#waiters]) waiter.arrive(undefined);
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
          record.timing = undefined;
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
    const channel = this.#channelFactory(parent, event.sessionId, event.targetInfo);
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
      PageNetworkTap.#respond(previous.record, redirect);
      this.#end(connection, event.requestId, 'redirected');
    }
    const live = PageNetworkTap.#create(connection, event.requestId, event.request, event.wallTime, event.timestamp);
    if (live.record.bodyPending) live.record.postData = this.#readPostData(live.record);
    this.#live.set(key, live);
    this.#waiters.find((waiter) => PageNetworkTap.#matches(waiter.query, live.record))?.arrive(live.record);
  }

  #arrival(query: TapQuery, timeoutMs: number): Promise<TapRecord | undefined> {
    return new Promise((resolve) => {
      const waiter: ClaimWaiter = {
        query,
        arrive: (record) => {
          clearTimeout(timer);
          const index = this.#waiters.indexOf(waiter);
          if (index >= 0) this.#waiters.splice(index, 1);
          resolve(record);
        },
      };
      const timer = setTimeout(() => waiter.arrive(undefined), timeoutMs);
      this.#waiters.push(waiter);
    });
  }

  #onResponse(connection: NetworkConnection, event: CdpResponseReceived): void {
    const record = this.#record(connection, event.requestId);
    if (record) PageNetworkTap.#respond(record, event.response);
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
    if (state === 'finished' && this.#wantsBody(live.record)) live.record.body = this.#readOnce(live.record);
    live.end();
    if (live.record.claimed) return;
    this.#kept.push(live.record);
    if (this.#kept.length > PageNetworkTap.MAX_KEPT) this.#kept.splice(0, this.#kept.length - PageNetworkTap.MAX_KEPT);
  }

  #wantsBody(record: TapRecord): boolean {
    if (this.#options.bodies === false || !record.responded || PageNetworkTap.BODYLESS_METHODS.has(record.method.toUpperCase())) return false;
    if (record.status !== undefined && (Helpers.REDIRECT_STATUSES.has(record.status) || Helpers.NO_BODY_STATUSES.has(record.status))) return false;
    return Helpers.isNetworkUrl(record.url);
  }

  async #workerScript(record: TapRecord): Promise<TapBody | undefined> {
    const workers = [...this.#channels].filter((candidate) => !candidate.closed && candidate.target.type === PageNetworkTap.WORKER && Helpers.withoutFragment(candidate.target.url) === record.url);
    const channel = workers.find((candidate) => candidate === record.connection) ?? workers[0];
    if (!channel || record.method !== PageNetworkTap.SCRIPT_METHOD) return undefined;
    let unsubscribe: () => void = () => undefined;
    const parsed = new Promise<string>((resolve) => {
      unsubscribe = channel.on((method, params) => {
        const event = params as unknown as CdpScriptParsed;
        if (method === PageNetworkTap.SCRIPT_PARSED && Helpers.withoutFragment(event.url) === record.url) resolve(event.scriptId);
      });
    });
    try {
      await Promise.all([channel.send('Debugger.enable'), channel.send('Debugger.setSkipAllPauses', { skip: true })]);
      const scriptId = await Helpers.settle(parsed, PageNetworkTap.SESSION_LAG_MS);
      if (scriptId === undefined) return undefined;
      const source = await channel.send<CdpScriptSource>('Debugger.getScriptSource', { scriptId });
      return { bytes: Buffer.from(source.scriptSource, 'utf8'), text: true };
    } catch {
      return undefined;
    } finally {
      unsubscribe();
      await channel.send('Debugger.disable').catch(() => undefined);
    }
  }

  #readOnce(record: TapRecord): Promise<TapBody | undefined> {
    const early = record.body;
    return early === undefined ? this.#read(record) : early.then((body) => body ?? this.#read(record));
  }

  #read(record: TapRecord): Promise<TapBody | undefined> {
    return record.connection.send<CdpResponseBody>('Network.getResponseBody', { requestId: record.requestId }).then(
      (result) => ({ bytes: Buffer.from(result.body, result.base64Encoded ? 'base64' : 'utf8'), text: !result.base64Encoded }),
      () => undefined,
    );
  }

  static #respond(record: TapRecord, response: CdpResponse): void {
    record.responded = true;
    record.status = response.status;
    if (record.cache === undefined && response.fromPrefetchCache) record.cache = 'prefetch';
    else if (record.cache === undefined && response.fromDiskCache) record.cache = 'disk';
    record.fromServiceWorker = response.fromServiceWorker === true;
    record.serviceWorkerSource = response.serviceWorkerResponseSource;
    const timing = response.timing;
    if (!timing || record.memoryCache) return;
    record.startTime = PageNetworkTap.#startTime(timing, record);
    record.timing = PageNetworkTap.timingKey(timing);
  }

  static #matches(query: TapQuery, record: TapRecord): boolean {
    return !record.claimed && record.method === query.method && record.url === query.url && (query.signature === undefined || record.signature === query.signature);
  }

  static #closer(candidate: TapRecord, best: TapRecord, startTime: number): boolean {
    if (startTime > 0) {
      const a = Math.abs(candidate.startTime - startTime);
      const b = Math.abs(best.startTime - startTime);
      if (a !== b) return a < b;
    }
    return candidate.wallTime < best.wallTime;
  }

  static #key(connection: NetworkConnection, requestId: string): string {
    return `${connection.key}\u0000${requestId}`;
  }

  static #startTime(timing: CdpTiming, record: TapRecord): number {
    return (timing.requestTime - record.timestamp + record.wallTime) * PageNetworkTap.MS_PER_SECOND;
  }

  static #postData(request: CdpRequest): Buffer | undefined {
    const entries = (request.postDataEntries ?? []).filter((entry) => entry.bytes);
    return entries.length > 0 ? Buffer.concat(entries.map((entry) => Buffer.from(entry.bytes ?? '', 'base64'))) : undefined;
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
      url: request.url,
      signature: PageNetworkTap.signature(request.headers, PageNetworkTap.#postData(request)),
      wallTime,
      timestamp,
      bodyPending: request.hasPostData === true && !inline,
      ended,
      startTime: wallTime * PageNetworkTap.MS_PER_SECOND,
      timing: undefined,
      status: undefined,
      memoryCache: false,
      cache: undefined,
      fromServiceWorker: false,
      serviceWorkerSource: undefined,
      dataLength: 0,
      responded: false,
      state: 'loading',
      claimed: false,
      body: undefined,
      postData: undefined,
    };
    return { record, end };
  }
}
