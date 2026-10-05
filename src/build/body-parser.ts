import type { BodyData, BodyKind } from '../model/index.js';
import { Http, Json } from '../shared/index.js';
import { GraphqlDocument } from './graphql-document.js';
import { MultipartParser } from './multipart-parser.js';

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

export class BodyParser {
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

  readonly #multipart: MultipartParser;

  constructor(deps: BodyParserDeps = {}) {
    this.#multipart = deps.multipart ?? new MultipartParser();
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

  parse(body: BodyData | undefined, contentType?: string): ParsedBody {
    const declared = contentType ?? body?.mimeType ?? '';
    const mime = Http.mimeEssence(declared);
    if (!body || body.data === '') return { kind: 'empty', mimeType: mime };
    if (mime === BodyParser.MULTIPART) return this.#multipartBody(body, declared, mime);
    const text = BodyParser.#text(body, declared);
    if (text === undefined) return { kind: 'binary', mimeType: mime || BodyParser.DEFAULT_MIMES.binary };
    if (BodyParser.GRAPHQL_MIMES.has(mime)) return BodyParser.#graphqlDocument(text, mime);
    if (BodyParser.LINE_JSON_MIMES.has(mime)) return BodyParser.#lines(text, mime, body.truncated === true);
    if (Http.isJsonMime(mime)) {
      const parsed = Json.safeParse(BodyParser.#stripBom(text));
      if (parsed.ok) return BodyParser.#json(parsed.value, mime);
      return body.truncated ? { kind: 'json', mimeType: mime } : { kind: 'text', mimeType: mime, value: text };
    }
    const sniffed = BodyParser.#sniff(text);
    if (sniffed !== undefined) return BodyParser.#json(sniffed, mime);
    if (mime === BodyParser.URLENCODED) return { kind: 'form', mimeType: mime, value: BodyParser.urlencoded(text) };
    if (BodyParser.HTML_MIMES.has(mime)) return { kind: 'html', mimeType: mime, value: text };
    if (mime === '' || Http.isTextMime(mime)) return { kind: 'text', mimeType: mime || BodyParser.DEFAULT_MIMES.text, value: text };
    return { kind: 'binary', mimeType: mime };
  }

  static urlencoded(text: string): Record<string, string | string[]> {
    const fields = new Map<string, string[]>();
    for (const sequence of text.split('&')) {
      if (sequence === '') continue;
      const eq = sequence.indexOf('=');
      const name = BodyParser.#formDecode(eq < 0 ? sequence : sequence.slice(0, eq));
      const value = BodyParser.#formDecode(eq < 0 ? '' : sequence.slice(eq + 1));
      const list = fields.get(name);
      if (list) list.push(value);
      else fields.set(name, [value]);
    }
    return Object.fromEntries([...fields].map(([name, values]) => [name, values.length === 1 ? (values[0] ?? '') : values]));
  }

  #multipartBody(body: BodyData, declared: string, mime: string): ParsedBody {
    const bytes = Http.bodyBytes(body);
    const boundary = MultipartParser.boundary(declared) ?? MultipartParser.boundary(body.mimeType) ?? MultipartParser.sniffBoundary(bytes);
    if (!boundary) return { kind: 'multipart', mimeType: mime };
    const fields = new Map<string, unknown[]>();
    for (const part of this.#multipart.parse(bytes, boundary)) {
      if (part.name === undefined) continue;
      const value: unknown =
        part.filename !== undefined
          ? { filename: part.filename, contentType: part.contentType ?? BodyParser.MULTIPART_FILE_TYPE, size: part.data.byteLength }
          : new TextDecoder('utf-8').decode(part.data);
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
    const extensions = value.extensions;
    return value.query === undefined && Json.isPlainObject(extensions) && Json.isPlainObject(extensions.persistedQuery);
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
    const trimmed = BodyParser.#stripBom(text).trimStart();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
    const parsed = Json.safeParse(trimmed);
    if (!parsed.ok) return undefined;
    return Json.isPlainObject(parsed.value) || Array.isArray(parsed.value) ? parsed.value : undefined;
  }

  static #stripBom(text: string): string {
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  }

  static #text(body: BodyData, declared: string): string | undefined {
    if (body.encoding === 'utf8') return body.data;
    const bytes = Http.bodyBytes(body);
    const charset = Http.charsetOf(declared);
    const labels = charset && charset !== 'utf-8' && charset !== 'utf8' ? [charset, 'utf-8'] : ['utf-8'];
    for (const label of labels) {
      let decoder: TextDecoder;
      try {
        decoder = new TextDecoder(label, { fatal: true });
      } catch {
        continue;
      }
      try {
        const text = decoder.decode(bytes, { stream: body.truncated === true });
        return text.includes('\u0000') ? undefined : text;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  static #formDecode(value: string): string {
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
    return new TextDecoder('utf-8').decode(new Uint8Array(out));
  }
}
