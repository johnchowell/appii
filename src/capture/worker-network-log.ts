import type { BodyData, CacheKind, CapturedRequest, CapturedResponse, Exchange, Header } from '../model/index.js';
import { Http } from '../shared/index.js';
import { BodyBudget } from './body-budget.js';
import type {
  CdpDataReceived,
  CdpHeaders,
  CdpLoadingFailed,
  CdpLoadingFinished,
  CdpPostData,
  CdpRequestExtraInfo,
  CdpRequestWillBeSent,
  CdpResponse,
  CdpResponseBody,
  CdpResponseExtraInfo,
  CdpResponseReceived,
  CdpServedFromCache,
} from './cdp-network-types.js';
import { Helpers } from './helpers.js';
import { PageNetworkTap } from './page-network-tap.js';
import { ResourceTypeMapper } from './resource-type-mapper.js';
import type { TargetChannel } from './target-channel.js';

export interface WorkerRequest {
  readonly id: string;
  readonly method: string;
  readonly url: string;
  readonly startMs: number;
  readonly done: Promise<Exchange | undefined>;
  exchange: Exchange | undefined;
  settled: boolean;
  claimed: boolean;
}

export interface WorkerNetworkLogOptions {
  budget: BodyBudget;
  captureBodies: boolean;
  readTimeoutMs: number;
  flushTimeoutMs: number;
  bufferBytes: number;
  resourceBufferBytes: number;
  onRequest?: (request: WorkerRequest) => void;
  onExchange?: (request: WorkerRequest, exchange: Exchange | undefined) => void;
}

interface Hop {
  readonly request: WorkerRequest;
  readonly event: CdpRequestWillBeSent;
  readonly index: number;
  readonly redirectedFrom: string | undefined;
  readonly resolve: (exchange: Exchange | undefined) => void;
  response?: CdpResponse;
  hasExtraInfo: boolean;
  memoryCache: boolean;
  dataLength: number;
  ended: boolean;
  postData: Promise<CdpPostData | undefined> | undefined;
}

interface Chain {
  readonly requestId: string;
  readonly hops: Hop[];
  readonly requestExtras: CdpHeaders[];
  readonly responseExtras: CdpHeaders[];
  readonly waiters: Set<() => void>;
}

type HopOutcome = { kind: 'finished'; timestamp: number } | { kind: 'failed'; timestamp: number; error: string } | { kind: 'incomplete'; error: string };

export class WorkerNetworkLog {
  static readonly MAX_CHAINS = 2000;
  static readonly MS_PER_SECOND = 1000;
  static readonly INCOMPLETE_REQUEST = 'Capture ended before the request completed';
  static readonly INCOMPLETE_RESPONSE = 'Capture ended before the response completed';

  readonly #channel: TargetChannel;
  readonly #options: WorkerNetworkLogOptions;
  readonly #chains = new Map<string, Chain>();
  readonly #pending = new Set<Promise<void>>();
  #unsubscribe: (() => void) | undefined;
  #finished = false;

  constructor(channel: TargetChannel, options: WorkerNetworkLogOptions) {
    this.#channel = channel;
    this.#options = options;
  }

  get channel(): TargetChannel {
    return this.#channel;
  }

  async start(): Promise<boolean> {
    this.#unsubscribe = this.#channel.on(this.#onEvent);
    try {
      await PageNetworkTap.enable(this.#channel, { bufferBytes: this.#options.bufferBytes, resourceBufferBytes: this.#options.resourceBufferBytes });
      return true;
    } catch {
      this.#unsubscribe();
      return false;
    }
  }

  get busy(): boolean {
    return this.#pending.size > 0;
  }

  async settled(): Promise<void> {
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  finish(): void {
    if (this.#finished) return;
    this.#finished = true;
    this.#unsubscribe?.();
    for (const chain of this.#chains.values()) {
      const hop = chain.hops[chain.hops.length - 1];
      if (hop && !hop.ended) this.#end(chain, hop, { kind: 'incomplete', error: hop.response ? WorkerNetworkLog.INCOMPLETE_RESPONSE : WorkerNetworkLog.INCOMPLETE_REQUEST }, false);
    }
    this.#chains.clear();
  }

  readonly #onEvent = (method: string, params: Record<string, unknown>): void => {
    if (this.#finished) return;
    switch (method) {
      case 'Network.requestWillBeSent':
        this.#onRequest(params as unknown as CdpRequestWillBeSent);
        break;
      case 'Network.requestWillBeSentExtraInfo': {
        const event = params as unknown as CdpRequestExtraInfo;
        this.#extra(event.requestId, (chain) => chain.requestExtras.push(event.headers));
        break;
      }
      case 'Network.responseReceivedExtraInfo': {
        const event = params as unknown as CdpResponseExtraInfo;
        this.#extra(event.requestId, (chain) => chain.responseExtras.push(event.headers));
        break;
      }
      case 'Network.requestServedFromCache': {
        const hop = this.#current((params as unknown as CdpServedFromCache).requestId);
        if (hop) hop.memoryCache = true;
        break;
      }
      case 'Network.responseReceived': {
        const event = params as unknown as CdpResponseReceived;
        const hop = this.#current(event.requestId);
        if (!hop) break;
        hop.response = event.response;
        hop.hasExtraInfo = event.hasExtraInfo === true;
        break;
      }
      case 'Network.dataReceived': {
        const event = params as unknown as CdpDataReceived;
        const hop = this.#current(event.requestId);
        if (hop) hop.dataLength += event.dataLength;
        break;
      }
      case 'Network.loadingFinished': {
        const event = params as unknown as CdpLoadingFinished;
        this.#last(event.requestId, { kind: 'finished', timestamp: event.timestamp });
        break;
      }
      case 'Network.loadingFailed': {
        const event = params as unknown as CdpLoadingFailed;
        this.#last(event.requestId, { kind: 'failed', timestamp: event.timestamp, error: event.errorText });
        break;
      }
      default:
        break;
    }
  };

  #onRequest(event: CdpRequestWillBeSent): void {
    let chain = this.#chains.get(event.requestId);
    let previous: Hop | undefined;
    if (chain && event.redirectResponse) {
      previous = chain.hops[chain.hops.length - 1];
      if (previous && !previous.ended) {
        previous.response = event.redirectResponse;
        previous.hasExtraInfo = event.redirectHasExtraInfo === true;
        this.#end(chain, previous, { kind: 'finished', timestamp: event.timestamp }, false);
      }
    }
    if (!Helpers.isNetworkUrl(event.request.url)) {
      if (chain) this.#end(chain, undefined, { kind: 'finished', timestamp: event.timestamp }, true);
      return;
    }
    if (!chain) chain = this.#chain(event.requestId);
    let resolve: (exchange: Exchange | undefined) => void = () => undefined;
    const done = new Promise<Exchange | undefined>((settle) => {
      resolve = settle;
    });
    const request: WorkerRequest = {
      id: Http.newId(),
      method: event.request.method,
      url: event.request.url + (event.request.urlFragment ?? ''),
      startMs: event.wallTime * WorkerNetworkLog.MS_PER_SECOND,
      done,
      exchange: undefined,
      settled: false,
      claimed: false,
    };
    const hop: Hop = {
      request,
      event,
      index: chain.hops.length,
      redirectedFrom: previous?.request.id,
      resolve,
      hasExtraInfo: false,
      memoryCache: false,
      dataLength: 0,
      ended: false,
      postData: undefined,
    };
    if (this.#options.captureBodies && WorkerNetworkLog.#bodyPending(event)) {
      hop.postData = Helpers.settle(this.#channel.send<CdpPostData>('Network.getRequestPostData', { requestId: event.requestId }), this.#options.readTimeoutMs);
    }
    chain.hops.push(hop);
    this.#options.onRequest?.(request);
  }

  static #bodyPending(event: CdpRequestWillBeSent): boolean {
    const request = event.request;
    if (request.hasPostData !== true || request.postData !== undefined) return false;
    const entries = request.postDataEntries;
    return !(entries !== undefined && entries.length > 0 && entries.every((entry) => entry.bytes !== undefined));
  }

  #chain(requestId: string): Chain {
    const existing = this.#chains.get(requestId);
    if (existing) return existing;
    const chain: Chain = { requestId, hops: [], requestExtras: [], responseExtras: [], waiters: new Set() };
    this.#chains.set(requestId, chain);
    if (this.#chains.size > WorkerNetworkLog.MAX_CHAINS) {
      for (const [id, candidate] of this.#chains) {
        if (candidate.hops.every((hop) => hop.ended)) {
          this.#chains.delete(id);
          break;
        }
      }
    }
    return chain;
  }

  #extra(requestId: string, add: (chain: Chain) => void): void {
    const chain = this.#chain(requestId);
    add(chain);
    const waiters = [...chain.waiters];
    chain.waiters.clear();
    for (const waiter of waiters) waiter();
  }

  #current(requestId: string): Hop | undefined {
    const chain = this.#chains.get(requestId);
    const hop = chain?.hops[chain.hops.length - 1];
    return hop && !hop.ended ? hop : undefined;
  }

  #last(requestId: string, outcome: HopOutcome): void {
    const chain = this.#chains.get(requestId);
    const hop = chain?.hops[chain.hops.length - 1];
    if (!chain || !hop || hop.ended) return;
    this.#end(chain, hop, outcome, true);
  }

  #end(chain: Chain, hop: Hop | undefined, outcome: HopOutcome, last: boolean): void {
    if (hop) hop.ended = true;
    const build = (hop ? this.#build(chain, hop, outcome) : Promise.resolve(undefined))
      .catch(() => undefined)
      .then((exchange) => {
        if (last && this.#chains.get(chain.requestId) === chain) this.#chains.delete(chain.requestId);
        if (!hop) return;
        hop.request.exchange = exchange;
        hop.request.settled = true;
        hop.resolve(exchange);
        this.#options.onExchange?.(hop.request, exchange);
      });
    const tracked: Promise<void> = build.finally(() => this.#pending.delete(tracked));
    this.#pending.add(tracked);
  }

  async #extras(chain: Chain, hop: Hop, outcome: HopOutcome): Promise<{ request: CdpHeaders | undefined; response: CdpHeaders | undefined }> {
    const ready = (): boolean => chain.requestExtras.length > hop.index && chain.responseExtras.length > hop.index;
    if (hop.hasExtraInfo && outcome.kind !== 'incomplete' && !ready()) {
      await Helpers.withTimeout(
        new Promise<void>((resolve) => {
          const check = (): void => {
            if (ready()) resolve();
            else chain.waiters.add(check);
          };
          check();
        }),
        this.#options.flushTimeoutMs,
        () => undefined,
      );
    }
    return { request: chain.requestExtras[hop.index], response: chain.responseExtras[hop.index] };
  }

  async #build(chain: Chain, hop: Hop, outcome: HopOutcome): Promise<Exchange | undefined> {
    if (!hop.response && outcome.kind === 'finished') return undefined;
    const extras = await this.#extras(chain, hop, outcome);
    const event = hop.event;
    const requestHeaders = Helpers.stripPseudoHeaders(Helpers.headersFromCdp(extras.request ?? event.request.headers));
    const request: CapturedRequest = { method: event.request.method, url: hop.request.url, headers: requestHeaders };
    const requestBody = await this.#requestBody(hop, requestHeaders);
    if (requestBody) request.body = requestBody;
    const cacheKind = WorkerNetworkLog.#cacheKind(hop);
    let response: CapturedResponse | undefined;
    if (hop.response) {
      const headers = Helpers.stripPseudoHeaders(Helpers.headersFromCdp(extras.response ?? hop.response.headers));
      response = { status: hop.response.status, statusText: hop.response.statusText, headers };
      const body = await this.#responseBody(hop, headers, outcome);
      if (body) response.body = body;
      const ip = hop.response.remoteIPAddress;
      if (ip && cacheKind === undefined) response.remoteAddress = Helpers.formatAddress(ip, hop.response.remotePort);
    }
    const timing = WorkerNetworkLog.#timing(hop, outcome);
    return {
      id: hop.request.id,
      source: 'browser',
      resourceType: ResourceTypeMapper.fromBrowser(event.type ?? 'other'),
      startedAt: timing.startedAt,
      durationMs: timing.durationMs,
      request,
      ...(response ? { response } : {}),
      ...(outcome.kind === 'finished' ? {} : { error: outcome.error }),
      ...(hop.redirectedFrom ? { redirectedFrom: hop.redirectedFrom } : {}),
      ...(cacheKind ? { servedBy: 'cache' as const, cacheKind } : {}),
    };
  }

  async #requestBody(hop: Hop, headers: Header[]): Promise<BodyData | undefined> {
    const source = hop.event.request;
    if (!this.#options.captureBodies) return undefined;
    const contentType = Http.getHeader(headers, 'content-type');
    const expected = Helpers.contentLength(headers);
    const entries = source.postDataEntries;
    let bytes: Uint8Array | undefined;
    if (entries && entries.length > 0 && entries.every((entry) => entry.bytes !== undefined)) {
      bytes = Buffer.concat(entries.map((entry) => Buffer.from(entry.bytes ?? '', 'base64')));
    } else if (source.postData !== undefined) {
      bytes = PageNetworkTap.bytes(source.postData, expected);
    } else if (source.hasPostData === true) {
      const read = (hop.postData === undefined ? undefined : await hop.postData) ?? (await Helpers.settle(this.#channel.send<CdpPostData>('Network.getRequestPostData', { requestId: hop.event.requestId }), this.#options.readTimeoutMs));
      bytes = read ? PageNetworkTap.bytes(read.postData, expected) : undefined;
    }
    if (!bytes || bytes.length === 0) {
      return (expected ?? 0) > 0 || source.hasPostData === true ? BodyBudget.unread(contentType ?? '', expected ?? 0) : undefined;
    }
    const body = this.#options.budget.of(bytes, contentType, Http.getHeader(headers, 'content-encoding'));
    if (body && expected !== undefined && bytes.length < expected) {
      body.size = expected;
      body.truncated = true;
    }
    return body;
  }

  async #responseBody(hop: Hop, headers: Header[], outcome: HopOutcome): Promise<BodyData | undefined> {
    const response = hop.response;
    if (!this.#options.captureBodies || outcome.kind !== 'finished' || !response) return undefined;
    if (hop.event.request.method.toUpperCase() === 'HEAD' || Helpers.REDIRECT_STATUSES.has(response.status) || Helpers.NO_BODY_STATUSES.has(response.status)) return undefined;
    const contentType = Http.getHeader(headers, 'content-type');
    const read = await Helpers.settle(this.#channel.send<CdpResponseBody>('Network.getResponseBody', { requestId: hop.event.requestId }), this.#options.readTimeoutMs);
    const bytes = read ? Buffer.from(read.body, read.base64Encoded ? 'base64' : 'utf8') : undefined;
    if (bytes && bytes.length > 0) return this.#options.budget.of(bytes, contentType, undefined, read?.base64Encoded === false);
    const size = hop.dataLength > 0 ? hop.dataLength : (Helpers.contentLength(headers) ?? 0);
    return size > 0 || Helpers.isChunked(headers) ? BodyBudget.unread(contentType ?? '', size) : undefined;
  }

  static #cacheKind(hop: Hop): CacheKind | undefined {
    if (hop.memoryCache) return 'memory';
    if (hop.response?.fromPrefetchCache) return 'prefetch';
    if (hop.response?.fromDiskCache) return 'disk';
    return undefined;
  }

  static #timing(hop: Hop, outcome: HopOutcome): { startedAt: string; durationMs: number } {
    const event = hop.event;
    const timing = hop.response?.timing;
    const startSeconds = timing && !hop.memoryCache ? timing.requestTime : event.timestamp;
    const startMs = (startSeconds - event.timestamp + event.wallTime) * WorkerNetworkLog.MS_PER_SECOND;
    const durationMs = outcome.kind === 'incomplete' ? Date.now() - startMs : (outcome.timestamp - startSeconds) * WorkerNetworkLog.MS_PER_SECOND;
    return Helpers.timing(startMs, durationMs);
  }
}
