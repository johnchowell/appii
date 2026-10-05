import { chromium } from 'playwright';
import type { Browser, BrowserContext, BrowserContextOptions, LaunchOptions } from 'playwright';
import { AppiiError, Fs } from '../shared/index.js';
import { Helpers } from './helpers.js';

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
}

export class BrowserLauncher {
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
      throw new AppiiError(
        'BROWSER',
        `Cannot launch Chromium: ${Helpers.errorMessage(err)}. Install it with "npx playwright install chromium" or pass an executable path.`,
        { cause: err },
      );
    }
    try {
      const context = await browser.newContext(this.contextOptions());
      return { browser, context };
    } catch (err) {
      await browser.close().catch(() => undefined);
      throw new AppiiError('BROWSER', `Cannot create a browser context: ${Helpers.errorMessage(err)}`, { cause: err });
    }
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
