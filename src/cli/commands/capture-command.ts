import { CaptureStore } from '../../capture/index.js';
import { BasePresenter, PresenterFactory } from '../../present/index.js';
import { Meta } from '../../shared/index.js';
import type { Capture } from '../../model/index.js';
import { CaptureOptionGroup } from '../capture-option-group.js';
import { CaptureRunner } from '../capture-runner.js';
import { CaptureSaver } from '../capture-saver.js';
import type { CliContext } from '../cli-context.js';
import { Command } from '../command.js';
import type { CommandDeps, CommandSpec } from '../command.js';
import { ExitCode } from '../exit-code.js';
import { Helpers } from '../helpers.js';
import { OptionReader } from '../option-reader.js';
import type { OptionValues } from '../option-reader.js';
import { UsageError } from '../usage-error.js';

export interface CaptureCommandDeps extends CommandDeps {
  runner?: CaptureRunner;
  store?: CaptureStore;
  saver?: CaptureSaver;
  capture?: CaptureOptionGroup;
}

export class CaptureCommand extends Command {
  static readonly DEFAULT_OUT = 'capture.json';

  readonly spec: CommandSpec;
  readonly #runner: CaptureRunner;
  readonly #store: CaptureStore;
  readonly #saver: CaptureSaver;
  readonly #capture: CaptureOptionGroup;

  constructor(deps: CaptureCommandDeps = {}) {
    super(deps);
    this.#runner = deps.runner ?? CaptureRunner.create();
    this.#store = deps.store ?? new CaptureStore();
    this.#saver = deps.saver ?? new CaptureSaver({ store: this.#store });
    this.#capture = deps.capture ?? new CaptureOptionGroup();
    const app = Meta.APP_NAME;
    this.spec = {
      name: 'capture',
      summary: 'Record a browsing session (traffic, cookies, storage, forms) into capture.json',
      usage: `${app} capture <url> [options]\n${app} capture --from-har <file.har> [-o <file>]`,
      options: { out: { type: 'string', short: 'o' }, 'from-har': { type: 'string' }, ...this.#capture.options },
      allowPositionals: true,
      docs: {
        out: { value: 'file', description: `Where to save the capture (default: ${CaptureCommand.DEFAULT_OUT})` },
        'from-har': { value: 'file', description: 'Convert a HAR file exported from browser DevTools instead of recording' },
        ...this.#capture.docs,
      },
      examples: [
        `${app} capture https://example.com`,
        `${app} capture https://example.com/app --headless --duration 30 -o app.json`,
        `${app} capture --from-har session.har`,
      ],
    };
  }

  static create(): CaptureCommand {
    const store = CaptureStore.create();
    return new CaptureCommand({ runner: CaptureRunner.create(), store, saver: new CaptureSaver({ store }), capture: new CaptureOptionGroup() });
  }

  protected async execute(values: OptionValues, positionals: string[], ctx: CliContext): Promise<number> {
    const out = await Helpers.outputFile(ctx, OptionReader.string(values, 'out'), CaptureCommand.DEFAULT_OUT);
    const har = OptionReader.string(values, 'from-har');
    let capture: Capture;
    if (har !== undefined) {
      if (positionals.length > 0) throw new UsageError(`--from-har converts a file and takes no URL (got '${positionals[0]}')`);
      const recording = Object.keys(this.#capture.options).find((name) => values[name] !== undefined);
      if (recording !== undefined) throw new UsageError(`--${recording} applies to recording and cannot be combined with --from-har`);
      const input = ctx.resolve(har);
      capture = await this.#store.load(input);
      if (input === out) throw new UsageError(Helpers.overwriteMessage(OptionReader.string(values, 'out'), CaptureCommand.DEFAULT_OUT, 'HAR file'));
    } else {
      const options = this.#capture.read(values, ctx);
      const url = this.argument(positionals, 0, '<url>');
      this.expectArguments(positionals, 1);
      await this.#saver.preflight([out]);
      capture = await this.#runner.record({ ...options, url }, ctx);
    }
    await this.#saver.save(out, capture);
    const file = ctx.display(out);
    const next = `${Meta.APP_NAME} build ${BasePresenter.fileArgument(file)}`;
    ctx.out(new PresenterFactory(ctx.presenterOptions()).captureSummary().render({ capture, file, next }));
    return ExitCode.OK;
  }
}
