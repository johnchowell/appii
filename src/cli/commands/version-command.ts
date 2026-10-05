import { Meta } from '../../shared/index.js';
import type { CliContext } from '../cli-context.js';
import { Command } from '../command.js';
import type { CommandDeps, CommandSpec } from '../command.js';
import { DisplayOptionGroup } from '../display-option-group.js';
import { ExitCode } from '../exit-code.js';
import type { OptionValues } from '../option-reader.js';

export class VersionCommand extends Command {
  readonly spec: CommandSpec;

  constructor(deps: CommandDeps = {}) {
    super(deps);
    this.spec = {
      name: 'version',
      summary: 'Print the version',
      usage: `${Meta.APP_NAME} version`,
      options: {},
      allowPositionals: false,
      docs: {},
    };
  }

  static create(): VersionCommand {
    return new VersionCommand({ display: new DisplayOptionGroup() });
  }

  static line(): string {
    return `${Meta.APP_NAME} ${Meta.appVersion()}`;
  }

  protected async execute(_values: OptionValues, _positionals: string[], ctx: CliContext): Promise<number> {
    ctx.out(VersionCommand.line());
    return ExitCode.OK;
  }
}
