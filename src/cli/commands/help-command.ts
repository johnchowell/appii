import { Meta, Text } from '../../shared/index.js';
import type { CliContext } from '../cli-context.js';
import { Command } from '../command.js';
import type { CommandDeps, CommandSpec } from '../command.js';
import { DisplayOptionGroup } from '../display-option-group.js';
import type { CommandRegistry } from '../command-registry.js';
import { ExitCode } from '../exit-code.js';
import { HelpFormatter } from '../help-formatter.js';
import type { OptionValues } from '../option-reader.js';
import { UsageError } from '../usage-error.js';
import { VersionCommand } from './version-command.js';

export class HelpCommand extends Command {
  readonly spec: CommandSpec;
  readonly #registry: CommandRegistry;

  constructor(registry: CommandRegistry, deps: CommandDeps = {}) {
    super(deps);
    this.#registry = registry;
    this.spec = {
      name: 'help',
      summary: 'Show the commands, or the options of one command',
      usage: `${Meta.APP_NAME} help [command]`,
      options: {},
      allowPositionals: true,
      docs: {},
      examples: [`${Meta.APP_NAME} help export`],
    };
  }

  static create(registry: CommandRegistry): HelpCommand {
    return new HelpCommand(registry, { display: new DisplayOptionGroup() });
  }

  static overview(registry: CommandRegistry, display: DisplayOptionGroup, ctx: CliContext): string {
    const topics = registry.list().map((command) => command.spec);
    return new HelpFormatter({ ansi: ctx.ansi, width: ctx.width }).overview(topics, display, [VersionCommand.globalRow()]);
  }

  static unknownCommand(name: string, names: readonly string[]): UsageError {
    const guess = Text.closest(name, names);
    return new UsageError(`unknown command '${name}'${guess === undefined ? '' : `; did you mean '${guess}'?`}`);
  }

  overview(ctx: CliContext): string {
    return HelpCommand.overview(this.#registry, this.display, ctx);
  }

  protected async execute(_values: OptionValues, positionals: string[], ctx: CliContext): Promise<number> {
    this.expectArguments(positionals, 1);
    const name = positionals[0];
    if (name === undefined) {
      ctx.out(this.overview(ctx));
      return ExitCode.OK;
    }
    const command = this.#registry.get(name);
    if (!command) throw HelpCommand.unknownCommand(name, this.#registry.names());
    ctx.out(command.help(ctx));
    return ExitCode.OK;
  }
}
