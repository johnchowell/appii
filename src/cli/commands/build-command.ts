import { dirname, relative, sep } from 'node:path';
import { CaptureStore } from '../../capture/index.js';
import { Meta } from '../../shared/index.js';
import { BuildOptionGroup } from '../build-option-group.js';
import { BuildStep } from '../build-step.js';
import type { CliContext } from '../cli-context.js';
import { Command } from '../command.js';
import type { CommandDeps, CommandSpec } from '../command.js';
import { ExitCode } from '../exit-code.js';
import { Helpers } from '../helpers.js';
import { OptionReader } from '../option-reader.js';
import type { OptionValues } from '../option-reader.js';
import { OutputTarget } from '../output-target.js';
import { UsageError } from '../usage-error.js';

export interface BuildCommandDeps extends CommandDeps {
  store?: CaptureStore;
  step?: BuildStep;
  build?: BuildOptionGroup;
}

export class BuildCommand extends Command {
  static readonly DEFAULT_OUT = 'api.json';

  readonly spec: CommandSpec;
  readonly #store: CaptureStore;
  readonly #step: BuildStep;
  readonly #build: BuildOptionGroup;

  constructor(deps: BuildCommandDeps = {}) {
    super(deps);
    this.#store = deps.store ?? new CaptureStore();
    this.#step = deps.step ?? BuildStep.create();
    this.#build = deps.build ?? new BuildOptionGroup();
    const app = Meta.APP_NAME;
    this.spec = {
      name: 'build',
      summary: 'Infer endpoints, auth, cookies and form rules from a capture into api.json',
      usage: `${app} build <capture.json|file.har> [options]`,
      options: { out: { type: 'string', short: 'o' }, ...this.#build.options },
      allowPositionals: true,
      docs: { out: { value: 'file', description: `Where to save the API model, or - for stdout (default: ${BuildCommand.DEFAULT_OUT})` }, ...this.#build.docs },
      examples: [`${app} build capture.json`, `${app} build session.har -o shop.json --name shop --origin https://api.example.com`],
    };
  }

  static create(): BuildCommand {
    return new BuildCommand({ store: CaptureStore.create(), step: BuildStep.create(), build: new BuildOptionGroup() });
  }

  static source(out: string, input: string): string {
    return relative(dirname(out), input).split(sep).join('/');
  }

  protected async execute(values: OptionValues, positionals: string[], ctx: CliContext): Promise<number> {
    const options = this.#build.read(values, ctx);
    const file = this.argument(positionals, 0, '<capture.json|file.har>');
    this.expectArguments(positionals, 1);
    const input = ctx.resolve(file);
    const explicit = OptionReader.string(values, 'out');
    const out = await OutputTarget.of(ctx, explicit, BuildCommand.DEFAULT_OUT);
    const capture = await this.#store.load(input);
    if (await out.overwrites(input)) throw new UsageError(Helpers.overwriteMessage(explicit, BuildCommand.DEFAULT_OUT));
    await this.#step.run(capture, { out, source: BuildCommand.source(out.path ?? ctx.resolve(BuildCommand.DEFAULT_OUT), input), options }, ctx);
    return ExitCode.OK;
  }
}
