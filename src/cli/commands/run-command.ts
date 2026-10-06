import { join } from 'node:path';
import { CaptureMerger, CaptureStore } from '../../capture/index.js';
import type { CaptureInput, LoginOutcome, ProbeOutcome } from '../../capture/index.js';
import { ExporterRegistry } from '../../export/index.js';
import { BasePresenter, PresenterFactory, TextLayout } from '../../present/index.js';
import { Fs, Meta } from '../../shared/index.js';
import { BuildOptionGroup } from '../build-option-group.js';
import { BuildCommand } from './build-command.js';
import { BuildStep } from '../build-step.js';
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

export interface RunCommandDeps extends CommandDeps {
  runner?: CaptureRunner;
  saver?: CaptureSaver;
  store?: CaptureStore;
  merger?: CaptureMerger;
  step?: BuildStep;
  registry?: ExporterRegistry;
  capture?: CaptureOptionGroup;
  build?: BuildOptionGroup;
}

interface EarlierCapture {
  readonly input: CaptureInput;
  readonly label: string;
}

export class RunCommand extends Command {
  static readonly DEFAULT_OUT_DIR = 'appii-out';
  static readonly CAPTURE_FILE = 'capture.json';
  static readonly MODEL_FILE = 'api.json';

  readonly spec: CommandSpec;
  readonly #runner: CaptureRunner;
  readonly #saver: CaptureSaver;
  readonly #store: CaptureStore;
  readonly #merger: CaptureMerger;
  readonly #step: BuildStep;
  readonly #registry: ExporterRegistry;
  readonly #capture: CaptureOptionGroup;
  readonly #build: BuildOptionGroup;

  constructor(deps: RunCommandDeps = {}) {
    super(deps);
    this.#runner = deps.runner ?? CaptureRunner.create();
    this.#saver = deps.saver ?? new CaptureSaver();
    this.#store = deps.store ?? new CaptureStore();
    this.#merger = deps.merger ?? new CaptureMerger();
    this.#step = deps.step ?? BuildStep.create();
    this.#registry = deps.registry ?? ExporterRegistry.default();
    this.#capture = deps.capture ?? new CaptureOptionGroup();
    this.#build = deps.build ?? new BuildOptionGroup();
    const app = Meta.APP_NAME;
    this.spec = {
      name: 'run',
      summary: 'Capture, build and list in one step',
      usage: `${app} run <url> [<url>...] [options]`,
      options: { 'out-dir': { type: 'string' }, with: { type: 'string', multiple: true }, ...this.#capture.options, ...this.#build.options },
      allowPositionals: true,
      docs: {
        'out-dir': { value: 'dir', description: `Directory for ${RunCommand.CAPTURE_FILE} and ${RunCommand.MODEL_FILE} (default: ./${RunCommand.DEFAULT_OUT_DIR})` },
        with: { value: 'file', description: `Build ${RunCommand.MODEL_FILE} from this earlier capture or HAR file too, for example one recorded before logging in; repeat for more` },
        ...this.#capture.docs,
        ...this.#build.docs,
      },
      examples: [
        `${app} run https://example.com`,
        `${app} run https://example.com/app --headless --duration 20 --out-dir shop`,
        `${app} run https://example.com/login --headless --probe-login --out-dir anon`,
        `${app} run https://example.com/login https://example.com/account --headless --login username --login password --with anon/capture.json --out-dir authed`,
      ],
    };
  }

  static create(): RunCommand {
    return new RunCommand({
      runner: CaptureRunner.create(),
      saver: CaptureSaver.create(),
      store: CaptureStore.create(),
      merger: CaptureMerger.create(),
      step: BuildStep.create(),
      registry: ExporterRegistry.default(),
      capture: new CaptureOptionGroup(),
      build: new BuildOptionGroup(),
    });
  }

  protected async execute(values: OptionValues, positionals: string[], ctx: CliContext): Promise<number> {
    const captureOptions = this.#capture.read(values, ctx);
    const buildOptions = this.#build.read(values, ctx);
    const url = this.argument(positionals, 0, '<url>');
    const visits = positionals.slice(1);
    const outDir = OptionReader.string(values, 'out-dir');
    OutputTarget.refuseStdout('--out-dir', outDir, `run writes ${RunCommand.CAPTURE_FILE} and ${RunCommand.MODEL_FILE} into a directory; use --out-dir <dir>, or capture and build -o - for stdout`);
    const dir = ctx.resolve(outDir ?? RunCommand.DEFAULT_OUT_DIR);
    if ((await Fs.exists(dir)) && !(await Helpers.isDirectory(dir))) throw new UsageError(`--out-dir ${ctx.display(dir)} is a file, not a directory`);
    await Fs.ensureDir(dir);
    const captureFile = OutputTarget.file(ctx, join(dir, RunCommand.CAPTURE_FILE));
    const modelFile = OutputTarget.file(ctx, join(dir, RunCommand.MODEL_FILE));
    const earlier = await this.#earlier(OptionReader.strings(values, 'with'), [captureFile, modelFile], modelFile.path ?? join(dir, RunCommand.MODEL_FILE), ctx);
    await this.#saver.preflight([captureFile, modelFile]);
    let login: LoginOutcome | undefined;
    let probe: ProbeOutcome | undefined;
    const capture = await this.#runner
      .record({ ...captureOptions, url, ...(visits.length === 0 ? {} : { visits }), onLogin: (outcome) => (login = outcome), onProbe: (outcome) => (probe = outcome) }, ctx)
      .catch(async (err: unknown) => {
        throw await this.#saver.keepPartial(err, captureFile);
      });
    await this.#saver.save(captureFile, capture);
    ctx.out(new PresenterFactory(ctx.presenterOptions()).captureSummary().render({ capture, file: captureFile.label }));
    if (login !== undefined) ctx.out('\n' + LoginReport.create(captureOptions.login ?? []).render(login, ctx));
    if (probe !== undefined) ctx.out('\n' + ProbeReport.create().render(probe, ctx));
    ctx.out('');
    const current: CaptureInput = { capture, file: RunCommand.CAPTURE_FILE };
    const merged = this.#merger.merge([...earlier.map((entry) => entry.input), current]);
    const labels = new Map<CaptureInput, string>(earlier.map((entry): [CaptureInput, string] => [entry.input, entry.label]));
    for (const note of BuildCommand.repeatNotes(merged.repeated, (input) => labels.get(input) ?? input.file ?? '')) ctx.err(ctx.ansi.clean(note));
    const source = merged.sources.length === 1 ? merged.sources[0]?.file : undefined;
    await this.#step.run(merged.capture, { out: modelFile, ...(source === undefined ? {} : { source }), sources: merged.sources, options: buildOptions, hints: false }, ctx);
    const formats = this.#registry.list().map((exporter) => exporter.format).join(', ');
    const model = BasePresenter.fileArgument(modelFile.label);
    ctx.out('');
    ctx.out(TextLayout.wrap(`Next: ${Meta.APP_NAME} export ${model} --format <format>, where <format> is one of ${formats}`, ctx.width).join('\n'));
    return ExitCode.OK;
  }

  async #earlier(files: readonly string[], outputs: readonly OutputTarget[], model: string, ctx: CliContext): Promise<EarlierCapture[]> {
    const inputs: EarlierCapture[] = [];
    for (const file of files) {
      const path = ctx.resolve(file);
      for (const output of outputs) {
        if (await output.overwrites(path)) throw new UsageError(`--with ${file} is the ${output.label} that this run writes; copy it elsewhere or use another --out-dir`);
      }
      inputs.push({ input: { capture: await this.#store.load(path), file: BuildCommand.source(model, path) }, label: file });
    }
    return inputs;
  }
}
