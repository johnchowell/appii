import type { Capture, Exchange, TokenSource } from '../model/index.js';
import { HtmlDocument } from '../forms/index.js';
import type { FormExtractor, TokenDetector } from '../forms/index.js';
import { Http, Json, isAppiiError } from '../shared/index.js';
import type { BodyParser } from './body-parser.js';
import { HeaderPolicy } from './header-policy.js';
import { Helpers } from './helpers.js';
import { HtmlPages } from './html-pages.js';

export interface TokenOrigin {
  source: TokenSource;
  sourceName?: string;
  sourceUrl?: string;
}

export interface CsrfSourceResolverDeps {
  extractor: FormExtractor;
  tokens: TokenDetector;
  body: BodyParser;
  pages?: HtmlPages;
  headers?: HeaderPolicy;
}

interface PageToken {
  readonly name: string;
  readonly value: string;
  readonly url: string;
}

interface ResponseToken {
  readonly name: string;
  readonly url: string;
  readonly start: number;
  readonly index: number;
}

export class CsrfSourceResolver {
  static readonly MIN_TOKEN_LENGTH = 8;

  readonly #metas: PageToken[] = [];
  readonly #hidden: PageToken[] = [];
  readonly #responses = new Map<string, ResponseToken>();
  readonly #positions = new Map<string, number>();

  constructor(capture: Capture, deps: CsrfSourceResolverDeps) {
    const pages = deps.pages ?? new HtmlPages({ body: deps.body });
    const headers = deps.headers ?? new HeaderPolicy();
    for (const page of pages.collect(capture)) {
      let doc: HtmlDocument;
      try {
        doc = HtmlDocument.parse(page.html, page.url);
      } catch (err) {
        if (isAppiiError(err)) continue;
        throw err;
      }
      for (const [name, value] of Object.entries(deps.tokens.documentTokens(doc))) this.#metas.push({ name, value, url: page.url });
      for (const form of deps.extractor.extractDocument(doc)) {
        for (const field of form.fields) {
          if (field.type === 'hidden' && field.name !== '' && field.value !== '') this.#hidden.push({ name: field.name, value: field.value, url: page.url });
        }
      }
    }
    capture.exchanges.forEach((exchange, index) => {
      this.#positions.set(exchange.id, index);
      const response = exchange.response;
      if (!response) return;
      const start = Helpers.startMs(exchange);
      const record = (value: string, name: string): void => {
        if (value.length < CsrfSourceResolver.MIN_TOKEN_LENGTH) return;
        const existing = this.#responses.get(value);
        if (!existing || CsrfSourceResolver.#before({ start, index }, existing)) {
          this.#responses.set(value, { name, url: exchange.request.url, start, index });
        }
      };
      for (const header of response.headers) {
        if (headers.isCsrf(header.name)) record(header.value, header.name.toLowerCase());
      }
      const parsed = deps.body.parse(response.body, Http.getHeader(response.headers, 'content-type'));
      if (parsed.kind !== 'json' && parsed.kind !== 'graphql') return;
      Json.walk(parsed.value, (node, path) => {
        if (typeof node !== 'string') return;
        const key = [...path].reverse().find((part): part is string => typeof part === 'string');
        if (key !== undefined) record(node, key);
      });
    });
  }

  resolve(value: string, exchange: Exchange): TokenOrigin {
    if (value.length < CsrfSourceResolver.MIN_TOKEN_LENGTH) return { source: 'unknown' };
    for (const cookie of Http.parseCookieHeader(Http.getHeader(exchange.request.headers, 'cookie'))) {
      if (cookie.name !== '' && (cookie.value === value || Helpers.decode(cookie.value) === value)) return { source: 'cookie', sourceName: cookie.name };
    }
    const meta = CsrfSourceResolver.#pick(this.#metas, value, exchange);
    if (meta) return { source: 'meta', sourceName: meta.name, sourceUrl: meta.url };
    const hidden = CsrfSourceResolver.#pick(this.#hidden, value, exchange);
    if (hidden) return { source: 'hidden-field', sourceName: hidden.name, sourceUrl: hidden.url };
    const response = this.#responses.get(value);
    const position = { start: Helpers.startMs(exchange), index: this.#positions.get(exchange.id) ?? Number.POSITIVE_INFINITY };
    if (response && CsrfSourceResolver.#before(response, position)) return { source: 'response', sourceName: response.name, sourceUrl: response.url };
    return { source: 'unknown' };
  }

  static #pick(tokens: readonly PageToken[], value: string, exchange: Exchange): PageToken | undefined {
    const matching = tokens.filter((token) => token.value === value);
    const page = exchange.pageUrl === undefined ? undefined : HtmlPages.documentKey(exchange.pageUrl);
    return matching.find((token) => HtmlPages.documentKey(token.url) === page) ?? matching[0];
  }

  static #before(a: { start: number; index: number }, b: { start: number; index: number }): boolean {
    if (Number.isFinite(a.start) && Number.isFinite(b.start) && a.start !== b.start) return a.start < b.start;
    return a.index < b.index;
  }
}
