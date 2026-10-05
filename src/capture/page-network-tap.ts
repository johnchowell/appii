import type { BrowserContext, CDPSession, Page } from 'playwright';
import { Http } from '../shared/index.js';

export interface TapRecord {
  readonly requestId: string;
  readonly method: string;
  readonly url: string;
  readonly wallTime: number;
  readonly timestamp: number;
  readonly bodyPending: boolean;
  startTime: number;
  memoryCache: boolean;
  cached: boolean;
  claimed: boolean;
}

interface CdpRequest {
  url: string;
  method: string;
  hasPostData?: boolean;
  postDataEntries?: { bytes?: string }[];
}

export class PageNetworkTap {
  static readonly MAX_KEPT = 2000;
  static readonly MS_PER_SECOND = 1000;
  static readonly LATIN1_MAX = 0xff;
  static readonly ASCII_MAX = 0x7f;

  readonly #session: CDPSession;
  readonly #live = new Map<string, TapRecord>();
  readonly #kept: TapRecord[] = [];
  #closed = false;

  constructor(session: CDPSession) {
    this.#session = session;
    session.on('Network.requestWillBeSent', (event) => {
      const previous = this.#live.get(event.requestId);
      const redirect = event.redirectResponse;
      if (previous && redirect) {
        if (redirect.timing && !previous.memoryCache) previous.startTime = (redirect.timing.requestTime - previous.timestamp + previous.wallTime) * PageNetworkTap.MS_PER_SECOND;
        this.#finish(previous);
      }
      this.#live.set(event.requestId, PageNetworkTap.#record(event.requestId, event.request, event.wallTime, event.timestamp));
    });
    session.on('Network.requestServedFromCache', (event) => {
      const record = this.#live.get(event.requestId);
      if (!record) return;
      record.memoryCache = true;
      record.cached = true;
      record.startTime = record.wallTime * PageNetworkTap.MS_PER_SECOND;
    });
    session.on('Network.responseReceived', (event) => {
      const record = this.#live.get(event.requestId);
      if (!record) return;
      const response = event.response;
      if (response.fromDiskCache || response.fromPrefetchCache) record.cached = true;
      const timing = response.timing;
      if (timing && !record.memoryCache) record.startTime = (timing.requestTime - record.timestamp + record.wallTime) * PageNetworkTap.MS_PER_SECOND;
    });
    session.on('Network.loadingFinished', (event) => this.#done(event.requestId));
    session.on('Network.loadingFailed', (event) => this.#done(event.requestId));
  }

  static async open(context: BrowserContext, page: Page): Promise<PageNetworkTap | undefined> {
    let session: CDPSession;
    try {
      session = await context.newCDPSession(page);
    } catch {
      return undefined;
    }
    const tap = new PageNetworkTap(session);
    try {
      await session.send('Network.enable');
      return tap;
    } catch {
      await tap.close();
      return undefined;
    }
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
    const candidates = [...this.#kept, ...this.#live.values()].filter((r) => !r.claimed && r.method === method && r.url === url);
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
    const result = await this.#session.send('Network.getRequestPostData', { requestId: record.requestId });
    return result.postData;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#live.clear();
    this.#kept.length = 0;
    await this.#session.detach().catch(() => undefined);
  }

  #done(requestId: string): void {
    const record = this.#live.get(requestId);
    if (!record) return;
    this.#live.delete(requestId);
    this.#finish(record);
  }

  #finish(record: TapRecord): void {
    if (record.claimed || !(record.bodyPending || record.cached)) return;
    this.#kept.push(record);
    if (this.#kept.length > PageNetworkTap.MAX_KEPT) this.#kept.splice(0, this.#kept.length - PageNetworkTap.MAX_KEPT);
  }

  static #record(requestId: string, request: CdpRequest, wallTime: number, timestamp: number): TapRecord {
    const entries = request.postDataEntries;
    const inline = entries !== undefined && entries.length > 0 && entries.every((entry) => entry.bytes !== undefined);
    return {
      requestId,
      method: request.method,
      url: request.url,
      wallTime,
      timestamp,
      bodyPending: request.hasPostData === true && !inline,
      startTime: wallTime * PageNetworkTap.MS_PER_SECOND,
      memoryCache: false,
      cached: false,
      claimed: false,
    };
  }
}
