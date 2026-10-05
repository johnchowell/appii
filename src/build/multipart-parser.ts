import type { Header } from '../model/index.js';
import { Http } from '../shared/index.js';

export interface MultipartPart {
  headers: Header[];
  name?: string;
  filename?: string;
  contentType?: string;
  data: Uint8Array;
  complete: boolean;
}

export interface ContentDisposition {
  type: string;
  params: Map<string, string>;
}

export class MultipartParser {
  static readonly CRLF: Buffer = Buffer.from('\r\n', 'latin1');
  static readonly HEADER_END: Buffer = Buffer.from('\r\n\r\n', 'latin1');
  static readonly NAME_ESCAPES: Readonly<Record<string, string>> = { '%0A': '\n', '%0D': '\r', '%22': '"' };
  static readonly MAX_BOUNDARY_LENGTH = 200;

  static boundary(contentType: string | undefined): string | undefined {
    if (!contentType) return undefined;
    const value = MultipartParser.parameters(contentType, true).get('boundary');
    return value ? value : undefined;
  }

  static sniffBoundary(bytes: Uint8Array): string | undefined {
    const data = MultipartParser.#buffer(bytes);
    if (data[0] !== 0x2d || data[1] !== 0x2d) return undefined;
    const end = data.indexOf(MultipartParser.CRLF);
    if (end < 3 || end > MultipartParser.MAX_BOUNDARY_LENGTH + 2) return undefined;
    const boundary = data.subarray(2, end).toString('latin1').replace(/[ \t]+$/, '');
    return /^[\x21-\x7e][\x20-\x7e]*$/.test(boundary) ? boundary : undefined;
  }

  static parameters(value: string, backslashEscapes: boolean): Map<string, string> {
    const out = new Map<string, string>();
    const n = value.length;
    let i = value.indexOf(';');
    if (i < 0) return out;
    i++;
    while (i < n) {
      while (i < n && (value[i] === ' ' || value[i] === '\t' || value[i] === ';')) i++;
      let j = i;
      while (j < n && value[j] !== '=' && value[j] !== ';') j++;
      const name = value.slice(i, j).trim().toLowerCase();
      if (j >= n || value[j] === ';') {
        i = j;
        continue;
      }
      j++;
      while (j < n && (value[j] === ' ' || value[j] === '\t')) j++;
      let parsed = '';
      if (value[j] === '"') {
        j++;
        while (j < n && value[j] !== '"') {
          if (backslashEscapes && value[j] === '\\' && j + 1 < n) {
            parsed += value[j + 1];
            j += 2;
            continue;
          }
          parsed += value[j];
          j++;
        }
        while (j < n && value[j] !== ';') j++;
      } else {
        const start = j;
        while (j < n && value[j] !== ';') j++;
        parsed = value.slice(start, j).trim();
      }
      if (name !== '' && !out.has(name)) out.set(name, parsed);
      i = j;
    }
    return out;
  }

  static disposition(value: string): ContentDisposition {
    const type = (value.split(';')[0] ?? '').trim().toLowerCase();
    const params = MultipartParser.parameters(value, false);
    for (const key of ['name', 'filename']) {
      const raw = params.get(key);
      if (raw !== undefined) params.set(key, MultipartParser.decodeName(raw));
    }
    return { type, params };
  }

  static decodeName(value: string): string {
    return value.replace(/%0A|%0D|%22/g, (escape) => MultipartParser.NAME_ESCAPES[escape] ?? escape);
  }

  parse(bytes: Uint8Array, boundary: string): MultipartPart[] {
    const data = MultipartParser.#buffer(bytes);
    const delimiter = Buffer.from('--' + boundary, 'utf8');
    const separator = Buffer.concat([MultipartParser.CRLF, delimiter]);
    let position = MultipartParser.#firstDelimiter(data, delimiter);
    const parts: MultipartPart[] = [];
    while (position >= 0) {
      let cursor = position + delimiter.length;
      if (data[cursor] === 0x2d && data[cursor + 1] === 0x2d) break;
      while (cursor < data.length && (data[cursor] === 0x20 || data[cursor] === 0x09)) cursor++;
      if (data[cursor] === 0x0d && data[cursor + 1] === 0x0a) cursor += 2;
      else if (data[cursor] === 0x0a) cursor += 1;
      else break;
      const next = data.indexOf(separator, cursor);
      const part = MultipartParser.#part(data.subarray(cursor, next < 0 ? data.length : next), next >= 0);
      if (part) parts.push(part);
      position = next < 0 ? -1 : next + 2;
    }
    return parts;
  }

  static #buffer(bytes: Uint8Array): Buffer {
    return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  static #firstDelimiter(data: Buffer, delimiter: Buffer): number {
    let position = data.indexOf(delimiter);
    while (position > 0 && !(data[position - 2] === 0x0d && data[position - 1] === 0x0a)) {
      position = data.indexOf(delimiter, position + 1);
    }
    return position;
  }

  static #part(bytes: Buffer, complete: boolean): MultipartPart | undefined {
    let headerText: string;
    let body: Buffer;
    if (bytes[0] === 0x0d && bytes[1] === 0x0a) {
      headerText = '';
      body = bytes.subarray(2);
    } else {
      const end = bytes.indexOf(MultipartParser.HEADER_END);
      if (end < 0) return undefined;
      headerText = new TextDecoder('utf-8').decode(bytes.subarray(0, end));
      body = bytes.subarray(end + 4);
    }
    const headers = MultipartParser.#headers(headerText);
    const part: MultipartPart = { headers, data: new Uint8Array(body), complete };
    const disposition = Http.getHeader(headers, 'content-disposition');
    if (disposition !== undefined) {
      const parsed = MultipartParser.disposition(disposition);
      const name = parsed.params.get('name');
      const filename = parsed.params.get('filename');
      if (name !== undefined) part.name = name;
      if (filename !== undefined) part.filename = filename;
    }
    const contentType = Http.getHeader(headers, 'content-type');
    if (contentType !== undefined) part.contentType = contentType;
    return part;
  }

  static #headers(text: string): Header[] {
    const headers: Header[] = [];
    for (const line of text.split(/\r\n|\n/)) {
      if (line === '') continue;
      const last = headers[headers.length - 1];
      if ((line.startsWith(' ') || line.startsWith('\t')) && last) {
        last.value = `${last.value} ${line.trim()}`;
        continue;
      }
      const colon = line.indexOf(':');
      if (colon <= 0) continue;
      headers.push({ name: line.slice(0, colon).trim(), value: line.slice(colon + 1).trim() });
    }
    return headers;
  }
}
