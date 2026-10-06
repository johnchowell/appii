import type { Exchange } from '../model/index.js';
import { BodyParser, MultipartParser } from '../build/index.js';
import type { HarParam, HarPostData } from '../capture/index.js';
import { Http } from '../shared/index.js';

export interface HarPostDataWriterDeps {
  multipart?: MultipartParser;
}

export class HarPostDataWriter {
  static readonly URLENCODED = 'application/x-www-form-urlencoded';
  static readonly MULTIPART = 'multipart/form-data';
  static readonly CONTENT_ENCODING = 'content-encoding';

  readonly #multipart: MultipartParser;

  static create(): HarPostDataWriter {
    return new HarPostDataWriter({ multipart: new MultipartParser() });
  }

  constructor(deps: HarPostDataWriterDeps = {}) {
    this.#multipart = deps.multipart ?? new MultipartParser();
  }

  static utf8(bytes: Uint8Array): string | undefined {
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
      return undefined;
    }
  }

  postData(postData: HarPostData, exchange: Exchange, charset?: string): HarPostData {
    if (postData._appiiEncoding !== undefined || postData._appiiTruncated === true || typeof postData.text !== 'string') return postData;
    if (Http.isContentEncoded(Http.getHeader(exchange.request.headers, HarPostDataWriter.CONTENT_ENCODING))) return postData;
    const params = this.params(postData.mimeType, postData.text, charset);
    return params === undefined ? postData : { ...postData, params };
  }

  params(mimeType: string, text: string, charset?: string): HarParam[] | undefined {
    const essence = Http.mimeEssence(mimeType);
    if (essence === HarPostDataWriter.URLENCODED) return BodyParser.urlencodedPairs(text, charset).map(([name, value]) => ({ name, value }));
    if (essence !== HarPostDataWriter.MULTIPART) return undefined;
    const bytes = new Uint8Array(Buffer.from(text, 'utf8'));
    const boundary = MultipartParser.boundary(mimeType) ?? MultipartParser.sniffBoundary(bytes);
    if (boundary === undefined) return undefined;
    const parts = this.#multipart.parse(bytes, boundary);
    if (parts.length === 0 || parts.some((part) => !part.complete || part.name === undefined)) return undefined;
    return parts.map((part) => {
      const param: HarParam = { name: part.name ?? '', value: HarPostDataWriter.utf8(part.data) ?? '' };
      if (part.filename !== undefined) param.fileName = part.filename;
      if (part.contentType !== undefined && part.contentType !== '') param.contentType = part.contentType;
      return param;
    });
  }
}
