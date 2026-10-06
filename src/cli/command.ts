import { parseArgs } from 'node:util';
import type { ParseArgsOptionsConfig } from 'node:util';
import { Meta, Text } from '../shared/index.js';
import type { CliContext } from './cli-context.js';
import { DisplayOptionGroup } from './display-option-group.js';
import { ErrorReporter } from './error-reporter.js';
import { ExitCode } from './exit-code.js';
import { HelpFormatter } from './help-formatter.js';
import type { OptionDocs } from './option-group.js';
import type { OptionValues } from './option-reader.js';
import { UsageError } from './usage-error.js';

export interface CommandSpec {
  name: string;
  summary: string;
  usage: string;
  options: ParseArgsOptionsConfig;
  allowPositionals: boolean;
  docs?: OptionDocs;
  examples?: readonly string[];
}

export interface CommandDeps {
  display?: DisplayOptionGroup;
}

interface ParsedArguments {
  values: OptionValues;
  positionals: string[];
}

export abstract class Command {
  static readonly PARSE_ERROR_PREFIX = 'ERR_PARSE_ARGS_';
  static readonly NEGATION_PREFIX = '--no-';

  abstract readonly spec: CommandSpec;
  protected readonly display: DisplayOptionGroup;

  constructor(deps: CommandDeps = {}) {
    this.display = deps.display ?? new DisplayOptionGroup();
  }

  static isParseError(err: unknown): err is Error & { code: string } {
    if (!(err instanceof Error)) return false;
    const code = (err as { code?: unknown }).code;
    return typeof code === 'string' && code.startsWith(Command.PARSE_ERROR_PREFIX);
  }

  options(): ParseArgsOptionsConfig {
    return { ...this.spec.options, ...this.display.options };
  }

  async run(argv: string[], ctx: CliContext): Promise<number> {
    let parsed: ParsedArguments;
    let scoped: CliContext;
    try {
      parsed = this.#parse(argv);
      scoped = ctx.withOptions(this.display.read(parsed.values));
    } catch (err) {
      if (err instanceof UsageError) return this.usage(ctx, err.message);
      throw err;
    }
    if (this.display.wantsHelp(parsed.values)) {
      scoped.out(this.help(scoped));
      return ExitCode.OK;
    }
    try {
      return await this.execute(parsed.values, parsed.positionals, scoped);
    } catch (err) {
      if (err instanceof UsageError) return this.usage(scoped, err.message);
      throw err;
    }
  }

  help(ctx: CliContext): string {
    return new HelpFormatter({ ansi: ctx.ansi, width: ctx.width }).command(this.spec, this.display);
  }

  usage(ctx: CliContext, message: string): number {
    const lines = this.spec.usage.split('\n');
    ctx.err(
      [
        ErrorReporter.PREFIX + ctx.ansi.clean(message),
        ...lines.map((line, i) => (i === 0 ? 'usage: ' : '       ') + line),
        `Run '${Meta.APP_NAME} help ${this.spec.name}' for all options.`,
      ].join('\n'),
    );
    return ExitCode.USAGE;
  }

  protected abstract execute(values: OptionValues, positionals: string[], ctx: CliContext): Promise<number>;

  protected argument(positionals: readonly string[], index: number, name: string): string {
    const value = positionals[index];
    if (value === undefined || value === '') throw new UsageError(`missing ${name}`);
    return value;
  }

  protected expectArguments(positionals: readonly string[], max: number): void {
    const extra = positionals[max];
    if (extra !== undefined) throw new UsageError(`unexpected argument '${extra}'`);
  }

  #parse(argv: string[]): ParsedArguments {
    const options = this.options();
    try {
      const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: this.spec.allowPositionals, allowNegative: true, strict: true });
      return { values: values as OptionValues, positionals };
    } catch (err) {
      if (!Command.isParseError(err)) throw err;
      throw new UsageError(Command.#unknownOption(argv, options) ?? Command.#sentence(err.message));
    }
  }

  static #unknownOption(argv: string[], options: ParseArgsOptionsConfig): string | undefined {
    const { tokens } = parseArgs({ args: argv, options, allowPositionals: true, allowNegative: true, strict: false, tokens: true });
    for (const token of tokens) {
      if (token.kind !== 'option' || Object.hasOwn(options, token.name)) continue;
      const negated = token.rawName.startsWith(Command.NEGATION_PREFIX);
      const candidates = Object.keys(options).filter((name) => !negated || options[name]?.type === 'boolean');
      const guess = Text.closest(token.name, candidates);
      const suggestion = guess === undefined ? '' : `; did you mean '${negated ? Command.NEGATION_PREFIX : '--'}${guess}'?`;
      return `unknown option '${token.rawName}'${suggestion}`;
    }
    return undefined;
  }

  static #sentence(message: string): string {
    return message.charAt(0).toLowerCase() + message.slice(1);
  }
}
