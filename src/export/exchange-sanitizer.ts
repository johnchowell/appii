import { parse } from 'parse5';
import type { BodyData, CapturedRequest, Exchange, Header } from '../model/index.js';
import { BodyParser, MultipartParser, Redactor } from '../build/index.js';
import type { MultipartPart } from '../build/index.js';
import { TokenDetector } from '../forms/index.js';
import { Http, Json, Samples, Text } from '../shared/index.js';

export interface ExchangeSanitizerDeps {
  redactor?: Redactor;
  body?: BodyParser;
  tokens?: TokenDetector;
  multipart?: MultipartParser;
}

export interface ExchangeSanitizerOptions {
  redact?: boolean;
}

interface HtmlLocation {
  startOffset: number;
  endOffset: number;
}

interface HtmlNode {
  nodeName: string;
  tagName?: string;
  attrs?: { name: string; value: string }[];
  childNodes?: HtmlNode[];
  content?: HtmlNode;
  sourceCodeLocation?: (HtmlLocation & { startTag?: HtmlLocation & { attrs?: Record<string, HtmlLocation> }; endTag?: HtmlLocation }) | null;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

export class ExchangeSanitizer {
  static readonly URL_HEADERS: ReadonlySet<string> = new Set(['location', 'referer', 'content-location']);
  static readonly CODING_HEADERS: ReadonlySet<string> = new Set(['content-encoding', 'content-length']);
  static readonly HTML_TARGETS: Readonly<Record<string, string>> = Object.freeze({ input: 'value', meta: 'content' });
  static readonly SECRET_INPUT_TYPES: ReadonlySet<string> = new Set(['password']);
  static readonly LINE_BREAK: RegExp = /\r\n|\r|\n/;
  static readonly LAST_LINE_BREAK: RegExp = /(?:\r\n|\r|\n)(?![\s\S]*[\r\n])/;
  static readonly CRLF = '\r\n';

  readonly #redactor: Redactor;
  readonly #body: BodyParser;
  readonly #tokens: TokenDetector;
  readonly #multipart: MultipartParser;

  static create(options: ExchangeSanitizerOptions = {}): ExchangeSanitizer {
    return new ExchangeSanitizer({ redactor: Redactor.create({ redact: options.redact ?? true }), body: BodyParser.create(), tokens: new TokenDetector(), multipart: new MultipartParser() });
  }

  constructor(deps: ExchangeSanitizerDeps = {}) {
    this.#redactor = deps.redactor ?? Redactor.create();
    this.#body = deps.body ?? new BodyParser();
    this.#tokens = deps.tokens ?? new TokenDetector();
    this.#multipart = deps.multipart ?? new MultipartParser();
  }

  static withheld(body: BodyData): BodyData {
    return { mimeType: body.mimeType, encoding: 'utf8', data: '', size: body.size, truncated: true };
  }

  static textBody(body: BodyData, text: string): BodyData {
    const size = new TextEncoder().encode(text).byteLength;
    return { mimeType: body.mimeType, encoding: 'utf8', data: text, size: body.truncated ? body.size : size, ...(body.truncated ? { truncated: true } : {}) };
  }

  static byteText(body: BodyData): string {
    return Buffer.from(Http.bodyBytes(body)).toString('latin1');
  }

  static bytesBody(body: BodyData, bytes: Uint8Array): BodyData {
    const out = Http.toBodyData(bytes, body.mimeType);
    return { ...out, size: body.truncated ? body.size : bytes.byteLength, ...(body.truncated ? { truncated: true } : {}) };
  }

  sanitize(exchange: Exchange): Exchange {
    const out = Json.clone(exchange);
    if (!this.#redactor.enabled) return out;
    out.request.url = this.#redactor.url(out.request.url);
    if (out.pageUrl !== undefined) out.pageUrl = this.#redactor.url(out.pageUrl);
    out.request.headers = this.#headers(out.request.headers);
    if (out.request.body) this.#request(out.request, out.request.body);
    if (out.response) {
      out.response.headers = this.#headers(out.response.headers);
      if (out.response.body) out.response.body = this.body(out.response.body, Http.getHeader(out.response.headers, 'content-type'));
    }
    return out;
  }

  body(body: BodyData, contentType: string | undefined): BodyData {
    if (body.data === '') return body;
    const parsed = this.#body.parse(body, contentType);
    switch (parsed.kind) {
      case 'form':
        return this.#urlencoded(body);
      case 'json':
      case 'graphql':
        return this.#json(body);
      case 'multipart':
        return this.#multipartBody(body, contentType);
      case 'html':
        return this.#htmlBody(body);
      case 'text':
        return this.#plain(body);
      default:
        return body;
    }
  }

  html(source: string): string {
    const doc = parse(source, { sourceCodeLocationInfo: true, scriptingEnabled: false }) as unknown as HtmlNode;
    const replacements: Replacement[] = [];
    for (const element of ExchangeSanitizer.#elements(doc)) {
      const tag = element.tagName ?? '';
      const target = ExchangeSanitizer.HTML_TARGETS[tag];
      const location = target === undefined ? undefined : element.sourceCodeLocation?.startTag?.attrs?.[target];
      if (target === undefined || location === undefined || !this.#secretElement(tag, element, target)) continue;
      replacements.push({ start: location.startOffset, end: location.endOffset, text: `${target}="${Text.escapeHtml(Samples.REDACTED)}"` });
    }
    let out = source;
    for (const replacement of replacements.sort((a, b) => b.start - a.start)) out = out.slice(0, replacement.start) + replacement.text + out.slice(replacement.end);
    return out;
  }

  static completeHtml(source: string): string {
    const doc = parse(source, { sourceCodeLocationInfo: true, scriptingEnabled: false }) as unknown as HtmlNode;
    let end = 0;
    const visit = (node: HtmlNode): void => {
      const location = node.sourceCodeLocation;
      if (location) {
        if (node.tagName === undefined) end = Math.max(end, location.endOffset);
        if (location.startTag) end = Math.max(end, location.startTag.endOffset);
        if (location.endTag) end = Math.max(end, location.endTag.endOffset);
      }
      for (const child of node.childNodes ?? []) visit(child);
      if (node.content) visit(node.content);
    };
    visit(doc);
    return source.slice(0, end);
  }

  #request(request: CapturedRequest, body: BodyData): void {
    const contentType = Http.getHeader(request.headers, 'content-type');
    const coding = Http.getHeader(request.headers, 'content-encoding');
    if (!Http.isContentEncoded(coding)) {
      request.body = this.body(body, contentType);
      return;
    }
    const decoded = BodyParser.decodeContent(body, coding ?? '');
    if (!decoded) {
      request.body = ExchangeSanitizer.withheld(body);
      return;
    }
    const redacted = this.body(decoded, contentType);
    if (redacted === decoded) return;
    request.body = redacted;
    request.headers = request.headers.filter((header) => !ExchangeSanitizer.CODING_HEADERS.has(header.name.toLowerCase()));
  }

  #headers(headers: Header[]): Header[] {
    return headers.map((header) => {
      if (ExchangeSanitizer.URL_HEADERS.has(header.name.toLowerCase())) return { name: header.name, value: this.#redactor.url(header.value) };
      return { name: header.name, value: this.#redactor.header(header.name, header.value) };
    });
  }

  #urlencoded(body: BodyData): BodyData {
    const text = Http.bodyText(body);
    const complete = body.truncated ? text.slice(0, Math.max(0, text.lastIndexOf('&'))) : text;
    const out = complete === '' ? '' : complete.split('&').map((part) => this.#pair(part)).join('&');
    return out === text ? body : ExchangeSanitizer.textBody(body, out);
  }

  #pair(part: string): string {
    const eq = part.indexOf('=');
    const rawName = eq < 0 ? part : part.slice(0, eq);
    const name = Http.decodeComponent(rawName.replace(/\+/g, ' '));
    const value = eq < 0 ? '' : Http.decodeComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    if (this.#secretField(name) || this.#redactor.isSecretValue(value)) return `${rawName}=${encodeURIComponent(Samples.REDACTED)}`;
    const inner = String(this.#redactor.deep(value));
    return inner === value ? part : `${rawName}=${encodeURIComponent(inner)}`;
  }

  #json(body: BodyData): BodyData {
    if (body.truncated) return ExchangeSanitizer.withheld(body);
    const text = Http.bodyText(body);
    const whole = Json.safeParse(Text.stripBom(text));
    if (whole.ok) {
      const redacted = this.#redactor.deep(whole.value);
      return JSON.stringify(redacted) === JSON.stringify(whole.value) ? body : ExchangeSanitizer.textBody(body, JSON.stringify(redacted));
    }
    const out = text
      .split(/(\r\n|\r|\n)/)
      .map((line, i) => {
        if (i % 2 === 1 || line.trim() === '') return line;
        const parsed = Json.safeParse(line);
        return parsed.ok ? JSON.stringify(this.#redactor.deep(parsed.value)) : this.#redactor.plainText(line);
      })
      .join('');
    return out === text ? body : ExchangeSanitizer.textBody(body, out);
  }

  #plain(body: BodyData): BodyData {
    const text = ExchangeSanitizer.byteText(body);
    const last = body.truncated ? ExchangeSanitizer.LAST_LINE_BREAK.exec(text) : null;
    const complete = body.truncated ? (last ? text.slice(0, last.index + last[0].length) : '') : text;
    const out = this.#redactor.plainText(complete);
    return out === text ? body : ExchangeSanitizer.bytesBody(body, new Uint8Array(Buffer.from(out, 'latin1')));
  }

  #htmlBody(body: BodyData): BodyData {
    const text = ExchangeSanitizer.byteText(body);
    const out = this.html(body.truncated ? ExchangeSanitizer.completeHtml(text) : text);
    return out === text ? body : ExchangeSanitizer.bytesBody(body, new Uint8Array(Buffer.from(out, 'latin1')));
  }

  #multipartBody(body: BodyData, contentType: string | undefined): BodyData {
    const bytes = Http.bodyBytes(body);
    const boundary = MultipartParser.boundary(contentType) ?? MultipartParser.boundary(body.mimeType) ?? MultipartParser.sniffBoundary(bytes);
    if (!boundary) return ExchangeSanitizer.withheld(body);
    const parts = this.#multipart.parse(bytes, boundary);
    if (!body.truncated && (parts.length === 0 || parts.some((part) => !part.complete))) return ExchangeSanitizer.withheld(body);
    const kept = parts.filter((part) => part.complete || part.filename !== undefined);
    const values = kept.map((part) => this.#partData(part));
    if (!body.truncated && values.every((value, i) => value === kept[i]?.data)) return body;
    const encoder = new TextEncoder();
    const chunks: Uint8Array[] = [];
    kept.forEach((part, i) => {
      const head = [`--${boundary}`, ...part.headers.map((header) => `${header.name}: ${header.value}`), '', ''].join(ExchangeSanitizer.CRLF);
      chunks.push(new Uint8Array(Buffer.from(head, 'latin1')), values[i] ?? new Uint8Array());
      if (part.complete) chunks.push(encoder.encode(ExchangeSanitizer.CRLF));
    });
    if (!body.truncated) chunks.push(encoder.encode(`--${boundary}--${ExchangeSanitizer.CRLF}`));
    return ExchangeSanitizer.bytesBody(body, new Uint8Array(Buffer.concat(chunks)));
  }

  #partData(part: MultipartPart): Uint8Array {
    if (part.filename !== undefined || part.name === undefined) return part.data;
    const text = new TextDecoder().decode(part.data);
    const redacted = this.#secretField(part.name) ? Samples.REDACTED : String(this.#redactor.field(part.name, text));
    return redacted === text ? part.data : new TextEncoder().encode(redacted);
  }

  #secretElement(tag: string, element: HtmlNode, target: string): boolean {
    const attrs = new Map((element.attrs ?? []).map((attr) => [attr.name, attr.value]));
    const name = attrs.get('name') ?? '';
    const value = attrs.get(target) ?? '';
    if (this.#redactor.isSecretValue(value)) return true;
    if (tag === 'meta') return name !== '' && (this.#tokens.isTokenMeta(name) || this.#secretField(name));
    if (ExchangeSanitizer.SECRET_INPUT_TYPES.has((attrs.get('type') ?? '').toLowerCase())) return value !== '';
    return name !== '' && (this.#tokens.isTokenField(name) || this.#secretField(name));
  }

  #secretField(name: string): boolean {
    return this.#redactor.isSecretField(name);
  }

  static #elements(root: HtmlNode): HtmlNode[] {
    const out: HtmlNode[] = [];
    const stack: HtmlNode[] = [root];
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) continue;
      if (node.tagName !== undefined) out.push(node);
      if (node.content) stack.push(node.content);
      for (const child of node.childNodes ?? []) stack.push(child);
    }
    return out;
  }
}
