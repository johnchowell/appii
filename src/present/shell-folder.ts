import { AppiiError } from '../shared/index.js';
import { TextLayout } from './text-layout.js';

export type ShellQuote = '' | "'" | '"';

export interface ShellUnit {
  text: string;
  quote: ShellQuote;
}

export interface ShellGroup {
  indent: number;
  words: ShellUnit[][];
  continued: boolean;
}

export interface ShellFolderOptions {
  indent?: number;
}

export class ShellFolder {
  static readonly DEFAULT_INDENT = 2;
  static readonly RESERVE = 2;
  static readonly MIN_BUDGET = 8;
  static readonly MIN_ROOM = 6;
  static readonly NAME: RegExp = /^[A-Za-z_][A-Za-z0-9_]*/;
  static readonly UNSUPPORTED_AFTER_DOLLAR: ReadonlySet<string> = new Set(['(', "'", '"']);
  static readonly ANSI_C_QUOTE = "$'";

  readonly #indent: number;

  constructor(options: ShellFolderOptions = {}) {
    const indent = options.indent ?? ShellFolder.DEFAULT_INDENT;
    if (!Number.isInteger(indent) || indent < 0) throw new AppiiError('BAD_INPUT', 'ShellFolder indent must be a non-negative integer', { details: { indent } });
    this.#indent = indent;
  }

  static parse(command: string): ShellGroup[] | undefined {
    const groups: ShellGroup[] = [];
    let group: ShellGroup = { indent: 0, words: [], continued: false };
    let word: ShellUnit[] | undefined;
    let lineStart = true;
    const endWord = (): void => {
      if (word) group.words.push(word);
      word = undefined;
    };
    const add = (text: string, quote: ShellQuote): void => {
      (word ??= []).push({ text, quote });
    };
    const endGroup = (continued: boolean): void => {
      endWord();
      group.continued = continued;
      groups.push(group);
      group = { indent: 0, words: [], continued: false };
      lineStart = true;
    };
    let i = 0;
    while (i < command.length) {
      const ch = command.charAt(i);
      if (ch === ' ' || ch === '\t') {
        if (lineStart) group.indent++;
        else endWord();
        i++;
        continue;
      }
      lineStart = false;
      if (ch === '\n') {
        endGroup(false);
        i++;
        continue;
      }
      if (ch === '\\') {
        const next = command.charAt(i + 1);
        if (next === '') return undefined;
        if (next === '\n') endGroup(true);
        else add(ch + next, '');
        i += 2;
        continue;
      }
      if (command.startsWith(ShellFolder.ANSI_C_QUOTE, i)) {
        const end = ShellFolder.#ansiCEnd(command, i + ShellFolder.ANSI_C_QUOTE.length);
        if (end < 0) return undefined;
        add(command.slice(i, end + 1), '');
        i = end + 1;
        continue;
      }
      if (ch === "'") {
        const end = command.indexOf("'", i + 1);
        if (end < 0) return undefined;
        const content = command.slice(i + 1, end);
        if (content === '') add('', "'");
        for (const c of content) add(c, "'");
        i = end + 1;
        continue;
      }
      if (ch === '"') {
        const start = word?.length ?? 0;
        let j = i + 1;
        for (;;) {
          if (j >= command.length) return undefined;
          const c = command.charAt(j);
          if (c === '"') break;
          const atom = ShellFolder.#atom(command, j);
          if (atom === undefined) return undefined;
          if (atom !== '\\\n') add(atom, '"');
          j += atom.length;
        }
        if ((word?.length ?? 0) === start) add('', '"');
        i = j + 1;
        continue;
      }
      if (ch === '#' && word === undefined) return undefined;
      const atom = ShellFolder.#atom(command, i);
      if (atom === undefined) return undefined;
      add(atom, '');
      i += atom.length;
    }
    endGroup(false);
    return groups;
  }

  static render(word: readonly ShellUnit[]): string {
    let out = '';
    let open: ShellQuote = '';
    for (const unit of word) {
      if (unit.quote !== open) out += open + unit.quote;
      open = unit.quote;
      out += unit.text;
    }
    return out + open;
  }

  fold(command: string, width: number): string[] {
    const max = TextLayout.checkWidth(width);
    const groups = ShellFolder.parse(command);
    if (!groups) return command.split('\n');
    const budget = max - ShellFolder.RESERVE;
    const out: string[] = [];
    for (const group of groups) {
      if (budget < ShellFolder.MIN_BUDGET) {
        out.push(' '.repeat(group.indent) + group.words.map((word) => ShellFolder.render(word)).join(' ') + (group.continued ? ' \\' : ''));
        continue;
      }
      this.#foldGroup(group, budget, out);
    }
    return out;
  }

  #foldGroup(group: ShellGroup, budget: number, out: string[]): void {
    const indent = ' '.repeat(Math.min(group.indent, Math.floor(budget / 2)));
    const continuation = ' '.repeat(Math.min(group.indent + this.#indent, Math.floor(budget / 2)));
    let line = indent;
    let hasWord = false;
    for (const word of group.words) {
      const text = ShellFolder.render(word);
      const whole = !text.includes('\n');
      const first = ShellFolder.#firstCost(word);
      if (hasWord) {
        if (whole && line.length + 1 + text.length <= budget) {
          line += ' ' + text;
          continue;
        }
        const fresh = whole && continuation.length + text.length <= budget;
        if (fresh || budget - line.length - 1 < Math.max(ShellFolder.MIN_ROOM, first)) {
          out.push(line + ' \\');
          line = continuation;
          hasWord = false;
        } else {
          line += ' ';
        }
      }
      if (!hasWord) {
        if (whole && line.length + text.length <= budget) {
          line += text;
          hasWord = true;
          continue;
        }
        if (line.length + first > budget) line = '';
      }
      line = ShellFolder.#place(word, line, budget, out);
      hasWord = true;
    }
    out.push(group.continued ? line + ' \\' : line);
  }

  static #place(word: readonly ShellUnit[], start: string, budget: number, out: string[]): string {
    let line = start;
    let open: ShellQuote = '';
    let placed = false;
    for (const unit of word) {
      if (unit.text === '\n' && unit.quote !== '') {
        if (unit.quote !== open) line += open + unit.quote;
        open = unit.quote;
        out.push(line);
        line = '';
        placed = false;
        continue;
      }
      const opening = unit.quote !== open ? open.length + unit.quote.length : 0;
      const closing = unit.quote === '' ? 0 : 1;
      if (placed && line.length + opening + unit.text.length + closing > budget) {
        out.push(line + open + '\\');
        line = '';
        open = '';
        placed = false;
      }
      if (unit.quote !== open) line += open + unit.quote;
      open = unit.quote;
      line += unit.text;
      placed = true;
    }
    return line + open;
  }

  static #closingBrace(source: string, from: number): number {
    let depth = 1;
    for (let i = from; i < source.length; i++) {
      const ch = source.charAt(i);
      if (ch === '\\') i++;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) return i;
    }
    return -1;
  }

  static #ansiCEnd(source: string, from: number): number {
    for (let i = from; i < source.length; i++) {
      const ch = source.charAt(i);
      if (ch === '\\') i++;
      else if (ch === "'") return i;
    }
    return -1;
  }

  static #firstCost(word: readonly ShellUnit[]): number {
    const unit = word[0];
    if (!unit) return 0;
    return unit.text.length + (unit.quote === '' ? 0 : 2);
  }

  static #atom(source: string, index: number): string | undefined {
    const ch = source.charAt(index);
    if (ch === '\\') {
      const next = source.charAt(index + 1);
      return next === '' ? undefined : ch + next;
    }
    if (ch === '$') {
      const next = source.charAt(index + 1);
      if (next === '{') {
        const close = ShellFolder.#closingBrace(source, index + 2);
        return close < 0 ? undefined : source.slice(index, close + 1);
      }
      if (ShellFolder.UNSUPPORTED_AFTER_DOLLAR.has(next)) return undefined;
      const name = ShellFolder.NAME.exec(source.slice(index + 1));
      if (name) return ch + name[0];
      return ch;
    }
    if (ch === '`') {
      const close = source.indexOf('`', index + 1);
      return close < 0 ? undefined : source.slice(index, close + 1);
    }
    return ch;
  }
}
