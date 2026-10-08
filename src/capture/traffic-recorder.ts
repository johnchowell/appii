import type { BrowserContext, Download, Page, Request, Response, WebSocket } from 'playwright';
import { AppiiError, Http } from '../shared/index.js';
import type { BodyData, CapturedRequest, CapturedResponse, Exchange, Header, ResourceType, WebSocketCapture, WebSocketMessage } from '../model/index.js';
import { BodyBudget } from './body-budget.js';
import type { BodyBudgetOptions } from './body-budget.js';
import { Helpers } from './helpers.js';
import { NetworkIdleMonitor } from './network-idle-monitor.js';
import { PageNetworkTap } from './page-network-tap.js';
import type { PageNetworkTapOptions, TapBody, TapQuery, TapRecord, TapTarget } from './page-network-tap.js';
import { ResourceTypeMapper } from './resource-type-mapper.js';
import { PageTargetWatcher } from './page-target-watcher.js';
import { ServiceWorkerRecorder } from './service-worker-recorder.js';
import type { ServiceWorkerRecorderOptions, WorkerRequest } from './service-worker-recorder.js';
import type { TargetChannel } from './target-channel.js';
import { WorkerNetworkSwitch } from './worker-network-switch.js';
import type { WorkerNetworkRelease } from './worker-network-switch.js';

export interface TrafficRecorderOptions {
  captureBodies?: boolean;
  maxBodyBytes?: number;
  maxTotalBodyBytes?: number;
  maxExchanges?: number;
  readTimeoutMs?: number;
  quietMs?: number;
  serviceWorkers?: boolean;
}

export type SettleListener = (request: Request, settled: boolean) => void;

export type ProbeCheck = (method: string, url: string) => boolean;

export type WorkerSetup = (channel: TargetChannel) => Promise<unknown>;

export type TapOpener = (context: BrowserContext, page: Page, options: PageNetworkTapOptions) => Promise<PageNetworkTap | undefined>;

export type TargetWatcherStarter = (context: BrowserContext, options: PageNetworkTapOptions) => Promise<PageTargetWatcher | undefined>;

export interface TrafficRecorderDeps {
  budget?: (options: BodyBudgetOptions) => BodyBudget;
  workers?: (options: ServiceWorkerRecorderOptions) => ServiceWorkerRecorder;
  tap?: TapOpener;
  watcher?: TargetWatcherStarter;
  workerNetwork?: WorkerNetworkSwitch;
}

interface ResponseReads {
  readonly requestHeaders: Promise<Header[] | undefined>;
  readonly responseHeaders: Promise<Header[] | undefined>;
  readonly serverAddr: Promise<string | undefined>;
}

interface PendingRequest {
  readonly id: string;
  readonly generation: number;
  readonly method: string;
  readonly url: string;
  readonly wallStart: number;
  readonly resourceType: ResourceType;
  readonly pageUrl: string | undefined;
  readonly redirectedFrom: string | undefined;
  readonly probe: ProbeCheck | undefined;
  readonly worker: WorkerRequest | undefined;
  response?: Response;
  reads?: ResponseReads;
  finish?: () => void;
  settled?: boolean;
  grace?: NodeJS.Timeout;
}

interface Tapped {
  readonly tap: PageNetworkTap;
  readonly record: TapRecord;
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
  static readonly MIN_RESOURCE_BUFFER_BYTES = PageNetworkTap.DEFAULT_RESOURCE_BUFFER_BYTES;
  static readonly REDIRECT_STATUSES: ReadonlySet<number> = Helpers.REDIRECT_STATUSES;
  static readonly NO_BODY_STATUSES: ReadonlySet<number> = Helpers.NO_BODY_STATUSES;
  static readonly CHUNKED = Helpers.CHUNKED;
  static readonly PASS_THROUGH_SOURCES: ReadonlySet<string> = new Set(['network', 'http-cache']);
  static readonly HTTP_CACHE_SOURCE = 'http-cache';
  static readonly SESSION_BODY_TYPES: ReadonlySet<string> = new Set(['document', 'stylesheet', 'image', 'media', 'font', 'script', 'texttrack', 'xhr', 'fetch', 'manifest']);

  readonly exchanges: Exchange[] = [];
  readonly websockets: WebSocketCapture[] = [];

  readonly #captureBodies: boolean;
  readonly #maxBodyBytes: number;
  readonly #maxExchanges: number;
  readonly #readTimeoutMs: number;
  readonly #budget: BodyBudget;
  readonly #tapOptions: PageNetworkTapOptions;
  readonly #workers: ServiceWorkerRecorder;
  readonly #serviceWorkers: boolean;
  readonly #workerNetwork: WorkerNetworkSwitch;
  readonly #openTap: TapOpener;
  readonly #startWatcher: TargetWatcherStarter;
  readonly #pending = new Map<Request, PendingRequest>();
  readonly #building = new Set<PendingRequest>();
  readonly #ids = new WeakMap<Request, string>();
  readonly #builds = new Set<Promise<void>>();
  readonly #loading = new Set<Promise<void>>();
  readonly #listeners = new Set<(e: Exchange) => void>();
  readonly #settleListeners = new Set<SettleListener>();
  readonly #workerSetups = new Set<WorkerSetup>();
  readonly #pages = new Map<Page, TrackedPage>();
  readonly #opened = new Map<Page, PageNetworkTap>();
  readonly #downloads = new Map<string, Download[]>();
  readonly #downloadWaiters = new Map<string, ((download: Download) => void)[]>();
  #context: BrowserContext | undefined;
  #watcher: Promise<PageTargetWatcher | undefined> = Promise.resolve(undefined);
  #generation = 0;
  #probe: ProbeCheck | undefined;
  #releaseWorkerNetwork: WorkerNetworkRelease | undefined;

  constructor(options: TrafficRecorderOptions = {}, deps: TrafficRecorderDeps = {}) {
    this.#captureBodies = options.captureBodies ?? true;
    this.#maxBodyBytes = TrafficRecorder.#positive(options.maxBodyBytes, TrafficRecorder.DEFAULT_MAX_BODY_BYTES, 'maxBodyBytes', true);
    const maxTotalBodyBytes = TrafficRecorder.#positive(options.maxTotalBodyBytes, TrafficRecorder.DEFAULT_MAX_TOTAL_BODY_BYTES, 'maxTotalBodyBytes', true);
    this.#maxExchanges = TrafficRecorder.#positive(options.maxExchanges, TrafficRecorder.DEFAULT_MAX_EXCHANGES, 'maxExchanges', false);
    this.#readTimeoutMs = TrafficRecorder.#positive(options.readTimeoutMs, TrafficRecorder.READ_TIMEOUT_MS, 'readTimeoutMs', false);
    this.#budget = (deps.budget ?? TrafficRecorder.budget)({ maxBodyBytes: this.#maxBodyBytes, maxTotalBodyBytes });
    const bufferBytes = Math.max(maxTotalBodyBytes, this.#maxBodyBytes, 1);
    const resourceBufferBytes = Math.max(this.#maxBodyBytes, TrafficRecorder.MIN_RESOURCE_BUFFER_BYTES);
    this.#workers = (deps.workers ?? TrafficRecorder.workers)({
      emit: (exchange) => this.#push(exchange),
      hasPageRequest: (method, url, startMs) => this.#hasPageRequest(method, url, startMs),
    });
    this.#serviceWorkers = options.serviceWorkers !== false;
    this.#workerNetwork = deps.workerNetwork ?? WorkerNetworkSwitch.shared;
    this.#tapOptions = {
      bufferBytes,
      resourceBufferBytes,
      bodies: this.#captureBodies,
      streamBytes: this.#maxBodyBytes,
      ...(options.quietMs === undefined ? {} : { quietMs: options.quietMs }),
      onSettle: (tap, record) => this.#onSettle(tap, record),
      ...(this.#serviceWorkers ? { onWorker: (channel) => this.#onWorker(channel) } : {}),
    };
    this.#openTap = deps.tap ?? PageNetworkTap.open;
    this.#startWatcher = deps.watcher ?? PageTargetWatcher.start;
  }

  static create(options: TrafficRecorderOptions = {}): TrafficRecorder {
    return new TrafficRecorder(options, { budget: TrafficRecorder.budget, workers: TrafficRecorder.workers, tap: PageNetworkTap.open, watcher: PageTargetWatcher.start, workerNetwork: WorkerNetworkSwitch.shared });
  }

  static budget(options: BodyBudgetOptions): BodyBudget {
    return new BodyBudget(options);
  }

  static workers(options: ServiceWorkerRecorderOptions): ServiceWorkerRecorder {
    return ServiceWorkerRecorder.create(options);
  }

  attach(context: BrowserContext): void {
    if (this.#context === context) return;
    if (this.#context) throw new AppiiError('CAPTURE', 'TrafficRecorder is already attached to another browser context; call detach() first');
    this.#context = context;
    if (this.#serviceWorkers) this.#releaseWorkerNetwork = this.#workerNetwork.hold();
    this.#watcher = this.#startWatcher(context, this.#tapOptions).catch(() => undefined);
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
      this.#startBuild(request, entry, { kind: 'incomplete', error });
      entry.finish?.();
    }
    this.#releaseWorkerNetwork?.();
    this.#releaseWorkerNetwork = undefined;
    const taps = [...this.#pages.values()].map((tracked) => tracked.tap);
    this.#pages.clear();
    this.#opened.clear();
    this.#downloads.clear();
    this.#closeTaps(taps, this.#watcher);
    this.#watcher = Promise.resolve(undefined);
  }

  prepare(page: Page): Promise<boolean> {
    const tracked = this.#pages.get(page);
    return tracked ? tracked.tap.then((tap) => tap !== undefined) : Promise.resolve(false);
  }

  async ready(): Promise<TapTarget[]> {
    const taps = await Promise.all([...this.#pages.values()].map((tracked) => tracked.tap));
    const targets = await Promise.all(taps.map((tap) => (tap ? tap.ready() : Promise.resolve([]))));
    return targets.flat();
  }

  onServiceWorker(setup: WorkerSetup): () => void {
    this.#workerSetups.add(setup);
    return () => {
      this.#workerSetups.delete(setup);
    };
  }

  async #onWorker(channel: TargetChannel): Promise<void> {
    await Promise.allSettled([...this.#workerSetups].map((setup) => setup(channel)));
  }

  probe(blocked: ProbeCheck): () => void {
    this.#probe = blocked;
    return () => {
      if (this.#probe === blocked) this.#probe = undefined;
    };
  }

  onExchange(listener: (e: Exchange) => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  onSettled(listener: SettleListener): () => void {
    this.#settleListeners.add(listener);
    return () => {
      this.#settleListeners.delete(listener);
    };
  }

  async settled(): Promise<void> {
    while (this.#builds.size > 0 || this.#loading.size > 0) {
      await Promise.allSettled([...this.#builds, ...this.#loading]);
    }
    if (!this.#context) this.#workers.flush();
  }

  clear(): void {
    this.#generation++;
    for (const entry of this.#pending.values()) {
      entry.finish?.();
      if (entry.worker) this.#workers.settle(entry.worker, undefined);
    }
    this.#pending.clear();
    this.#building.clear();
    this.#workers.clear();
    this.exchanges.length = 0;
    this.websockets.length = 0;
    this.#budget.reset();
  }

  readonly #onRequest = (request: Request): void => {
    if (!Helpers.isNetworkUrl(request.url())) return;
    const fromWorker = Helpers.fromServiceWorker(request);
    if (fromWorker && !this.#serviceWorkers) return;
    const id = Http.newId();
    this.#ids.set(request, id);
    const previous = request.redirectedFrom();
    const wallStart = Date.now();
    const entry: PendingRequest = {
      id,
      generation: this.#generation,
      method: request.method(),
      url: request.url(),
      wallStart,
      resourceType: ResourceTypeMapper.fromBrowser(request.resourceType()),
      pageUrl: TrafficRecorder.#pageUrlOf(request),
      redirectedFrom: previous ? this.#ids.get(previous) : undefined,
      probe: this.#probe,
      worker: fromWorker ? this.#workers.track(request.method(), request.url(), wallStart) : undefined,
    };
    this.#pending.set(request, entry);
  };

  readonly #onResponse = (response: Response): void => {
    const entry = this.#pending.get(response.request());
    if (!entry || entry.response) return;
    entry.response = response;
    entry.reads = this.#startReads(response.request(), response);
    if (entry.worker || NetworkIdleMonitor.LONG_LIVED_TYPES.has(response.request().resourceType())) return;
    const done = new Promise<void>((resolve) => {
      entry.finish = resolve;
    });
    const loading: Promise<void> = Helpers.withTimeout(done, this.#readTimeoutMs, () => undefined).finally(() => this.#loading.delete(loading));
    this.#loading.add(loading);
    const page = TrafficRecorder.#pageOf(response.request());
    const record = page ? this.#opened.get(page)?.peek(TrafficRecorder.#query(response.request())) : undefined;
    if (record?.settled === true) this.#settled(response.request(), entry, true);
  };

  #onSettle(tap: PageNetworkTap, record: TapRecord): void {
    for (const [request, entry] of this.#pending) {
      if (!entry.response) continue;
      const page = TrafficRecorder.#pageOf(request);
      if (!page || this.#opened.get(page) !== tap || tap.peek(TrafficRecorder.#query(request)) !== record) continue;
      this.#settled(request, entry, record.settled);
      return;
    }
  }

  #settled(request: Request, entry: PendingRequest, settled: boolean): void {
    if ((entry.settled ?? false) === settled) return;
    entry.settled = settled;
    clearTimeout(entry.grace);
    entry.grace = undefined;
    if (settled) {
      entry.grace = setTimeout(() => entry.finish?.(), PageNetworkTap.SESSION_LAG_MS);
      entry.grace.unref();
    }
    for (const listener of [...this.#settleListeners]) {
      try {
        listener(request, settled);
      } catch {
        continue;
      }
    }
  }

  readonly #onFinished = (request: Request): void => {
    this.#prefetch(request);
    this.#complete(request, { kind: 'finished' });
  };

  #prefetch(request: Request): void {
    const status = this.#pending.get(request)?.response?.status();
    if (!this.#captureBodies || status === undefined || request.method().toUpperCase() === 'HEAD') return;
    if (TrafficRecorder.REDIRECT_STATUSES.has(status) || TrafficRecorder.NO_BODY_STATUSES.has(status)) return;
    const page = TrafficRecorder.#pageOf(request);
    if (page) this.#opened.get(page)?.prefetch(TrafficRecorder.#query(request));
  }

  readonly #onFailed = (request: Request): void => {
    const entry = this.#pending.get(request);
    const error = request.failure()?.errorText ?? 'Request failed';
    if (!entry?.response || !request.isNavigationRequest()) {
      this.#complete(request, { kind: 'failed', error });
      return;
    }
    this.#pending.delete(request);
    this.#building.add(entry);
    const build = this.#download(request.url()).then(async (download) => {
      const outcome: Outcome = download ? { kind: 'downloaded', body: await this.#readDownload(download) } : { kind: 'failed', error };
      await this.#build(request, entry, outcome, Date.now());
    });
    this.#track(build, entry);
    entry.finish?.();
  };

  readonly #onPage = (page: Page): void => {
    const context = this.#context;
    if (this.#pages.has(page) || !context) return;
    const tracked: TrackedPage = {
      onWebSocket: (ws: WebSocket): void => this.#onWebSocket(page, ws),
      onDownload: (download: Download): void => this.#onDownload(download),
      tap: this.#tapFor(context, page).catch(() => undefined),
    };
    this.#pages.set(page, tracked);
    void tracked.tap.then((opened) => {
      if (opened && this.#pages.get(page) === tracked) this.#opened.set(page, opened);
    });
    page.on('websocket', tracked.onWebSocket);
    page.on('download', tracked.onDownload);
    page.once('close', () => {
      page.off('websocket', tracked.onWebSocket);
      page.off('download', tracked.onDownload);
      if (this.#pages.get(page) !== tracked) return;
      this.#pages.delete(page);
      this.#opened.delete(page);
      this.#closeTaps([tracked.tap]);
    });
  };

  async #tapFor(context: BrowserContext, page: Page): Promise<PageNetworkTap | undefined> {
    const watcher = await this.#watcher;
    const targetId = watcher ? await PageTargetWatcher.targetId(context, page) : undefined;
    const early = watcher && targetId !== undefined ? await watcher.take(targetId) : undefined;
    return early ?? this.#openTap(context, page, this.#tapOptions);
  }

  #closeTaps(taps: Promise<PageNetworkTap | undefined>[], watcher?: Promise<PageTargetWatcher | undefined>): void {
    void Promise.allSettled([...this.#builds])
      .then(() => Promise.allSettled(taps.map((tap) => tap.then((opened) => opened?.close()))))
      .then(() => watcher?.then((opened) => opened?.close()));
  }

  #complete(request: Request, outcome: Outcome): void {
    const entry = this.#pending.get(request);
    if (!entry) return;
    this.#pending.delete(request);
    clearTimeout(entry.grace);
    this.#startBuild(request, entry, outcome);
    entry.finish?.();
  }

  #startBuild(request: Request, entry: PendingRequest, outcome: Outcome): void {
    this.#building.add(entry);
    this.#track(this.#build(request, entry, outcome, Date.now()), entry);
  }

  #track(build: Promise<void>, entry: PendingRequest): void {
    const tracked = build
      .catch(() => undefined)
      .finally(() => {
        this.#builds.delete(tracked);
        this.#building.delete(entry);
        if (entry.worker) this.#workers.settle(entry.worker, undefined);
        this.#workers.release();
      });
    this.#builds.add(tracked);
  }

  #hasPageRequest(method: string, url: string, startMs: number): boolean {
    const key = Helpers.withoutFragment(url);
    const latest = startMs + ServiceWorkerRecorder.MATCH_TOLERANCE_MS;
    const matches = (entry: PendingRequest): boolean => !entry.worker && entry.method === method && entry.wallStart <= latest && Helpers.withoutFragment(entry.url) === key;
    for (const entry of this.#pending.values()) if (matches(entry)) return true;
    for (const entry of this.#building) if (matches(entry)) return true;
    return false;
  }

  #startReads(request: Request, response: Response): ResponseReads {
    const timeout = this.#readTimeoutMs;
    return {
      requestHeaders: Helpers.settle(request.headersArray(), timeout),
      responseHeaders: Helpers.settle(response.headersArray(), timeout),
      serverAddr: Helpers.settle(
        response.serverAddr().then((addr) => (addr ? Helpers.formatAddress(addr.ipAddress, addr.port) : undefined)),
        timeout,
      ),
    };
  }

  async #build(request: Request, entry: PendingRequest, reported: Outcome, reportedAt: number): Promise<void> {
    const incomplete = reported.kind === 'incomplete';
    const wait = incomplete ? TrafficRecorder.FLUSH_TIMEOUT_MS : this.#readTimeoutMs;
    let response = entry.response;
    if (!response && !incomplete) response = (await Helpers.settle(request.response(), wait)) ?? undefined;
    const reads = entry.reads ?? (response ? this.#startReads(request, response) : undefined);
    const tapped = await this.#claim(request);
    if (reported.kind === 'failed' && tapped?.record.state === 'loading') await Helpers.settle(tapped.record.ended, PageNetworkTap.SESSION_LAG_MS);
    const arrived = TrafficRecorder.#arrived(reported, response, tapped);
    const outcome: Outcome = arrived ? { kind: 'finished' } : reported;
    const endedAt = arrived ? Math.min(reportedAt, tapped?.record.arrivedAt ?? reportedAt) : reportedAt;
    const [requestHeaders, responseHeaders, body, remoteAddress] = await Promise.all([
      reads ? Helpers.settle(reads.requestHeaders, wait) : incomplete ? Promise.resolve(undefined) : Helpers.settle(request.headersArray(), wait),
      reads ? Helpers.settle(reads.responseHeaders, wait) : Promise.resolve(undefined),
      this.#responseBytes(request, response, tapped, outcome),
      reads ? Helpers.settle(reads.serverAddr, wait) : Promise.resolve(undefined),
    ]);
    if (entry.generation !== this.#generation) return;

    const fromWorker = !entry.worker && response !== undefined && (tapped?.record.fromServiceWorker ?? response.fromServiceWorker());
    const source = tapped?.record.serviceWorkerSource;
    const passThrough = fromWorker && (source === undefined || TrafficRecorder.PASS_THROUGH_SOURCES.has(source));
    if (passThrough && (await this.#passThrough(request, entry, outcome, endedAt, body, tapped))) return;
    if (entry.generation !== this.#generation) return;

    const reqHeaders = Helpers.stripPseudoHeaders(requestHeaders ?? Http.recordToHeaders(request.headers()));
    const captured: CapturedRequest = { method: request.method(), url: request.url(), headers: reqHeaders };
    const requestBody = this.#captureBodies ? await this.#requestBody(request, reqHeaders, tapped) : undefined;
    if (entry.generation !== this.#generation) return;
    if (requestBody) captured.body = requestBody;

    const cacheKind = fromWorker ? undefined : tapped?.record.cache;
    let capturedResponse: CapturedResponse | undefined;
    if (response) {
      const resHeaders = Helpers.stripPseudoHeaders(responseHeaders ?? Http.recordToHeaders(response.headers()));
      capturedResponse = { status: response.status(), statusText: response.statusText(), headers: resHeaders };
      const responseBody = this.#responseBody(request, response, resHeaders, body, tapped, outcome);
      if (responseBody) capturedResponse.body = responseBody;
      if (remoteAddress && !fromWorker && cacheKind === undefined) capturedResponse.remoteAddress = remoteAddress;
    }
    const finished = (outcome.kind === 'finished' && !arrived) || outcome.kind === 'downloaded';
    const timing = TrafficRecorder.#timing(request, entry, finished, endedAt);
    const probed = !entry.worker && capturedResponse === undefined && entry.probe?.(captured.method, captured.url) === true;
    if (probed) {
      const startMs = TrafficRecorder.#startTime(request) || entry.wallStart;
      this.#workers.claim(captured.method, captured.url, startMs, Math.max(endedAt, startMs));
    }
    const exchange: Exchange = {
      id: entry.id,
      source: probed ? 'probe' : 'browser',
      resourceType: entry.resourceType,
      ...(entry.pageUrl ? { pageUrl: entry.pageUrl } : {}),
      startedAt: timing.startedAt,
      durationMs: timing.durationMs,
      request: captured,
      ...(capturedResponse ? { response: capturedResponse } : {}),
      ...(outcome.kind === 'failed' || outcome.kind === 'incomplete' ? { error: outcome.error } : {}),
      ...(entry.redirectedFrom ? { redirectedFrom: entry.redirectedFrom } : {}),
      ...(fromWorker ? { servedBy: 'service-worker' as const } : cacheKind ? { servedBy: 'cache' as const, cacheKind } : {}),
    };
    if (entry.worker) this.#workers.settle(entry.worker, exchange);
    else this.#push(exchange);
  }

  async #passThrough(request: Request, entry: PendingRequest, outcome: Outcome, endedAt: number, pageBody: TapBody | undefined, tapped: Tapped | undefined): Promise<boolean> {
    const startMs = TrafficRecorder.#startTime(request) || entry.wallStart;
    const worker = this.#workers.claim(entry.method, entry.url, startMs, Math.max(endedAt, startMs));
    if (!worker) return false;
    const network = worker.settled ? worker.exchange : await Helpers.settle(worker.done, outcome.kind === 'incomplete' ? TrafficRecorder.FLUSH_TIMEOUT_MS : this.#readTimeoutMs);
    if (!network || entry.generation !== this.#generation) return false;
    this.#workers.alias(network.id, entry.id);
    const cached = tapped?.record.serviceWorkerSource === TrafficRecorder.HTTP_CACHE_SOURCE;
    let captured = network.request;
    if (TrafficRecorder.#unread(captured.body)) {
      const body = await this.#requestBody(request, captured.headers, tapped);
      if (entry.generation !== this.#generation) return true;
      if (body && !TrafficRecorder.#unread(body)) captured = { ...captured, body };
    }
    let response = network.response;
    const unread = response !== undefined && (response.body === undefined || TrafficRecorder.#unread(response.body));
    if (response && unread && pageBody && pageBody.bytes.length > 0) {
      const body = this.#budget.of(pageBody.bytes, Http.getHeader(response.headers, 'content-type'), undefined, pageBody.text);
      if (body) response = { ...response, body };
    }
    if (response && cached) response = TrafficRecorder.#withoutAddress(response);
    this.#push({
      id: entry.id,
      source: network.source,
      resourceType: entry.resourceType,
      ...(entry.pageUrl ? { pageUrl: entry.pageUrl } : {}),
      startedAt: network.startedAt,
      durationMs: network.durationMs,
      request: captured,
      ...(response ? { response } : {}),
      ...(network.error !== undefined ? { error: network.error } : {}),
      ...(entry.redirectedFrom ? { redirectedFrom: entry.redirectedFrom } : {}),
      ...(cached ? { servedBy: 'cache' as const, cacheKind: 'disk' as const } : network.servedBy ? { servedBy: network.servedBy, ...(network.cacheKind ? { cacheKind: network.cacheKind } : {}) } : {}),
    });
    return true;
  }

  static #unread(body: BodyData | undefined): boolean {
    return body !== undefined && body.truncated === true && body.data === '';
  }

  static #withoutAddress(response: CapturedResponse): CapturedResponse {
    const copy = { ...response };
    delete copy.remoteAddress;
    return copy;
  }

  static #arrived(outcome: Outcome, response: Response | undefined, tapped: Tapped | undefined): boolean {
    if (outcome.kind !== 'failed' && outcome.kind !== 'incomplete') return false;
    return response !== undefined && tapped !== undefined && PageNetworkTap.complete(tapped.record);
  }

  async #responseBytes(request: Request, response: Response | undefined, tapped: Tapped | undefined, outcome: Outcome): Promise<TapBody | undefined> {
    if (outcome.kind === 'downloaded') return outcome.body ? { bytes: outcome.body.bytes, text: false } : undefined;
    if (response && tapped && this.#captureBodies && (outcome.kind === 'failed' || outcome.kind === 'incomplete')) return tapped.tap.partialBody(tapped.record);
    if (!response || outcome.kind !== 'finished' || !this.#captureBodies) return undefined;
    if (request.method().toUpperCase() === 'HEAD' || TrafficRecorder.REDIRECT_STATUSES.has(response.status())) return undefined;
    if (!tapped) return (await this.#documentBytes(request)) ?? this.#sessionBody(request, response);
    return Helpers.settle(tapped.tap.responseBody(tapped.record), this.#readTimeoutMs);
  }

  async #sessionBody(request: Request, response: Response): Promise<TapBody | undefined> {
    const headers = Http.recordToHeaders(response.headers());
    if (!TrafficRecorder.#readableWithoutRefetch(request, response, headers)) return undefined;
    const bytes = await Helpers.settle(response.body(), this.#readTimeoutMs);
    if (!bytes || bytes.length === 0) return undefined;
    const declared = Helpers.contentLength(headers);
    return { bytes, text: declared !== undefined && bytes.length !== declared };
  }

  static #readableWithoutRefetch(request: Request, response: Response, headers: Header[]): boolean {
    if (!TrafficRecorder.SESSION_BODY_TYPES.has(request.resourceType()) || response.fromServiceWorker()) return false;
    const declared = Helpers.contentLength(headers);
    return declared === undefined || declared === 0 || !Http.isContentEncoded(Http.getHeader(headers, 'content-encoding'));
  }

  #responseBody(request: Request, response: Response, headers: Header[], read: TapBody | undefined, tapped: Tapped | undefined, outcome: Outcome): BodyData | undefined {
    const contentType = Http.getHeader(headers, 'content-type');
    if (read && read.bytes.length > 0) {
      const body = this.#budget.of(read.bytes, contentType, undefined, read.text);
      const total = outcome.kind === 'downloaded' && outcome.body ? outcome.body.size : Helpers.fullBodySize(headers, tapped?.record.dataLength ?? 0);
      const partial = outcome.kind === 'failed' || outcome.kind === 'incomplete';
      if (body && (partial || total > body.size)) {
        body.size = Math.max(total, body.size);
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
    const size = Helpers.fullBodySize(headers, tapped?.record.dataLength ?? 0);
    if (size > 0 || Helpers.isChunked(headers)) return BodyBudget.unread(contentType ?? '', size);
    return undefined;
  }

  async #requestBody(request: Request, headers: Header[], tapped: Tapped | undefined): Promise<BodyData | undefined> {
    const contentType = Http.getHeader(headers, 'content-type');
    const contentEncoding = Http.getHeader(headers, 'content-encoding');
    const expected = Helpers.contentLength(headers);
    const inline = request.postDataBuffer();
    const pending = tapped?.record.bodyPending === true || (expected !== undefined && (inline?.length ?? 0) < expected);
    if (!pending) return this.#budget.of(inline, contentType, contentEncoding);
    const text = tapped ? await Helpers.settle(tapped.tap.postData(tapped.record), this.#readTimeoutMs) : undefined;
    const bytes = text === undefined ? undefined : PageNetworkTap.bytes(text, expected);
    if (!bytes || bytes.length === 0) {
      return (expected ?? 0) > 0 || tapped?.record.bodyPending === true || Helpers.isChunked(headers) ? BodyBudget.unread(contentType ?? '', expected ?? 0) : undefined;
    }
    const body = this.#budget.of(Buffer.from(bytes), contentType, contentEncoding);
    if (body && expected !== undefined && bytes.length < expected) {
      body.size = expected;
      body.truncated = true;
    }
    return body;
  }

  async #claim(request: Request): Promise<Tapped | undefined> {
    const page = TrafficRecorder.#pageOf(request);
    const tracked = page ? this.#pages.get(page) : undefined;
    const tap = tracked ? await tracked.tap : undefined;
    if (!tap) return undefined;
    const record = await tap.claimWhenSeen(TrafficRecorder.#query(request), PageNetworkTap.SESSION_LAG_MS);
    return record ? { tap, record } : undefined;
  }

  async #documentBytes(request: Request): Promise<TapBody | undefined> {
    const page = TrafficRecorder.#pageOf(request);
    if (!page || !request.isNavigationRequest() || request.frame() !== page.mainFrame()) return undefined;
    const tap = await this.#pages.get(page)?.tap;
    return tap ? Helpers.settle(tap.documentBody(request.url()), this.#readTimeoutMs) : undefined;
  }

  static #pageOf(request: Request): Page | undefined {
    try {
      return request.serviceWorker() ? undefined : request.frame().page();
    } catch {
      return undefined;
    }
  }

  static #query(request: Request): TapQuery {
    let startTime = 0;
    let timing: string | undefined;
    try {
      const value = request.timing();
      startTime = value.startTime;
      timing = PageNetworkTap.timingKey({
        dnsStart: value.domainLookupStart,
        dnsEnd: value.domainLookupEnd,
        connectStart: value.connectStart,
        sslStart: value.secureConnectionStart,
        connectEnd: value.connectEnd,
        sendStart: value.requestStart,
        receiveHeadersEnd: value.responseStart,
      });
    } catch {
      timing = undefined;
    }
    return {
      method: request.method(),
      url: request.url(),
      startTime,
      signature: PageNetworkTap.signature(request.headers(), request.postDataBuffer()),
      ...(timing === undefined ? {} : { timing }),
    };
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
    return Helpers.timing(start, duration);
  }

  static #startTime(request: Request): number {
    try {
      return request.timing().startTime;
    } catch {
      return 0;
    }
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

  static #positive(value: number | undefined, fallback: number, name: string, allowZero: boolean): number {
    if (value === undefined) return fallback;
    if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0) || !Number.isInteger(value)) {
      throw new AppiiError('BAD_INPUT', `TrafficRecorder option ${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer, got ${value}`);
    }
    return value;
  }
}
