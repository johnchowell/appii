import { Ansi, AppiiError, Text } from '../shared/index.js';

export interface FlowOptions {
  prefix?: string;
  separator?: string;
  indent?: number;
}

export interface DefinitionOptions {
  indent?: number;
  label?: (text: string) => string;
}

export type Definition = readonly [label: string, value: string];

export class TextLayout {
  static readonly MIN_VALUE_WIDTH = 12;

  static checkWidth(value: number, label = 'width'): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 1) {
      throw new AppiiError('BAD_INPUT', `The ${label} must be a positive number of columns (got ${String(value)})`, { details: { [label]: value } });
    }
    return Math.floor(value);
  }

  static clean(text: string): string {
    return Text.printable(text, { lineBreaks: 'space' });
  }

  static cleanBlock(text: string): string {
    return Text.printable(text, { lineBreaks: 'normalize' });
  }

  static fit(line: string, width: number): string {
    return Ansi.width(line) <= width ? line : Ansi.truncate(line, Math.max(0, width));
  }

  static wrap(text: string, width: number): string[] {
    const max = Math.max(1, Math.floor(width));
    const lines: string[] = [];
    let line = '';
    for (const word of text.split(' ')) {
      if (word === '') continue;
      if (line !== '' && line.length + 1 + word.length <= max) {
        line += ' ' + word;
        continue;
      }
      if (line !== '') lines.push(line);
      let rest = word;
      while (rest.length > max) {
        lines.push(rest.slice(0, max));
        rest = rest.slice(max);
      }
      line = rest;
    }
    if (line !== '' || lines.length === 0) lines.push(line);
    return lines;
  }

  static flow(items: readonly string[], width: number, options: FlowOptions = {}): string[] {
    const prefix = options.prefix ?? '';
    const separator = options.separator ?? '  ';
    const indentWidth = Math.max(0, Math.min(options.indent ?? Ansi.width(prefix), width - 1));
    const pad = ' '.repeat(indentWidth);
    const lines: string[] = [];
    let line = prefix;
    let empty = true;
    for (const item of items) {
      const gap = empty ? '' : separator;
      if (Ansi.width(line) + Ansi.width(gap) + Ansi.width(item) <= width) {
        line += gap + item;
        empty = false;
        continue;
      }
      if (!empty) {
        lines.push(line);
        line = pad;
      }
      const room = width - Ansi.width(line);
      line += Ansi.width(item) <= room ? item : Ansi.truncate(item, Math.max(0, room));
      empty = false;
    }
    lines.push(line);
    return lines.map((entry) => TextLayout.fit(entry, width));
  }

  static definitions(entries: readonly Definition[], width: number, options: DefinitionOptions = {}): string[] {
    if (entries.length === 0) return [];
    const indent = Math.max(0, options.indent ?? 0);
    const style = options.label ?? ((text: string) => text);
    const labelWidth = Math.max(...entries.map(([label]) => label.length + 1));
    const gutter = indent + labelWidth + 1;
    const room = width - gutter;
    const lines: string[] = [];
    for (const [label, value] of entries) {
      const head = ' '.repeat(indent) + style(label + ':') + ' '.repeat(labelWidth - label.length - 1) + ' ';
      if (room >= TextLayout.MIN_VALUE_WIDTH) {
        TextLayout.wrap(value, room).forEach((piece, i) => lines.push((i === 0 ? head : ' '.repeat(gutter)) + piece));
        continue;
      }
      lines.push(' '.repeat(indent) + style(label + ':'));
      const inner = indent + 2;
      for (const piece of TextLayout.wrap(value, width - inner)) lines.push(' '.repeat(inner) + piece);
    }
    return lines.map((line) => TextLayout.fit(line, width));
  }
}
