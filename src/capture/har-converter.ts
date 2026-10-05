import { randomBytes } from 'node:crypto';
import { load } from 'cheerio';
import { AppiiError, Http, Json, Meta, Text } from '../shared/index.js';
import type {
  BodyData,
  Capture,
  CapturedRequest,
  CapturedResponse,
  Exchange,
  Header,
  PageSnapshot,
  WebSocketCapture,
  WebSocketMessage,
} from '../model/index.js';
import { CaptureValidator } from './capture-validator.js';
import { CookieParser } from './cookie-parser.js';
import { Helpers } from './helpers.js';
import { ResourceTypeMapper } from './resource-type-mapper.js';
import type { Har, HarContent, HarCookie, HarEntry, HarPage, HarParam, HarPostData, HarRequest, HarResponse, HarTimings, HarWebSocketMessage } from './har-types.js';

export interface HarConverterDeps {
  cookies?: CookieParser;
  validator?: CaptureValidator;
}

interface Ordered {
  readonly start: number;
  readonly pageUrl: string | undefined;
  readonly build: (pageref: string | undefined) => HarEntry;
}

interface ImportedEntry {
  readonly raw: Record<string, unknown>;
  readonly own: boolean;
  readonly pageref: string | undefined;
}

export class HarConverter {
  static readonly VERSION = '1.2';
  static readonly HTML_MIMES: ReadonlySet<string> = new Set(['text/html', 'application/xhtml+xml']);
  static readonly REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
  static readonly NO_BODY_STATUSES: ReadonlySet<number> = new Set([101, 204, 205, 304]);
  static readonly NORMALIZED_METHODS: ReadonlySet<string> = new Set(['DELETE', 'GET', 'HEAD', 'OPTIONS', 'POST', 'PUT']);

  readonly #cookies: CookieParser;
  readonly #validator: CaptureValidator;

  constructor(deps: HarConverterDeps = {}) {
    this.#cookies = deps.cookies ?? new CookieParser();
    this.#validator = deps.validator ?? new CaptureValidator();
  }

  static create(): HarConverter {
    return new HarConverter({ cookies: new CookieParser(), validator: new CaptureValidator() });
  }

  toHar(input: Capture | Exchange[]): Har {
    const capture = Array.isArray(input) ? undefined : input;
    const exchanges = Array.isArray(input) ? input : input.exchanges;
    const titles = new Map<string, string>();
    for (const page of capture?.pages ?? []) if (page.title && !titles.has(page.url)) titles.set(page.url, page.title);

    const ordered: Ordered[] = [
      ...exchanges.map((e) => ({ start: Date.parse(e.startedAt), pageUrl: e.pageUrl, build: (ref: string | undefined) => this.#exchangeEntry(e, ref) })),
      ...(capture?.websockets ?? []).map((ws) => ({ start: Date.parse(ws.openedAt), pageUrl: ws.pageUrl, build: (ref: string | undefined) => HarConverter.#socketEntry(ws, ref) })),
    ];
    const sorted = ordered
      .map((item, index) => ({ item, index }))
      .sort((a, b) => HarConverter.#order(a.item.start) - HarConverter.#order(b.item.start) || a.index - b.index)
      .map(({ item }) => item);

    const pages = new Map<string, HarPage>();
    const entries = sorted.map((item) => {
      let pageref: string | undefined;
      if (item.pageUrl) {
        let page = pages.get(item.pageUrl);
        if (!page) {
          page = {
            startedDateTime: HarConverter.#iso(item.start),
            id: `page_${pages.size + 1}`,
            title: titles.get(item.pageUrl) ?? item.pageUrl,
            pageTimings: { onContentLoad: -1, onLoad: -1 },
          };
          pages.set(item.pageUrl, page);
        }
        pageref = page.id;
      }
      return item.build(pageref);
    });

    const creator = Meta.creator();
    return {
      log: {
        version: HarConverter.VERSION,
        creator: { name: creator.name, version: creator.version },
        pages: [...pages.values()],
        entries,
        ...(capture
          ? {
              ...(capture.startUrl ? { _appiiStartUrl: capture.startUrl } : {}),
              _appiiStartedAt: capture.startedAt,
              _appiiEndedAt: capture.endedAt,
              _appiiCookies: Json.clone(capture.cookies),
              _appiiStorage: Json.clone(capture.storage),
              _appiiPages: Json.clone(capture.pages),
            }
          : {}),
      },
    };
  }

  fromHar(input: Har | string): Capture {
    const har: unknown = typeof input === 'string' ? HarConverter.#parse(input) : input;
    if (!Json.isPlainObject(har) || !Json.isPlainObject(har.log) || !Array.isArray(har.log.entries)) {
      throw new AppiiError('BAD_INPUT', 'Not a HAR file: log.entries is missing');
    }
    const log = har.log;
    const exchanges: Exchange[] = [];
    const exchangeEntries: ImportedEntry[] = [];
    const websockets: WebSocketCapture[] = [];
    const socketEntries: ImportedEntry[] = [];

    (log.entries as unknown[]).forEach((raw, index) => {
      if (!Json.isPlainObject(raw) || !Json.isPlainObject(raw.request) || typeof raw.request.url !== 'string') {
        throw new AppiiError('BAD_INPUT', `HAR entry ${index} has no request URL`);
      }
      if (!Helpers.isNetworkUrl(raw.request.url)) return;
      const entry: ImportedEntry = {
        raw,
        own: typeof raw._appiiId === 'string' && raw._appiiId.length > 0,
        pageref: typeof raw.pageref === 'string' ? raw.pageref : undefined,
      };
      if (HarConverter.#isSocket(raw)) {
        websockets.push(HarConverter.#socket(raw, index));
        socketEntries.push(entry);
      } else {
        exchanges.push(HarConverter.#exchange(raw, index));
        exchangeEntries.push(entry);
      }
    });

    const pageUrls = HarConverter.#pageUrls(Array.isArray(log.pages) ? log.pages : [], exchanges, exchangeEntries);
    exchanges.forEach((e, i) => HarConverter.#assignPage(e, exchangeEntries[i]!, pageUrls));
    websockets.forEach((ws, i) => HarConverter.#assignPage(ws, socketEntries[i]!, pageUrls));
    HarConverter.#linkRedirects(exchanges, exchangeEntries);

    let first = Number.POSITIVE_INFINITY;
    let last = Number.NEGATIVE_INFINITY;
    const times = [
      ...exchanges.flatMap((e) => [Date.parse(e.startedAt), Helpers.endTime(e)]),
      ...websockets.flatMap((ws) => [Date.parse(ws.openedAt), ws.closedAt ? Date.parse(ws.closedAt) : Number.NaN]),
    ];
    for (const t of times) {
      if (!Number.isFinite(t)) continue;
      first = Math.min(first, t);
      last = Math.max(last, t);
    }
    const startedAt = HarConverter.#dateOr(log._appiiStartedAt, Number.isFinite(first) ? new Date(first).toISOString() : new Date().toISOString());
    const endedAt = HarConverter.#dateOr(log._appiiEndedAt, Number.isFinite(last) ? new Date(last).toISOString() : startedAt);
    const own = typeof log._appiiStartedAt === 'string';
    const startUrl = own
      ? typeof log._appiiStartUrl === 'string'
        ? log._appiiStartUrl
        : undefined
      : exchanges.find((e) => e.resourceType === 'document')?.request.url;

    const cookies =
      log._appiiCookies !== undefined && this.#validator.cookies(log._appiiCookies).length === 0
        ? Json.clone(log._appiiCookies as Capture['cookies'])
        : this.#cookies.replay(exchanges);
    const storage =
      log._appiiStorage !== undefined && this.#validator.storage(log._appiiStorage).length === 0 ? Json.clone(log._appiiStorage as Capture['storage']) : [];
    const pages =
      log._appiiPages !== undefined && this.#validator.pages(log._appiiPages).length === 0
        ? Json.clone(log._appiiPages as PageSnapshot[])
        : HarConverter.#documentPages(exchanges);

    return {
      version: 1,
      tool: Meta.creator() as Capture['tool'],
      ...(startUrl ? { startUrl } : {}),
      startedAt,
      endedAt,
      exchanges,
      websockets,
      cookies,
      storage,
      pages,
    };
  }

  #exchangeEntry(e: Exchange, pageref: string | undefined): HarEntry {
    const at = Date.parse(e.startedAt);
    const duration = Math.max(0, e.durationMs);
    const request: HarRequest = {
      method: e.request.method,
      url: e.request.url,
      httpVersion: '',
      cookies: Http.getHeaderAll(e.request.headers, 'cookie').flatMap((h) => Http.parseCookieHeader(h).map((c) => ({ name: c.name, value: c.value }))),
      headers: HarConverter.#copyHeaders(e.request.headers),
      queryString: HarConverter.#query(e.request.url),
      ...(e.request.body ? { postData: HarConverter.#postData(e.request.body, e.request.headers) } : {}),
      headersSize: -1,
      bodySize: e.request.body ? e.request.body.size : 0,
    };
    const response = e.response ? HarConverter.#response(e, Number.isNaN(at) ? Date.now() : at + duration) : HarConverter.#failedResponse(e.error);
    const server = e.response?.remoteAddress ? HarConverter.#serverIp(e.response.remoteAddress) : undefined;
    return {
      ...(pageref ? { pageref } : {}),
      startedDateTime: e.startedAt,
      time: duration,
      request,
      response,
      cache: {},
      timings: HarConverter.#timings(duration),
      ...(server ? { serverIPAddress: server } : {}),
      _resourceType: e.resourceType,
      _appiiId: e.id,
      ...(e.redirectedFrom ? { _appiiRedirectedFrom: e.redirectedFrom } : {}),
      ...(e.pageUrl ? { _appiiPageUrl: e.pageUrl } : {}),
      ...(e.error ? { _appiiError: e.error } : {}),
      ...(e.response?.remoteAddress ? { _appiiRemoteAddress: e.response.remoteAddress } : {}),
    };
  }

  static #response(e: Exchange, atMs: number): HarResponse {
    const r = e.response!;
    const body = r.body;
    const content: HarContent = {
      size: body ? body.size : 0,
      mimeType: body?.mimeType || Http.getHeader(r.headers, 'content-type') || '',
      ...(body ? { text: body.data } : {}),
      ...(body?.encoding === 'base64' ? { encoding: 'base64' } : {}),
      ...(body?.truncated ? { _appiiTruncated: true } : {}),
    };
    return {
      status: r.status,
      statusText: r.statusText,
      httpVersion: '',
      cookies: HarConverter.#setCookies(r.headers, atMs),
      headers: HarConverter.#copyHeaders(r.headers),
      content,
      redirectURL: Http.getHeader(r.headers, 'location') ?? '',
      headersSize: -1,
      bodySize: HarConverter.#bodySize(e),
      ...(e.error ? { _error: e.error } : {}),
    };
  }

  static #failedResponse(error: string | undefined): HarResponse {
    return {
      status: 0,
      statusText: '',
      httpVersion: '',
      cookies: [],
      headers: [],
      content: { size: 0, mimeType: 'x-unknown' },
      redirectURL: '',
      headersSize: -1,
      bodySize: -1,
      _error: error ?? 'No response',
    };
  }

  static #socketEntry(ws: WebSocketCapture, pageref: string | undefined): HarEntry {
    const opened = Date.parse(ws.openedAt);
    const closed = ws.closedAt ? Date.parse(ws.closedAt) : Number.NaN;
    const time = Number.isFinite(opened) && Number.isFinite(closed) ? Math.max(0, closed - opened) : 0;
    const failed = ws.error !== undefined && ws.messages.length === 0;
    const messages: HarWebSocketMessage[] = ws.messages.map((m) => ({
      type: m.direction === 'sent' ? 'send' : 'receive',
      time: Date.parse(m.at) / 1000,
      opcode: m.opcode === 'text' ? 1 : 2,
      data: m.data,
    }));
    return {
      ...(pageref ? { pageref } : {}),
      startedDateTime: ws.openedAt,
      time,
      request: {
        method: 'GET',
        url: ws.url,
        httpVersion: '',
        cookies: [],
        headers: [],
        queryString: HarConverter.#query(ws.url),
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status: failed ? 0 : 101,
        statusText: failed ? '' : 'Switching Protocols',
        httpVersion: '',
        cookies: [],
        headers: [],
        content: { size: 0, mimeType: failed ? 'x-unknown' : '' },
        redirectURL: '',
        headersSize: -1,
        bodySize: failed ? -1 : 0,
        ...(ws.error ? { _error: ws.error } : {}),
      },
      cache: {},
      timings: HarConverter.#timings(time),
      _resourceType: 'websocket',
      _webSocketMessages: messages,
      _appiiId: ws.id,
      ...(ws.pageUrl ? { _appiiPageUrl: ws.pageUrl } : {}),
      ...(ws.error ? { _appiiError: ws.error } : {}),
      ...(ws.closedAt ? { _appiiClosedAt: ws.closedAt } : {}),
    };
  }

  static #exchange(raw: Record<string, unknown>, index: number): Exchange {
    const req = raw.request as Record<string, unknown>;
    const url = req.url as string;
    const method = HarConverter.#method(req.method);
    const requestHeaders = Helpers.stripPseudoHeaders(HarConverter.#headers(req.headers));
    const request: CapturedRequest = { method, url, headers: requestHeaders };
    const requestBody = HarConverter.#requestBody(req, requestHeaders);
    if (requestBody) request.body = requestBody;

    const res = Json.isPlainObject(raw.response) ? raw.response : {};
    const status = typeof res.status === 'number' && Number.isInteger(res.status) ? res.status : 0;
    let response: CapturedResponse | undefined;
    if (status > 0) {
      const responseHeaders = Helpers.stripPseudoHeaders(HarConverter.#headers(res.headers));
      response = { status, statusText: typeof res.statusText === 'string' ? res.statusText : '', headers: responseHeaders };
      const body = HarConverter.#contentBody(res.content, responseHeaders);
      if (body) response.body = body;
      const remote = typeof raw._appiiRemoteAddress === 'string' && raw._appiiRemoteAddress ? raw._appiiRemoteAddress : raw.serverIPAddress;
      if (typeof remote === 'string' && remote) response.remoteAddress = remote;
    }
    const error =
      typeof raw._appiiError === 'string' ? raw._appiiError : status === 0 ? (typeof res._error === 'string' && res._error ? res._error : 'No response recorded') : undefined;
    const resourceType =
      typeof raw._resourceType === 'string' && raw._resourceType
        ? ResourceTypeMapper.fromBrowser(raw._resourceType)
        : ResourceTypeMapper.infer({
            method,
            url,
            requestHeaders,
            status,
            mimeType: response ? response.body?.mimeType || Http.getHeader(response.headers, 'content-type') || HarConverter.#declaredMime(res.content) : '',
          });
    return {
      id: typeof raw._appiiId === 'string' && raw._appiiId ? raw._appiiId : Http.newId(),
      source: 'har',
      resourceType,
      ...(typeof raw._appiiPageUrl === 'string' && raw._appiiPageUrl ? { pageUrl: raw._appiiPageUrl } : {}),
      startedAt: HarConverter.#startedAt(raw.startedDateTime, index),
      durationMs: HarConverter.#duration(raw),
      request,
      ...(response ? { response } : {}),
      ...(error ? { error } : {}),
      ...(typeof raw._appiiRedirectedFrom === 'string' && raw._appiiRedirectedFrom ? { redirectedFrom: raw._appiiRedirectedFrom } : {}),
    };
  }

  static #socket(raw: Record<string, unknown>, index: number): WebSocketCapture {
    const req = raw.request as Record<string, unknown>;
    const res = Json.isPlainObject(raw.response) ? raw.response : {};
    const openedAt = HarConverter.#startedAt(raw.startedDateTime, index);
    const messages: WebSocketMessage[] = [];
    if (Array.isArray(raw._webSocketMessages)) {
      for (const m of raw._webSocketMessages as unknown[]) {
        if (!Json.isPlainObject(m)) continue;
        const opcode = Number(m.opcode);
        if (opcode !== 1 && opcode !== 2) continue;
        const at = typeof m.time === 'number' && Number.isFinite(m.time) ? new Date(Math.round(m.time * 1000)).toISOString() : openedAt;
        messages.push({ direction: m.type === 'send' ? 'sent' : 'received', at, opcode: opcode === 1 ? 'text' : 'binary', data: typeof m.data === 'string' ? m.data : '' });
      }
    }
    const error = typeof raw._appiiError === 'string' ? raw._appiiError : typeof res._error === 'string' && res._error ? res._error : undefined;
    const closedAt = typeof raw._appiiClosedAt === 'string' && !Number.isNaN(Date.parse(raw._appiiClosedAt)) ? raw._appiiClosedAt : undefined;
    return {
      id: typeof raw._appiiId === 'string' && raw._appiiId ? raw._appiiId : Http.newId(),
      url: HarConverter.#socketUrl(req.url as string),
      ...(typeof raw._appiiPageUrl === 'string' && raw._appiiPageUrl ? { pageUrl: raw._appiiPageUrl } : {}),
      openedAt,
      ...(closedAt ? { closedAt } : {}),
      ...(error ? { error } : {}),
      messages,
    };
  }

  static #requestBody(req: Record<string, unknown>, headers: Header[]): BodyData | undefined {
    const pd = req.postData;
    if (!Json.isPlainObject(pd)) return undefined;
    const headerType = Http.getHeader(headers, 'content-type') ?? '';
    let mimeType = (typeof pd.mimeType === 'string' && pd.mimeType) || headerType;
    let bytes: Uint8Array | undefined;
    if (typeof pd.text === 'string') {
      const base64 = pd._appiiEncoding === 'base64' || pd._encoding === 'base64' || pd.encoding === 'base64';
      bytes = base64 ? Buffer.from(pd.text, 'base64') : Buffer.from(pd.text, 'utf8');
    } else if (Array.isArray(pd.params) && pd.params.length > 0) {
      const params = (pd.params as unknown[]).filter((p): p is HarParam => Json.isPlainObject(p) && typeof p.name === 'string');
      const rebuilt = HarConverter.#rebuild(params, mimeType, headerType);
      mimeType = rebuilt.mimeType;
      bytes = rebuilt.bytes;
    }
    if (!bytes || bytes.length === 0) return undefined;
    const body = Http.toBodyData(bytes, mimeType, { contentEncoding: Http.getHeader(headers, 'content-encoding') });
    if (typeof req.bodySize === 'number' && Number.isFinite(req.bodySize) && req.bodySize > 0) body.size = req.bodySize;
    if (pd._appiiTruncated === true) body.truncated = true;
    return body;
  }

  static #contentBody(content: unknown, headers: Header[]): BodyData | undefined {
    if (!Json.isPlainObject(content) || typeof content.text !== 'string') return undefined;
    const mimeType = HarConverter.#declaredMime(content) || Http.getHeader(headers, 'content-type') || '';
    const bytes = content.encoding === 'base64' ? Buffer.from(content.text, 'base64') : Buffer.from(content.text, 'utf8');
    if (bytes.length === 0) return undefined;
    const body = Http.toBodyData(bytes, mimeType);
    const size = typeof content.size === 'number' && Number.isFinite(content.size) && content.size > 0 ? content.size : bytes.length;
    body.size = size;
    if (content._appiiTruncated === true) body.truncated = true;
    return body;
  }

  static #declaredMime(content: unknown): string {
    if (!Json.isPlainObject(content) || typeof content.mimeType !== 'string' || content.mimeType === 'x-unknown') return '';
    return content.mimeType;
  }

  static #rebuild(params: HarParam[], mimeType: string, headerType: string): { mimeType: string; bytes: Uint8Array } {
    const essence = Http.mimeEssence(mimeType) || Http.mimeEssence(headerType);
    if (essence === 'multipart/form-data') {
      const declared = HarConverter.#boundary(mimeType);
      const fromHeader = HarConverter.#boundary(headerType);
      const boundary = declared ?? fromHeader ?? `----appiiFormBoundary${randomBytes(8).toString('hex')}`;
      const type = declared ? mimeType : fromHeader ? headerType : `multipart/form-data; boundary=${boundary}`;
      const escape = (s: string): string => s.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
      let text = '';
      for (const p of params) {
        const file = typeof p.fileName === 'string';
        text += `--${boundary}\r\nContent-Disposition: form-data; name="${escape(p.name)}"${file ? `; filename="${escape(p.fileName!)}"` : ''}\r\n`;
        if (file || p.contentType) text += `Content-Type: ${p.contentType || 'application/octet-stream'}\r\n`;
        text += `\r\n${p.value ?? ''}\r\n`;
      }
      text += `--${boundary}--\r\n`;
      return { mimeType: type, bytes: Buffer.from(text, 'utf8') };
    }
    if (essence === 'text/plain') {
      const text = params.map((p) => `${p.name}=${p.value ?? ''}\r\n`).join('');
      return { mimeType: mimeType || headerType, bytes: Buffer.from(text, 'utf8') };
    }
    const search = new URLSearchParams();
    for (const p of params) search.append(p.name, p.value ?? '');
    return { mimeType: mimeType || headerType || 'application/x-www-form-urlencoded', bytes: Buffer.from(search.toString(), 'utf8') };
  }

  static #boundary(contentType: string | undefined): string | undefined {
    if (!contentType) return undefined;
    const m = /;\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    return m?.[1] ?? m?.[2];
  }

  static #postData(body: BodyData, headers: Header[]): HarPostData {
    return {
      mimeType: body.mimeType || Http.getHeader(headers, 'content-type') || '',
      text: body.data,
      ...(body.encoding === 'base64' ? { _appiiEncoding: 'base64' as const } : {}),
      ...(body.truncated ? { _appiiTruncated: true } : {}),
    };
  }

  static #setCookies(headers: Header[], atMs: number): HarCookie[] {
    const out: HarCookie[] = [];
    for (const header of Http.getHeaderAll(headers, 'set-cookie')) {
      for (const line of header.split('\n')) {
        const parts = CookieParser.tokenize(line);
        if (!parts) continue;
        const cookie: HarCookie = { name: parts.name, value: parts.value };
        let maxAge: string | undefined;
        let expires: string | undefined;
        for (const { name, value } of parts.attributes) {
          const key = name.toLowerCase();
          if (key === 'path') cookie.path = value;
          else if (key === 'domain') cookie.domain = value;
          else if (key === 'httponly') cookie.httpOnly = true;
          else if (key === 'secure') cookie.secure = true;
          else if (key === 'samesite') cookie.sameSite = value;
          else if (key === 'max-age' && /^-?\d+$/.test(value)) {
            const seconds = Number(value);
            maxAge = new Date(seconds <= 0 ? 0 : Math.min(atMs + seconds * 1000, 8.64e15)).toISOString();
          } else if (key === 'expires') {
            const date = CookieParser.parseDate(value);
            if (date !== null) expires = new Date(date).toISOString();
          }
        }
        const expiry = maxAge ?? expires;
        if (expiry) cookie.expires = expiry;
        out.push(cookie);
      }
    }
    return out;
  }

  static #bodySize(e: Exchange): number {
    const r = e.response!;
    const length = Http.getHeader(r.headers, 'content-length');
    if (length !== undefined && /^\d+$/.test(length.trim())) return Number(length.trim());
    if (r.body) return Http.getHeader(r.headers, 'content-encoding') ? -1 : r.body.size;
    if (HarConverter.NO_BODY_STATUSES.has(r.status) || e.request.method.toUpperCase() === 'HEAD') return 0;
    return -1;
  }

  static #timings(duration: number): HarTimings {
    return { blocked: -1, dns: -1, connect: -1, send: 0, wait: duration, receive: 0, ssl: -1 };
  }

  static #pageUrls(pages: unknown[], exchanges: Exchange[], entries: ImportedEntry[]): Map<string, string> {
    const out = new Map<string, string>();
    exchanges.forEach((e, i) => {
      const ref = entries[i]?.pageref;
      if (ref && !out.has(ref) && e.resourceType === 'document') out.set(ref, e.request.url);
    });
    for (const page of pages) {
      if (!Json.isPlainObject(page) || typeof page.id !== 'string' || out.has(page.id)) continue;
      if (typeof page.title === 'string' && /^https?:\/\//i.test(page.title)) out.set(page.id, page.title);
    }
    return out;
  }

  static #assignPage(target: Exchange | WebSocketCapture, entry: ImportedEntry, pageUrls: Map<string, string>): void {
    if (entry.own || target.pageUrl || !entry.pageref) return;
    const url = pageUrls.get(entry.pageref);
    if (url) target.pageUrl = url;
  }

  static #linkRedirects(exchanges: Exchange[], entries: ImportedEntry[]): void {
    const claimed = new Set<number>();
    exchanges.forEach((e, i) => {
      const r = e.response;
      if (!r || !HarConverter.REDIRECT_STATUSES.has(r.status)) return;
      const raw = entries[i]?.raw.response;
      const location = Http.getHeader(r.headers, 'location') || (Json.isPlainObject(raw) && typeof raw.redirectURL === 'string' ? raw.redirectURL : '');
      if (!location) return;
      let target: string;
      try {
        const url = new URL(location, e.request.url);
        url.hash = '';
        target = url.href;
      } catch {
        return;
      }
      for (let j = i + 1; j < exchanges.length; j++) {
        const next = exchanges[j]!;
        if (claimed.has(j) || entries[j]?.own || next.redirectedFrom || next.request.url !== target) continue;
        next.redirectedFrom = e.id;
        claimed.add(j);
        break;
      }
    });
  }

  static #documentPages(exchanges: Exchange[]): PageSnapshot[] {
    const pages: PageSnapshot[] = [];
    for (const e of exchanges) {
      const body = e.response?.body;
      if (e.resourceType !== 'document' || !body) continue;
      const mime = Http.mimeEssence(body.mimeType || Http.getHeader(e.response!.headers, 'content-type'));
      if (!HarConverter.HTML_MIMES.has(mime)) continue;
      const html = Http.bodyText(body);
      if (!html.trim()) continue;
      const end = Helpers.endTime(e);
      pages.push({
        url: e.request.url,
        title: HarConverter.#title(html),
        capturedAt: Number.isFinite(end) ? new Date(end).toISOString() : e.startedAt,
        html,
      });
    }
    return pages;
  }

  static #title(html: string): string {
    try {
      return load(html)('title').first().text().replace(/[\t\n\f\r ]+/g, ' ').trim();
    } catch {
      return '';
    }
  }

  static #isSocket(raw: Record<string, unknown>): boolean {
    const type = typeof raw._resourceType === 'string' ? raw._resourceType.toLowerCase() : '';
    const url = (raw.request as Record<string, unknown>).url as string;
    const status = Json.isPlainObject(raw.response) ? raw.response.status : undefined;
    return type === 'websocket' || Array.isArray(raw._webSocketMessages) || /^wss?:/i.test(url) || status === 101;
  }

  static #socketUrl(url: string): string {
    return url.replace(/^http(s?):/i, (_m, s: string) => `ws${s.toLowerCase()}:`);
  }

  static #headers(value: unknown): Header[] {
    if (!Array.isArray(value)) return [];
    const out: Header[] = [];
    for (const h of value as unknown[]) {
      if (Json.isPlainObject(h) && typeof h.name === 'string') out.push({ name: h.name, value: typeof h.value === 'string' ? h.value : String(h.value ?? '') });
    }
    return out;
  }

  static #copyHeaders(headers: Header[]): { name: string; value: string }[] {
    return headers.map((h) => ({ name: h.name, value: h.value }));
  }

  static #query(url: string): { name: string; value: string }[] {
    try {
      return Http.queryPairs(url).map(([name, value]) => ({ name, value }));
    } catch {
      return [];
    }
  }

  static #method(value: unknown): string {
    if (typeof value !== 'string' || !value) return 'GET';
    const upper = value.toUpperCase();
    return HarConverter.NORMALIZED_METHODS.has(upper) ? upper : value;
  }

  static #startedAt(value: unknown, index: number): string {
    const ms = typeof value === 'string' ? Date.parse(value) : Number.NaN;
    if (Number.isNaN(ms)) throw new AppiiError('BAD_INPUT', `HAR entry ${index} has an invalid startedDateTime`);
    return new Date(ms).toISOString();
  }

  static #duration(raw: Record<string, unknown>): number {
    if (typeof raw.time === 'number' && Number.isFinite(raw.time) && raw.time >= 0) return raw.time;
    const timings = raw.timings;
    if (!Json.isPlainObject(timings)) return 0;
    let total = 0;
    for (const value of Object.values(timings)) if (typeof value === 'number' && Number.isFinite(value) && value > 0) total += value;
    return total;
  }

  static #dateOr(value: unknown, fallback: string): string {
    return typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? value : fallback;
  }

  static #serverIp(remote: string): string {
    if (remote.startsWith('[')) return remote.slice(1, remote.indexOf(']') > 0 ? remote.indexOf(']') : undefined);
    const colons = remote.split(':').length - 1;
    return colons === 1 ? remote.slice(0, remote.indexOf(':')) : remote;
  }

  static #order(start: number): number {
    return Number.isFinite(start) ? start : Number.MAX_SAFE_INTEGER;
  }

  static #iso(ms: number): string {
    return new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
  }

  static #parse(text: string): unknown {
    const parsed = Json.safeParse(Text.stripBom(text));
    if (!parsed.ok) throw new AppiiError('BAD_INPUT', `HAR is not valid JSON: ${parsed.error}`);
    return parsed.value;
  }
}
