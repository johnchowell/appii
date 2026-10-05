import type { BrowserContext, Page } from 'playwright';
import type { UserAgentIdentity } from './user-agent-identity.js';

export class UserAgentOverride {
  readonly identity: UserAgentIdentity;
  readonly #pages = new Map<Page, Promise<boolean>>();
  #context: BrowserContext | undefined;

  constructor(identity: UserAgentIdentity) {
    this.identity = identity;
  }

  attach(context: BrowserContext): void {
    if (this.#context) return;
    this.#context = context;
    context.on('page', this.#onPage);
    for (const page of context.pages()) this.#onPage(page);
  }

  detach(): void {
    this.#context?.off('page', this.#onPage);
    this.#context = undefined;
    this.#pages.clear();
  }

  prepare(page: Page): Promise<boolean> {
    return this.#pages.get(page) ?? Promise.resolve(false);
  }

  readonly #onPage = (page: Page): void => {
    const context = this.#context;
    if (!context || this.#pages.has(page)) return;
    this.#pages.set(page, this.identity.apply(context, page));
    page.once('close', () => this.#pages.delete(page));
  };
}
