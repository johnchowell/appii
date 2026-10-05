import * as zlib from 'node:zlib';
import type { BodyData, BodyKind, CapturedRequest, CapturedResponse } from '../model/index.js';
import { CharsetEncoder, HtmlEncodingSniffer, Http, Json, Text } from '../shared/index.js';
import { GraphqlDocument } from './graphql-document.js';
import { MultipartParser } from './multipart-parser.js';
import type { MultipartPart } from './multipart-parser.js';

export interface ParsedBody {
  kind: BodyKind;
  mimeType: string;
  value?: unknown;
  operationName?: string;
}

export interface UploadedFile {
  filename: string;
  contentType: string;
  size: number;
}

export interface BodyParserDeps {
  multipart?: MultipartParser;
}

export interface BodyParseOptions {
  contentEncoding?: string | undefined;
  formEncoding?: string | undefined;
}

export class BodyParser {
  static readonly TEXT_FORM = 'text/plain';
  static readonly URLENCODED = 'application/x-www-form-urlencoded';
  static readonly MULTIPART = 'multipart/form-data';
  static readonly HTML_MIMES: ReadonlySet<string> = new Set(['text/html', 'application/xhtml+xml']);
  static readonly GRAPHQL_MIMES: ReadonlySet<string> = new Set(['application/graphql']);
  static readonly LINE_JSON_MIMES: ReadonlySet<string> = new Set([
    'application/x-ndjson',
    'application/ndjson',
    'application/jsonl',
    'application/x-jsonlines',
    'application/jsonlines',
  ]);
  static readonly DEFAULT_MIMES: Readonly<Record<BodyKind, string>> = {
    json: 'application/json',
    graphql: 'application/json',
    form: 'application/x-www-form-urlencoded',
    multipart: 'multipart/form-data',
    html: 'text/html',
    text: 'text/plain',
    binary: 'application/octet-stream',
    empty: '',
  };
  static readonly MULTIPART_FILE_TYPE = 'text/plain';
  static readonly MAX_DECODED_BYTES = 64 * 1024 * 1024;
  static readonly CHARSET_FIELD = '_charset_';
  static readonly DEFAULT_FORM_ENCODING = 'utf-8';
  static readonly GZIP_CODINGS: ReadonlySet<string> = new Set(['gzip', 'x-gzip']);

  readonly #multipart: MultipartParser;

  constructor(deps: BodyParserDeps = {}) {
    this.#multipart = deps.multipart ?? new MultipartParser();
  }

  static create(): BodyParser {
    return new BodyParser({ multipart: new MultipartParser() });
  }

  static kindOf(mimeType: string): BodyKind {
    const mime = Http.mimeEssence(mimeType);
    if (mime === '') return 'empty';
    if (mime === BodyParser.MULTIPART) return 'multipart';
    if (mime === BodyParser.URLENCODED) return 'form';
    if (BodyParser.GRAPHQL_MIMES.has(mime)) return 'graphql';
    if (BodyParser.HTML_MIMES.has(mime)) return 'html';
    if (Http.isJsonMime(mime)) return 'json';
    return Http.isTextMime(mime) ? 'text' : 'binary';
  }

  static isUploadedFile(value: unknown): value is UploadedFile {
    return (
      Json.isPlainObject(value) &&
      typeof value.filename === 'string' &&
      typeof value.contentType === 'string' &&
      typeof value.size === 'number' &&
      Object.keys(value).length === 3
    );
  }

  static isGraphqlRequest(value: unknown): boolean {
    if (Array.isArray(value)) return value.length > 0 && value.every((item) => BodyParser.#isGraphqlOperation(item));
    return BodyParser.#isGraphqlOperation(value);
  }

  static graphqlOperationName(value: unknown): string | undefined {
    if (Array.isArray(value)) {
      const names = value.map((item) => BodyParser.graphqlOperationName(item)).filter((name): name is string => !!name);
      return names.length > 0 ? names.join(',') : undefined;
    }
    if (!Json.isPlainObject(value)) return undefined;
    return GraphqlDocument.operationName(typeof value.query === 'string' ? value.query : '', value.operationName);
  }

  request(request: CapturedRequest, formEncoding?: string): ParsedBody {
    const contentEncoding = Http.getHeader(request.headers, 'content-encoding');
    return this.parse(request.body, Http.getHeader(request.headers, 'content-type'), { contentEncoding, formEncoding });
  }

  response(response: CapturedResponse): ParsedBody {
    return this.parse(response.body, Http.getHeader(response.headers, 'content-type'));
  }

  static decodeContent(body: BodyData, contentEncoding: string): BodyData | undefined {
    const codings = contentEncoding
      .split(',')
      .map((coding) => coding.trim().toLowerCase())
      .filter((coding) => coding !== '' && coding !== Http.IDENTITY_ENCODING);
    let data: Uint8Array = Http.bodyBytes(body);
    for (const coding of codings.reverse()) {
      const next = BodyParser.#decodeCoding(coding, data, body.truncated === true);
      if (!next) return undefined;
      data = next;
    }
    const out: BodyData = { mimeType: body.mimeType, encoding: 'base64', data: Buffer.from(data).toString('base64'), size: data.length };
    if (body.truncated) out.truncated = true;
    return out;
  }

  parse(body: BodyData | undefined, contentType?: string, options: BodyParseOptions = {}): ParsedBody {
    const declared = contentType ?? body?.mimeType ?? '';
    const mime = Http.mimeEssence(declared);
    if (!body || body.data === '') return { kind: 'empty', mimeType: mime };
    if (Http.isContentEncoded(options.contentEncoding)) {
      const decoded = BodyParser.decodeContent(body, options.contentEncoding ?? '');
      if (!decoded) return { kind: 'binary', mimeType: mime || BodyParser.DEFAULT_MIMES.binary };
      return this.parse(decoded, declared, { formEncoding: options.formEncoding });
    }
    if (mime === BodyParser.MULTIPART) return this.#multipartBody(body, declared, mime, options.formEncoding);
    const text = BodyParser.HTML_MIMES.has(mime) ? BodyParser.#html(body, declared) : BodyParser.#text(body, declared, mime === BodyParser.TEXT_FORM ? options.formEncoding : undefined);
    if (text === undefined) return { kind: 'binary', mimeType: mime || BodyParser.DEFAULT_MIMES.binary };
    if (BodyParser.GRAPHQL_MIMES.has(mime)) return BodyParser.#graphqlDocument(text, mime);
    if (BodyParser.LINE_JSON_MIMES.has(mime)) return BodyParser.#lines(text, mime, body.truncated === true);
    if (Http.isJsonMime(mime)) {
      const parsed = Json.safeParse(Text.stripBom(text));
      if (parsed.ok) return BodyParser.#json(parsed.value, mime);
      return body.truncated ? { kind: 'json', mimeType: mime } : { kind: 'text', mimeType: mime, value: text };
    }
    const sniffed = BodyParser.#sniff(text);
    if (sniffed !== undefined) return BodyParser.#json(sniffed, mime);
    if (mime === BodyParser.URLENCODED) return { kind: 'form', mimeType: mime, value: BodyParser.urlencoded(text, BodyParser.#formCharset(text, declared, options.formEncoding)) };
    if (BodyParser.HTML_MIMES.has(mime)) return { kind: 'html', mimeType: mime, value: text };
    if (mime === '' || Http.isTextMime(mime)) return { kind: 'text', mimeType: mime || BodyParser.DEFAULT_MIMES.text, value: text };
    return { kind: 'binary', mimeType: mime };
  }

  static urlencoded(text: string, encoding: string = BodyParser.DEFAULT_FORM_ENCODING): Record<string, string | string[]> {
    const fields = new Map<string, string[]>();
    for (const [name, value] of BodyParser.urlencodedPairs(text, encoding)) {
      const list = fields.get(name);
      if (list) list.push(value);
      else fields.set(name, [value]);
    }
    return Object.fromEntries([...fields].map(([name, values]) => [name, values.length === 1 ? (values[0] ?? '') : values]));
  }

  static urlencodedPairs(text: string, encoding: string = BodyParser.DEFAULT_FORM_ENCODING): [string, string][] {
    const label = CharsetEncoder.canonical(encoding) ?? BodyParser.DEFAULT_FORM_ENCODING;
    const pairs: [string, string][] = [];
    for (const sequence of text.split('&')) {
      if (sequence === '') continue;
      const eq = sequence.indexOf('=');
      pairs.push([BodyParser.#formDecode(eq < 0 ? sequence : sequence.slice(0, eq), label), BodyParser.#formDecode(eq < 0 ? '' : sequence.slice(eq + 1), label)]);
    }
    return pairs;
  }

  #multipartBody(body: BodyData, declared: string, mime: string, formEncoding: string | undefined): ParsedBody {
    const bytes = Http.bodyBytes(body);
    const boundary = MultipartParser.boundary(declared) ?? MultipartParser.boundary(body.mimeType) ?? MultipartParser.sniffBoundary(bytes);
    if (!boundary) return { kind: 'multipart', mimeType: mime };
    const fields = new Map<string, unknown[]>();
    const probe = this.#multipart.parse(bytes, boundary);
    const charset = BodyParser.multipartCharset(probe, formEncoding);
    const parts = Http.isLegacyCharset(charset) ? this.#multipart.parse(bytes, boundary, charset) : probe;
    for (const part of parts) {
      if (part.name === undefined) continue;
      const value: unknown =
        part.filename !== undefined
          ? { filename: part.filename, contentType: part.contentType ?? BodyParser.MULTIPART_FILE_TYPE, size: part.data.byteLength }
          : CharsetEncoder.decode(part.data, charset);
      const list = fields.get(part.name);
      if (list) list.push(value);
      else fields.set(part.name, [value]);
    }
    const value = Object.fromEntries([...fields].map(([name, values]) => [name, values.length === 1 ? values[0] : values]));
    return { kind: 'multipart', mimeType: mime, value };
  }

  static #isGraphqlOperation(value: unknown): boolean {
    if (!Json.isPlainObject(value)) return false;
    if (typeof value.query === 'string') return GraphqlDocument.looksLikeDocument(value.query);
    return value.query === undefined && GraphqlDocument.isPersistedQuery(value.extensions);
  }

  static #json(value: unknown, mime: string): ParsedBody {
    if (BodyParser.isGraphqlRequest(value)) {
      const parsed: ParsedBody = { kind: 'graphql', mimeType: mime || BodyParser.DEFAULT_MIMES.graphql, value };
      const operationName = BodyParser.graphqlOperationName(value);
      if (operationName) parsed.operationName = operationName;
      return parsed;
    }
    return { kind: 'json', mimeType: mime || BodyParser.DEFAULT_MIMES.json, value };
  }

  static #graphqlDocument(text: string, mime: string): ParsedBody {
    const parsed: ParsedBody = { kind: 'graphql', mimeType: mime, value: { query: text } };
    const operationName = GraphqlDocument.operationName(text);
    if (operationName) parsed.operationName = operationName;
    return parsed;
  }

  static #lines(text: string, mime: string, truncated: boolean): ParsedBody {
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '');
    const values: unknown[] = [];
    for (let i = 0; i < lines.length; i++) {
      const parsed = Json.safeParse(lines[i] ?? '');
      if (parsed.ok) values.push(parsed.value);
      else if (!(truncated && i === lines.length - 1)) return { kind: 'text', mimeType: mime, value: text };
    }
    return { kind: 'json', mimeType: mime, value: values };
  }

  static #sniff(text: string): unknown {
    const trimmed = Text.stripBom(text).trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
    const parsed = Json.safeParse(trimmed);
    if (!parsed.ok) return undefined;
    return Json.isPlainObject(parsed.value) || Array.isArray(parsed.value) ? parsed.value : undefined;
  }

  static #html(body: BodyData, declared: string): string | undefined {
    if (body.encoding === 'utf8') return body.data;
    const bytes = Http.bodyBytes(body);
    const text = CharsetEncoder.decode(bytes, HtmlEncodingSniffer.sniff(bytes, Http.charsetOf(declared)), { stream: body.truncated === true });
    return text.includes('\u0000') ? undefined : text;
  }

  static #text(body: BodyData, declared: string, formEncoding: string | undefined): string | undefined {
    if (body.encoding === 'utf8') return body.data;
    const bytes = Http.bodyBytes(body);
    const charset = Http.charsetOf(declared) ?? formEncoding;
    const labels = Http.isLegacyCharset(charset) && charset !== undefined ? [charset, CharsetEncoder.UTF8] : [CharsetEncoder.UTF8];
    for (const label of labels) {
      if (CharsetEncoder.canonical(label) === undefined) continue;
      try {
        const text = CharsetEncoder.decode(bytes, label, { fatal: true, stream: body.truncated === true });
        return text.includes('\u0000') ? undefined : text;
      } catch {
        continue;
      }
    }
    return undefined;
  }

  static #formCharset(text: string, declared: string, formEncoding: string | undefined): string {
    const declaredCharset = Http.charsetOf(declared);
    if (declaredCharset !== undefined && BodyParser.#known(declaredCharset)) return declaredCharset;
    const field = BodyParser.urlencoded(text)[BodyParser.CHARSET_FIELD];
    const named = Array.isArray(field) ? field[0] : field;
    if (named !== undefined && BodyParser.#known(named)) return named;
    if (formEncoding !== undefined && BodyParser.#known(formEncoding)) return formEncoding;
    return BodyParser.DEFAULT_FORM_ENCODING;
  }

  static multipartCharset(parts: readonly MultipartPart[], formEncoding: string | undefined): string {
    const field = parts.find((part) => part.name === BodyParser.CHARSET_FIELD && part.filename === undefined);
    const named = field === undefined ? undefined : CharsetEncoder.decode(field.data, BodyParser.DEFAULT_FORM_ENCODING).trim();
    if (named !== undefined && BodyParser.#known(named)) return named;
    if (formEncoding !== undefined && BodyParser.#known(formEncoding)) return formEncoding;
    return BodyParser.DEFAULT_FORM_ENCODING;
  }

  static #known(label: string): boolean {
    return CharsetEncoder.canonical(label) !== undefined;
  }

  static #decodeCoding(coding: string, data: Uint8Array, truncated: boolean): Uint8Array | undefined {
    const limit = { maxOutputLength: BodyParser.MAX_DECODED_BYTES };
    const flush = truncated ? { finishFlush: zlib.constants.Z_SYNC_FLUSH } : {};
    const zstd = (zlib as { zstdDecompressSync?: (data: Uint8Array, options: object) => Uint8Array }).zstdDecompressSync;
    try {
      if (BodyParser.GZIP_CODINGS.has(coding)) return zlib.gunzipSync(data, { ...limit, ...flush });
      if (coding === 'deflate') return BodyParser.#inflate(data, { ...limit, ...flush });
      if (coding === 'br') return zlib.brotliDecompressSync(data, { ...limit, ...(truncated ? { finishFlush: zlib.constants.BROTLI_OPERATION_FLUSH } : {}) });
      if (coding === 'zstd' && typeof zstd === 'function') return zstd(data, limit);
    } catch {
      return undefined;
    }
    return undefined;
  }

  static #inflate(data: Uint8Array, options: { maxOutputLength: number; finishFlush?: number }): Uint8Array {
    try {
      return zlib.inflateSync(data, options);
    } catch {
      return zlib.inflateRawSync(data, options);
    }
  }

  static #formDecode(value: string, label: string): string {
    const bytes = Buffer.from(value.replace(/\+/g, ' '), 'utf8');
    const out: number[] = [];
    for (let i = 0; i < bytes.length; i++) {
      const byte = bytes[i]!;
      if (byte === 0x25 && i + 2 < bytes.length) {
        const hex = String.fromCharCode(bytes[i + 1]!, bytes[i + 2]!);
        if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
          out.push(Number.parseInt(hex, 16));
          i += 2;
          continue;
        }
      }
      out.push(byte);
    }
    return CharsetEncoder.decode(new Uint8Array(out), label);
  }
}
