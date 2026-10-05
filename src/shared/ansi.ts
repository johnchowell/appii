const CODES = {
  bold: [1, 22],
  dim: [2, 22],
  red: [31, 39],
  green: [32, 39],
  yellow: [33, 39],
  blue: [34, 39],
  magenta: [35, 39],
  cyan: [36, 39],
  gray: [90, 39],
} as const;

export type AnsiStyle = keyof typeof CODES;

export const METHOD_COLORS: Readonly<Record<string, AnsiStyle>> = {
  GET: 'green',
  POST: 'yellow',
  PUT: 'blue',
  PATCH: 'magenta',
  DELETE: 'red',
};

const PATTERN = /\x1b\[[0-9;]*m/g;

export class Ansi {
  static readonly plain = new Ansi(false);
  static readonly color = new Ansi(true);

  constructor(readonly enabled: boolean) {}

  static strip(input: string): string {
    return input.replace(PATTERN, '');
  }

  static width(input: string): number {
    return Ansi.strip(input).length;
  }

  static truncate(input: string, max: number, ellipsis = '...'): string {
    if (Ansi.width(input) <= max) return input;
    if (max <= 0) return '';
    const keep = Math.max(0, max - ellipsis.length);
    let out = '';
    let visible = 0;
    let sawCode = false;
    PATTERN.lastIndex = 0;
    for (let i = 0; i < input.length; ) {
      PATTERN.lastIndex = i;
      const m = PATTERN.exec(input);
      if (m && m.index === i) {
        out += m[0];
        sawCode = true;
        i += m[0].length;
        continue;
      }
      if (visible >= keep) break;
      out += input[i];
      visible++;
      i++;
    }
    out += ellipsis.slice(0, max - visible);
    return sawCode ? out + '\x1b[0m' : out;
  }

  static padEnd(input: string, width: number): string {
    const w = Ansi.width(input);
    return w >= width ? input : input + ' '.repeat(width - w);
  }

  static padStart(input: string, width: number): string {
    const w = Ansi.width(input);
    return w >= width ? input : ' '.repeat(width - w) + input;
  }

  style(style: AnsiStyle, input: string): string {
    if (!this.enabled || input === '') return input;
    const [open, close] = CODES[style];
    return `\x1b[${open}m${input}\x1b[${close}m`;
  }

  bold(input: string): string {
    return this.style('bold', input);
  }

  dim(input: string): string {
    return this.style('dim', input);
  }

  red(input: string): string {
    return this.style('red', input);
  }

  green(input: string): string {
    return this.style('green', input);
  }

  yellow(input: string): string {
    return this.style('yellow', input);
  }

  blue(input: string): string {
    return this.style('blue', input);
  }

  magenta(input: string): string {
    return this.style('magenta', input);
  }

  cyan(input: string): string {
    return this.style('cyan', input);
  }

  gray(input: string): string {
    return this.style('gray', input);
  }

  method(method: string, text: string = method): string {
    return this.style(METHOD_COLORS[method.toUpperCase()] ?? 'cyan', text);
  }

  status(status: number, text: string = String(status)): string {
    if (status >= 500) return this.red(text);
    if (status >= 400) return this.yellow(text);
    if (status >= 300) return this.cyan(text);
    if (status >= 200) return this.green(text);
    return this.gray(text);
  }
}
