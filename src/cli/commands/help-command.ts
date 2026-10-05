import { Meta } from '../../shared/index.js';
import type { CliContext } from '../cli-context.js';
import { Command } from '../command.js';
import type { CommandDeps, CommandSpec } from '../command.js';
import type { CommandRegistry } from '../command-registry.js';
import { ExitCode } from '../exit-code.js';
import { HelpFormatter } from '../help-formatter.js';
import { Helpers } from '../helpers.js';
import type { OptionValues } from '../option-reader.js';
import { UsageError } from '../usage-error.js';

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

  overview(ctx: CliContext): string {
    const topics = this.#registry.list().map((command) => command.spec);
    return new HelpFormatter({ ansi: ctx.ansi, width: ctx.width }).overview(topics, this.display, HelpFormatter.GLOBAL_ROWS);
  }

  protected async execute(_values: OptionValues, positionals: string[], ctx: CliContext): Promise<number> {
    this.expectArguments(positionals, 1);
    const name = positionals[0];
    if (name === undefined) {
      ctx.out(this.overview(ctx));
      return ExitCode.OK;
    }
    const command = this.#registry.get(name);
    if (!command) {
      const guess = Helpers.closest(name, this.#registry.names());
      throw new UsageError(`unknown command '${name}'${guess === undefined ? '' : `; did you mean '${guess}'?`}`);
    }
    ctx.out(command.help(ctx));
    return ExitCode.OK;
  }
}
