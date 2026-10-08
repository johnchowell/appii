import { chromium } from 'playwright';
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright';
import { AppiiError, Fs, Text } from '../shared/index.js';
import { UserAgentIdentity } from './user-agent-identity.js';

export interface BrowserLauncherOptions {
  headless?: boolean;
  executablePath?: string;
  userAgent?: string;
  viewport?: { width: number; height: number } | null;
  storageState?: string;
  args?: string[];
}

export interface LaunchedBrowser {
  browser: Browser;
  context: BrowserContext;
  identity?: UserAgentIdentity;
}

export class BrowserLauncher {
  static readonly NO_DISPLAY: RegExp = /XServer|Missing X server|\$DISPLAY/i;
  static readonly NOT_INSTALLED: RegExp = /executable doesn't exist/i;
  static readonly API_PREFIX: RegExp = /^[A-Za-z]+\.[A-Za-z]+: /;
  static readonly NO_DISPLAY_MESSAGE = 'Cannot open a browser window: no display (X server) is available';
  static readonly INSTALL_COMMAND = 'npx playwright install chromium';

  readonly options: Readonly<BrowserLauncherOptions>;

  constructor(options: BrowserLauncherOptions = {}) {
    this.options = BrowserLauncher.#pick(options);
  }

  get headless(): boolean {
    return this.options.headless ?? true;
  }

  launchOptions(): LaunchOptions {
    const o = this.options;
    return {
      headless: this.headless,
      ...(o.executablePath ? { executablePath: o.executablePath } : {}),
      ...(o.args ? { args: [...o.args] } : {}),
    };
  }

  contextOptions(): BrowserContextOptions {
    const o = this.options;
    const viewport = o.viewport === undefined ? (this.headless ? undefined : null) : o.viewport;
    return {
      ...(o.userAgent ? { userAgent: o.userAgent } : {}),
      ...(viewport === undefined ? {} : { viewport: viewport === null ? null : { ...viewport } }),
      ...(o.storageState ? { storageState: o.storageState } : {}),
    };
  }

  async launch(): Promise<LaunchedBrowser> {
    const storageState = this.options.storageState;
    if (storageState && !(await Fs.exists(storageState))) {
      throw new AppiiError('NOT_FOUND', `Storage state file not found: ${storageState}`);
    }
    let browser: Browser;
    try {
      browser = await chromium.launch(this.launchOptions());
    } catch (err) {
      throw BrowserLauncher.launchError(err, this.options.executablePath);
    }
    try {
      const headed = this.headless ? await BrowserLauncher.#headedIdentity(browser) : undefined;
      const identity = headed && this.options.userAgent ? headed.withUserAgent(this.options.userAgent) : headed;
      const context = await browser.newContext({ ...this.contextOptions(), ...(identity ? { userAgent: identity.userAgent, extraHTTPHeaders: identity.headers() } : {}) });
      return { browser, context, ...(identity ? { identity } : {}) };
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw new AppiiError('BROWSER', `Cannot create a browser context: ${Text.errorMessage(err, { firstLine: true })}`, { cause: err });
    }
  }

  static launchError(err: unknown, executablePath?: string): AppiiError {
    const message = Text.errorMessage(err);
    if (BrowserLauncher.NO_DISPLAY.test(message)) return new AppiiError('BROWSER', BrowserLauncher.NO_DISPLAY_MESSAGE, { cause: err });
    if (BrowserLauncher.NOT_INSTALLED.test(message)) {
      const reason = executablePath ? `the browser file ${executablePath} does not exist` : `Chromium is not installed. Install it with "${BrowserLauncher.INSTALL_COMMAND}"`;
      return new AppiiError('BROWSER', `Cannot launch Chromium: ${reason}`, { cause: err });
    }
    const line = Text.errorMessage(err, { firstLine: true }).replace(BrowserLauncher.API_PREFIX, '');
    return new AppiiError('BROWSER', `Cannot launch Chromium${executablePath ? ` from ${executablePath}` : ''}: ${line}`, { cause: err });
  }

  static async #headedIdentity(browser: Browser): Promise<UserAgentIdentity | undefined> {
    const probe = await UserAgentIdentity.probe(browser);
    return probe ? UserAgentIdentity.headed(probe) : undefined;
  }

  static #pick(options: BrowserLauncherOptions): BrowserLauncherOptions {
    const out: BrowserLauncherOptions = {};
    if (options.headless !== undefined) out.headless = options.headless;
    if (options.executablePath !== undefined) out.executablePath = options.executablePath;
    if (options.userAgent !== undefined) out.userAgent = options.userAgent;
    if (options.viewport !== undefined) out.viewport = options.viewport === null ? null : { width: options.viewport.width, height: options.viewport.height };
    if (options.storageState !== undefined) out.storageState = options.storageState;
    if (options.args !== undefined) out.args = [...options.args];
    return out;
  }
}
