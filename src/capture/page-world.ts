import type { BrowserContext, CDPSession, Page } from 'playwright';

export interface PageWorldOptions {
  name: string;
  binding: string;
  source: string;
  onCall: (payload: string) => void;
}

export type PageWorldFactory = (context: BrowserContext, page: Page, options: PageWorldOptions) => Promise<PageWorld | undefined>;

export class PageWorld {
  readonly #session: CDPSession;
  readonly #options: PageWorldOptions;
  readonly #frames = new Map<number, string>();
  #mainFrame: string | undefined;
  #closed = false;

  constructor(session: CDPSession, options: PageWorldOptions) {
    this.#session = session;
    this.#options = options;
    session.on('Runtime.executionContextCreated', (event) => {
      const frameId: unknown = event.context.auxData?.frameId;
      if (event.context.name === options.name && typeof frameId === 'string') this.#frames.set(event.context.id, frameId);
    });
    session.on('Runtime.executionContextDestroyed', (event) => {
      this.#frames.delete(event.executionContextId);
    });
    session.on('Runtime.executionContextsCleared', () => {
      this.#frames.clear();
    });
    session.on('Page.frameNavigated', (event) => {
      if (!event.frame.parentId) this.#mainFrame = event.frame.id;
    });
    session.on('Runtime.bindingCalled', (event) => {
      if (event.name !== options.binding || this.#closed) return;
      const frameId = this.#frames.get(event.executionContextId);
      if (frameId === undefined || frameId !== this.#mainFrame) return;
      options.onCall(event.payload);
    });
  }

  static async open(context: BrowserContext, page: Page, options: PageWorldOptions): Promise<PageWorld | undefined> {
    let session: CDPSession;
    try {
      session = await context.newCDPSession(page);
    } catch {
      return undefined;
    }
    const world = new PageWorld(session, options);
    try {
      await world.#install();
      return world;
    } catch {
      await world.close();
      return undefined;
    }
  }

  get ready(): boolean {
    return !this.#closed && this.#mainContext() !== undefined;
  }

  async evaluate(expression: string): Promise<unknown> {
    const contextId = this.#mainContext();
    if (this.#closed || contextId === undefined) throw new Error(`The ${this.#options.name} world of the main frame is not available`);
    const result = await this.#session.send('Runtime.evaluate', { expression, contextId, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#frames.clear();
    await this.#session.detach().catch(() => undefined);
  }

  async #install(): Promise<void> {
    const session = this.#session;
    const { name, binding, source } = this.#options;
    await session.send('Page.enable');
    const tree = await session.send('Page.getFrameTree');
    this.#mainFrame ??= tree.frameTree.frame.id;
    await session.send('Runtime.addBinding', { name: binding, executionContextName: name });
    await session.send('Runtime.enable');
    await session.send('Page.addScriptToEvaluateOnNewDocument', { source, worldName: name, runImmediately: true });
  }

  #mainContext(): number | undefined {
    let found: number | undefined;
    for (const [contextId, frameId] of this.#frames) if (frameId === this.#mainFrame) found = contextId;
    return found;
  }
}
