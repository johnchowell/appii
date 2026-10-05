import { createHash, randomBytes } from 'node:crypto';
import type { BrowserContext, Page } from 'playwright';
import { Json } from '../shared/index.js';
import type { PageSnapshot } from '../model/index.js';
import { Helpers } from './helpers.js';
import { LiveDom } from './live-dom.js';
import { PageWorld } from './page-world.js';
import type { PageWorldFactory } from './page-world.js';

export interface PageSnapshotterOptions {
  debounceMs?: number;
  timeoutMs?: number;
  dom?: (page: Page, world: PageWorld | undefined) => LiveDom;
  world?: PageWorldFactory;
}

interface TrackedPage {
  readonly onLoad: () => void;
  readonly onClose: () => void;
  readonly world: Promise<PageWorld | undefined>;
  hooked: boolean;
  timer?: NodeJS.Timeout;
}

export class PageSnapshotter {
  static readonly DEFAULT_DEBOUNCE_MS = 300;
  static readonly DEFAULT_TIMEOUT_MS = 10000;
  static readonly WORLD_NAME = 'appii';
  static readonly HOOK_EVENTS: readonly { type: string; capture: boolean }[] = [
    { type: 'load', capture: false },
    { type: 'submit', capture: true },
    { type: 'pagehide', capture: false },
  ];
  static readonly INSPECT_EVENTS: readonly string[] = ['focusin', 'pointerdown', 'keydown', 'input'];

  readonly #debounceMs: number;
  readonly #timeoutMs: number;
  readonly #dom: (page: Page, world: PageWorld | undefined) => LiveDom;
  readonly #world: PageWorldFactory;
  readonly #token = randomBytes(6).toString('hex');
  readonly #binding = `appiiSnapshot_${this.#token}`;
  readonly #marks = `appiiSensitive_${this.#token}`;
  readonly #pages = new Map<Page, TrackedPage>();
  readonly #snapshots: PageSnapshot[] = [];
  readonly #seen = new Set<string>();
  readonly #pending = new Set<Promise<void>>();
  #context: BrowserContext | undefined;
  #ready: Promise<boolean> = Promise.resolve(false);

  constructor(options: PageSnapshotterOptions = {}) {
    this.#debounceMs = options.debounceMs ?? PageSnapshotter.DEFAULT_DEBOUNCE_MS;
    this.#timeoutMs = options.timeoutMs ?? PageSnapshotter.DEFAULT_TIMEOUT_MS;
    this.#world = options.world ?? ((context, page, worldOptions) => PageWorld.open(context, page, worldOptions));
    this.#dom = options.dom ?? ((page, world) => new LiveDom(page, world ? { evaluate: (expression) => world.evaluate(expression), marks: this.#marks } : {}));
  }

  get snapshots(): PageSnapshot[] {
    return [...this.#snapshots];
  }

  hookScript(): string {
    const listeners = PageSnapshotter.HOOK_EVENTS.map((e) => `window.addEventListener(${JSON.stringify(e.type)}, send, ${e.capture});`).join('\n  ');
    const inspectors = PageSnapshotter.INSPECT_EVENTS.map((type) => `window.addEventListener(${JSON.stringify(type)}, inspect, true);`).join('\n  ');
    return `(function () {
  if (window.top !== window) return;
  var marks = new WeakSet();
  var watched = new WeakSet();
  window[${JSON.stringify(this.#marks)}] = marks;
  function isPassword(node) {
    return node instanceof HTMLInputElement && node.type === 'password';
  }
  function markIn(node) {
    if (isPassword(node)) marks.add(node);
    if (!node || typeof node.querySelectorAll !== 'function') return;
    var inputs = node.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) if (isPassword(inputs[i])) marks.add(inputs[i]);
  }
  function process(records) {
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (record.type === 'attributes') {
        var target = record.target;
        if (target instanceof HTMLInputElement && ((record.oldValue || '').toLowerCase() === 'password' || isPassword(target))) marks.add(target);
      } else {
        for (var j = 0; j < record.addedNodes.length; j++) markIn(record.addedNodes[j]);
      }
    }
  }
  var observer = new MutationObserver(process);
  function send() {
    try {
      process(observer.takeRecords());
      var call = window[${JSON.stringify(this.#binding)}];
      if (typeof call !== 'function') return;
      var doc = ${LiveDom.expression(this.#marks)};
      call(JSON.stringify(doc));
    } catch (e) {}
  }
  function watch(root) {
    if (watched.has(root)) return;
    watched.add(root);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
    markIn(root);
    if (root !== document) root.addEventListener('submit', send, true);
  }
  function inspect(event) {
    var path = event.composedPath();
    for (var i = 0; i < path.length; i++) {
      if (path[i] instanceof ShadowRoot) watch(path[i]);
      else if (isPassword(path[i])) marks.add(path[i]);
    }
  }
  watch(document);
  ${inspectors}
  ${listeners}
  if (document.readyState === 'complete') send();
})();`;
  }

  attach(context: BrowserContext): Promise<boolean> {
    if (this.#context) return this.#ready;
    this.#context = context;
    context.on('page', this.#onPage);
    const worlds = context.pages().map((page) => this.#onPage(page));
    this.#ready = Promise.all(worlds).then((list) => list.every((world) => world !== undefined));
    return this.#ready;
  }

  detach(): void {
    this.#context?.off('page', this.#onPage);
    this.#context = undefined;
    for (const [page, tracked] of this.#pages) {
      clearTimeout(tracked.timer);
      page.off('load', tracked.onLoad);
      page.off('close', tracked.onClose);
      void tracked.world.then((world) => world?.close());
    }
    this.#pages.clear();
  }

  prepare(page: Page): Promise<boolean> {
    const tracked = this.#pages.get(page);
    return tracked ? tracked.world.then((world) => world !== undefined) : Promise.resolve(false);
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

  readonly #onPage = (page: Page): Promise<PageWorld | undefined> => {
    const existing = this.#pages.get(page);
    if (existing) return existing.world;
    const context = this.#context;
    const world = context
      ? this.#world(context, page, {
          name: PageSnapshotter.WORLD_NAME,
          binding: this.#binding,
          source: this.hookScript(),
          onCall: (payload) => this.#onHook(context, payload),
        }).catch(() => undefined)
      : Promise.resolve(undefined);
    const tracked: TrackedPage = {
      world,
      hooked: false,
      onLoad: () => this.#onLoad(page, tracked),
      onClose: () => {
        clearTimeout(tracked.timer);
        tracked.timer = undefined;
        page.off('load', tracked.onLoad);
        page.off('close', tracked.onClose);
        this.#pages.delete(page);
        void world.then((opened) => opened?.close());
      },
    };
    void world.then((opened) => {
      tracked.hooked = opened !== undefined;
    });
    this.#pages.set(page, tracked);
    page.on('load', tracked.onLoad);
    page.on('close', tracked.onClose);
    return world;
  };

  #onHook(context: BrowserContext, payload: string): void {
    if (this.#context !== context) return;
    const parsed = Json.safeParse(payload);
    if (!parsed.ok || !Json.isPlainObject(parsed.value)) return;
    const { url, title, html, characterSet } = parsed.value;
    if (typeof url !== 'string' || typeof title !== 'string' || typeof html !== 'string') return;
    this.#add({ url, title, capturedAt: new Date().toISOString(), html, ...(typeof characterSet === 'string' && characterSet !== '' ? { characterSet } : {}) });
  }

  #onLoad(page: Page, tracked: TrackedPage): void {
    if (tracked.timer === undefined && !tracked.hooked) void this.capture(page);
    clearTimeout(tracked.timer);
    tracked.timer = setTimeout(() => {
      tracked.timer = undefined;
      void this.capture(page);
    }, this.#debounceMs);
  }

  async #take(page: Page): Promise<void> {
    if (page.isClosed()) return;
    const world = await this.#pages.get(page)?.world;
    const snapshot = await Helpers.settle(this.#dom(page, world).snapshot(), this.#timeoutMs);
    if (snapshot) this.#add(snapshot);
  }

  #add(snapshot: PageSnapshot): void {
    if (!snapshot.html || !Helpers.isWebPageUrl(snapshot.url)) return;
    const key = createHash('sha256').update(snapshot.url).update('\u0000').update(snapshot.html).digest('hex');
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#snapshots.push(snapshot);
  }
}
