import type { Capture } from '../model/index.js';
import { Http } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { Helpers } from './helpers.js';

export interface HtmlPage {
  url: string;
  html: string;
  at: number;
  source: 'snapshot' | 'response';
  encoding?: string;
}

export interface HtmlPagesDeps {
  body?: BodyParser;
}

export class HtmlPages {
  readonly #body: BodyParser;

  constructor(deps: HtmlPagesDeps = {}) {
    this.#body = deps.body ?? new BodyParser();
  }

  static create(): HtmlPages {
    return new HtmlPages({ body: BodyParser.create() });
  }

  static documentKey(url: string): string {
    const parsed = Http.parseUrl(url);
    if (!parsed) return url;
    parsed.hash = '';
    return parsed.href;
  }

  collect(capture: Capture): HtmlPage[] {
    const charsets = new Map<string, string>();
    for (const exchange of capture.exchanges) {
      const charset = exchange.resourceType === 'document' && exchange.response ? Http.charsetOf(Http.getHeader(exchange.response.headers, 'content-type')) : undefined;
      if (charset !== undefined) charsets.set(HtmlPages.documentKey(exchange.request.url), charset);
    }
    const pages: HtmlPage[] = capture.pages.map((page) => HtmlPages.#page(page.url, page.html, Date.parse(page.capturedAt), 'snapshot', charsets.get(HtmlPages.documentKey(page.url))));
    const covered = new Set(pages.map((page) => HtmlPages.documentKey(page.url)));
    for (const exchange of capture.exchanges) {
      const response = exchange.response;
      if (exchange.resourceType !== 'document' || !response?.body || response.body.truncated) continue;
      if (covered.has(HtmlPages.documentKey(exchange.request.url))) continue;
      const parsed = this.#body.response(response);
      if (parsed.kind !== 'html' || typeof parsed.value !== 'string') continue;
      const charset = Http.charsetOf(Http.getHeader(response.headers, 'content-type'));
      pages.push(HtmlPages.#page(exchange.request.url, parsed.value, Helpers.startMs(exchange) + exchange.durationMs, 'response', charset));
    }
    return pages;
  }

  static #page(url: string, html: string, at: number, source: HtmlPage['source'], encoding: string | undefined): HtmlPage {
    return encoding === undefined ? { url, html, at, source } : { url, html, at, source, encoding };
  }
}
