import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { Meta, Text } from '../shared/index.js';
import { TextLayout } from '../present/index.js';
import { CliContext } from './cli-context.js';
import type { CliContextOptions, CliIo } from './cli-context.js';
import { CommandRegistry } from './command-registry.js';
import { HelpCommand } from './commands/help-command.js';
import { VersionCommand } from './commands/version-command.js';
import { DisplayOptionGroup } from './display-option-group.js';
import { ErrorReporter } from './error-reporter.js';
import { ExitCode } from './exit-code.js';
import { OptionReader } from './option-reader.js';
import { UsageError } from './usage-error.js';

export interface CliAppDeps {
  reporter?: ErrorReporter;
  display?: DisplayOptionGroup;
}

export interface GlobalArguments {
  options: CliContextOptions;
  rest: string[];
}

export class CliApp {
  static readonly HELP_COMMAND = 'help';
  static readonly VERSION_COMMAND = 'version';
  static readonly HELP_FLAGS: ReadonlySet<string> = new Set(['-h', '--help']);
  static readonly VERSION_FLAGS: ReadonlySet<string> = new Set(VersionCommand.FLAGS);
  static readonly GLOBAL_FLAGS: readonly string[] = ['--help', '--version', '--color', '--no-color', '--width'];
  static readonly WIDTH_FLAG = '--width';
  static readonly BROKEN_PIPE_CODES: ReadonlySet<string> = new Set(['EPIPE', 'ERR_STREAM_DESTROYED']);

  readonly #registry: CommandRegistry;
  readonly #io: CliIo;
  readonly #reporter: ErrorReporter;
  readonly #display: DisplayOptionGroup;

  constructor(registry: CommandRegistry, io: CliIo, deps: CliAppDeps = {}) {
    this.#registry = registry;
    this.#io = io;
    this.#reporter = deps.reporter ?? new ErrorReporter();
    this.#display = deps.display ?? new DisplayOptionGroup();
  }

  static create(io: Partial<CliIo> = {}): CliApp {
    return new CliApp(CommandRegistry.default(), CliApp.io(io), { reporter: new ErrorReporter(), display: new DisplayOptionGroup() });
  }

  static io(io: Partial<CliIo> = {}): CliIo {
    return {
      stdout: io.stdout ?? process.stdout,
      stderr: io.stderr ?? process.stderr,
      env: io.env ?? process.env,
      cwd: io.cwd ?? process.cwd(),
      ...(io.signals === undefined ? {} : { signals: io.signals }),
    };
  }

  static isEntryPoint(moduleUrl: string, scriptPath: string | undefined = process.argv[1]): boolean {
    if (scriptPath === undefined || scriptPath === '') return false;
    try {
      return moduleUrl === pathToFileURL(realpathSync(scriptPath)).href;
    } catch {
      return false;
    }
  }

  static ignoreBrokenPipes(stream: NodeJS.EventEmitter): void {
    stream.on('error', (err: NodeJS.ErrnoException) => {
      if (!CliApp.BROKEN_PIPE_CODES.has(err.code ?? '')) throw err;
    });
  }

  static crash(err: unknown, stderr: NodeJS.WritableStream): number {
    stderr.write(ErrorReporter.PREFIX + TextLayout.clean(Text.errorMessage(err)) + '\n');
    return ExitCode.ERROR;
  }

  static globals(argv: readonly string[]): GlobalArguments {
    const options: CliContextOptions = {};
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i] ?? '';
      if (arg === '--') return { options, rest: argv.slice(i + 1) };
      if (!arg.startsWith('-') || arg === '-') return { options, rest: argv.slice(i) };
      if (CliApp.HELP_FLAGS.has(arg)) return { options, rest: [CliApp.HELP_COMMAND, ...argv.slice(i + 1)] };
      if (CliApp.VERSION_FLAGS.has(arg)) return { options, rest: [CliApp.VERSION_COMMAND, ...argv.slice(i + 1)] };
      if (arg === '--color' || arg === '--no-color') {
        options.color = arg === '--color';
        continue;
      }
      if (arg === CliApp.WIDTH_FLAG || arg.startsWith(CliApp.WIDTH_FLAG + '=')) {
        const inline = arg !== CliApp.WIDTH_FLAG;
        const value = inline ? arg.slice(CliApp.WIDTH_FLAG.length + 1) : argv[++i];
        if (value === undefined) throw new UsageError(`${CliApp.WIDTH_FLAG} needs a value`);
        const width = OptionReader.integer({ width: value }, 'width', { min: 1 });
        if (width !== undefined) options.width = width;
        continue;
      }
      const guess = Text.closest(arg.replace(/=.*$/, ''), CliApp.GLOBAL_FLAGS);
      throw new UsageError(`unknown option '${arg}' before the command${guess === undefined ? '' : `; did you mean '${guess}'?`}`);
    }
    return { options, rest: [] };
  }

  async run(argv: readonly string[]): Promise<number> {
    let ctx = CliContext.create(this.#io);
    try {
      const { options, rest } = CliApp.globals(argv);
      ctx = ctx.withOptions(options);
      const [name, ...args] = rest;
      if (name === undefined) {
        ctx.err(this.#overview(ctx));
        return ExitCode.USAGE;
      }
      const command = this.#registry.get(name);
      if (!command) return this.#unknown(ctx, name);
      return await command.run(args, ctx);
    } catch (err) {
      if (err instanceof UsageError) return this.#usage(ctx, err.message);
      return this.#reporter.report(err, ctx);
    }
  }

  #overview(ctx: CliContext): string {
    return HelpCommand.overview(this.#registry, this.#display, ctx);
  }

  #unknown(ctx: CliContext, name: string): number {
    return this.#usage(ctx, HelpCommand.unknownCommand(name, this.#registry.names()).message);
  }

  #usage(ctx: CliContext, message: string): number {
    ctx.err(
      [
        ErrorReporter.PREFIX + ctx.ansi.clean(message),
        `usage: ${Meta.APP_NAME} <command> [options]`,
        `Commands: ${this.#registry.names().join(', ')}`,
        `Run '${Meta.APP_NAME} help' for details.`,
      ].join('\n'),
    );
    return ExitCode.USAGE;
  }
}
