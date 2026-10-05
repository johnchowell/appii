import { Text } from '../shared/index.js';

export interface ChartDatum {
  label: string;
  value: number;
  title?: string;
  tone?: string;
}

export class HtmlChartRenderer {
  static readonly TONE_PATTERN: RegExp = /^[a-z0-9-]+$/;

  bars(caption: string, data: readonly ChartDatum[], unit = ''): string {
    const max = Math.max(1, ...data.map((datum) => datum.value));
    const rows = data.map((datum) => {
      const width = datum.value <= 0 ? 0 : Math.max(0.5, (datum.value / max) * 100);
      const tone = datum.tone !== undefined && HtmlChartRenderer.TONE_PATTERN.test(datum.tone) ? ` tone-${datum.tone}` : '';
      const title = datum.title ?? `${datum.label}: ${datum.value}${unit ? ` ${unit}` : ''}`;
      return (
        `<li class="bar-row" title="${Text.escapeHtml(title)}">` +
        `<span class="bar-label">${Text.escapeHtml(datum.label)}</span>` +
        `<span class="bar-track"><span class="bar${tone}" style="width:${width.toFixed(1)}%"></span></span>` +
        `<span class="bar-value">${datum.value}</span></li>`
      );
    });
    const body = rows.length > 0 ? `<ul class="bars">${rows.join('')}</ul>` : '<p class="empty">No data</p>';
    return `<figure class="chart"><figcaption>${Text.escapeHtml(caption)}</figcaption>${body}</figure>`;
  }
}
