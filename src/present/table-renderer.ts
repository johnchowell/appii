import { Ansi, AppiiError } from '../shared/index.js';
import { TextLayout } from './text-layout.js';

export interface TableColumn {
  header: string;
  align?: 'left' | 'right';
  minWidth?: number;
  maxWidth?: number;
  flex?: boolean;
  wrap?: boolean;
  breakWords?: boolean;
  optional?: boolean;
  priority?: number;
}

export interface TableRendererOptions {
  ansi: Ansi;
  width: number;
}

export interface TableLayout {
  visible: number[];
  widths: number[];
  hidden: number[];
}

export class TableRenderer {
  static readonly DEFAULT_FLEX_FLOOR = 8;
  static readonly MAX_CELL_LINES = 8;
  static readonly CORNER = '+';
  static readonly HORIZONTAL = '-';
  static readonly VERTICAL = '|';
  static readonly CELL_BREAKS: RegExp = /\r\n|[\r\n\t]/g;

  readonly #ansi: Ansi;
  readonly #width: number;

  constructor(options: TableRendererOptions) {
    this.#ansi = options.ansi;
    this.#width = TextLayout.checkWidth(options.width, 'table width');
  }

  get width(): number {
    return this.#width;
  }

  static overhead(columns: number): number {
    return columns === 0 ? 0 : 3 * columns + 1;
  }

  layout(columns: readonly TableColumn[], rows: readonly (readonly string[])[]): TableLayout {
    TableRenderer.#validate(columns, rows);
    const natural = columns.map((column, i) => {
      let width = Ansi.width(column.header);
      for (const row of rows) width = Math.max(width, Ansi.width(TableRenderer.#cell(row[i])));
      if (column.maxWidth !== undefined) width = Math.min(width, column.maxWidth);
      return Math.max(1, width);
    });
    const floors = columns.map((column, i) => {
      const own = natural[i] ?? 1;
      if (!column.flex) return own;
      const words = column.wrap === true && column.breakWords === false ? TableRenderer.#longestWord(rows, i) : 0;
      return Math.min(own, Math.max(1, column.minWidth ?? TableRenderer.DEFAULT_FLEX_FLOOR, words));
    });
    let visible = columns.map((_, i) => i);
    while (TableRenderer.#total(visible, floors) > this.#width) {
      const drop = TableRenderer.#nextDrop(columns, visible);
      if (drop === undefined) break;
      visible = visible.filter((i) => i !== drop);
    }
    for (const i of TableRenderer.#readdOrder(columns, visible)) {
      const candidate = [...visible, i].sort((a, b) => a - b);
      if (TableRenderer.#total(candidate, floors) <= this.#width) visible = candidate;
    }
    const widths = [...natural];
    const flexible = visible.filter((i) => columns[i]?.flex === true);
    let excess = TableRenderer.#total(visible, widths) - this.#width;
    excess = TableRenderer.#shrink(widths, flexible.filter((i) => columns[i]?.wrap === true), floors, excess);
    excess = TableRenderer.#shrink(widths, flexible, floors, excess);
    TableRenderer.#shrink(widths, visible, widths.map(() => 1), excess);
    return {
      visible,
      widths: visible.map((i) => widths[i] ?? 1),
      hidden: columns.map((_, i) => i).filter((i) => !visible.includes(i)),
    };
  }

  render(columns: readonly TableColumn[], rows: readonly (readonly string[])[], layout?: TableLayout): string {
    const plan = layout ?? this.layout(columns, rows);
    if (layout) TableRenderer.#validate(columns, rows);
    if (plan.visible.length === 0) return '';
    const border = this.#ansi.dim(TableRenderer.CORNER + plan.widths.map((w) => TableRenderer.HORIZONTAL.repeat(w + 2)).join(TableRenderer.CORNER) + TableRenderer.CORNER);
    const bar = this.#ansi.dim(TableRenderer.VERTICAL);
    const line = (cells: readonly (string | undefined)[], header: boolean): string[] => {
      const blocks = plan.visible.map((col, k) => {
        const width = plan.widths[k] ?? 1;
        const raw = TableRenderer.#cell(cells[col]);
        if (header) return [this.#ansi.bold(Ansi.truncate(raw, width))];
        return columns[col]?.wrap === true ? TableRenderer.wrapCell(raw, width) : [Ansi.truncate(raw, width)];
      });
      const height = Math.max(1, ...blocks.map((block) => block.length));
      const out: string[] = [];
      for (let r = 0; r < height; r++) {
        const parts = plan.visible.map((col, k) => {
          const width = plan.widths[k] ?? 1;
          const text = blocks[k]?.[r] ?? '';
          return ' ' + (columns[col]?.align === 'right' ? Ansi.padStart(text, width) : Ansi.padEnd(text, width)) + ' ';
        });
        out.push(bar + parts.join(bar) + bar);
      }
      return out;
    };
    const lines = [border, ...line(columns.map((c) => c.header), true), border, ...rows.flatMap((row) => line(row, false)), border];
    return lines.map((entry) => TextLayout.fit(entry, this.#width)).join('\n');
  }

  static wrapCell(text: string, width: number): string[] {
    if (Ansi.width(text) <= width) return [text];
    if (Ansi.strip(text) !== text) return [Ansi.truncate(text, width)];
    const lines = TextLayout.wrap(text, width);
    if (lines.length <= TableRenderer.MAX_CELL_LINES) return lines;
    const kept = lines.slice(0, TableRenderer.MAX_CELL_LINES - 1);
    kept.push(Ansi.truncate(lines.slice(TableRenderer.MAX_CELL_LINES - 1).join(' '), width));
    return kept;
  }

  static #cell(value: string | undefined): string {
    return (value ?? '').replace(TableRenderer.CELL_BREAKS, ' ');
  }

  static #validate(columns: readonly TableColumn[], rows: readonly (readonly string[])[]): void {
    rows.forEach((row, i) => {
      if (row.length > columns.length) {
        throw new AppiiError('BAD_INPUT', `Table row ${i + 1} has ${row.length} cells but the table has ${columns.length} columns`, {
          details: { row: i, cells: row.length, columns: columns.length },
        });
      }
    });
    for (const column of columns) {
      for (const key of ['minWidth', 'maxWidth'] as const) {
        const value = column[key];
        if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
          throw new AppiiError('BAD_INPUT', `Column '${column.header}' ${key} must be a positive integer`, { details: { column: column.header, [key]: value } });
        }
      }
    }
  }

  static #total(visible: readonly number[], widths: readonly number[]): number {
    return visible.reduce((sum, i) => sum + (widths[i] ?? 1), 0) + TableRenderer.overhead(visible.length);
  }

  static #nextDrop(columns: readonly TableColumn[], visible: readonly number[]): number | undefined {
    let best: number | undefined;
    for (const i of visible) {
      const column = columns[i];
      if (!column?.optional) continue;
      if (best === undefined || (column.priority ?? 0) <= (columns[best]?.priority ?? 0)) best = i;
    }
    return best;
  }

  static #readdOrder(columns: readonly TableColumn[], visible: readonly number[]): number[] {
    return columns
      .map((_, i) => i)
      .filter((i) => !visible.includes(i))
      .sort((a, b) => (columns[b]?.priority ?? 0) - (columns[a]?.priority ?? 0) || a - b);
  }

  static #longestWord(rows: readonly (readonly string[])[], column: number): number {
    let longest = 0;
    for (const row of rows) for (const word of TableRenderer.#cell(row[column]).split(' ')) longest = Math.max(longest, Ansi.width(word));
    return longest;
  }

  static #shrink(widths: number[], candidates: readonly number[], floors: readonly number[], excess: number): number {
    let left = excess;
    while (left > 0) {
      let best: number | undefined;
      for (const i of candidates) {
        const width = widths[i] ?? 1;
        if (width <= (floors[i] ?? 1)) continue;
        if (best === undefined || width >= (widths[best] ?? 1)) best = i;
      }
      if (best === undefined) break;
      const current = widths[best] ?? 1;
      let next = floors[best] ?? 1;
      for (const i of candidates) {
        const width = widths[i] ?? 1;
        if (i !== best && width > (floors[i] ?? 1) && width <= current) next = Math.max(next, width);
      }
      const step = Math.max(1, Math.min(left, current - next));
      widths[best] = current - step;
      left -= step;
    }
    return left;
  }
}
