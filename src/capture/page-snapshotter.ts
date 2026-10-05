import { createHash, randomBytes } from 'node:crypto';
import type { BrowserContext, Frame, Page } from 'playwright';
import { Http } from '../shared/index.js';
import type { PageSnapshot } from '../model/index.js';
import { Helpers } from './helpers.js';
import { LiveDom } from './live-dom.js';

export interface PageSnapshotterOptions {
  debounceMs?: number;
  timeoutMs?: number;
  dom?: (page: Page) => LiveDom;
}

interface TrackedPage {
  readonly onLoad: () => void;
  readonly onClose: () => void;
  timer?: NodeJS.Timeout;
}

export class PageSnapshotter {
  static readonly DEFAULT_DEBOUNCE_MS = 300;
  static readonly DEFAULT_TIMEOUT_MS = 10000;
  static readonly HOOK_EVENTS: readonly { type: string; capture: boolean }[] = [
    { type: 'load', capture: false },
    { type: 'submit', capture: true },
    { type: 'pagehide', capture: false },
  ];

  readonly #debounceMs: number;
  readonly #timeoutMs: number;
  readonly #dom: (page: Page) => LiveDom;
  readonly #binding = `__appiiSnapshot_${randomBytes(6).toString('hex')}`;
  readonly #pages = new Map<Page, TrackedPage>();
  readonly #snapshots: PageSnapshot[] = [];
  readonly #seen = new Set<string>();
  readonly #pending = new Set<Promise<void>>();
  #context: BrowserContext | undefined;
  #ready: Promise<boolean> = Promise.resolve(false);
  #hooked = false;

  constructor(options: PageSnapshotterOptions = {}) {
    this.#debounceMs = options.debounceMs ?? PageSnapshotter.DEFAULT_DEBOUNCE_MS;
    this.#timeoutMs = options.timeoutMs ?? PageSnapshotter.DEFAULT_TIMEOUT_MS;
    this.#dom = options.dom ?? ((page) => new LiveDom(page));
  }

  get snapshots(): PageSnapshot[] {
    return [...this.#snapshots];
  }

  hookScript(): string {
    const listeners = PageSnapshotter.HOOK_EVENTS.map((e) => `window.addEventListener(${JSON.stringify(e.type)}, function () { send(); }, ${e.capture});`).join('\n  ');
    return `(function () {
  if (window.top !== window) return;
  function send() {
    try {
      var binding = window[${JSON.stringify(this.#binding)}];
      if (typeof binding !== 'function') return;
      var doc = ${LiveDom.expression()};
      var pending = binding(doc.url, doc.title, doc.html);
      if (pending && typeof pending.catch === 'function') pending.catch(function () {});
    } catch (e) {}
  }
  ${listeners}
})();`;
  }

  attach(context: BrowserContext): Promise<boolean> {
    if (this.#context) return this.#ready;
    this.#context = context;
    context.on('page', this.#onPage);
    for (const page of context.pages()) this.#onPage(page);
    this.#ready = this.#install(context);
    return this.#ready;
  }

  detach(): void {
    this.#context?.off('page', this.#onPage);
    this.#context = undefined;
    for (const [page, tracked] of this.#pages) {
      clearTimeout(tracked.timer);
      page.off('load', tracked.onLoad);
      page.off('close', tracked.onClose);
    }
    this.#pages.clear();
  }

  capture(page: Page): Promise<void> {
    const task = this.#take(page);
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
    return task;
  }

  async finish(): Promise<void> {
    const open: Page[] = [];
    for (const [page, tracked] of this.#pages) {
      clearTimeout(tracked.timer);
      tracked.timer = undefined;
      if (!page.isClosed()) open.push(page);
    }
    await this.settled();
    await Promise.all(open.map((page) => this.capture(page)));
  }

  async settled(): Promise<void> {
    await this.#ready;
    while (this.#pending.size > 0) await Promise.allSettled([...this.#pending]);
  }

  async #install(context: BrowserContext): Promise<boolean> {
    try {
      await context.exposeBinding(this.#binding, (source: { page: Page; frame: Frame }, url: unknown, title: unknown, html: unknown) => {
        if (this.#context !== context || source.frame !== source.page.mainFrame()) return;
        if (typeof url !== 'string' || typeof title !== 'string' || typeof html !== 'string') return;
        if (!PageSnapshotter.#sameOrigin(url, source.frame.url())) return;
        this.#add({ url, title, capturedAt: new Date().toISOString(), html });
      });
      await context.addInitScript({ content: this.hookScript() });
      this.#hooked = true;
      return true;
    } catch {
      this.#hooked = false;
      return false;
    }
  }

  readonly #onPage = (page: Page): void => {
    if (this.#pages.has(page)) return;
    const tracked: TrackedPage = {
      onLoad: () => this.#onLoad(page, tracked),
      onClose: () => {
        clearTimeout(tracked.timer);
        tracked.timer = undefined;
        page.off('load', tracked.onLoad);
        page.off('close', tracked.onClose);
        this.#pages.delete(page);
      },
    };
    this.#pages.set(page, tracked);
    page.on('load', tracked.onLoad);
    page.on('close', tracked.onClose);
  };

  #onLoad(page: Page, tracked: TrackedPage): void {
    if (tracked.timer === undefined && !this.#hooked) void this.capture(page);
    clearTimeout(tracked.timer);
    tracked.timer = setTimeout(() => {
      tracked.timer = undefined;
      void this.capture(page);
    }, this.#debounceMs);
  }

  async #take(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const snapshot = await Helpers.settle(this.#dom(page).snapshot(), this.#timeoutMs);
    if (snapshot) this.#add(snapshot);
  }

  static #sameOrigin(a: string, b: string): boolean {
    try {
      return Http.originOf(a) === Http.originOf(b);
    } catch {
      return false;
    }
  }

  #add(snapshot: PageSnapshot): void {
    if (!snapshot.html || !Helpers.isWebPageUrl(snapshot.url)) return;
    const key = createHash('sha256').update(snapshot.url).update('\u0000').update(snapshot.html).digest('hex');
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#snapshots.push(snapshot);
  }
}
