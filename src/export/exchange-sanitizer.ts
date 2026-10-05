import type { BodyData, Exchange, Header } from '../model/index.js';
import { BodyParser, MultipartParser, Redactor } from '../build/index.js';
import { TokenDetector } from '../forms/index.js';
import { Http, Json, Samples } from '../shared/index.js';

export interface ExchangeSanitizerDeps {
  redactor?: Redactor;
  body?: BodyParser;
  tokens?: TokenDetector;
  multipart?: MultipartParser;
}

export interface ExchangeSanitizerOptions {
  redact?: boolean;
}

export class ExchangeSanitizer {
  static readonly TAG_PATTERN: RegExp = /<(input|meta)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi;
  static readonly ATTRIBUTE_PATTERN: RegExp = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

  readonly #redactor: Redactor;
  readonly #body: BodyParser;
  readonly #tokens: TokenDetector;
  readonly #multipart: MultipartParser;

  static create(options: ExchangeSanitizerOptions = {}): ExchangeSanitizer {
    return new ExchangeSanitizer({ redactor: new Redactor(options.redact ?? true), body: BodyParser.create(), tokens: new TokenDetector(), multipart: new MultipartParser() });
  }

  constructor(deps: ExchangeSanitizerDeps = {}) {
    this.#redactor = deps.redactor ?? new Redactor(true);
    this.#body = deps.body ?? new BodyParser();
    this.#tokens = deps.tokens ?? new TokenDetector();
    this.#multipart = deps.multipart ?? new MultipartParser();
  }

  sanitize(exchange: Exchange): Exchange {
    if (!this.#redactor.enabled) return Json.clone(exchange);
    const out = Json.clone(exchange);
    out.request.url = this.#redactor.url(out.request.url);
    if (out.pageUrl !== undefined) out.pageUrl = this.#redactor.url(out.pageUrl);
    out.request.headers = this.#headers(out.request.headers);
    if (out.request.body) out.request.body = this.#bodyData(out.request.body, out.request.headers);
    if (out.response) {
      out.response.headers = this.#headers(out.response.headers);
      if (out.response.body) out.response.body = this.#bodyData(out.response.body, out.response.headers);
    }
    return out;
  }

  #headers(headers: Header[]): Header[] {
    return headers.map((header) => {
      const lower = header.name.toLowerCase();
      if (lower === 'location' || lower === 'referer' || lower === 'content-location') return { name: header.name, value: this.#redactor.url(header.value) };
      return { name: header.name, value: this.#redactor.header(header.name, header.value) };
    });
  }

  #bodyData(body: BodyData, headers: Header[]): BodyData {
    if (body.truncated) return body;
    const contentType = Http.getHeader(headers, 'content-type') ?? body.mimeType;
    const parsed = this.#body.parse(body, contentType);
    switch (parsed.kind) {
      case 'form':
        return this.#text(body, this.#urlencoded(Http.bodyText(body)));
      case 'json':
      case 'graphql':
        return this.#json(body);
      case 'multipart':
        return this.#multipartBody(body, contentType);
      case 'html':
        return this.#text(body, this.#html(Http.bodyText(body)));
      default:
        return body;
    }
  }

  #text(body: BodyData, text: string): BodyData {
    if (text === Http.bodyText(body)) return body;
    return Http.toBodyData(new TextEncoder().encode(text), body.mimeType);
  }

  #urlencoded(text: string): string {
    return text
      .split('&')
      .map((part) => {
        const eq = part.indexOf('=');
        const rawName = eq < 0 ? part : part.slice(0, eq);
        const name = Http.decodeComponent(rawName.replace(/\+/g, ' '));
        const value = eq < 0 ? '' : Http.decodeComponent(part.slice(eq + 1).replace(/\+/g, ' '));
        if (!this.#secretField(name) && !this.#redactor.isSecretValue(value)) return part;
        return `${rawName}=${encodeURIComponent(Samples.REDACTED)}`;
      })
      .join('&');
  }

  #json(body: BodyData): BodyData {
    const text = Http.bodyText(body);
    const parsed = Json.safeParse(text);
    if (!parsed.ok) return body;
    const redacted = this.#redactor.deep(parsed.value);
    if (JSON.stringify(redacted) === JSON.stringify(parsed.value)) return body;
    return Http.toBodyData(new TextEncoder().encode(JSON.stringify(redacted)), body.mimeType);
  }

  #multipartBody(body: BodyData, contentType: string): BodyData {
    const boundary = MultipartParser.boundary(contentType);
    if (!boundary) return body;
    const parts = this.#multipart.parse(Http.bodyBytes(body), boundary);
    if (parts.length === 0 || parts.some((part) => !part.complete)) return body;
    if (!parts.some((part) => part.filename === undefined && part.name !== undefined && this.#secretField(part.name))) return body;
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    for (const part of parts) {
      const secret = part.filename === undefined && part.name !== undefined && this.#secretField(part.name);
      const head = [`--${boundary}`, ...part.headers.map((header) => `${header.name}: ${header.value}`), '', ''].join('\r\n');
      chunks.push(new Uint8Array(Buffer.from(head, 'latin1')), secret ? encoder.encode(Samples.REDACTED) : part.data, encoder.encode('\r\n'));
    }
    chunks.push(encoder.encode(`--${boundary}--\r\n`));
    return Http.toBodyData(new Uint8Array(Buffer.concat(chunks)), body.mimeType);
  }

  #html(html: string): string {
    return html.replace(ExchangeSanitizer.TAG_PATTERN, (tag: string, name: string, rest: string) => {
      const attributes = ExchangeSanitizer.attributes(rest);
      const element = name.toLowerCase();
      const key = attributes.get('name');
      if (key === undefined) return tag;
      const target = element === 'meta' ? 'content' : 'value';
      const secret = element === 'meta' ? this.#tokens.isTokenMeta(key) : this.#tokens.isTokenField(key) || this.#secretField(key);
      if (!secret || !attributes.has(target)) return tag;
      return `<${name}${ExchangeSanitizer.#replaceAttribute(rest, target, Samples.REDACTED)}>`;
    });
  }

  #secretField(name: string): boolean {
    return this.#redactor.isSecretField(name) || this.#tokens.isTokenField(name);
  }

  static attributes(source: string): Map<string, string> {
    const out = new Map<string, string>();
    for (const match of source.matchAll(ExchangeSanitizer.ATTRIBUTE_PATTERN)) {
      const name = (match[1] ?? '').toLowerCase();
      if (name === '' || out.has(name)) continue;
      out.set(name, ExchangeSanitizer.#entities(match[2] ?? match[3] ?? match[4] ?? ''));
    }
    return out;
  }

  static #replaceAttribute(source: string, target: string, value: string): string {
    let done = false;
    return source.replace(ExchangeSanitizer.ATTRIBUTE_PATTERN, (whole: string, name: string) => {
      if (done || name.toLowerCase() !== target) return whole;
      done = true;
      return `${name}="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"`;
    });
  }

  static #entities(value: string): string {
    return value.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos);/gi, (whole: string, ref: string) => {
      const lower = ref.toLowerCase();
      if (lower.startsWith('#x')) return ExchangeSanitizer.#codePoint(parseInt(lower.slice(2), 16), whole);
      if (lower.startsWith('#')) return ExchangeSanitizer.#codePoint(parseInt(lower.slice(1), 10), whole);
      return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[lower] ?? whole;
    });
  }

  static #codePoint(code: number, fallback: string): string {
    return Number.isInteger(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : fallback;
  }
}
