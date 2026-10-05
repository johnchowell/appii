import type { ParseArgsOptionsConfig } from 'node:util';
import type { CliContext, CliContextOptions } from './cli-context.js';
import type { OptionDocs, OptionGroup } from './option-group.js';
import { OptionReader } from './option-reader.js';
import type { OptionValues } from './option-reader.js';

export class DisplayOptionGroup implements OptionGroup<CliContextOptions> {
  static readonly HELP = 'help';

  readonly options: ParseArgsOptionsConfig = {
    color: { type: 'boolean' },
    width: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
  };

  readonly docs: OptionDocs = {
    color: { flag: '--color, --no-color', description: 'Force or disable colors (default: colors on a terminal unless NO_COLOR is set)' },
    width: { value: 'n', description: 'Output width in columns (default: the terminal width, else 100)' },
    help: { description: 'Show help' },
  };

  read(values: OptionValues, _ctx?: CliContext): CliContextOptions {
    const out: CliContextOptions = {};
    const color = OptionReader.boolean(values, 'color');
    const width = OptionReader.integer(values, 'width', { min: 1 });
    if (color !== undefined) out.color = color;
    if (width !== undefined) out.width = width;
    return out;
  }

  wantsHelp(values: OptionValues): boolean {
    return OptionReader.boolean(values, DisplayOptionGroup.HELP) === true;
  }
}
