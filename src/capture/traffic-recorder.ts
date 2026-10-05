import type { BrowserContext, Download, Page, Request, Response, WebSocket } from 'playwright';
import { AppiiError, Http } from '../shared/index.js';
import type { BodyData, CapturedRequest, CapturedResponse, Exchange, Header, ResourceType, WebSocketCapture, WebSocketMessage } from '../model/index.js';
import { Helpers } from './helpers.js';
import { NetworkIdleMonitor } from './network-idle-monitor.js';
import { PageNetworkTap } from './page-network-tap.js';
import type { TapRecord } from './page-network-tap.js';
import { ResourceTypeMapper } from './resource-type-mapper.js';

export interface TrafficRecorderOptions {
  captureBodies?: boolean;
  maxBodyBytes?: number;
  maxTotalBodyBytes?: number;
  maxExchanges?: number;
  readTimeoutMs?: number;
  tap?: (context: BrowserContext, page: Page) => Promise<PageNetworkTap | undefined>;
}

interface ResponseReads {
  readonly requestHeaders: Promise<Header[] | undefined>;
  readonly responseHeaders: Promise<Header[] | undefined>;
  readonly body: Promise<Buffer | undefined>;
  readonly serverAddr: Promise<string | undefined>;
}

interface PendingRequest {
  readonly id: string;
  readonly generation: number;
  readonly wallStart: number;
  readonly resourceType: ResourceType;
  readonly pageUrl: string | undefined;
  readonly redirectedFrom: string | undefined;
  response?: Response;
  reads?: ResponseReads;
  finish?: () => void;
}

interface TrackedPage {
  readonly onWebSocket: (ws: WebSocket) => void;
  readonly onDownload: (download: Download) => void;
  readonly tap: Promise<PageNetworkTap | undefined>;
}

interface DownloadBody {
  readonly bytes: Buffer;
  readonly size: number;
}

type Outcome =
  | { kind: 'finished' }
  | { kind: 'downloaded'; body: DownloadBody | undefined }
  | { kind: 'failed'; error: string }
  | { kind: 'incomplete'; error: string };

export class TrafficRecorder {
  static readonly DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
  static readonly DEFAULT_MAX_TOTAL_BODY_BYTES = 256 * 1024 * 1024;
  static readonly DEFAULT_MAX_EXCHANGES = 20000;
  static readonly READ_TIMEOUT_MS = 10000;
  static readonly FLUSH_TIMEOUT_MS = 2000;
  static readonly MAX_UNCLAIMED_DOWNLOADS = 100;
  static readonly REDIRECT_STATUSES: ReadonlySet<number> = Helpers.REDIRECT_STATUSES;
  static readonly NO_BODY_STATUSES: ReadonlySet<number> = Helpers.NO_BODY_STATUSES;
  static readonly CHUNKED = 'chunked';

  readonly exchanges: Exchange[] = [];
  readonly websockets: WebSocketCapture[] = [];

  readonly #captureBodies: boolean;
  readonly #maxBodyBytes: number;
  readonly #maxTotalBodyBytes: number;
  readonly #maxExchanges: number;
  readonly #readTimeoutMs: number;
  readonly #openTap: (context: BrowserContext, page: Page) => Promise<PageNetworkTap | undefined>;
  readonly #pending = new Map<Request, PendingRequest>();
  readonly #ids = new WeakMap<Request, string>();
  readonly #builds = new Set<Promise<void>>();
  readonly #loading = new Set<Promise<void>>();
  readonly #listeners = new Set<(e: Exchange) => void>();
  readonly #pages = new Map<Page, TrackedPage>();
  readonly #downloads = new Map<string, Download[]>();
  readonly #downloadWaiters = new Map<string, ((download: Download) => void)[]>();
  #context: BrowserContext | undefined;
  #generation = 0;
  #bodyBytes = 0;

  constructor(options: TrafficRecorderOptions = {}) {
    this.#captureBodies = options.captureBodies ?? true;
    this.#maxBodyBytes = TrafficRecorder.#positive(options.maxBodyBytes, TrafficRecorder.DEFAULT_MAX_BODY_BYTES, 'maxBodyBytes', true);
    this.#maxTotalBodyBytes = TrafficRecorder.#positive(options.maxTotalBodyBytes, TrafficRecorder.DEFAULT_MAX_TOTAL_BODY_BYTES, 'maxTotalBodyBytes', true);
    this.#maxExchanges = TrafficRecorder.#positive(options.maxExchanges, TrafficRecorder.DEFAULT_MAX_EXCHANGES, 'maxExchanges', false);
    this.#readTimeoutMs = TrafficRecorder.#positive(options.readTimeoutMs, TrafficRecorder.READ_TIMEOUT_MS, 'readTimeoutMs', false);
    this.#openTap = options.tap ?? ((context, page) => PageNetworkTap.open(context, page));
  }

  attach(context: BrowserContext): void {
    if (this.#context === context) return;
    if (this.#context) throw new AppiiError('CAPTURE', 'TrafficRecorder is already attached to another browser context; call detach() first');
    this.#context = context;
    context.on('request', this.#onRequest);
    context.on('response', this.#onResponse);
    context.on('requestfinished', this.#onFinished);
    context.on('requestfailed', this.#onFailed);
    context.on('page', this.#onPage);
    for (const page of context.pages()) this.#onPage(page);
  }

  detach(): void {
    const context = this.#context;
    if (!context) return;
    context.off('request', this.#onRequest);
    context.off('response', this.#onResponse);
    context.off('requestfinished', this.#onFinished);
    context.off('requestfailed', this.#onFailed);
    context.off('page', this.#onPage);
    for (const [page, tracked] of this.#pages) {
      page.off('websocket', tracked.onWebSocket);
      page.off('download', tracked.onDownload);
    }
    this.#context = undefined;
    for (const [request, entry] of [...this.#pending]) {
      this.#pending.delete(request);
      const error = entry.response ? 'Capture ended before the response completed' : 'Capture ended before the request completed';
      this.#track(this.#build(request, entry, { kind: 'incomplete', error }, Date.now()));
      entry.finish?.();
    }
    const taps = [...this.#pages.values()].map((tracked) => tracked.tap);
    this.#pages.clear();
    this.#downloads.clear();
    this.#closeTaps(taps);
  }

  prepare(page: Page): Promise<boolean> {
    const tracked = this.#pages.get(page);
    return tracked ? tracked.tap.then((tap) => tap !== undefined) : Promise.resolve(false);
  }

  onExchange(listener: (e: Exchange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  async settled(): Promise<void> {
    while (this.#builds.size > 0 || this.#loading.size > 0) await Promise.allSettled([...this.#builds, ...this.#loading]);
  }

  clear(): void {
    this.#generation++;
    for (const entry of this.#pending.values()) entry.finish?.();
    this.#pending.clear();
    this.exchanges.length = 0;
    this.websockets.length = 0;
    this.#bodyBytes = 0;
  }

  readonly #onRequest = (request: Request): void => {
    if (!Helpers.isNetworkUrl(request.url())) return;
    const id = Http.newId();
    this.#ids.set(request, id);
    const previous = request.redirectedFrom();
    const entry: PendingRequest = {
      id,
      generation: this.#generation,
      wallStart: Date.now(),
      resourceType: ResourceTypeMapper.fromBrowser(request.resourceType()),
      pageUrl: TrafficRecorder.#pageUrlOf(request),
      redirectedFrom: previous ? this.#ids.get(previous) : undefined,
    };
    this.#pending.set(request, entry);
  };

  readonly #onResponse = (response: Response): void => {
    const entry = this.#pending.get(response.request());
    if (!entry || entry.response) return;
    entry.response = response;
    entry.reads = this.#startReads(response.request(), response);
    if (NetworkIdleMonitor.LONG_LIVED_TYPES.has(response.request().resourceType())) return;
    const done = new Promise<void>((resolve) => {
      entry.finish = resolve;
    });
    const loading: Promise<void> = Helpers.withTimeout(done, this.#readTimeoutMs, () => undefined).finally(() => this.#loading.delete(loading));
    this.#loading.add(loading);
  };

  readonly #onFinished = (request: Request): void => {
    this.#complete(request, { kind: 'finished' });
  };

  readonly #onFailed = (request: Request): void => {
    const entry = this.#pending.get(request);
    const error = request.failure()?.errorText ?? 'Request failed';
    if (!entry?.response || !request.isNavigationRequest()) {
      this.#complete(request, { kind: 'failed', error });
      return;
    }
    this.#pending.delete(request);
    const build = this.#download(request.url()).then(async (download) => {
      const outcome: Outcome = download ? { kind: 'downloaded', body: await this.#readDownload(download) } : { kind: 'failed', error };
      await this.#build(request, entry, outcome, Date.now());
    });
    this.#track(build);
    entry.finish?.();
  };

  readonly #onPage = (page: Page): void => {
    const context = this.#context;
    if (this.#pages.has(page) || !context) return;
    const tracked: TrackedPage = {
      onWebSocket: (ws: WebSocket): void => this.#onWebSocket(page, ws),
      onDownload: (download: Download): void => this.#onDownload(download),
      tap: this.#openTap(context, page).catch(() => undefined),
    };
    this.#pages.set(page, tracked);
    page.on('websocket', tracked.onWebSocket);
    page.on('download', tracked.onDownload);
    page.once('close', () => {
      page.off('websocket', tracked.onWebSocket);
      page.off('download', tracked.onDownload);
      if (this.#pages.get(page) !== tracked) return;
      this.#pages.delete(page);
      this.#closeTaps([tracked.tap]);
    });
  };

  #closeTaps(taps: Promise<PageNetworkTap | undefined>[]): void {
    void Promise.allSettled([...this.#builds]).then(() => Promise.allSettled(taps.map((tap) => tap.then((opened) => opened?.close()))));
  }

  #complete(request: Request, outcome: Outcome): void {
    const entry = this.#pending.get(request);
    if (!entry) return;
    this.#pending.delete(request);
    this.#track(this.#build(request, entry, outcome, Date.now()));
    entry.finish?.();
  }

  #track(build: Promise<void>): void {
    const tracked = build.catch(() => undefined).finally(() => this.#builds.delete(tracked));
    this.#builds.add(tracked);
  }

  #startReads(request: Request, response: Response): ResponseReads {
    const timeout = this.#readTimeoutMs;
    const readBody = this.#captureBodies && !TrafficRecorder.REDIRECT_STATUSES.has(response.status());
    const body = readBody ? response.body().catch(() => undefined) : Promise.resolve(undefined);
    return {
      requestHeaders: Helpers.settle(request.headersArray(), timeout),
      responseHeaders: Helpers.settle(response.headersArray(), timeout),
      body,
      serverAddr: Helpers.settle(
        response.serverAddr().then((addr) => (addr ? TrafficRecorder.#formatAddress(addr.ipAddress, addr.port) : undefined)),
        timeout,
      ),
    };
  }

  async #build(request: Request, entry: PendingRequest, outcome: Outcome, endedAt: number): Promise<void> {
    const incomplete = outcome.kind === 'incomplete';
    const wait = incomplete ? TrafficRecorder.FLUSH_TIMEOUT_MS : this.#readTimeoutMs;
    let response = entry.response;
    if (!response && !incomplete) response = (await Helpers.settle(request.response(), wait)) ?? undefined;
    const reads = entry.reads ?? (response ? this.#startReads(request, response) : undefined);
    const [requestHeaders, responseHeaders, body, remoteAddress, tapped] = await Promise.all([
      reads ? Helpers.settle(reads.requestHeaders, wait) : incomplete ? Promise.resolve(undefined) : Helpers.settle(request.headersArray(), wait),
      reads ? Helpers.settle(reads.responseHeaders, wait) : Promise.resolve(undefined),
      this.#responseBytes(reads, outcome),
      reads ? Helpers.settle(reads.serverAddr, wait) : Promise.resolve(undefined),
      this.#claim(request),
    ]);
    if (entry.generation !== this.#generation) return;

    const reqHeaders = Helpers.stripPseudoHeaders(requestHeaders ?? Http.recordToHeaders(request.headers()));
    const captured: CapturedRequest = { method: request.method(), url: request.url(), headers: reqHeaders };
    const requestBody = this.#captureBodies ? await this.#requestBody(request, reqHeaders, tapped) : undefined;
    if (entry.generation !== this.#generation) return;
    if (requestBody) captured.body = requestBody;

    let capturedResponse: CapturedResponse | undefined;
    if (response) {
      const resHeaders = Helpers.stripPseudoHeaders(responseHeaders ?? Http.recordToHeaders(response.headers()));
      capturedResponse = { status: response.status(), statusText: response.statusText(), headers: resHeaders };
      const responseBody = this.#responseBody(request, response, resHeaders, body, outcome);
      if (responseBody) capturedResponse.body = responseBody;
      if (remoteAddress && tapped?.record.cached !== true) capturedResponse.remoteAddress = remoteAddress;
    }
    const finished = outcome.kind === 'finished' || outcome.kind === 'downloaded';
    const timing = TrafficRecorder.#timing(request, entry, finished, endedAt);
    const exchange: Exchange = {
      id: entry.id,
      source: 'browser',
      resourceType: entry.resourceType,
      ...(entry.pageUrl ? { pageUrl: entry.pageUrl } : {}),
      startedAt: timing.startedAt,
      durationMs: timing.durationMs,
      request: captured,
      ...(capturedResponse ? { response: capturedResponse } : {}),
      ...(outcome.kind === 'failed' || outcome.kind === 'incomplete' ? { error: outcome.error } : {}),
      ...(entry.redirectedFrom ? { redirectedFrom: entry.redirectedFrom } : {}),
    };
    this.#push(exchange);
  }

  async #responseBytes(reads: ResponseReads | undefined, outcome: Outcome): Promise<Buffer | undefined> {
    if (outcome.kind === 'downloaded') return outcome.body?.bytes;
    if (!reads || outcome.kind === 'incomplete') return undefined;
    return Helpers.settle(reads.body, outcome.kind === 'finished' ? this.#readTimeoutMs : TrafficRecorder.FLUSH_TIMEOUT_MS);
  }

  #responseBody(request: Request, response: Response, headers: Header[], bytes: Buffer | undefined, outcome: Outcome): BodyData | undefined {
    const contentType = Http.getHeader(headers, 'content-type');
    if (bytes) {
      const body = this.#bodyOf(bytes, contentType, undefined);
      if (body && outcome.kind === 'downloaded' && outcome.body && outcome.body.size > body.size) {
        body.size = outcome.body.size;
        body.truncated = true;
      }
      return body;
    }
    const expectsBody =
      this.#captureBodies &&
      (outcome.kind === 'finished' || outcome.kind === 'downloaded') &&
      request.method().toUpperCase() !== 'HEAD' &&
      !TrafficRecorder.REDIRECT_STATUSES.has(response.status()) &&
      !TrafficRecorder.NO_BODY_STATUSES.has(response.status());
    if (!expectsBody) return undefined;
    const length = TrafficRecorder.#contentLength(headers);
    const chunked = (Http.getHeader(headers, 'transfer-encoding') ?? '').toLowerCase().includes(TrafficRecorder.CHUNKED);
    if ((length ?? 0) > 0 || chunked) return TrafficRecorder.#unread(contentType ?? '', length ?? 0);
    return undefined;
  }

  async #requestBody(request: Request, headers: Header[], tapped: { tap: PageNetworkTap; record: TapRecord } | undefined): Promise<BodyData | undefined> {
    const contentType = Http.getHeader(headers, 'content-type');
    const contentEncoding = Http.getHeader(headers, 'content-encoding');
    const expected = TrafficRecorder.#contentLength(headers);
    const inline = request.postDataBuffer();
    const pending = tapped?.record.bodyPending === true || (expected !== undefined && (inline?.length ?? 0) < expected);
    if (!pending) return this.#bodyOf(inline, contentType, contentEncoding);
    const text = tapped ? await Helpers.settle(tapped.tap.postData(tapped.record), this.#readTimeoutMs) : undefined;
    const bytes = text === undefined ? undefined : PageNetworkTap.bytes(text, expected);
    if (!bytes || bytes.length === 0) {
      const chunked = (Http.getHeader(headers, 'transfer-encoding') ?? '').toLowerCase().includes(TrafficRecorder.CHUNKED);
      return (expected ?? 0) > 0 || tapped?.record.bodyPending === true || chunked ? TrafficRecorder.#unread(contentType ?? '', expected ?? 0) : undefined;
    }
    const body = this.#bodyOf(Buffer.from(bytes), contentType, contentEncoding);
    if (body && expected !== undefined && bytes.length < expected) {
      body.size = expected;
      body.truncated = true;
    }
    return body;
  }

  async #claim(request: Request): Promise<{ tap: PageNetworkTap; record: TapRecord } | undefined> {
    let page: Page | undefined;
    try {
      if (!request.serviceWorker()) page = request.frame().page();
    } catch {
      page = undefined;
    }
    const tracked = page ? this.#pages.get(page) : undefined;
    const tap = tracked ? await tracked.tap : undefined;
    if (!tap) return undefined;
    const record = tap.claim(request.method(), request.url(), TrafficRecorder.#startTime(request));
    return record ? { tap, record } : undefined;
  }

  #onDownload(download: Download): void {
    const url = download.url();
    const waiters = this.#downloadWaiters.get(url);
    const waiter = waiters?.shift();
    if (waiters && waiters.length === 0) this.#downloadWaiters.delete(url);
    if (waiter) {
      waiter(download);
      return;
    }
    const list = this.#downloads.get(url) ?? [];
    list.push(download);
    this.#downloads.set(url, list);
    let total = 0;
    for (const items of this.#downloads.values()) total += items.length;
    if (total > TrafficRecorder.MAX_UNCLAIMED_DOWNLOADS) this.#downloads.delete(this.#downloads.keys().next().value ?? url);
  }

  #download(url: string): Promise<Download | undefined> {
    const list = this.#downloads.get(url);
    const ready = list?.shift();
    if (list && list.length === 0) this.#downloads.delete(url);
    if (ready) return Promise.resolve(ready);
    return new Promise<Download | undefined>((resolve) => {
      const waiter = (download: Download): void => {
        clearTimeout(timer);
        resolve(download);
      };
      const timer = setTimeout(() => {
        const waiters = this.#downloadWaiters.get(url) ?? [];
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        if (waiters.length === 0) this.#downloadWaiters.delete(url);
        resolve(undefined);
      }, TrafficRecorder.FLUSH_TIMEOUT_MS);
      this.#downloadWaiters.set(url, [...(this.#downloadWaiters.get(url) ?? []), waiter]);
    });
  }

  async #readDownload(download: Download): Promise<DownloadBody | undefined> {
    const read = async (): Promise<DownloadBody | undefined> => {
      const stream = await download.createReadStream();
      const limit = this.#maxBodyBytes + 1;
      const chunks: Buffer[] = [];
      let kept = 0;
      let size = 0;
      for await (const chunk of stream) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        size += buffer.length;
        if (kept >= limit) continue;
        const part = buffer.subarray(0, limit - kept);
        chunks.push(part);
        kept += part.length;
      }
      return { bytes: Buffer.concat(chunks), size };
    };
    return Helpers.settle(read(), this.#readTimeoutMs);
  }

  static #timing(request: Request, entry: PendingRequest, finished: boolean, endedAt: number): { startedAt: string; durationMs: number } {
    let start = entry.wallStart;
    let duration = endedAt - entry.wallStart;
    try {
      const timing = request.timing();
      if (timing.startTime > 0) {
        start = timing.startTime;
        duration = finished && timing.responseEnd >= 0 ? timing.responseEnd : endedAt - timing.startTime;
      }
    } catch {
      duration = endedAt - entry.wallStart;
    }
    const whole = Math.floor(start);
    return {
      startedAt: new Date(whole).toISOString(),
      durationMs: Math.round(Math.max(0, duration + (start - whole)) * 1000) / 1000,
    };
  }

  static #startTime(request: Request): number {
    try {
      return request.timing().startTime;
    } catch {
      return 0;
    }
  }

  static #contentLength(headers: Header[]): number | undefined {
    const value = Http.getHeader(headers, 'content-length')?.trim();
    return value !== undefined && /^\d+$/.test(value) ? Number(value) : undefined;
  }

  static #unread(mimeType: string, size: number): BodyData {
    return { mimeType, encoding: 'base64', data: '', size, truncated: true };
  }

  #bodyOf(bytes: Uint8Array | null, contentType: string | undefined, contentEncoding: string | undefined): BodyData | undefined {
    if (!bytes || bytes.length === 0) return undefined;
    const kept = Math.min(bytes.length, this.#maxBodyBytes);
    if (this.#bodyBytes + kept > this.#maxTotalBodyBytes) return TrafficRecorder.#unread(contentType ?? '', bytes.length);
    this.#bodyBytes += kept;
    return Http.toBodyData(bytes, contentType ?? '', { maxBytes: this.#maxBodyBytes, contentEncoding });
  }

  #push(exchange: Exchange): void {
    const list = this.exchanges;
    const start = Date.parse(exchange.startedAt);
    let index = list.length;
    while (index > 0 && Date.parse(list[index - 1]!.startedAt) > start) index--;
    list.splice(index, 0, exchange);
    if (list.length > this.#maxExchanges) list.splice(0, list.length - this.#maxExchanges);
    for (const listener of [...this.#listeners]) {
      try {
        listener(exchange);
      } catch {
        continue;
      }
    }
  }

  #onWebSocket(page: Page, ws: WebSocket): void {
    const pageUrl = page.url();
    const capture: WebSocketCapture = {
      id: Http.newId(),
      url: ws.url(),
      ...(Helpers.isWebPageUrl(pageUrl) ? { pageUrl } : {}),
      openedAt: new Date().toISOString(),
      messages: [],
    };
    const generation = this.#generation;
    this.websockets.push(capture);
    const frame = (direction: WebSocketMessage['direction']) => (data: { payload: string | Buffer }) => {
      if (generation !== this.#generation || !this.#context) return;
      capture.messages.push(this.#message(direction, data.payload));
    };
    ws.on('framesent', frame('sent'));
    ws.on('framereceived', frame('received'));
    ws.on('socketerror', (error: string) => {
      if (generation === this.#generation && this.#context) capture.error = error;
    });
    ws.on('close', () => {
      if (generation === this.#generation && this.#context) capture.closedAt = new Date().toISOString();
    });
  }

  #message(direction: WebSocketMessage['direction'], payload: string | Buffer): WebSocketMessage {
    const at = new Date().toISOString();
    if (!this.#captureBodies) return { direction, at, opcode: typeof payload === 'string' ? 'text' : 'binary', data: '' };
    if (typeof payload === 'string') {
      return { direction, at, opcode: 'text', data: Http.utf8Prefix(payload, this.#maxBodyBytes) };
    }
    const kept = payload.length > this.#maxBodyBytes ? payload.subarray(0, this.#maxBodyBytes) : payload;
    return { direction, at, opcode: 'binary', data: Buffer.from(kept).toString('base64') };
  }

  static #pageUrlOf(request: Request): string | undefined {
    try {
      if (request.serviceWorker()) return undefined;
      const url = request.frame().page().url();
      return Helpers.isWebPageUrl(url) ? url : undefined;
    } catch {
      return undefined;
    }
  }

  static #formatAddress(ip: string, port: number): string {
    const host = ip.includes(':') && !ip.startsWith('[') ? `[${ip}]` : ip;
    return port > 0 ? `${host}:${port}` : host;
  }

  static #positive(value: number | undefined, fallback: number, name: string, allowZero: boolean): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0) || !Number.isInteger(value)) {
      throw new AppiiError('BAD_INPUT', `TrafficRecorder option ${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer, got ${value}`);
    }
    return value;
  }
}
