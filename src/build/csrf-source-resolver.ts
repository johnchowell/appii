import type { Capture, Exchange, TokenSource } from '../model/index.js';
import { FormExtractor, TokenDetector } from '../forms/index.js';
import { Http, Json } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { HeaderPolicy } from './header-policy.js';
import { Helpers } from './helpers.js';
import { HtmlPages } from './html-pages.js';
import { PageDocuments } from './page-documents.js';

export interface TokenOrigin {
  source: TokenSource;
  sourceName?: string;
  sourceUrl?: string;
  sourceMethod?: string;
}

export interface CsrfSourceResolverDeps {
  tokens: TokenDetector;
  body: BodyParser;
  documents: PageDocuments;
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
  readonly method: string;
  readonly start: number;
  readonly index: number;
}

export class CsrfSourceResolver {
  static readonly MIN_TOKEN_LENGTH = 8;

  readonly #metas: PageToken[] = [];
  readonly #hidden: PageToken[] = [];
  readonly #responses = new Map<string, ResponseToken[]>();
  readonly #positions = new Map<string, number>();

  constructor(capture: Capture, deps: CsrfSourceResolverDeps) {
    const headers = deps.headers ?? new HeaderPolicy({ tokens: deps.tokens });
    for (const { page, doc, forms } of deps.documents.of(capture)) {
      for (const [name, value] of Object.entries(deps.tokens.documentTokens(doc))) this.#metas.push({ name, value, url: page.url });
      for (const form of forms) {
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
        const token: ResponseToken = { name, url: exchange.request.url, method: exchange.request.method.toUpperCase(), start, index };
        const list = this.#responses.get(value);
        if (list) list.push(token);
        else this.#responses.set(value, [token]);
      };
      for (const header of response.headers) {
        if (headers.isCsrf(header.name)) record(header.value, header.name.toLowerCase());
      }
      const parsed = deps.body.response(response);
      if (parsed.kind !== 'json' && parsed.kind !== 'graphql') return;
      Json.walk(parsed.value, (node, path) => {
        if (typeof node !== 'string') return;
        const key = [...path].reverse().find((part): part is string => typeof part === 'string');
        if (key !== undefined) record(node, key);
      });
    });
  }

  static create(capture: Capture): CsrfSourceResolver {
    const tokens = new TokenDetector();
    const body = BodyParser.create();
    const documents = new PageDocuments({ pages: new HtmlPages({ body }), extractor: new FormExtractor({ tokens }) });
    return new CsrfSourceResolver(capture, { tokens, body, documents, headers: new HeaderPolicy({ tokens }) });
  }

  resolve(value: string, exchange: Exchange): TokenOrigin {
    if (value.length < CsrfSourceResolver.MIN_TOKEN_LENGTH) return { source: 'unknown' };
    for (const cookie of Http.parseCookieHeader(Http.getHeader(exchange.request.headers, 'cookie'))) {
      if (cookie.name !== '' && (cookie.value === value || Http.decodeComponent(cookie.value) === value)) return { source: 'cookie', sourceName: cookie.name };
    }
    const meta = CsrfSourceResolver.#pick(this.#metas, value, exchange);
    if (meta) return { source: 'meta', sourceName: meta.name, sourceUrl: meta.url };
    const hidden = CsrfSourceResolver.#pick(this.#hidden, value, exchange);
    if (hidden) return { source: 'hidden-field', sourceName: hidden.name, sourceUrl: hidden.url };
    const position = { start: Helpers.startMs(exchange), index: this.#positions.get(exchange.id) ?? Number.POSITIVE_INFINITY };
    const response = CsrfSourceResolver.#response(this.#responses.get(value) ?? [], position);
    if (response) return { source: 'response', sourceName: response.name, sourceUrl: response.url, sourceMethod: response.method };
    return { source: 'unknown' };
  }

  static #response(tokens: readonly ResponseToken[], position: { start: number; index: number }): ResponseToken | undefined {
    let best: ResponseToken | undefined;
    for (const token of tokens) {
      if (!CsrfSourceResolver.#before(token, position)) continue;
      if (!best) {
        best = token;
        continue;
      }
      const safe = Http.isSafeMethod(token.method);
      const bestSafe = Http.isSafeMethod(best.method);
      if ((safe && !bestSafe) || (safe === bestSafe && CsrfSourceResolver.#before(token, best))) best = token;
    }
    return best;
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
