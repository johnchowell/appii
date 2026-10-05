import type { BrowserContext, CDPSession, Page } from 'playwright';
import type { CdpCookie } from './cookie-parser.js';

export type CdpCookieJarFactory = (context: BrowserContext, page: Page) => Promise<CdpCookieJar | undefined>;

export class CdpCookieJar {
  readonly #session: CDPSession;
  readonly #browserContextId: string;
  #closed = false;

  constructor(session: CDPSession, browserContextId: string) {
    this.#session = session;
    this.#browserContextId = browserContextId;
  }

  static async open(context: BrowserContext, page: Page): Promise<CdpCookieJar | undefined> {
    const browser = context.browser();
    if (!browser) return undefined;
    let browserContextId: string | undefined;
    try {
      const pageSession = await context.newCDPSession(page);
      try {
        browserContextId = (await pageSession.send('Target.getTargetInfo')).targetInfo.browserContextId;
      } finally {
        await pageSession.detach().catch(() => undefined);
      }
    } catch {
      return undefined;
    }
    if (!browserContextId) return undefined;
    try {
      return new CdpCookieJar(await browser.newBrowserCDPSession(), browserContextId);
    } catch {
      return undefined;
    }
  }

  async cookies(): Promise<CdpCookie[]> {
    if (this.#closed) throw new Error('The cookie jar session is closed');
    const result = await this.#session.send('Storage.getCookies', { browserContextId: this.#browserContextId });
    return result.cookies;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#session.detach().catch(() => undefined);
  }
}
