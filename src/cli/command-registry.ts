import type { Command } from './command.js';
import { BuildCommand } from './commands/build-command.js';
import { CaptureCommand } from './commands/capture-command.js';
import { ExportCommand } from './commands/export-command.js';
import { HelpCommand } from './commands/help-command.js';
import { ListCommand } from './commands/list-command.js';
import { RunCommand } from './commands/run-command.js';
import { VersionCommand } from './commands/version-command.js';

export class CommandRegistry {
  readonly #commands = new Map<string, Command>();

  static default(): CommandRegistry {
    const registry = new CommandRegistry();
    return registry
      .register(CaptureCommand.create())
      .register(BuildCommand.create())
      .register(ListCommand.create())
      .register(ExportCommand.create())
      .register(RunCommand.create())
      .register(HelpCommand.create(registry))
      .register(VersionCommand.create());
  }

  register(command: Command): this {
    this.#commands.set(command.spec.name, command);
    return this;
  }

  has(name: string): boolean {
    return this.#commands.has(name);
  }

  get(name: string): Command | undefined {
    return this.#commands.get(name);
  }

  list(): Command[] {
    return [...this.#commands.values()];
  }

  names(): string[] {
    return [...this.#commands.keys()];
  }
}
