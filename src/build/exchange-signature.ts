import type { Exchange } from '../model/index.js';
import { Http } from '../shared/index.js';
import type { BodyParser, ParsedBody } from './body-parser.js';
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

  readonly #body: BodyParser;

  constructor(deps: ExchangeSignatureDeps) {
    this.#body = deps.body;
  }

  of(exchange: Exchange): Signature | undefined {
    const url = Helpers.httpUrl(exchange.request.url);
    if (!url) return undefined;
    const request = this.#body.parse(exchange.request.body, Http.getHeader(exchange.request.headers, 'content-type'));
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
    if (query === null || !GraphqlDocument.looksLikeDocument(query)) return signature;
    signature.graphql = true;
    const operationName = GraphqlDocument.operationName(query, url.searchParams.get(ExchangeSignature.OPERATION_PARAM) ?? undefined);
    if (operationName) signature.operationName = operationName;
    return signature;
  }
}
