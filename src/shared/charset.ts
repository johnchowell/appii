export class CharsetEncoder {
  static readonly UTF8 = 'utf-8';
  static readonly UTF8_OUTPUT: ReadonlySet<string> = new Set(['utf-8', 'utf-16le', 'utf-16be', 'replacement']);
  static readonly SINGLE_BYTE: ReadonlySet<string> = new Set([
    'ibm866', 'iso-8859-2', 'iso-8859-3', 'iso-8859-4', 'iso-8859-5', 'iso-8859-6', 'iso-8859-7', 'iso-8859-8', 'iso-8859-8-i',
    'iso-8859-10', 'iso-8859-13', 'iso-8859-14', 'iso-8859-15', 'iso-8859-16', 'koi8-r', 'koi8-u', 'macintosh', 'windows-874',
    'windows-1250', 'windows-1251', 'windows-1252', 'windows-1253', 'windows-1254', 'windows-1255', 'windows-1256', 'windows-1257',
    'windows-1258', 'x-mac-cyrillic',
  ]);
  static readonly FIRST_HIGH_BYTE = 0x80;
  static readonly HIGH_BYTES = 0x80;
  static readonly REPLACEMENT = '\ufffd';
  static readonly FORM_SAFE_BYTE: RegExp = /^[*\-._0-9A-Za-z]$/;
  static readonly SPACE = 0x20;
  static readonly WINDOWS_1252 = 'windows-1252';
  static readonly WINDOWS_1252_HIGH: readonly number[] = Object.freeze([
    0x20ac, 0x0081, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x008d, 0x017d, 0x008f,
    0x0090, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x009d, 0x017e, 0x0178,
    ...Array.from({ length: 0x60 }, (_, i) => 0xa0 + i),
  ]);

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

  static canonical(label: string | undefined): string | undefined {
    if (label === undefined) return undefined;
    try {
      return new TextDecoder(label.trim()).encoding;
    } catch {
      return undefined;
    }
  }

  static singleByteTable(name: string): ReadonlyMap<number, number> | undefined {
    const decoded = name === CharsetEncoder.WINDOWS_1252 ? String.fromCharCode(...CharsetEncoder.WINDOWS_1252_HIGH) : CharsetEncoder.#decodeHighBytes(name);
    if (decoded === undefined || decoded.length !== CharsetEncoder.HIGH_BYTES) return undefined;
    const table = new Map<number, number>();
    for (let i = 0; i < decoded.length; i++) {
      const ch = decoded.charAt(i);
      if (ch !== CharsetEncoder.REPLACEMENT && !table.has(ch.charCodeAt(0))) table.set(ch.charCodeAt(0), CharsetEncoder.FIRST_HIGH_BYTE + i);
    }
    return table;
  }

  static #decodeHighBytes(name: string): string | undefined {
    try {
      return new TextDecoder(name).decode(Uint8Array.from({ length: CharsetEncoder.HIGH_BYTES }, (_, i) => CharsetEncoder.FIRST_HIGH_BYTE + i));
    } catch {
      return undefined;
    }
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
