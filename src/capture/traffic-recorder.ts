import type { BrowserContext, Page, Request, Response, WebSocket } from 'playwright';
import { AppiiError, Http } from '../shared/index.js';
import type { BodyData, CapturedRequest, CapturedResponse, Exchange, Header, ResourceType, WebSocketCapture, WebSocketMessage } from '../model/index.js';
import { Helpers } from './helpers.js';
import { NetworkIdleMonitor } from './network-idle-monitor.js';
import { ResourceTypeMapper } from './resource-type-mapper.js';

export interface TrafficRecorderOptions {
  captureBodies?: boolean;
  maxBodyBytes?: number;
  maxExchanges?: number;
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

type Outcome = { kind: 'finished' } | { kind: 'failed'; error: string } | { kind: 'incomplete'; error: string };

export class TrafficRecorder {
  static readonly DEFAULT_MAX_BODY_BYTES = 5 * 1024 * 1024;
  static readonly DEFAULT_MAX_EXCHANGES = 20000;
  static readonly READ_TIMEOUT_MS = 10000;
  static readonly FLUSH_TIMEOUT_MS = 2000;
  static readonly REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

  readonly exchanges: Exchange[] = [];
  readonly websockets: WebSocketCapture[] = [];

  readonly #captureBodies: boolean;
  readonly #maxBodyBytes: number;
  readonly #maxExchanges: number;
  readonly #pending = new Map<Request, PendingRequest>();
  readonly #ids = new WeakMap<Request, string>();
  readonly #builds = new Set<Promise<void>>();
  readonly #loading = new Set<Promise<void>>();
  readonly #listeners = new Set<(e: Exchange) => void>();
  readonly #pages = new Map<Page, (ws: WebSocket) => void>();
  #context: BrowserContext | undefined;
  #generation = 0;

  constructor(options: TrafficRecorderOptions = {}) {
    this.#captureBodies = options.captureBodies ?? true;
    this.#maxBodyBytes = TrafficRecorder.#positive(options.maxBodyBytes, TrafficRecorder.DEFAULT_MAX_BODY_BYTES, 'maxBodyBytes', true);
    this.#maxExchanges = TrafficRecorder.#positive(options.maxExchanges, TrafficRecorder.DEFAULT_MAX_EXCHANGES, 'maxExchanges', false);
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
    for (const [page, listener] of this.#pages) page.off('websocket', listener);
    this.#pages.clear();
    this.#context = undefined;
    for (const [request, entry] of [...this.#pending]) {
      this.#pending.delete(request);
      const error = entry.response ? 'Capture ended before the response completed' : 'Capture ended before the request completed';
      this.#track(this.#build(request, entry, { kind: 'incomplete', error }, Date.now()));
      entry.finish?.();
    }
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
  }

  readonly #onRequest = (request: Request): void => {
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
    const loading: Promise<void> = Helpers.withTimeout(done, TrafficRecorder.READ_TIMEOUT_MS, () => undefined).finally(() => this.#loading.delete(loading));
    this.#loading.add(loading);
  };

  readonly #onFinished = (request: Request): void => {
    this.#complete(request, { kind: 'finished' });
  };

  readonly #onFailed = (request: Request): void => {
    this.#complete(request, { kind: 'failed', error: request.failure()?.errorText ?? 'Request failed' });
  };

  readonly #onPage = (page: Page): void => {
    if (this.#pages.has(page)) return;
    const listener = (ws: WebSocket): void => this.#onWebSocket(page, ws);
    this.#pages.set(page, listener);
    page.on('websocket', listener);
    page.once('close', () => {
      page.off('websocket', listener);
      this.#pages.delete(page);
    });
  };

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
    const timeout = TrafficRecorder.READ_TIMEOUT_MS;
    const readBody = this.#captureBodies && !TrafficRecorder.REDIRECT_STATUSES.has(response.status());
    return {
      requestHeaders: Helpers.settle(request.headersArray(), timeout),
      responseHeaders: Helpers.settle(response.headersArray(), timeout),
      body: readBody ? Helpers.settle(response.body(), timeout) : Promise.resolve(undefined),
      serverAddr: Helpers.settle(
        response.serverAddr().then((addr) => (addr ? TrafficRecorder.#formatAddress(addr.ipAddress, addr.port) : undefined)),
        timeout,
      ),
    };
  }

  async #build(request: Request, entry: PendingRequest, outcome: Outcome, endedAt: number): Promise<void> {
    const incomplete = outcome.kind === 'incomplete';
    const wait = incomplete ? TrafficRecorder.FLUSH_TIMEOUT_MS : TrafficRecorder.READ_TIMEOUT_MS;
    let response = entry.response;
    if (!response && !incomplete) response = (await Helpers.settle(request.response(), wait)) ?? undefined;
    const reads = entry.reads ?? (response ? this.#startReads(request, response) : undefined);
    const [requestHeaders, responseHeaders, body, remoteAddress] = await Promise.all([
      reads ? Helpers.settle(reads.requestHeaders, wait) : incomplete ? Promise.resolve(undefined) : Helpers.settle(request.headersArray(), wait),
      reads ? Helpers.settle(reads.responseHeaders, wait) : Promise.resolve(undefined),
      reads && !incomplete ? reads.body : Promise.resolve(undefined),
      reads ? Helpers.settle(reads.serverAddr, wait) : Promise.resolve(undefined),
    ]);
    if (entry.generation !== this.#generation) return;

    const reqHeaders = Helpers.stripPseudoHeaders(requestHeaders ?? Http.recordToHeaders(request.headers()));
    const captured: CapturedRequest = { method: request.method(), url: request.url(), headers: reqHeaders };
    const postData = this.#captureBodies ? request.postDataBuffer() : null;
    const requestBody = this.#bodyOf(postData, Http.getHeader(reqHeaders, 'content-type'), Http.getHeader(reqHeaders, 'content-encoding'));
    if (requestBody) captured.body = requestBody;

    let capturedResponse: CapturedResponse | undefined;
    if (response) {
      const resHeaders = Helpers.stripPseudoHeaders(responseHeaders ?? Http.recordToHeaders(response.headers()));
      capturedResponse = { status: response.status(), statusText: response.statusText(), headers: resHeaders };
      const responseBody = this.#bodyOf(body ?? null, Http.getHeader(resHeaders, 'content-type'), undefined);
      if (responseBody) capturedResponse.body = responseBody;
      if (remoteAddress) capturedResponse.remoteAddress = remoteAddress;
    }
    const timing = TrafficRecorder.#timing(request, entry, outcome.kind === 'finished', endedAt);
    const exchange: Exchange = {
      id: entry.id,
      source: 'browser',
      resourceType: entry.resourceType,
      ...(entry.pageUrl ? { pageUrl: entry.pageUrl } : {}),
      startedAt: timing.startedAt,
      durationMs: timing.durationMs,
      request: captured,
      ...(capturedResponse ? { response: capturedResponse } : {}),
      ...(outcome.kind === 'finished' ? {} : { error: outcome.error }),
      ...(entry.redirectedFrom ? { redirectedFrom: entry.redirectedFrom } : {}),
    };
    this.#push(exchange);
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

  #bodyOf(bytes: Buffer | null, contentType: string | undefined, contentEncoding: string | undefined): BodyData | undefined {
    if (!bytes || bytes.length === 0) return undefined;
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
