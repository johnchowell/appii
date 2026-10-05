import type { BrowserContext, Page } from 'playwright';
import { Http } from '../shared/index.js';
import type { Cookie, StorageSnapshot } from '../model/index.js';
import { CdpCookieJar } from './cdp-cookie-jar.js';
import type { CdpCookieJarFactory } from './cdp-cookie-jar.js';
import { CookieParser } from './cookie-parser.js';
import { Helpers } from './helpers.js';

export interface BrowserStateTrackerOptions {
  intervalMs?: number;
  timeoutMs?: number;
  cookieJar?: CdpCookieJarFactory;
}

interface StorageRead {
  origin: string;
  local: Record<string, string>;
  session: Record<string, string>;
}

export class BrowserStateTracker {
  static readonly DEFAULT_INTERVAL_MS = 2000;
  static readonly DEFAULT_TIMEOUT_MS = 5000;
  static readonly STORAGE_FUNCTION = `function () {
  function dump(name) {
    var out = {};
    try {
      var store = window[name];
      for (var i = 0; i < store.length; i++) {
        var key = store.key(i);
        if (key !== null) out[key] = store.getItem(key) || '';
      }
    } catch (e) {}
    return out;
  }
  return { origin: location.origin, local: dump('localStorage'), session: dump('sessionStorage') };
}`;

  readonly #intervalMs: number;
  readonly #timeoutMs: number;
  readonly #openJar: CdpCookieJarFactory;
  readonly #storage = new Map<string, StorageSnapshot>();
  readonly #pages = new Map<Page, () => void>();
  #cookies: Cookie[] = [];
  #cookiesAt: number | undefined;
  #context: BrowserContext | undefined;
  #interval: NodeJS.Timeout | undefined;
  #queued: Promise<boolean> | undefined;
  #jar: Promise<CdpCookieJar | undefined> | undefined;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(options: BrowserStateTrackerOptions = {}) {
    this.#intervalMs = options.intervalMs ?? BrowserStateTracker.DEFAULT_INTERVAL_MS;
    this.#timeoutMs = options.timeoutMs ?? BrowserStateTracker.DEFAULT_TIMEOUT_MS;
    this.#openJar = options.cookieJar ?? ((context, page) => CdpCookieJar.open(context, page));
  }

  get cookies(): Cookie[] {
    return this.#cookies.map((c) => ({ ...c }));
  }

  get cookiesAt(): number | undefined {
    return this.#cookiesAt;
  }

  get storage(): StorageSnapshot[] {
    return [...this.#storage.values()]
      .filter((s) => Object.keys(s.localStorage).length > 0 || Object.keys(s.sessionStorage).length > 0)
      .map((s) => ({ origin: s.origin, localStorage: { ...s.localStorage }, sessionStorage: { ...s.sessionStorage } }));
  }

  start(context: BrowserContext): void {
    if (this.#context) return;
    this.#context = context;
    context.on('page', this.#onPage);
    for (const page of context.pages()) this.#onPage(page);
    this.#interval = setInterval(() => void this.refresh(), this.#intervalMs);
    this.#interval.unref();
  }

  stop(): void {
    clearInterval(this.#interval);
    this.#interval = undefined;
    this.#context?.off('page', this.#onPage);
    for (const [page, listener] of this.#pages) page.off('load', listener);
    this.#pages.clear();
    this.#context = undefined;
    const jar = this.#jar;
    this.#jar = undefined;
    void jar?.then((opened) => opened?.close());
  }

  refresh(): Promise<boolean> {
    if (this.#queued) return this.#queued;
    const run = this.#tail.then(() => {
      this.#queued = undefined;
      return this.#read();
    });
    this.#queued = run;
    this.#tail = run.catch(() => false);
    return run;
  }

  readonly #onPage = (page: Page): void => {
    if (this.#pages.has(page)) return;
    const listener = (): void => void this.refresh();
    this.#pages.set(page, listener);
    page.on('load', listener);
    page.once('close', () => {
      page.off('load', listener);
      this.#pages.delete(page);
    });
  };

  async #read(): Promise<boolean> {
    const context = this.#context;
    if (!context) return false;
    const startedAt = Date.now();
    const cookies = await this.#readCookies(context);
    const ok = cookies !== undefined;
    if (cookies) {
      this.#cookies = cookies;
      this.#cookiesAt = startedAt;
    }
    const reads = await Promise.all(context.pages().map((page) => this.#readStorage(page)));
    const merged = new Map<string, StorageSnapshot>();
    for (const read of reads) {
      if (!read) continue;
      const current = merged.get(read.origin);
      merged.set(read.origin, {
        origin: read.origin,
        localStorage: { ...read.local },
        sessionStorage: { ...(current?.sessionStorage ?? {}), ...read.session },
      });
    }
    for (const [origin, snapshot] of merged) this.#storage.set(origin, snapshot);
    return ok;
  }

  async #readCookies(context: BrowserContext): Promise<Cookie[] | undefined> {
    const jar = await Helpers.settle(this.#cookieJar(context), this.#timeoutMs);
    const exact = jar ? await Helpers.settle(jar.cookies(), this.#timeoutMs) : undefined;
    if (exact) return exact.map((c) => CookieParser.fromCdp(c));
    const raw = await Helpers.settle(context.cookies(), this.#timeoutMs);
    return raw?.map((c) => CookieParser.fromPlaywright(c));
  }

  #cookieJar(context: BrowserContext): Promise<CdpCookieJar | undefined> {
    if (this.#jar) return this.#jar;
    const page = context.pages().find((p) => !p.isClosed());
    if (!page) return Promise.resolve(undefined);
    const jar = this.#openJar(context, page).catch(() => undefined);
    this.#jar = jar;
    void jar.then((opened) => {
      if (!opened && this.#jar === jar) this.#jar = undefined;
    });
    return jar;
  }

  async #readStorage(page: Page): Promise<StorageRead | undefined> {
    if (page.isClosed()) return undefined;
    try {
      if (Http.originOf(page.url()) === 'null') return undefined;
    } catch {
      return undefined;
    }
    const result = await Helpers.settle(page.evaluate(`(${BrowserStateTracker.STORAGE_FUNCTION})()`), this.#timeoutMs);
    if (!result || typeof result !== 'object') return undefined;
    const read = result as Partial<StorageRead>;
    if (typeof read.origin !== 'string' || read.origin === 'null') return undefined;
    return { origin: read.origin, local: BrowserStateTracker.#strings(read.local), session: BrowserStateTracker.#strings(read.session) };
  }

  static #strings(value: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!value || typeof value !== 'object') return out;
    for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
    return out;
  }
}
