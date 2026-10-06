import type { BodyData, CapturedRequest, Exchange, FormEnctype, Header } from '../model/index.js';
import { BodyParser, MultipartParser, Redactor } from '../build/index.js';
import type { MultipartPart, PlainTextMode, SecretValues } from '../build/index.js';
import { HtmlTagScanner, TokenDetector } from '../forms/index.js';
import type { ScannedTag } from '../forms/index.js';
import { CharsetEncoder, Http, Json, Samples, Text } from '../shared/index.js';

export interface ExchangeSanitizerDeps {
  redactor?: Redactor;
  body?: BodyParser;
  tokens?: TokenDetector;
  multipart?: MultipartParser;
  scanner?: HtmlTagScanner;
}

export interface ExchangeSanitizerOptions {
  redact?: boolean;
}

export interface SanitizeContext {
  secrets?: ReadonlySet<string>;
  formEnctype?: FormEnctype;
  formCharset?: string;
}

export interface BodyScope {
  secrets?: ReadonlySet<string>;
  textMode?: PlainTextMode;
  formCharset?: string;
}

export class ExchangeSanitizer {
  static readonly URL_HEADERS: ReadonlySet<string> = new Set(['location', 'referer', 'content-location']);
  static readonly CONTENT_ENCODING = 'content-encoding';
  static readonly CONTENT_LENGTH = 'content-length';
  static readonly TEXT_FORM: FormEnctype = 'text/plain';
  static readonly NAVIGATION = 'document';
  static readonly HTML_TARGETS: Readonly<Record<string, string>> = Object.freeze({ input: 'value', meta: 'content' });
  static readonly HTML_TAGS: readonly string[] = Object.freeze(Object.keys(ExchangeSanitizer.HTML_TARGETS));
  static readonly SECRET_INPUT_TYPES: ReadonlySet<string> = new Set(['password']);
  static readonly LINE_BREAK: RegExp = /\r\n|\r|\n/;
  static readonly LAST_LINE_BREAK: RegExp = /(?:\r\n|\r|\n)(?![\s\S]*[\r\n])/;
  static readonly CRLF = '\r\n';

  readonly #redactor: Redactor;
  readonly #body: BodyParser;
  readonly #tokens: TokenDetector;
  readonly #multipart: MultipartParser;
  readonly #scanner: HtmlTagScanner;

  static create(options: ExchangeSanitizerOptions = {}): ExchangeSanitizer {
    return new ExchangeSanitizer({
      redactor: Redactor.create({ redact: options.redact ?? true }),
      body: BodyParser.create(),
      tokens: new TokenDetector(),
      multipart: new MultipartParser(),
      scanner: new HtmlTagScanner(),
    });
  }

  constructor(deps: ExchangeSanitizerDeps = {}) {
    this.#redactor = deps.redactor ?? Redactor.create();
    this.#body = deps.body ?? new BodyParser();
    this.#tokens = deps.tokens ?? new TokenDetector();
    this.#multipart = deps.multipart ?? new MultipartParser();
    this.#scanner = deps.scanner ?? new HtmlTagScanner();
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

  useValues(values: SecretValues): void {
    this.#redactor.useValues(values);
  }

  sanitize(exchange: Exchange, context: SanitizeContext = {}): Exchange {
    const out = Json.clone(exchange);
    if (!this.#redactor.enabled) return out;
    const secrets = context.secrets ?? Redactor.NO_NAMES;
    out.request.url = this.#redactor.url(out.request.url, secrets);
    if (out.pageUrl !== undefined) out.pageUrl = this.#redactor.url(out.pageUrl);
    out.request.headers = this.#headers(out.request.headers);
    if (out.request.body) {
      const textMode = Redactor.plainTextMode(Http.getHeader(out.request.headers, 'content-type') ?? out.request.body.mimeType);
      const form = context.formEnctype === ExchangeSanitizer.TEXT_FORM || (out.resourceType === ExchangeSanitizer.NAVIGATION && textMode === 'pairs');
      this.#request(out.request, out.request.body, { secrets, textMode: form ? 'form' : textMode, ...(context.formCharset === undefined ? {} : { formCharset: context.formCharset }) });
    }
    if (out.response) {
      out.response.headers = this.#headers(out.response.headers);
      const body = out.response.body;
      if (body) {
        const redacted = this.body(body, Http.getHeader(out.response.headers, 'content-type'));
        if (redacted !== body && !Http.isContentEncoded(Http.getHeader(out.response.headers, ExchangeSanitizer.CONTENT_ENCODING))) {
          out.response.headers = ExchangeSanitizer.#lengthHeaders(out.response.headers, redacted);
        }
        out.response.body = redacted;
      }
    }
    return out;
  }

  body(body: BodyData, contentType: string | undefined, scope: BodyScope = {}): BodyData {
    if (body.data === '') return body;
    const secrets = scope.secrets ?? Redactor.NO_NAMES;
    const textMode = scope.textMode ?? Redactor.plainTextMode(contentType ?? body.mimeType);
    const parsed = this.#body.parse(body, contentType);
    switch (parsed.kind) {
      case 'form':
        return this.#urlencoded(body, secrets);
      case 'json':
      case 'graphql':
        return this.#json(body);
      case 'multipart':
        return this.#multipartBody(body, contentType, secrets, scope.formCharset);
      case 'html':
        return this.#htmlBody(body);
      case 'text':
        return this.#plain(body, secrets, textMode);
      default:
        return body;
    }
  }

  html(source: string, truncated = false): string {
    const scan = this.#scanner.scan(source, ExchangeSanitizer.HTML_TAGS);
    const kept = truncated ? scan.complete : source.length;
    const chunks: string[] = [];
    let position = 0;
    for (const tag of scan.tags) {
      const target = ExchangeSanitizer.HTML_TARGETS[tag.name];
      const location = target === undefined ? undefined : tag.attrs.find((attr) => attr.name === target);
      if (target === undefined || location === undefined || location.end > kept || !this.#secretElement(tag, target)) continue;
      chunks.push(source.slice(position, location.start), `${target}="${Text.escapeHtml(Samples.REDACTED)}"`);
      position = location.end;
    }
    chunks.push(source.slice(position, kept));
    return chunks.join('');
  }

  #request(request: CapturedRequest, body: BodyData, scope: BodyScope): void {
    const contentType = Http.getHeader(request.headers, 'content-type');
    const coding = Http.getHeader(request.headers, ExchangeSanitizer.CONTENT_ENCODING);
    if (!Http.isContentEncoded(coding)) {
      const redacted = this.body(body, contentType, scope);
      if (redacted === body) return;
      request.body = redacted;
      request.headers = ExchangeSanitizer.#lengthHeaders(request.headers, redacted);
      return;
    }
    const decoded = BodyParser.decodeContent(body, coding ?? '');
    if (!decoded) {
      request.body = ExchangeSanitizer.withheld(body);
      return;
    }
    const redacted = this.body(decoded, contentType, scope);
    if (redacted === decoded) return;
    request.body = redacted;
    const decodedHeaders = request.headers.filter((header) => header.name.toLowerCase() !== ExchangeSanitizer.CONTENT_ENCODING);
    request.headers = ExchangeSanitizer.#lengthHeaders(decodedHeaders, redacted);
  }

  static #lengthHeaders(headers: Header[], body: BodyData): Header[] {
    return headers.flatMap((header) => {
      if (header.name.toLowerCase() !== ExchangeSanitizer.CONTENT_LENGTH) return [header];
      return body.truncated ? [] : [{ name: header.name, value: String(body.size) }];
    });
  }

  #headers(headers: Header[]): Header[] {
    return headers.map((header) => {
      if (ExchangeSanitizer.URL_HEADERS.has(header.name.toLowerCase())) return { name: header.name, value: this.#redactor.url(header.value) };
      return { name: header.name, value: this.#redactor.header(header.name, header.value) };
    });
  }

  #urlencoded(body: BodyData, secrets: ReadonlySet<string>): BodyData {
    const text = Http.bodyText(body);
    const complete = body.truncated ? text.slice(0, Math.max(0, text.lastIndexOf('&'))) : text;
    const out = complete === '' ? '' : complete.split('&').map((part) => this.#pair(part, secrets)).join('&');
    return out === text ? body : ExchangeSanitizer.textBody(body, out);
  }

  #pair(part: string, secrets: ReadonlySet<string>): string {
    const eq = part.indexOf('=');
    const rawName = eq < 0 ? part : part.slice(0, eq);
    const name = Http.decodeComponent(rawName.replace(/\+/g, ' '));
    const value = eq < 0 ? '' : Http.decodeComponent(part.slice(eq + 1).replace(/\+/g, ' '));
    if (secrets.has(name) || this.#secretField(name) || this.#redactor.isSecretValue(value)) return `${rawName}=${encodeURIComponent(Samples.REDACTED)}`;
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
        return parsed.ok ? JSON.stringify(this.#redactor.deep(parsed.value)) : this.#redactor.plainText(line, Redactor.NO_NAMES, 'values');
      })
      .join('');
    return out === text ? body : ExchangeSanitizer.textBody(body, out);
  }

  #plain(body: BodyData, secrets: ReadonlySet<string>, textMode: PlainTextMode): BodyData {
    const text = ExchangeSanitizer.byteText(body);
    const last = body.truncated ? ExchangeSanitizer.LAST_LINE_BREAK.exec(text) : null;
    const complete = body.truncated ? (last ? text.slice(0, last.index + last[0].length) : '') : text;
    const out = this.#redactor.plainText(complete, secrets, textMode);
    return out === text ? body : ExchangeSanitizer.bytesBody(body, new Uint8Array(Buffer.from(out, 'latin1')));
  }

  #htmlBody(body: BodyData): BodyData {
    const text = ExchangeSanitizer.byteText(body);
    const out = this.#redactor.scrub(this.html(text, body.truncated === true));
    return out === text ? body : ExchangeSanitizer.bytesBody(body, new Uint8Array(Buffer.from(out, 'latin1')));
  }

  #multipartBody(body: BodyData, contentType: string | undefined, secrets: ReadonlySet<string>, formCharset: string | undefined): BodyData {
    const bytes = Http.bodyBytes(body);
    const boundary = MultipartParser.boundary(contentType) ?? MultipartParser.boundary(body.mimeType) ?? MultipartParser.sniffBoundary(bytes);
    if (!boundary) return ExchangeSanitizer.withheld(body);
    const probe = this.#multipart.parse(bytes, boundary);
    const charset = BodyParser.multipartCharset(probe, formCharset);
    const encoder = CharsetEncoder.for(charset);
    const parts = Http.isLegacyCharset(charset) ? this.#multipart.parse(bytes, boundary, charset) : probe;
    if (!body.truncated && (parts.length === 0 || parts.some((part) => !part.complete))) return ExchangeSanitizer.withheld(body);
    const kept = parts.filter((part) => part.complete || part.filename !== undefined);
    const values = kept.map((part) => this.#partData(part, secrets, charset, encoder));
    if (!body.truncated && values.every((value, i) => value === kept[i]?.data)) return body;
    const chunks: Uint8Array[] = [];
    kept.forEach((part, i) => {
      const head = [`--${boundary}`, ...part.headers.map((header) => `${header.name}: ${header.value}`), '', ''].join(ExchangeSanitizer.CRLF);
      chunks.push(encoder.encode(head), values[i] ?? new Uint8Array());
      if (part.complete) chunks.push(encoder.encode(ExchangeSanitizer.CRLF));
    });
    if (!body.truncated) chunks.push(encoder.encode(`--${boundary}--${ExchangeSanitizer.CRLF}`));
    return ExchangeSanitizer.bytesBody(body, new Uint8Array(Buffer.concat(chunks)));
  }

  #partData(part: MultipartPart, secrets: ReadonlySet<string>, charset: string, encoder: CharsetEncoder): Uint8Array {
    if (part.filename !== undefined || part.name === undefined) return part.data;
    const text = CharsetEncoder.decode(part.data, charset);
    const redacted = secrets.has(part.name) || this.#secretField(part.name) ? Samples.REDACTED : String(this.#redactor.field(part.name, text));
    return redacted === text ? part.data : encoder.encode(redacted);
  }

  #secretElement(tag: ScannedTag, target: string): boolean {
    const attrs = new Map(tag.attrs.map((attr) => [attr.name, attr.value]));
    const name = attrs.get('name') ?? '';
    const value = attrs.get(target) ?? '';
    if (this.#redactor.isSecretValue(value)) return true;
    if (tag.name === 'meta') return name !== '' && (this.#tokens.isTokenMeta(name) || this.#secretField(name));
    if (ExchangeSanitizer.SECRET_INPUT_TYPES.has((attrs.get('type') ?? '').toLowerCase())) return value !== '';
    return name !== '' && (this.#tokens.isTokenField(name) || this.#secretField(name));
  }

  #secretField(name: string): boolean {
    return this.#redactor.isSecretField(name);
  }
}
