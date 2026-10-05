import { Ansi, Meta, Text } from '../shared/index.js';
import { EndpointFilter } from './endpoint-filter.js';
import type { ListFilter } from './endpoint-filter.js';
import { TableRenderer } from './table-renderer.js';
import { TextLayout } from './text-layout.js';
import type { Definition } from './text-layout.js';

export interface PresenterOptions {
  color?: boolean;
  width?: number;
  filter?: ListFilter;
  file?: string;
}

export interface Presenter<T> {
  render(input: T): string;
}

export type PresenterBlock = string | readonly string[] | undefined | null | false;

export abstract class BasePresenter<T> implements Presenter<T> {
  static readonly DEFAULT_WIDTH = 100;
  static readonly FILE_PLACEHOLDER = '<file>';
  static readonly SAFE_SHELL_WORD: RegExp = /^[A-Za-z0-9_@%+=:,./-]+$/;

  protected readonly ansi: Ansi;
  protected readonly width: number;
  protected readonly filter: EndpointFilter;
  protected readonly file: string | undefined;

  constructor(options: PresenterOptions = {}) {
    this.ansi = BasePresenter.ansiFor(options);
    this.width = TextLayout.checkWidth(options.width ?? BasePresenter.DEFAULT_WIDTH);
    this.filter = new EndpointFilter(options.filter);
    this.file = options.file;
  }

  static ansiFor(options: PresenterOptions = {}): Ansi {
    return options.color === true ? Ansi.color : Ansi.plain;
  }

  static fileArgument(file: string | undefined): string {
    if (file === undefined || file === '') return BasePresenter.FILE_PLACEHOLDER;
    const clean = TextLayout.clean(file);
    return BasePresenter.SAFE_SHELL_WORD.test(clean) ? clean : Text.shellQuote(clean);
  }

  abstract render(input: T): string;

  protected table(width: number = this.width): TableRenderer {
    return new TableRenderer({ ansi: this.ansi, width });
  }

  protected heading(text: string): string {
    const title = TextLayout.fit(TextLayout.clean(text), this.width);
    return this.ansi.bold(title) + '\n' + this.ansi.dim('-'.repeat(Ansi.width(title)));
  }

  protected definitions(entries: readonly Definition[], indent = 0): string[] {
    return TextLayout.definitions(entries, this.width, { indent, label: (label) => this.ansi.dim(label) });
  }

  protected command(args: string): string {
    return `${Meta.APP_NAME} ${args}`;
  }

  protected compose(blocks: readonly PresenterBlock[]): string {
    return blocks
      .filter((block): block is string | readonly string[] => typeof block === 'string' ? block !== '' : Array.isArray(block) && block.length > 0)
      .map((block) => (typeof block === 'string' ? block : block.join('\n')))
      .join('\n\n')
      .split('\n')
      .map((line) => TextLayout.fit(Text.isAscii(line) ? line : Text.toAscii(line, 'escape'), this.width))
      .join('\n');
  }
}
