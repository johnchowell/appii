import { SingleByteIndexes } from './single-byte-indexes.js';

export interface CharsetDecodeOptions {
  fatal?: boolean;
  stream?: boolean;
}

export class CharsetEncoder {
  static readonly UTF8 = 'utf-8';
  static readonly UTF16BE = 'utf-16be';
  static readonly UTF16LE = 'utf-16le';
  static readonly BOM_CODE_POINT = 0xfeff;
  static readonly UNLABELED_DOCUMENT = 'windows-1252';
  static readonly UTF8_OUTPUT: ReadonlySet<string> = new Set(['utf-8', 'utf-16le', 'utf-16be', 'replacement']);
  static readonly SINGLE_BYTE: ReadonlySet<string> = new Set(SingleByteIndexes.names());
  static readonly FIRST_HIGH_BYTE = 0x80;
  static readonly HIGH_BYTES = 0x80;
  static readonly DECODE_CHUNK = 0x2000;
  static readonly REPLACEMENT = '\ufffd';
  static readonly FORM_SAFE_BYTE: RegExp = /^[*\-._0-9A-Za-z]$/;
  static readonly SPACE = 0x20;
  static readonly WINDOWS_1252 = 'windows-1252';
  static readonly WINDOWS_1252_HIGH: readonly number[] = Object.freeze((SingleByteIndexes.codePoints('windows-1252') ?? []).map((cp) => cp ?? 0xfffd));

  readonly name: string;
  readonly exact: boolean;
  readonly #table: ReadonlyMap<number, number> | undefined;

  private constructor(name: string, exact: boolean, table: ReadonlyMap<number, number> | undefined) {
    this.name = name;
    this.exact = exact;
    this.#table = table;
  }

  static for(label: string | undefined): CharsetEncoder {
    const name = label === undefined ? CharsetEncoder.UTF8 : CharsetEncoder.canonical(label);
    if (name === undefined || CharsetEncoder.UTF8_OUTPUT.has(name)) return new CharsetEncoder(CharsetEncoder.UTF8, name !== undefined, undefined);
    if (!CharsetEncoder.SINGLE_BYTE.has(name)) return new CharsetEncoder(name, false, undefined);
    const table = CharsetEncoder.singleByteTable(name);
    return table === undefined ? new CharsetEncoder(name, false, undefined) : new CharsetEncoder(name, true, table);
  }

  static bom(bytes: Uint8Array): string | undefined {
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return CharsetEncoder.UTF8;
    if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return CharsetEncoder.UTF16BE;
    if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return CharsetEncoder.UTF16LE;
    return undefined;
  }

  static textBom(text: string): string | undefined {
    return text.charCodeAt(0) === CharsetEncoder.BOM_CODE_POINT ? CharsetEncoder.UTF8 : undefined;
  }

  static canonical(label: string | undefined): string | undefined {
    if (label === undefined) return undefined;
    const single = SingleByteIndexes.encoding(label);
    if (single !== undefined) return single;
    try {
      return new TextDecoder(label.trim()).encoding;
    } catch {
      return undefined;
    }
  }

  static singleByteTable(name: string): ReadonlyMap<number, number> | undefined {
    const points = SingleByteIndexes.codePoints(name);
    if (points === undefined) return undefined;
    const table = new Map<number, number>();
    points.forEach((cp, i) => {
      if (cp !== undefined && !table.has(cp)) table.set(cp, CharsetEncoder.FIRST_HIGH_BYTE + i);
    });
    return table;
  }

  static decode(bytes: Uint8Array, label: string, options: CharsetDecodeOptions = {}): string {
    const name = CharsetEncoder.canonical(label);
    if (name === undefined) throw new RangeError(`The encoding label ${JSON.stringify(label)} is not known`);
    const points = SingleByteIndexes.codePoints(name);
    if (points === undefined) return new TextDecoder(name, { fatal: options.fatal === true }).decode(bytes, { stream: options.stream === true });
    const units: number[] = [];
    let out = '';
    for (const byte of bytes) {
      if (byte < CharsetEncoder.FIRST_HIGH_BYTE) units.push(byte);
      else {
        const cp = points[byte - CharsetEncoder.FIRST_HIGH_BYTE];
        if (cp === undefined && options.fatal === true) throw new TypeError(`The ${name} index has no code point for byte 0x${byte.toString(16)}`);
        units.push(cp ?? CharsetEncoder.REPLACEMENT.charCodeAt(0));
      }
      if (units.length >= CharsetEncoder.DECODE_CHUNK) out += String.fromCharCode(...units.splice(0));
    }
    return out + String.fromCharCode(...units);
  }

  get utf8(): boolean {
    return this.name === CharsetEncoder.UTF8;
  }

  encode(text: string): Uint8Array {
    const table = this.#table;
    if (table === undefined) return new TextEncoder().encode(text);
    const bytes: number[] = [];
    for (const ch of text) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp < CharsetEncoder.FIRST_HIGH_BYTE) bytes.push(cp);
      else {
        const byte = table.get(cp);
        if (byte !== undefined) bytes.push(byte);
        else for (const unit of `&#${cp};`) bytes.push(unit.charCodeAt(0));
      }
    }
    return Uint8Array.from(bytes);
  }

  formComponent(text: string): string {
    let out = '';
    for (const byte of this.encode(text)) {
      const ch = String.fromCharCode(byte);
      if (byte === CharsetEncoder.SPACE) out += '+';
      else if (CharsetEncoder.FORM_SAFE_BYTE.test(ch)) out += ch;
      else out += '%' + byte.toString(16).toUpperCase().padStart(2, '0');
    }
    return out;
  }
}
