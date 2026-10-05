import type { Capture } from '../model/index.js';
import { Http } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { Helpers } from './helpers.js';

export interface HtmlPage {
  url: string;
  html: string;
  at: number;
  source: 'snapshot' | 'response';
}

export interface HtmlPagesDeps {
  body?: BodyParser;
}

export class HtmlPages {
  readonly #body: BodyParser;

  constructor(deps: HtmlPagesDeps = {}) {
    this.#body = deps.body ?? new BodyParser();
  }

  static documentKey(url: string): string {
    const parsed = Helpers.parseUrl(url);
    if (!parsed) return url;
    parsed.hash = '';
    return parsed.href;
  }

  collect(capture: Capture): HtmlPage[] {
    const pages: HtmlPage[] = capture.pages.map((page) => ({ url: page.url, html: page.html, at: Date.parse(page.capturedAt), source: 'snapshot' }));
    const covered = new Set(pages.map((page) => HtmlPages.documentKey(page.url)));
    for (const exchange of capture.exchanges) {
      const response = exchange.response;
      if (exchange.resourceType !== 'document' || !response?.body || response.body.truncated) continue;
      if (covered.has(HtmlPages.documentKey(exchange.request.url))) continue;
      const parsed = this.#body.parse(response.body, Http.getHeader(response.headers, 'content-type'));
      if (parsed.kind !== 'html' || typeof parsed.value !== 'string') continue;
      pages.push({ url: exchange.request.url, html: parsed.value, at: Helpers.startMs(exchange) + exchange.durationMs, source: 'response' });
    }
    return pages;
  }
}
