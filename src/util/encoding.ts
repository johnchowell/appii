import { randomBytes } from 'node:crypto';
import type { FileValue, FormDataEntry } from '../types.js';

export type RequestBody =
  | string
  | Uint8Array
  | { json: unknown }
  | { form: Record<string, string | string[]> | [string, string][] }
  | { multipart: FormDataEntry[] }
  | { raw: string | Uint8Array; contentType: string };

export function normalizeNewlines(value: string): string {
  return value.replace(/\r\n|\r|\n/g, '\r\n');
}

export function isFileValue(value: unknown): value is FileValue {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as FileValue).filename === 'string' &&
    typeof (value as FileValue).dataBase64 === 'string'
  );
}

export function entriesToPairs(entries: FormDataEntry[]): [string, string][] {
  return entries.map((e) => [
    normalizeNewlines(e.name),
    typeof e.value === 'string' ? normalizeNewlines(e.value) : e.value.filename,
  ]);
}

const URLENCODED_SAFE = /[*\-._0-9A-Za-z]/;

function urlencodeComponent(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = '';
  for (const b of bytes) {
    const ch = String.fromCharCode(b);
    if (b === 0x20) out += '+';
    else if (b < 0x80 && URLENCODED_SAFE.test(ch)) out += ch;
    else out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

export function urlencodePairs(pairs: [string, string][]): string {
  return pairs.map(([n, v]) => `${urlencodeComponent(n)}=${urlencodeComponent(v)}`).join('&');
}

export function urlencodeEntries(entries: FormDataEntry[]): string {
  return urlencodePairs(entriesToPairs(entries));
}

export function encodeTextPlain(entries: FormDataEntry[]): string {
  return entriesToPairs(entries)
    .map(([n, v]) => `${n}=${v}\r\n`)
    .join('');
}

function escapeMultipartName(value: string): string {
  return value.replace(/\n/g, '%0A').replace(/\r/g, '%0D').replace(/"/g, '%22');
}

export function newBoundary(): string {
  return '----appiiFormBoundary' + randomBytes(12).toString('base64url');
}

export function encodeMultipart(
  entries: FormDataEntry[],
  boundary: string = newBoundary(),
): { body: Uint8Array<ArrayBuffer>; contentType: string; boundary: string } {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const entry of entries) {
    const name = escapeMultipartName(normalizeNewlines(entry.name));
    chunks.push(enc.encode(`--${boundary}\r\n`));
    if (typeof entry.value === 'string') {
      chunks.push(enc.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
      chunks.push(enc.encode(normalizeNewlines(entry.value)));
    } else {
      const file = entry.value;
      const filename = escapeMultipartName(file.filename);
      const type = file.contentType || 'application/octet-stream';
      chunks.push(enc.encode(`Content-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${type}\r\n\r\n`));
      chunks.push(new Uint8Array(Buffer.from(file.dataBase64, 'base64')));
    }
    chunks.push(enc.encode('\r\n'));
  }
  chunks.push(enc.encode(`--${boundary}--\r\n`));
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    body.set(c, offset);
    offset += c.length;
  }
  return { body, contentType: `multipart/form-data; boundary=${boundary}`, boundary };
}

export function encodeRequestBody(body: RequestBody | undefined): { bytes?: Uint8Array<ArrayBuffer>; contentType?: string } {
  if (body === undefined) return {};
  if (typeof body === 'string') return { bytes: new TextEncoder().encode(body), contentType: 'text/plain;charset=UTF-8' };
  if (body instanceof Uint8Array) return { bytes: new Uint8Array(body) };
  if ('json' in body) return { bytes: new TextEncoder().encode(JSON.stringify(body.json)), contentType: 'application/json' };
  if ('form' in body) {
    const pairs: [string, string][] = Array.isArray(body.form)
      ? body.form.map(([n, v]) => [n, v])
      : Object.entries(body.form).flatMap(([n, v]) => (Array.isArray(v) ? v.map((x): [string, string] => [n, x]) : [[n, v] as [string, string]]));
    return {
      bytes: new TextEncoder().encode(urlencodePairs(pairs.map(([n, v]) => [normalizeNewlines(n), normalizeNewlines(v)]))),
      contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
    };
  }
  if ('multipart' in body) {
    const m = encodeMultipart(body.multipart);
    return { bytes: m.body, contentType: m.contentType };
  }
  const raw = typeof body.raw === 'string' ? new TextEncoder().encode(body.raw) : new Uint8Array(body.raw);
  return { bytes: raw, contentType: body.contentType };
}
