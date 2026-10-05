import { Text } from '../shared/index.js';
import { Helpers } from './helpers.js';

export type MarkdownAlign = 'left' | 'right';

export class MarkdownWriter {
  static readonly EXTRA_PUNCTUATION: RegExp = /[*_[\]<>#~!&]/g;
  static readonly EMPTY_CELL = '-';

  text(value: string): string {
    return Text.escapeMarkdown(value).replace(MarkdownWriter.EXTRA_PUNCTUATION, (ch) => '\\' + ch);
  }

  code(value: string, inTable = false): string {
    let clean = Text.toAscii(value.replace(/\r\n|\r|\n/g, ' '), 'escape');
    if (inTable) clean = clean.replace(/\|/g, '\\|');
    if (clean === '') return inTable ? MarkdownWriter.EMPTY_CELL : '` `';
    let longest = 0;
    for (const match of clean.matchAll(/`+/g)) longest = Math.max(longest, match[0].length);
    const fence = '`'.repeat(longest + 1);
    const pad = clean.startsWith('`') || clean.endsWith('`') || (clean.startsWith(' ') && clean.endsWith(' ')) ? ' ' : '';
    return fence + pad + clean + pad + fence;
  }

  block(content: string, language = ''): string {
    const body = Text.toAscii(content, 'escape');
    const fence = Helpers.fence(body);
    return `${fence}${language}\n${body}\n${fence}`;
  }

  table(headers: readonly string[], rows: readonly (readonly string[])[], align: readonly MarkdownAlign[] = []): string {
    const line = (cells: readonly string[]): string => `| ${headers.map((_header, i) => cells[i] || MarkdownWriter.EMPTY_CELL).join(' | ')} |`;
    const rule = `|${headers.map((_header, i) => (align[i] === 'right' ? ' ---: ' : ' --- ')).join('|')}|`;
    return [line(headers.map((header) => this.text(header))), rule, ...rows.map((row) => line(row))].join('\n');
  }

  heading(level: number, value: string): string {
    return `${'#'.repeat(Math.min(6, Math.max(1, level)))} ${this.text(value)}`;
  }
}
