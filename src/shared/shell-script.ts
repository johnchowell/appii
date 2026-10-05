export type QuoteState = 'none' | 'single' | 'double';

export interface ShellChar {
  ch: string;
  state: QuoteState;
  escaped: boolean;
}

export class ShellScript {
  static readonly LINE_FEED = '\n';
  static readonly LAST_ASCII = 0x7e;
  static readonly FIRST_PRINTABLE = 0x20;

  static isLiteralSafe(ch: string): boolean {
    const cp = ch.codePointAt(0) ?? 0;
    return ch === ShellScript.LINE_FEED || (cp >= ShellScript.FIRST_PRINTABLE && cp <= ShellScript.LAST_ASCII);
  }

  static *scan(text: string): Generator<ShellChar> {
    let state: QuoteState = 'none';
    const chars = [...text];
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i] ?? '';
      if (state === 'single') {
        yield { ch, state, escaped: false };
        if (ch === "'") state = 'none';
        continue;
      }
      if (ch === '\\' && i + 1 < chars.length) {
        yield { ch, state, escaped: false };
        yield { ch: chars[i + 1] ?? '', state, escaped: true };
        i++;
        continue;
      }
      yield { ch, state, escaped: false };
      if (state === 'double' && ch === '"') state = 'none';
      else if (state === 'none' && ch === "'") state = 'single';
      else if (state === 'none' && ch === '"') state = 'double';
    }
  }

  static bytes(ch: string): string {
    return "$'" + [...Buffer.from(ch, 'utf8')].map((byte) => '\\' + byte.toString(8).padStart(3, '0')).join('') + "'";
  }

  static ascii(text: string): string {
    let out = '';
    for (const { ch, state, escaped } of ShellScript.scan(text)) {
      if (ShellScript.isLiteralSafe(ch)) {
        out += ch;
        continue;
      }
      if (escaped) out = state === 'double' ? out + '\\' : out.slice(0, -1);
      const encoded = ShellScript.bytes(ch);
      out += state === 'single' ? `'${encoded}'` : state === 'double' ? `"${encoded}"` : encoded;
    }
    return out;
  }

  static indent(text: string, spaces: number): string {
    const pad = ' '.repeat(spaces);
    let out = pad;
    for (const { ch, state } of ShellScript.scan(text)) {
      out += ch;
      if (ch === '\n' && state === 'none') out += pad;
    }
    return out;
  }
}
