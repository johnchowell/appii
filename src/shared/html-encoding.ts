import { CharsetEncoder } from './charset.js';

interface PrescanAttribute {
  readonly name: string;
  readonly value: string;
  readonly next: number;
}

export class HtmlEncodingSniffer {
  static readonly PRESCAN_BYTES = 1024;
  static readonly DEFAULT = CharsetEncoder.UNLABELED_DOCUMENT;
  static readonly USER_DEFINED = 'x-user-defined';
  static readonly UTF16: ReadonlySet<string> = new Set([CharsetEncoder.UTF16BE, CharsetEncoder.UTF16LE]);
  static readonly LT = 0x3c;
  static readonly GT = 0x3e;
  static readonly SLASH = 0x2f;
  static readonly BANG = 0x21;
  static readonly QUESTION = 0x3f;
  static readonly EQUALS = 0x3d;
  static readonly DQUOTE = 0x22;
  static readonly SQUOTE = 0x27;
  static readonly SPACES: ReadonlySet<number> = new Set([0x09, 0x0a, 0x0c, 0x0d, 0x20]);
  static readonly COMMENT_OPEN = '<!--';
  static readonly COMMENT_CLOSE = '-->';
  static readonly META = '<meta';
  static readonly CONTENT_CHARSET: RegExp = /charset[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r ;"']+))/i;

  static sniff(bytes: Uint8Array, transport?: string): string {
    return CharsetEncoder.bom(bytes) ?? HtmlEncodingSniffer.#known(transport) ?? HtmlEncodingSniffer.prescan(bytes) ?? HtmlEncodingSniffer.DEFAULT;
  }

  static prescan(bytes: Uint8Array): string | undefined {
    const end = Math.min(bytes.length, HtmlEncodingSniffer.PRESCAN_BYTES);
    const text = Buffer.from(bytes.subarray(0, end)).toString('latin1');
    const lower = text.toLowerCase();
    for (let position = 0; position < end; position++) {
      if (lower.startsWith(HtmlEncodingSniffer.COMMENT_OPEN, position)) {
        const close = lower.indexOf(HtmlEncodingSniffer.COMMENT_CLOSE, position + 2);
        if (close < 0) return undefined;
        position = close + 2;
        continue;
      }
      if (lower.startsWith(HtmlEncodingSniffer.META, position) && HtmlEncodingSniffer.#endsName(text.charCodeAt(position + HtmlEncodingSniffer.META.length))) {
        const found = HtmlEncodingSniffer.#meta(text, position + HtmlEncodingSniffer.META.length);
        if (found.charset !== undefined) return found.charset;
        position = found.next;
        continue;
      }
      const code = text.charCodeAt(position);
      if (code !== HtmlEncodingSniffer.LT) continue;
      const next = text.charCodeAt(position + 1);
      const tag = HtmlEncodingSniffer.#letter(next) || (next === HtmlEncodingSniffer.SLASH && HtmlEncodingSniffer.#letter(text.charCodeAt(position + 2)));
      if (tag) {
        position = HtmlEncodingSniffer.#skipTag(text, position + 1);
        continue;
      }
      if (next === HtmlEncodingSniffer.BANG || next === HtmlEncodingSniffer.SLASH || next === HtmlEncodingSniffer.QUESTION) {
        const close = text.indexOf('>', position + 1);
        if (close < 0) return undefined;
        position = close;
      }
    }
    return undefined;
  }

  static #meta(text: string, start: number): { charset: string | undefined; next: number } {
    const seen = new Set<string>();
    let gotPragma = false;
    let needPragma: boolean | undefined;
    let charset: string | undefined;
    let position = start;
    for (let attribute = HtmlEncodingSniffer.#attribute(text, position); attribute; attribute = HtmlEncodingSniffer.#attribute(text, position)) {
      position = attribute.next;
      if (seen.has(attribute.name)) continue;
      seen.add(attribute.name);
      if (attribute.name === 'http-equiv' && attribute.value === 'content-type') gotPragma = true;
      else if (attribute.name === 'content' && charset === undefined) {
        const m = HtmlEncodingSniffer.CONTENT_CHARSET.exec(attribute.value);
        const label = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
        if (label !== undefined) {
          charset = CharsetEncoder.canonical(label);
          if (charset !== undefined) needPragma = true;
        }
      } else if (attribute.name === 'charset') {
        charset = CharsetEncoder.canonical(attribute.value);
        needPragma = false;
      }
    }
    if (needPragma === undefined || (needPragma && !gotPragma) || charset === undefined) return { charset: undefined, next: position };
    if (HtmlEncodingSniffer.UTF16.has(charset)) return { charset: CharsetEncoder.UTF8, next: position };
    if (charset === HtmlEncodingSniffer.USER_DEFINED) return { charset: CharsetEncoder.UNLABELED_DOCUMENT, next: position };
    return { charset, next: position };
  }

  static #skipTag(text: string, start: number): number {
    let position = start;
    while (position < text.length && !HtmlEncodingSniffer.SPACES.has(text.charCodeAt(position)) && text.charCodeAt(position) !== HtmlEncodingSniffer.GT) position++;
    for (let attribute = HtmlEncodingSniffer.#attribute(text, position); attribute; attribute = HtmlEncodingSniffer.#attribute(text, position)) position = attribute.next;
    return position;
  }

  static #attribute(text: string, start: number): PrescanAttribute | undefined {
    let position = start;
    while (position < text.length && (HtmlEncodingSniffer.SPACES.has(text.charCodeAt(position)) || text.charCodeAt(position) === HtmlEncodingSniffer.SLASH)) position++;
    if (position >= text.length || text.charCodeAt(position) === HtmlEncodingSniffer.GT) return undefined;
    let name = '';
    for (;;) {
      if (position >= text.length) return undefined;
      const code = text.charCodeAt(position);
      if (code === HtmlEncodingSniffer.EQUALS && name !== '') {
        position++;
        break;
      }
      if (HtmlEncodingSniffer.SPACES.has(code)) {
        while (position < text.length && HtmlEncodingSniffer.SPACES.has(text.charCodeAt(position))) position++;
        if (text.charCodeAt(position) !== HtmlEncodingSniffer.EQUALS) return { name, value: '', next: position };
        position++;
        break;
      }
      if (code === HtmlEncodingSniffer.SLASH || code === HtmlEncodingSniffer.GT) return { name, value: '', next: position };
      name += text.charAt(position).toLowerCase();
      position++;
    }
    while (position < text.length && HtmlEncodingSniffer.SPACES.has(text.charCodeAt(position))) position++;
    if (position >= text.length) return undefined;
    const quote = text.charCodeAt(position);
    if (quote === HtmlEncodingSniffer.DQUOTE || quote === HtmlEncodingSniffer.SQUOTE) {
      const close = text.indexOf(text.charAt(position), position + 1);
      if (close < 0) return undefined;
      return { name, value: text.slice(position + 1, close).toLowerCase(), next: close + 1 };
    }
    if (quote === HtmlEncodingSniffer.GT) return { name, value: '', next: position };
    let value = '';
    while (position < text.length && !HtmlEncodingSniffer.SPACES.has(text.charCodeAt(position)) && text.charCodeAt(position) !== HtmlEncodingSniffer.GT) {
      value += text.charAt(position).toLowerCase();
      position++;
    }
    return position < text.length ? { name, value, next: position } : undefined;
  }

  static #endsName(code: number): boolean {
    return HtmlEncodingSniffer.SPACES.has(code) || code === HtmlEncodingSniffer.SLASH;
  }

  static #letter(code: number): boolean {
    return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
  }

  static #known(label: string | undefined): string | undefined {
    return label === undefined ? undefined : CharsetEncoder.canonical(label);
  }
}
