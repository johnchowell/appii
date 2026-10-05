import { ExporterRegistry } from '../export/index.js';
import { BasePresenter, TextLayout } from '../present/index.js';
import type { TableColumn } from '../present/index.js';
import { Meta, Text } from '../shared/index.js';

export interface ExportFormatRow {
  format: string;
  extension: string;
  aliases: string[];
  description: string;
}

export class ExportFormatsPresenter extends BasePresenter<ExporterRegistry> {
  static readonly COLUMNS: readonly TableColumn[] = [
    { header: 'FORMAT' },
    { header: 'EXT' },
    { header: 'ALIASES', flex: true, minWidth: 8, maxWidth: 28, wrap: true, breakWords: false, optional: true, priority: 1 },
    { header: 'DESCRIPTION', flex: true, minWidth: 20, wrap: true },
  ];
  static readonly MARKDOWN_HEADER = '| Format | Extension | Aliases | Description |\n| --- | --- | --- | --- |';

  static rows(registry: ExporterRegistry): ExportFormatRow[] {
    return registry.list().map((exporter) => ({
      format: exporter.format,
      extension: `.${exporter.extension}`,
      aliases: Object.entries(ExporterRegistry.ALIASES)
        .filter(([, format]) => format === exporter.format)
        .map(([alias]) => alias)
        .sort(),
      description: exporter.description,
    }));
  }

  static markdown(registry: ExporterRegistry): string {
    const code = (text: string): string => '`' + text + '`';
    const lines = ExportFormatsPresenter.rows(registry).map(
      (row) => `| ${code(row.format)} | ${code(row.extension)} | ${row.aliases.map(code).join(', ')} | ${Text.escapeMarkdown(row.description)} |`,
    );
    return [ExportFormatsPresenter.MARKDOWN_HEADER, ...lines].join('\n');
  }

  render(registry: ExporterRegistry): string {
    const rows = ExportFormatsPresenter.rows(registry).map((row) => [
      this.ansi.bold(TextLayout.clean(row.format)),
      TextLayout.clean(row.extension),
      TextLayout.clean(row.aliases.join(', ')),
      TextLayout.clean(row.description),
    ]);
    const table = this.table();
    const layout = table.layout(ExportFormatsPresenter.COLUMNS, rows);
    const hidden = layout.hidden.map((i) => ExportFormatsPresenter.COLUMNS[i]?.header ?? '');
    return this.compose([
      this.heading(`Export formats: ${rows.length}`),
      table.render(ExportFormatsPresenter.COLUMNS, rows, layout),
      hidden.length === 0 ? undefined : TextLayout.wrap(`Columns hidden to fit ${this.width} characters: ${hidden.join(', ')}`, this.width).map((line) => this.ansi.dim(line)),
      this.definitions([['Usage', `${Meta.APP_NAME} export <file> --format <format> [-o <file>|-]`]]),
    ]);
  }
}
