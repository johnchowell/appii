import { Ansi, AppiiError } from '../shared/index.js';
import { TextLayout } from './text-layout.js';

export interface BarChartItem {
  label: string;
  value: number;
}

export interface BarChartOptions {
  ansi: Ansi;
  width: number;
  bar?: string;
  labelShare?: number;
  maxBar?: number;
}

export class BarChart {
  static readonly BAR = '#';
  static readonly LABEL_SHARE = 0.45;
  static readonly MAX_BAR = 40;

  readonly #ansi: Ansi;
  readonly #width: number;
  readonly #bar: string;
  readonly #labelShare: number;
  readonly #maxBar: number;

  constructor(options: BarChartOptions) {
    this.#ansi = options.ansi;
    this.#width = TextLayout.checkWidth(options.width, 'chart width');
    this.#bar = options.bar ?? BarChart.BAR;
    if (this.#bar.length !== 1 || this.#bar.charCodeAt(0) < 0x20 || this.#bar.charCodeAt(0) > 0x7e) {
      throw new AppiiError('BAD_INPUT', 'The bar character must be one printable ASCII character', { details: { bar: this.#bar } });
    }
    this.#labelShare = options.labelShare ?? BarChart.LABEL_SHARE;
    if (!(this.#labelShare > 0 && this.#labelShare < 1)) {
      throw new AppiiError('BAD_INPUT', 'The label share must be between 0 and 1', { details: { labelShare: this.#labelShare } });
    }
    this.#maxBar = TextLayout.checkWidth(options.maxBar ?? BarChart.MAX_BAR, 'maximum bar length');
  }

  render(items: readonly BarChartItem[]): string {
    if (items.length === 0) return '';
    for (const item of items) {
      if (!Number.isFinite(item.value) || item.value < 0) {
        throw new AppiiError('BAD_INPUT', `Bar chart values must be finite non-negative numbers (got ${String(item.value)})`, { details: { label: item.label, value: item.value } });
      }
    }
    const max = Math.max(...items.map((item) => item.value));
    const counts = items.map((item) => BarChart.#count(item.value));
    const countWidth = Math.max(...counts.map((count) => count.length));
    const labelWidth = Math.min(Math.max(...items.map((item) => Ansi.width(item.label))), Math.max(1, Math.floor(this.#width * this.#labelShare)));
    const room = Math.max(0, Math.min(this.#maxBar, this.#width - labelWidth - countWidth - 2));
    return items
      .map((item, i) => {
        const label = Ansi.padEnd(Ansi.truncate(item.label, labelWidth), labelWidth);
        const length = item.value === 0 || max === 0 ? 0 : Math.max(1, Math.round((item.value / max) * room));
        const bar = this.#ansi.cyan(this.#bar.repeat(Math.min(length, room)));
        const line = `${label} ${bar}${bar === '' ? '' : ' '}${counts[i] ?? ''}`;
        return TextLayout.fit(line, this.#width);
      })
      .join('\n');
  }

  static #count(value: number): string {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
  }
}
