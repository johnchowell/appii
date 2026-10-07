import type { Capture, Exchange, TokenSource } from '../model/index.js';
import { FormExtractor, TokenDetector } from '../forms/index.js';
import { Http, Json } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { HeaderPolicy } from './header-policy.js';
import { Helpers } from './helpers.js';
import { HtmlPages } from './html-pages.js';
import { PageDocuments } from './page-documents.js';

export interface PageField {
  readonly kind: 'meta' | 'hidden-field';
  readonly name: string;
}

export interface TokenOrigin {
  source: TokenSource;
  sourceName?: string;
  sourceUrl?: string;
  sourceMethod?: string;
  page?: PageField;
  exchange?: Exchange;
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
  readonly at: number;
  readonly served: boolean;
  readonly exchange?: Exchange;
}

interface Position {
  readonly start: number;
  readonly index: number;
}

interface CookiePair {
  readonly name: string;
  readonly value: string;
}

interface Lookup {
  readonly cookies: readonly CookiePair[];
  readonly page: string | undefined;
  readonly position: Position;
}

interface SentCookies {
  readonly page: string | undefined;
  readonly start: number;
  readonly cookies: readonly CookiePair[];
}

interface ResponseToken {
  readonly name: string;
  readonly url: string;
  readonly method: string;
  readonly start: number;
  readonly index: number;
  readonly exchange: Exchange;
}

export class CsrfSourceResolver {
  static readonly MIN_TOKEN_LENGTH = 8;

  readonly #metas: PageToken[] = [];
  readonly #hidden: PageToken[] = [];
  readonly #responses = new Map<string, ResponseToken[]>();
  readonly #positions = new Map<string, number>();
  readonly #sent: SentCookies[] = [];

  constructor(capture: Capture, deps: CsrfSourceResolverDeps) {
    const headers = deps.headers ?? new HeaderPolicy({ tokens: deps.tokens });
    const byId = new Map(capture.exchanges.map((exchange) => [exchange.id, exchange]));
    for (const { page, doc, forms } of deps.documents.all(capture)) {
      const served = page.source === 'response';
      const exchange = page.exchange === undefined ? undefined : byId.get(page.exchange);
      const at = { url: page.url, at: page.at, served, ...(exchange === undefined ? {} : { exchange }) };
      for (const [name, value] of Object.entries(deps.tokens.documentTokens(doc))) this.#metas.push({ name, value, ...at });
      for (const form of forms) {
        for (const field of form.fields) {
          if (field.type === 'hidden' && field.name !== '' && field.value !== '') this.#hidden.push({ name: field.name, value: field.value, ...at });
        }
      }
    }
    capture.exchanges.forEach((exchange, index) => {
      this.#positions.set(exchange.id, index);
      this.#sent.push({ page: CsrfSourceResolver.#documentOf(exchange), start: Helpers.startMs(exchange), cookies: Http.parseCookieHeader(Http.getHeader(exchange.request.headers, 'cookie')) });
      const response = exchange.response;
      if (!response || Http.isWorkerResponse(exchange)) return;
      const start = Helpers.startMs(exchange);
      const record = (value: string, name: string): void => {
        if (value.length < CsrfSourceResolver.MIN_TOKEN_LENGTH) return;
        const token: ResponseToken = { name, url: exchange.request.url, method: exchange.request.method.toUpperCase(), start, index, exchange };
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
    return this.#origin(value, {
      cookies: Http.parseCookieHeader(Http.getHeader(exchange.request.headers, 'cookie')),
      page: exchange.pageUrl,
      position: { start: Helpers.startMs(exchange), index: this.#positions.get(exchange.id) ?? Number.POSITIVE_INFINITY },
    });
  }

  formToken(name: string, onPage: (url: string) => boolean): TokenOrigin | undefined {
    const fields = this.#hidden.filter((token) => token.name === name && onPage(token.url));
    const served = fields.find((token) => token.served);
    if (served) return CsrfSourceResolver.#page('hidden-field', served);
    const snapshots = [...fields].sort((a, b) => b.at - a.at);
    for (const token of snapshots) {
      const page = HtmlPages.documentKey(token.url);
      const cookies = this.#sent.filter((sent) => sent.page === page && !(sent.start > token.at)).flatMap((sent) => sent.cookies);
      const origin = this.#serverSent(token.value, { cookies, page: token.url, position: { start: token.at, index: Number.POSITIVE_INFINITY } });
      if (origin) return origin;
    }
    const latest = snapshots[0];
    return latest ? CsrfSourceResolver.#page('hidden-field', latest) : undefined;
  }

  #origin(value: string, lookup: Lookup): TokenOrigin {
    if (value.length < CsrfSourceResolver.MIN_TOKEN_LENGTH) return { source: 'unknown' };
    const sent = this.#serverSent(value, lookup);
    if (sent) return sent;
    const meta = CsrfSourceResolver.#pick(this.#metas.filter((token) => token.value === value), lookup.page);
    if (meta) return CsrfSourceResolver.#page('meta', meta);
    const field = CsrfSourceResolver.#pick(this.#hidden.filter((token) => token.value === value), lookup.page);
    if (field) return CsrfSourceResolver.#page('hidden-field', field);
    return { source: 'unknown' };
  }

  #serverSent(value: string, lookup: Lookup): TokenOrigin | undefined {
    if (value.length < CsrfSourceResolver.MIN_TOKEN_LENGTH) return undefined;
    for (const cookie of lookup.cookies) {
      if (cookie.name !== '' && (cookie.value === value || Http.decodeComponent(cookie.value) === value)) return { source: 'cookie', sourceName: cookie.name };
    }
    const metas = this.#metas.filter((token) => token.value === value);
    const hidden = this.#hidden.filter((token) => token.value === value);
    const servedMeta = CsrfSourceResolver.#pick(metas.filter((token) => token.served), lookup.page);
    if (servedMeta) return CsrfSourceResolver.#page('meta', servedMeta);
    const servedHidden = CsrfSourceResolver.#pick(hidden.filter((token) => token.served), lookup.page);
    if (servedHidden) return CsrfSourceResolver.#page('hidden-field', servedHidden);
    const response = CsrfSourceResolver.#response(this.#responses.get(value) ?? [], lookup.position);
    if (!response) return undefined;
    const meta = CsrfSourceResolver.#pick(metas, lookup.page);
    const field = CsrfSourceResolver.#pick(hidden, lookup.page);
    const page: PageField | undefined = meta ? { kind: 'meta', name: meta.name } : field ? { kind: 'hidden-field', name: field.name } : undefined;
    return { source: 'response', sourceName: response.name, sourceUrl: response.url, sourceMethod: response.method, ...(page ? { page } : {}), exchange: response.exchange };
  }

  static #page(kind: PageField['kind'], token: PageToken): TokenOrigin {
    return { source: kind, sourceName: token.name, sourceUrl: token.url, page: { kind, name: token.name }, ...(token.exchange === undefined ? {} : { exchange: token.exchange }) };
  }

  static #documentOf(exchange: Exchange): string | undefined {
    if (exchange.resourceType === 'document') return HtmlPages.documentKey(exchange.request.url);
    return exchange.pageUrl === undefined ? undefined : HtmlPages.documentKey(exchange.pageUrl);
  }

  static #response(tokens: readonly ResponseToken[], position: Position): ResponseToken | undefined {
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

  static #pick(tokens: readonly PageToken[], pageUrl: string | undefined): PageToken | undefined {
    const page = pageUrl === undefined ? undefined : HtmlPages.documentKey(pageUrl);
    return tokens.find((token) => HtmlPages.documentKey(token.url) === page) ?? tokens[0];
  }

  static #before(a: Position, b: Position): boolean {
    if (Number.isFinite(a.start) && Number.isFinite(b.start) && a.start !== b.start) return a.start < b.start;
    return a.index < b.index;
  }
}
