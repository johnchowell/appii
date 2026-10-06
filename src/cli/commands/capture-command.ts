import { CaptureStore } from '../../capture/index.js';
import type { LoginOutcome, ProbeOutcome } from '../../capture/index.js';
import { BasePresenter, PresenterFactory, TextLayout } from '../../present/index.js';
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
import { LoginReport } from '../login-report.js';
import { ProbeReport } from '../probe-report.js';
import { OptionReader } from '../option-reader.js';
import type { OptionValues } from '../option-reader.js';
import { OutputTarget } from '../output-target.js';
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
      usage: `${app} capture <url> [<url>...] [options]\n${app} capture --from-har <file.har> [-o <file>]`,
      options: { out: { type: 'string', short: 'o' }, 'from-har': { type: 'string' }, ...this.#capture.options },
      allowPositionals: true,
      docs: {
        out: { value: 'file', description: `Where to save the capture, or - for stdout (default: ${CaptureCommand.DEFAULT_OUT})` },
        'from-har': { value: 'file', description: 'Convert a HAR file exported from browser DevTools instead of recording' },
        ...this.#capture.docs,
      },
      examples: [
        `${app} capture https://example.com`,
        `${app} capture https://example.com/app --headless --duration 30 -o app.json`,
        `${app} capture https://example.com/login --headless --probe-login -o anon.json`,
        `${app} capture https://example.com/login https://example.com/account --headless --login username --login password -o authed.json`,
        `${app} capture --from-har session.har`,
      ],
    };
  }

  static create(): CaptureCommand {
    const store = CaptureStore.create();
    return new CaptureCommand({ runner: CaptureRunner.create(), store, saver: new CaptureSaver({ store }), capture: new CaptureOptionGroup() });
  }

  static next(command: string, ctx: CliContext): string {
    return TextLayout.definitions([['Next', ctx.ansi.clean(command)]], ctx.width, { label: (label) => ctx.ansi.dim(label) }).join('\n');
  }

  protected async execute(values: OptionValues, positionals: string[], ctx: CliContext): Promise<number> {
    const explicit = OptionReader.string(values, 'out');
    const out = await OutputTarget.of(ctx, explicit, CaptureCommand.DEFAULT_OUT);
    const har = OptionReader.string(values, 'from-har');
    let capture: Capture;
    let login: LoginOutcome | undefined;
    let probe: ProbeOutcome | undefined;
    let report = LoginReport.create();
    if (har !== undefined) {
      if (positionals.length > 0) throw new UsageError(`--from-har converts a file and takes no URL (got '${positionals[0]}')`);
      const recording = Object.keys(this.#capture.options).find((name) => values[name] !== undefined);
      if (recording !== undefined) throw new UsageError(`--${recording} applies to recording and cannot be combined with --from-har`);
      const input = ctx.resolve(har);
      capture = await this.#store.load(input);
      if (await out.overwrites(input)) throw new UsageError(Helpers.overwriteMessage(explicit, CaptureCommand.DEFAULT_OUT, 'HAR file'));
    } else {
      const options = this.#capture.read(values, ctx);
      const url = this.argument(positionals, 0, '<url>');
      const visits = positionals.slice(1);
      report = LoginReport.create(options.login ?? []);
      await this.#saver.preflight([out]);
      capture = await this.#runner
        .record({ ...options, url, ...(visits.length === 0 ? {} : { visits }), onLogin: (outcome) => (login = outcome), onProbe: (outcome) => (probe = outcome) }, ctx)
        .catch(async (err: unknown) => {
          throw await this.#saver.keepPartial(err, out);
        });
    }
    await this.#saver.save(out, capture);
    const summary = new PresenterFactory(ctx.presenterOptions()).captureSummary();
    const blocks = [out.stdout ? summary.render({ capture, written: out.label }) : summary.render({ capture, file: out.label })];
    if (login !== undefined) blocks.push(report.render(login, ctx));
    if (probe !== undefined) blocks.push(ProbeReport.create().render(probe, ctx));
    if (!out.stdout) blocks.push(CaptureCommand.next(`${Meta.APP_NAME} build ${BasePresenter.fileArgument(out.label)}`, ctx));
    out.report(blocks.join('\n\n'));
    return ExitCode.OK;
  }
}
