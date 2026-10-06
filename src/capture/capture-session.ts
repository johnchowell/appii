import { errors } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { AppiiError, Meta, Text, isAppiiError } from '../shared/index.js';
import type { Capture, Cookie, Exchange, PageSnapshot, StorageSnapshot } from '../model/index.js';
import { BrowserLauncher } from './browser-launcher.js';
import type { BrowserLauncherOptions } from './browser-launcher.js';
import { BrowserStateTracker } from './browser-state-tracker.js';
import { CaptureStore } from './capture-store.js';
import { CookieParser } from './cookie-parser.js';
import { Helpers } from './helpers.js';
import { LoginProbe } from './login-probe.js';
import type { ProbeOutcome } from './login-probe.js';
import { LoginSubmitter } from './login-submitter.js';
import type { LoginField, LoginOutcome } from './login-submitter.js';
import { NetworkIdleMonitor } from './network-idle-monitor.js';
import { PageSnapshotter } from './page-snapshotter.js';
import { TrafficRecorder } from './traffic-recorder.js';
import type { TrafficRecorderOptions } from './traffic-recorder.js';
import type { UserAgentIdentity } from './user-agent-identity.js';
import { UserAgentOverride } from './user-agent-override.js';

export interface CaptureSessionOptions extends BrowserLauncherOptions {
  url?: string;
  visits?: readonly string[];
  login?: readonly LoginField[];
  probeLogin?: boolean;
  durationMs?: number;
  idleMs?: number;
  recorder?: TrafficRecorderOptions;
  script?: (page: Page) => Promise<void>;
  signal?: AbortSignal;
  onExchange?: (e: Exchange) => void;
  onReady?: () => void;
  onLogin?: (outcome: LoginOutcome) => void;
  onProbe?: (outcome: ProbeOutcome) => void;
}

export interface CaptureSessionDeps {
  launcher: BrowserLauncher;
  recorder: TrafficRecorder;
  cookies: CookieParser;
  snapshots?: () => PageSnapshotter;
  state?: () => BrowserStateTracker;
  idle?: () => NetworkIdleMonitor;
  identity?: (identity: UserAgentIdentity) => UserAgentOverride;
  login?: () => LoginSubmitter;
  probe?: () => LoginProbe;
}

interface RunFactories {
  readonly snapshots: () => PageSnapshotter;
  readonly state: () => BrowserStateTracker;
  readonly idle: () => NetworkIdleMonitor;
  readonly identity: (identity: UserAgentIdentity) => UserAgentOverride;
  readonly login: () => LoginSubmitter;
  readonly probe: () => LoginProbe;
}

interface CaptureRun {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly snapshots: PageSnapshotter;
  readonly state: BrowserStateTracker;
  readonly idle: NetworkIdleMonitor;
  readonly identity: UserAgentOverride | undefined;
  attached: boolean;
  contextClosed: boolean;
  browserLost: boolean;
  closing: boolean;
}

interface FinalState {
  cookies: Cookie[];
  storage: StorageSnapshot[];
  pages: PageSnapshot[];
}

export class CaptureSession {
  static readonly DEFAULT_IDLE_MS = 1500;
  static readonly NAVIGATION_TIMEOUT_MS = 30000;
  static readonly FINALIZE_TIMEOUT_MS = 15000;
  static readonly PREPARE_TIMEOUT_MS = 5000;
  static readonly DOWNLOAD_STARTING = 'Download is starting';
  static readonly BROWSER_LOST = 'The browser closed before the capture finished, most likely because it crashed';
  static readonly START_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'file:']);

  readonly recorder: TrafficRecorder;
  readonly #options: Readonly<CaptureSessionOptions>;
  readonly #deps: CaptureSessionDeps;
  readonly #factories: RunFactories;
  readonly #stopSignal: Promise<void>;
  readonly #resolveStop: () => void;
  #started = false;
  #stopped = false;

  constructor(options: CaptureSessionOptions, deps: CaptureSessionDeps) {
    CaptureSession.#checkDuration(options.durationMs, 'durationMs');
    CaptureSession.#checkDuration(options.idleMs, 'idleMs');
    if (options.url !== undefined) CaptureSession.#checkUrl(options.url);
    for (const visit of options.visits ?? []) CaptureSession.#checkUrl(visit);
    CaptureSession.#checkLogin(options);
    this.#options = { ...options };
    this.#deps = deps;
    this.#factories = {
      snapshots: deps.snapshots ?? (() => new PageSnapshotter()),
      state: deps.state ?? (() => new BrowserStateTracker()),
      idle: deps.idle ?? (() => new NetworkIdleMonitor()),
      identity: deps.identity ?? ((identity) => new UserAgentOverride(identity)),
      login: deps.login ?? (() => new LoginSubmitter()),
      probe: deps.probe ?? (() => new LoginProbe()),
    };
    this.recorder = deps.recorder;
    let resolveStop: () => void = () => undefined;
    this.#stopSignal = new Promise<void>((resolve) => {
      resolveStop = resolve;
    });
    this.#resolveStop = resolveStop;
  }

  static create(options: CaptureSessionOptions = {}): CaptureSession {
    return new CaptureSession(options, {
      launcher: new BrowserLauncher(options),
      recorder: new TrafficRecorder(CaptureSession.recorderOptions(options)),
      cookies: new CookieParser(),
      snapshots: () => new PageSnapshotter(),
      state: () => new BrowserStateTracker(),
      idle: () => new NetworkIdleMonitor(),
      identity: (identity) => new UserAgentOverride(identity),
      login: () => LoginSubmitter.create(),
      probe: () => LoginProbe.create(),
    });
  }

  static recorderOptions(options: CaptureSessionOptions): TrafficRecorderOptions {
    return { quietMs: options.idleMs ?? CaptureSession.DEFAULT_IDLE_MS, ...options.recorder };
  }

  get stopped(): boolean {
    return this.#stopped;
  }

  stop(): void {
    this.#stopped = true;
    this.#resolveStop();
  }

  async run(): Promise<Capture> {
    if (this.#started) throw new AppiiError('CAPTURE', 'This capture session has already run; create a new CaptureSession for another capture');
    this.#started = true;
    const startedAt = new Date();
    const signal = this.#options.signal;
    const onAbort = (): void => this.stop();
    if (signal?.aborted) this.stop();
    else signal?.addEventListener('abort', onAbort, { once: true });
    try {
      if (this.#stopped) return this.#assemble(startedAt, { cookies: [], storage: [], pages: [] });
      const { browser, context, identity } = await this.#deps.launcher.launch();
      return await this.#capture(browser, context, identity, startedAt);
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  }

  get #headless(): boolean {
    return this.#deps.launcher.headless;
  }

  get #idleMs(): number {
    return this.#options.idleMs ?? CaptureSession.DEFAULT_IDLE_MS;
  }

  get #readTimeoutMs(): number {
    return this.#options.recorder?.readTimeoutMs ?? TrafficRecorder.READ_TIMEOUT_MS;
  }

  async #capture(browser: Browser, context: BrowserContext, identity: UserAgentIdentity | undefined, startedAt: Date): Promise<Capture> {
    const run: CaptureRun = {
      browser,
      context,
      snapshots: this.#factories.snapshots(),
      state: this.#factories.state(),
      idle: this.#factories.idle(),
      identity: identity ? this.#factories.identity(identity) : undefined,
      attached: false,
      contextClosed: false,
      browserLost: false,
      closing: false,
    };
    const onLost = (): void => {
      if (!this.#stopped && !run.closing) run.browserLost = true;
    };
    browser.on('disconnected', onLost);
    context.on('close', onLost);
    const onExchange = this.#options.onExchange;
    const unsubscribe = onExchange ? this.recorder.onExchange(onExchange) : undefined;
    const unsettle = this.recorder.onSettled((request, settled) => run.idle.settle(request, settled));
    const workerIdentity = identity ? this.recorder.onServiceWorker((channel) => identity.applyToWorker(channel)) : undefined;
    let failure: unknown;
    try {
      run.identity?.attach(context);
      this.recorder.attach(context);
      run.attached = true;
      run.idle.attach(context);
      await run.snapshots.attach(context);
      run.state.start(context);
      await this.#drive(run);
    } catch (err) {
      failure = err;
    }
    const final = await this.#finalize(run);
    browser.off('disconnected', onLost);
    context.off('close', onLost);
    unsubscribe?.();
    unsettle();
    workerIdentity?.();
    const capture = this.#assemble(startedAt, final);
    if (failure === undefined && run.browserLost) failure = new AppiiError('BROWSER', CaptureSession.BROWSER_LOST);
    if (failure !== undefined) throw CaptureSession.#failure(failure, capture);
    return capture;
  }

  async #drive(run: CaptureRun): Promise<void> {
    const { browser, context } = run;
    const cleanups: (() => void)[] = [];
    const ends: Promise<unknown>[] = [this.#stopSignal];
    ends.push(
      new Promise<void>((resolve) => {
        const onDisconnected = (): void => resolve();
        const onClose = (): void => {
          run.contextClosed = true;
          resolve();
        };
        browser.on('disconnected', onDisconnected);
        context.on('close', onClose);
        cleanups.push(() => {
          browser.off('disconnected', onDisconnected);
          context.off('close', onClose);
        });
      }),
    );
    const duration = this.#options.durationMs;
    if (duration !== undefined) {
      ends.push(
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, duration);
          cleanups.push(() => clearTimeout(timer));
        }),
      );
    }
    if (!this.#headless) ends.push(CaptureSession.#allPagesClosed(context, cleanups));
    const main = this.#main(run).catch((err: unknown) => {
      if (!this.#gone(run)) throw err;
    });
    main.catch(() => undefined);
    ends.push(main);
    try {
      await Promise.race(ends);
    } finally {
      for (const cleanup of cleanups) cleanup();
    }
  }

  async #main(run: CaptureRun): Promise<void> {
    if (this.#stopped) return;
    let page = run.context.pages().find((p) => !p.isClosed());
    if (!page) {
      try {
        page = await run.context.newPage();
      } catch (err) {
        throw new AppiiError('BROWSER', `Cannot open a browser page: ${Text.errorMessage(err, { firstLine: true })}`, { cause: err });
      }
    }
    await Helpers.settle(Promise.all([run.identity?.prepare(page), this.recorder.prepare(page), run.snapshots.prepare(page)]), CaptureSession.PREPARE_TIMEOUT_MS);
    if (!this.#stopped) this.#options.onReady?.();
    const url = this.#options.url;
    const visits = this.#options.visits ?? [];
    const login = this.#options.login ?? [];
    const probe = this.#options.probeLogin === true;
    if (url) await this.#open(run, page, url);
    if (login.length > 0 || probe || (url && visits.length > 0)) await run.idle.waitForIdle(this.#idleMs);
    if (this.#stopped) return;
    if (probe) await this.#probe(run, page);
    else await this.#login(run, page, login);
    for (const visit of visits) {
      if (this.#stopped) return;
      await this.#open(run, page, visit);
      await run.idle.waitForIdle(this.#idleMs);
    }
    if (this.#stopped) return;
    const script = this.#options.script;
    if (script) {
      try {
        await script(page);
      } catch (err) {
        if (this.#gone(run)) return;
        throw new AppiiError('CAPTURE', `Capture script failed: ${Text.errorMessage(err, { firstLine: true })}`, { cause: err });
      }
      await run.idle.waitForIdle(this.#idleMs);
      return;
    }
    if (this.#headless && this.#options.durationMs === undefined) {
      await run.idle.waitForIdle(this.#idleMs);
      return;
    }
    await new Promise<void>(() => undefined);
  }

  async #login(run: CaptureRun, page: Page, fields: readonly LoginField[]): Promise<void> {
    if (fields.length === 0) return;
    const outcome = await this.#factories.login().submit(page, fields, { timeoutMs: this.#readTimeoutMs, settle: () => run.idle.waitForIdle(this.#idleMs) });
    if (!this.#stopped) this.#options.onLogin?.(outcome);
  }

  async #probe(run: CaptureRun, page: Page): Promise<void> {
    const outcome = await this.#factories.probe().run(run.context, page, {
      timeoutMs: this.#readTimeoutMs,
      settle: () => run.idle.waitForIdle(this.#idleMs),
      window: (blocked) => this.recorder.probe(blocked),
    });
    if (!this.#stopped) this.#options.onProbe?.(outcome);
  }

  async #open(run: CaptureRun, page: Page, url: string): Promise<void> {
    try {
      await page.goto(url, { waitUntil: 'load', timeout: CaptureSession.NAVIGATION_TIMEOUT_MS });
    } catch (err) {
      if (this.#gone(run) || page.isClosed() || err instanceof errors.TimeoutError || !this.#headless) return;
      if (CaptureSession.#isDownload(err)) return;
      throw new AppiiError('CAPTURE', `Cannot open ${url}: ${Text.errorMessage(err, { firstLine: true })}`, { cause: err });
    }
  }

  #gone(run: CaptureRun): boolean {
    return this.#stopped || run.contextClosed || !run.browser.isConnected();
  }

  async #finalize(run: CaptureRun): Promise<FinalState> {
    const timeout = CaptureSession.FINALIZE_TIMEOUT_MS;
    await Helpers.settle(this.recorder.settled(), timeout);
    let cookiesFresh = false;
    if (run.browser.isConnected() && !run.contextClosed) {
      await Helpers.settle(run.snapshots.finish(), timeout);
      cookiesFresh = (await Helpers.settle(run.state.refresh(), timeout)) === true;
    }
    if (run.attached) this.recorder.detach();
    run.idle.detach();
    run.identity?.detach();
    run.snapshots.detach();
    run.state.stop();
    await Helpers.settle(this.recorder.settled(), timeout);
    await Helpers.settle(run.snapshots.settled(), timeout);
    run.closing = true;
    await Helpers.settle(run.browser.close(), timeout);
    const cookies = cookiesFresh ? run.state.cookies : this.#replayCookies(run.state);
    return { cookies, storage: run.state.storage, pages: run.snapshots.snapshots };
  }

  #replayCookies(state: BrowserStateTracker): Cookie[] {
    const since = state.cookiesAt;
    const exchanges = since === undefined ? this.recorder.exchanges : this.recorder.exchanges.filter((e) => !(Helpers.endTime(e) < since));
    return this.#deps.cookies.replay(exchanges, state.cookies);
  }

  #assemble(startedAt: Date, final: FinalState): Capture {
    const url = this.#options.url;
    return {
      version: CaptureStore.VERSION,
      tool: Meta.creator() as Capture['tool'],
      ...(url ? { startUrl: url } : {}),
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      exchanges: [...this.recorder.exchanges],
      websockets: this.recorder.websockets.map((ws) => ({ ...ws, messages: [...ws.messages] })),
      cookies: final.cookies,
      storage: final.storage,
      pages: final.pages,
    };
  }

  static #allPagesClosed(context: BrowserContext, cleanups: (() => void)[]): Promise<void> {
    return new Promise<void>((resolve) => {
      const check = (): void => {
        if (context.pages().every((p) => p.isClosed())) resolve();
      };
      const watch = (page: Page): void => {
        page.once('close', check);
      };
      context.on('page', watch);
      for (const page of context.pages()) watch(page);
      cleanups.push(() => context.off('page', watch));
    });
  }

  static #isDownload(err: unknown): boolean {
    return err instanceof Error && err.message.includes(CaptureSession.DOWNLOAD_STARTING);
  }

  static #failure(err: unknown, capture: Capture): AppiiError {
    if (isAppiiError(err)) return new AppiiError(err.code, err.message, { cause: err.cause ?? err, details: { capture } });
    return new AppiiError('CAPTURE', `Capture failed: ${Text.errorMessage(err, { firstLine: true })}`, { cause: err, details: { capture } });
  }

  static #checkDuration(value: number | undefined, name: string): void {
    if (value === undefined) return;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new AppiiError('BAD_INPUT', `Capture option ${name} must be a non-negative number of milliseconds, got ${String(value)}`);
    }
  }

  static #checkLogin(options: CaptureSessionOptions): void {
    if (options.probeLogin === true && (options.login?.length ?? 0) > 0) {
      throw new AppiiError('BAD_INPUT', 'Capture options probeLogin and login cannot be combined: the probe fills the login form with placeholder values and stops what it sends, login submits your values');
    }
    for (const field of options.login ?? []) {
      if (typeof field.name !== 'string' || field.name === '' || typeof field.value !== 'string') {
        throw new AppiiError('BAD_INPUT', 'Capture option login needs fields with a non-empty name and a string value');
      }
    }
  }

  static #checkUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new AppiiError('BAD_INPUT', `Capture URL is not an absolute URL: ${url}`);
    }
    if (!CaptureSession.START_SCHEMES.has(parsed.protocol)) {
      throw new AppiiError('BAD_INPUT', `Capture URL must use http, https or file, got ${parsed.protocol}`);
    }
  }
}
