import { createHash, randomBytes } from 'node:crypto';
import type { BrowserContext, Frame, Page } from 'playwright';
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
  url: string;
  readonly onLoad: () => void;
  readonly onNavigated: (frame: Frame) => void;
  readonly onClose: () => void;
  readonly world: Promise<PageWorld | undefined>;
  hooked: boolean;
  timer?: NodeJS.Timeout;
  route?: NodeJS.Timeout;
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
  static readonly ROUTE_EVENTS: readonly string[] = ['popstate'];
  static readonly NAVIGATION_EVENT = 'currententrychange';
  static readonly LOADED_STATE = 'complete';
  static readonly FORM_CONTROLS: readonly string[] = ['form', ...LiveDom.LISTED_CONTROLS];

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
    const routes = PageSnapshotter.ROUTE_EVENTS.map((type) => `window.addEventListener(${JSON.stringify(type)}, route, false);`).join('\n  ');
    const inspectors = PageSnapshotter.INSPECT_EVENTS.map((type) => `window.addEventListener(${JSON.stringify(type)}, inspect, true);`).join('\n  ');
    return `(function () {
  if (window.top !== window) return;
  var marks = new WeakSet();
  var watched = new WeakSet();
  var shapes = new Set();
  var timer = 0;
  var sentUrl = '';
  var CONTROLS = ${JSON.stringify(PageSnapshotter.FORM_CONTROLS.join(','))};
  function getter(proto, name) {
    return Object.getOwnPropertyDescriptor(proto, name).get;
  }
  var getAttribute = Element.prototype.getAttribute;
  var matches = Element.prototype.matches;
  var queries = [[Element, Element.prototype.querySelectorAll], [Document, Document.prototype.querySelectorAll], [DocumentFragment, DocumentFragment.prototype.querySelectorAll]];
  var formElements = getter(HTMLFormElement.prototype, 'elements');
  var documentForms = getter(Document.prototype, 'forms');
  var readyState = getter(Document.prototype, 'readyState');
  var isConnected = getter(Node.prototype, 'isConnected');
  window[${JSON.stringify(this.#marks)}] = marks;
  function isPassword(node) {
    return node instanceof HTMLInputElement && node.type === 'password';
  }
  function parsed() {
    return readyState.call(document) !== 'loading';
  }
  function withoutFragment(url) {
    var hash = url.indexOf('#');
    return hash < 0 ? url : url.slice(0, hash);
  }
  function eachControl(node, selector, visit) {
    if (node instanceof Element && matches.call(node, selector)) visit(node);
    for (var i = 0; i < queries.length; i++) {
      if (!(node instanceof queries[i][0])) continue;
      var found = queries[i][1].call(node, selector);
      for (var j = 0; j < found.length; j++) visit(found[j]);
      return;
    }
  }
  function markIn(node, owners) {
    eachControl(node, owners ? CONTROLS : 'input', function (control) {
      if (isPassword(control)) marks.add(control);
      var owner = control instanceof HTMLFormElement ? control : control.form;
      if (owners && owner) owners.add(owner);
    });
  }
  function remember(form) {
    var shape = [location.href, getAttribute.call(form, 'action'), getAttribute.call(form, 'method'), getAttribute.call(form, 'enctype')];
    var controls = formElements.call(form);
    for (var i = 0; i < controls.length; i++) shape.push(controls[i].localName, controls[i].type, controls[i].name);
    var key = JSON.stringify(shape);
    if (shapes.has(key)) return false;
    shapes.add(key);
    return true;
  }
  function process(records, collect) {
    var owners = collect ? new Set() : null;
    for (var i = 0; i < records.length; i++) {
      var record = records[i];
      if (record.type === 'attributes') {
        var target = record.target;
        if (target instanceof HTMLInputElement && ((record.oldValue || '').toLowerCase() === 'password' || isPassword(target))) marks.add(target);
      } else {
        for (var j = 0; j < record.addedNodes.length; j++) markIn(record.addedNodes[j], owners);
      }
    }
    var fresh = false;
    if (owners) owners.forEach(function (form) {
      if (isConnected.call(form) && remember(form)) fresh = true;
    });
    return fresh;
  }
  var observer = new MutationObserver(function (records) {
    if (process(records, parsed())) schedule();
  });
  function baseline() {
    process(observer.takeRecords(), false);
    var forms = documentForms.call(document);
    for (var i = 0; i < forms.length; i++) remember(forms[i]);
  }
  function send() {
    clearTimeout(timer);
    timer = 0;
    try {
      baseline();
      sentUrl = location.href;
      var call = window[${JSON.stringify(this.#binding)}];
      if (typeof call !== 'function') return;
      var doc = ${LiveDom.expression(this.#marks)};
      call(JSON.stringify(doc));
    } catch (e) {}
  }
  function settle() {
    timer = 0;
    if (parsed()) send();
  }
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(settle, ${this.#debounceMs});
  }
  function route() {
    if (withoutFragment(location.href) !== withoutFragment(sentUrl)) schedule();
  }
  function watch(root) {
    if (watched.has(root)) return;
    watched.add(root);
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
    markIn(root, null);
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
  document.addEventListener('readystatechange', function () {
    if (readyState.call(document) === 'interactive') baseline();
  });
  ${inspectors}
  ${listeners}
  ${routes}
  if (typeof navigation === 'object' && navigation !== null) navigation.addEventListener(${JSON.stringify(PageSnapshotter.NAVIGATION_EVENT)}, route);
  var state = readyState.call(document);
  if (state === 'complete') send();
  else if (state === 'interactive') baseline();
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
      PageSnapshotter.#stop(tracked);
      PageSnapshotter.#unhook(page, tracked);
      void tracked.world.then((world) => world?.close());
    }
    this.#pages.clear();
  }

  prepare(page: Page): Promise<boolean> {
    const tracked = this.#pages.get(page);
    return tracked ? tracked.world.then((world) => world !== undefined) : Promise.resolve(false);
  }

  capture(page: Page): Promise<void> {
    return this.#track(this.#take(page));
  }

  async finish(): Promise<void> {
    const open: Page[] = [];
    for (const [page, tracked] of this.#pages) {
      PageSnapshotter.#stop(tracked);
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
      url: page.url(),
      world,
      hooked: false,
      onLoad: () => this.#onLoad(page, tracked),
      onNavigated: (frame) => this.#onNavigated(page, tracked, frame),
      onClose: () => {
        PageSnapshotter.#stop(tracked);
        PageSnapshotter.#unhook(page, tracked);
        this.#pages.delete(page);
        void world.then((opened) => opened?.close());
      },
    };
    void world.then((opened) => {
      tracked.hooked = opened !== undefined;
    });
    this.#pages.set(page, tracked);
    page.on('load', tracked.onLoad);
    page.on('framenavigated', tracked.onNavigated);
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
    clearTimeout(tracked.route);
    tracked.route = undefined;
    if (tracked.timer === undefined && !tracked.hooked) void this.capture(page);
    clearTimeout(tracked.timer);
    tracked.timer = setTimeout(() => {
      tracked.timer = undefined;
      void this.capture(page);
    }, this.#debounceMs);
  }

  #onNavigated(page: Page, tracked: TrackedPage, frame: Frame): void {
    if (frame !== page.mainFrame()) return;
    const previous = tracked.url;
    tracked.url = frame.url();
    if (tracked.hooked || Helpers.withoutFragment(previous) === Helpers.withoutFragment(tracked.url)) return;
    clearTimeout(tracked.route);
    tracked.route = setTimeout(() => {
      tracked.route = undefined;
      void this.#track(this.#take(page, true));
    }, this.#debounceMs);
  }

  #track(task: Promise<void>): Promise<void> {
    this.#pending.add(task);
    void task.finally(() => this.#pending.delete(task));
    return task;
  }

  async #take(page: Page, loadedOnly = false): Promise<void> {
    if (page.isClosed()) return;
    const world = await this.#pages.get(page)?.world;
    const dom = this.#dom(page, world);
    if (loadedOnly && (await Helpers.settle(dom.readyState(), this.#timeoutMs)) !== PageSnapshotter.LOADED_STATE) return;
    const snapshot = await Helpers.settle(dom.snapshot(), this.#timeoutMs);
    if (snapshot) this.#add(snapshot);
  }

  static #stop(tracked: TrackedPage): void {
    clearTimeout(tracked.timer);
    clearTimeout(tracked.route);
    tracked.timer = undefined;
    tracked.route = undefined;
  }

  static #unhook(page: Page, tracked: TrackedPage): void {
    page.off('load', tracked.onLoad);
    page.off('framenavigated', tracked.onNavigated);
    page.off('close', tracked.onClose);
  }

  #add(snapshot: PageSnapshot): void {
    if (!snapshot.html || !Helpers.isWebPageUrl(snapshot.url)) return;
    const key = createHash('sha256').update(snapshot.url).update('\u0000').update(snapshot.html).digest('hex');
    if (this.#seen.has(key)) return;
    this.#seen.add(key);
    this.#snapshots.push(snapshot);
  }
}
