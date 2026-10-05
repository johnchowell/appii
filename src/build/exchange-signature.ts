import type { Exchange } from '../model/index.js';
import { Json } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import type { ParsedBody } from './body-parser.js';
import { GraphqlDocument } from './graphql-document.js';
import { Helpers } from './helpers.js';

export interface Signature {
  method: string;
  url: URL;
  origin: string;
  path: string;
  request: ParsedBody;
  graphql: boolean;
  operationName?: string;
}

export interface ExchangeSignatureDeps {
  body: BodyParser;
}

export class ExchangeSignature {
  static readonly QUERY_PARAM = 'query';
  static readonly OPERATION_PARAM = 'operationName';
  static readonly EXTENSIONS_PARAM = 'extensions';

  readonly #body: BodyParser;

  constructor(deps: ExchangeSignatureDeps) {
    this.#body = deps.body;
  }

  static create(): ExchangeSignature {
    return new ExchangeSignature({ body: BodyParser.create() });
  }

  of(exchange: Exchange, formEncoding?: string): Signature | undefined {
    const url = Helpers.httpUrl(exchange.request.url);
    if (!url) return undefined;
    const request = this.#body.request(exchange.request, formEncoding);
    const signature: Signature = {
      method: exchange.request.method,
      url,
      origin: url.origin,
      path: url.pathname,
      request,
      graphql: request.kind === 'graphql',
    };
    if (signature.graphql) {
      if (request.operationName) signature.operationName = request.operationName;
      return signature;
    }
    if (request.kind !== 'empty') return signature;
    const query = url.searchParams.get(ExchangeSignature.QUERY_PARAM);
    const document = query !== null && GraphqlDocument.looksLikeDocument(query);
    if (!document && !ExchangeSignature.#persisted(url)) return signature;
    signature.graphql = true;
    const operationName = GraphqlDocument.operationName(document ? (query ?? '') : '', url.searchParams.get(ExchangeSignature.OPERATION_PARAM) ?? undefined);
    if (operationName) signature.operationName = operationName;
    return signature;
  }

  static #persisted(url: URL): boolean {
    const extensions = url.searchParams.get(ExchangeSignature.EXTENSIONS_PARAM);
    if (extensions === null) return false;
    const parsed = Json.safeParse(extensions);
    return parsed.ok && GraphqlDocument.isPersistedQuery(parsed.value);
  }
}
