import type { Browser, BrowserContext, CDPSession, Page } from 'playwright';

export interface BrandVersion {
  brand: string;
  version: string;
}

export interface UserAgentMetadata {
  brands: BrandVersion[];
  fullVersionList: BrandVersion[];
  platform: string;
  platformVersion: string;
  architecture: string;
  model: string;
  mobile: boolean;
  bitness: string;
  wow64: boolean;
  formFactors: string[];
}

export interface UserAgentProbe {
  userAgent: string;
  metadata: UserAgentMetadata;
}

export class UserAgentIdentity {
  static readonly HEADLESS_BRAND = 'HeadlessChrome';
  static readonly HEADED_PRODUCT = 'Chrome';
  static readonly CHROMIUM_BRAND = 'Chromium';
  static readonly PROBE_URL = 'https://appii.invalid/';
  static readonly HIGH_ENTROPY_HINTS: readonly string[] = ['architecture', 'bitness', 'formFactors', 'fullVersionList', 'model', 'platformVersion', 'wow64'];
  static readonly PROBE_FUNCTION = `async function (hints) {
  var data = navigator.userAgentData;
  if (!data) return { userAgent: navigator.userAgent };
  var high = await data.getHighEntropyValues(hints);
  return { userAgent: navigator.userAgent, metadata: high };
}`;

  readonly userAgent: string;
  readonly metadata: UserAgentMetadata;

  constructor(userAgent: string, metadata: UserAgentMetadata) {
    this.userAgent = userAgent;
    this.metadata = metadata;
  }

  static async probe(browser: Browser): Promise<UserAgentProbe | undefined> {
    let context: BrowserContext | undefined;
    try {
      context = await browser.newContext();
      const page = await context.newPage();
      await page.route(UserAgentIdentity.PROBE_URL, (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '' }));
      await page.goto(UserAgentIdentity.PROBE_URL);
      const result = (await page.evaluate(`(${UserAgentIdentity.PROBE_FUNCTION})(${JSON.stringify(UserAgentIdentity.HIGH_ENTROPY_HINTS)})`)) as Partial<UserAgentProbe>;
      if (typeof result.userAgent !== 'string' || !result.metadata) return undefined;
      return { userAgent: result.userAgent, metadata: result.metadata };
    } catch {
      return undefined;
    } finally {
      await context?.close().catch(() => undefined);
    }
  }

  static headed(probe: UserAgentProbe): UserAgentIdentity | undefined {
    const match = new RegExp(`${UserAgentIdentity.HEADLESS_BRAND}/(\\d+)[\\d.]*`).exec(probe.userAgent);
    if (!match) return undefined;
    const major = Number(match[1]);
    const userAgent = probe.userAgent.replace(match[0], `${UserAgentIdentity.HEADED_PRODUCT}/${major}.0.0.0`);
    const metadata: UserAgentMetadata = {
      ...probe.metadata,
      brands: UserAgentIdentity.#headedBrands(probe.metadata.brands, major),
      fullVersionList: UserAgentIdentity.#headedBrands(probe.metadata.fullVersionList, major),
    };
    return new UserAgentIdentity(userAgent, metadata);
  }

  async apply(context: BrowserContext, page: Page): Promise<boolean> {
    let session: CDPSession | undefined;
    try {
      session = await context.newCDPSession(page);
      await session.send('Emulation.setUserAgentOverride', { userAgent: this.userAgent, userAgentMetadata: this.metadata });
      return true;
    } catch {
      return false;
    }
  }

  async applyToWorker(connection: { send<T>(method: string, params?: Record<string, unknown>): Promise<T> }): Promise<boolean> {
    try {
      await connection.send('Network.setUserAgentOverride', { userAgent: this.userAgent, userAgentMetadata: this.metadata });
      return true;
    } catch {
      return false;
    }
  }

  withUserAgent(userAgent: string): UserAgentIdentity {
    return new UserAgentIdentity(userAgent, this.metadata);
  }

  static #headedBrands(list: readonly BrandVersion[], major: number): BrandVersion[] {
    const kept = list.filter((entry) => entry.brand !== UserAgentIdentity.HEADLESS_BRAND);
    const chromium = kept.find((entry) => entry.brand === UserAgentIdentity.CHROMIUM_BRAND);
    const grease = kept.find((entry) => entry.brand !== UserAgentIdentity.CHROMIUM_BRAND);
    if (!chromium || !grease || kept.length !== 2) return kept.map((entry) => ({ ...entry }));
    const ordered: BrandVersion[] = [];
    ordered[major % 2] = { ...grease };
    ordered[(major + 1) % 2] = { ...chromium };
    return ordered;
  }
}
