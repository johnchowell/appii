import { randomUUID } from 'node:crypto';
import { getDomain } from 'tldts';
import type { BodyData, Header } from '../model/index.js';

export function newId(prefix = ''): string {
  return prefix + randomUUID();
}

export function getHeader(headers: Header[], name: string): string | undefined {
  const lower = name.toLowerCase();
  const found = headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value);
  if (found.length === 0) return undefined;
  return lower === 'set-cookie' ? found.join('\n') : found.join(', ');
}

export function getHeaderAll(headers: Header[], name: string): string[] {
  const lower = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() === lower).map((h) => h.value);
}

export function setHeader(headers: Header[], name: string, value: string): Header[] {
  const lower = name.toLowerCase();
  return [...headers.filter((h) => h.name.toLowerCase() !== lower), { name, value }];
}

export function removeHeader(headers: Header[], name: string): Header[] {
  const lower = name.toLowerCase();
  return headers.filter((h) => h.name.toLowerCase() !== lower);
}

export function headersToRecord(headers: Header[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of headers) {
    const key = h.name.toLowerCase();
    const prev = out[key];
    out[key] = prev === undefined ? h.value : prev + (key === 'set-cookie' ? '\n' : ', ') + h.value;
  }
  return out;
}

export function recordToHeaders(record: Record<string, string | string[] | number | undefined> | Header[] | undefined): Header[] {
  if (!record) return [];
  if (Array.isArray(record)) return record.map((h) => ({ name: h.name, value: h.value }));
  const out: Header[] = [];
  for (const [name, value] of Object.entries(record)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const v of value) out.push({ name, value: v });
    else out.push({ name, value: String(value) });
  }
  return out;
}

export function mimeEssence(contentType: string | undefined | null): string {
  if (!contentType) return '';
  return (contentType.split(';')[0] ?? '').trim().toLowerCase();
}

export function charsetOf(contentType: string | undefined | null): string | undefined {
  if (!contentType) return undefined;
  const m = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  return m?.[1]?.toLowerCase();
}

export function isJsonMime(mime: string): boolean {
  const m = mimeEssence(mime);
  return m === 'application/json' || m.endsWith('+json') || m === 'text/json' || m === 'application/x-ndjson';
}

export function isTextMime(mime: string): boolean {
  const m = mimeEssence(mime);
  if (!m) return false;
  if (m.startsWith('text/')) return true;
  if (isJsonMime(m)) return true;
  if (m.endsWith('+xml') || m === 'application/xml') return true;
  return [
    'application/javascript',
    'application/ecmascript',
    'application/x-javascript',
    'application/x-www-form-urlencoded',
    'application/graphql',
    'application/x-yaml',
    'application/yaml',
    'image/svg+xml',
  ].includes(m);
}

function looksLikeUtf8Text(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, 4096);
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(sample.length < bytes.length ? trimPartialUtf8(sample) : sample);
  } catch {
    return false;
  }
  for (const b of sample) if (b === 0) return false;
  return true;
}

function trimPartialUtf8(bytes: Uint8Array): Uint8Array {
  let end = bytes.length;
  for (let i = 1; i <= 3 && end - i >= 0; i++) {
    const b = bytes[end - i]!;
    if ((b & 0xc0) === 0x80) continue;
    const need = b >= 0xf0 ? 4 : b >= 0xe0 ? 3 : b >= 0xc0 ? 2 : 1;
    if (need > i) end = end - i;
    break;
  }
  return bytes.subarray(0, end);
}

export function toBodyData(bytes: Uint8Array, contentType: string | undefined | null, maxBytes = Number.POSITIVE_INFINITY): BodyData {
  const mimeType = contentType ?? '';
  const truncated = bytes.length > maxBytes;
  const kept = truncated ? bytes.subarray(0, maxBytes) : bytes;
  const text = isTextMime(mimeType) || (!mimeEssence(mimeType) && looksLikeUtf8Text(kept));
  const body: BodyData = text
    ? { mimeType, encoding: 'utf8', data: new TextDecoder('utf-8').decode(truncated ? trimPartialUtf8(kept) : kept), size: bytes.length }
    : { mimeType, encoding: 'base64', data: Buffer.from(kept).toString('base64'), size: bytes.length };
  if (truncated) body.truncated = true;
  return body;
}

export function bodyBytes(body: BodyData | undefined): Uint8Array {
  if (!body) return new Uint8Array();
  return body.encoding === 'base64' ? new Uint8Array(Buffer.from(body.data, 'base64')) : new TextEncoder().encode(body.data);
}

export function bodyText(body: BodyData | undefined): string {
  if (!body) return '';
  return body.encoding === 'utf8' ? body.data : Buffer.from(body.data, 'base64').toString('utf8');
}

export function bodyJson(body: BodyData | undefined): unknown {
  if (!body || body.truncated) return undefined;
  const text = bodyText(body).trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export function originOf(url: string): string {
  return new URL(url).origin;
}

export function registrableDomain(host: string): string {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return getDomain(h, { allowPrivateDomains: true }) ?? h;
}

export function isSameSite(a: string, b: string): boolean {
  const ua = new URL(a);
  const ub = new URL(b);
  return ua.protocol === ub.protocol && registrableDomain(ua.hostname) === registrableDomain(ub.hostname);
}

const STATUS_TEXT: Record<number, string> = {
  100: 'Continue',
  101: 'Switching Protocols',
  200: 'OK',
  201: 'Created',
  202: 'Accepted',
  203: 'Non-Authoritative Information',
  204: 'No Content',
  205: 'Reset Content',
  206: 'Partial Content',
  207: 'Multi-Status',
  300: 'Multiple Choices',
  301: 'Moved Permanently',
  302: 'Found',
  303: 'See Other',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  402: 'Payment Required',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  406: 'Not Acceptable',
  408: 'Request Timeout',
  409: 'Conflict',
  410: 'Gone',
  411: 'Length Required',
  412: 'Precondition Failed',
  413: 'Content Too Large',
  414: 'URI Too Long',
  415: 'Unsupported Media Type',
  416: 'Range Not Satisfiable',
  417: 'Expectation Failed',
  418: "I'm a teapot",
  419: 'Page Expired',
  421: 'Misdirected Request',
  422: 'Unprocessable Content',
  423: 'Locked',
  425: 'Too Early',
  426: 'Upgrade Required',
  428: 'Precondition Required',
  429: 'Too Many Requests',
  431: 'Request Header Fields Too Large',
  451: 'Unavailable For Legal Reasons',
  500: 'Internal Server Error',
  501: 'Not Implemented',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
  505: 'HTTP Version Not Supported',
};

export function reasonPhrase(status: number): string {
  const known = STATUS_TEXT[status];
  if (known) return known;
  if (status >= 100 && status < 200) return 'Informational';
  if (status >= 200 && status < 300) return 'Success';
  if (status >= 300 && status < 400) return 'Redirection';
  if (status >= 400 && status < 500) return 'Client Error';
  if (status >= 500 && status < 600) return 'Server Error';
  return 'Unknown';
}

export function queryPairs(url: string): [string, string][] {
  return [...new URL(url).searchParams.entries()];
}

export function pathOf(url: string): string {
  return new URL(url).pathname;
}

export function parseCookieHeader(header: string | undefined): { name: string; value: string }[] {
  if (!header) return [];
  const out: { name: string; value: string }[] = [];
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) out.push({ name: '', value: trimmed });
    else out.push({ name: trimmed.slice(0, eq).trim(), value: trimmed.slice(eq + 1).trim() });
  }
  return out;
}

export const SAFE_METHODS: readonly string[] = ['GET', 'HEAD', 'OPTIONS', 'TRACE'];

export function isSafeMethod(method: string): boolean {
  return SAFE_METHODS.includes(method.toUpperCase());
}
