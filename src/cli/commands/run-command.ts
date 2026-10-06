import { join } from 'node:path';
import { ExporterRegistry } from '../../export/index.js';
import { BasePresenter, PresenterFactory, TextLayout } from '../../present/index.js';
import { Fs, Meta } from '../../shared/index.js';
import { BuildOptionGroup } from '../build-option-group.js';
import { BuildStep } from '../build-step.js';
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
import { OutputTarget } from '../output-target.js';
import { UsageError } from '../usage-error.js';

export interface RunCommandDeps extends CommandDeps {
  runner?: CaptureRunner;
  saver?: CaptureSaver;
  step?: BuildStep;
  registry?: ExporterRegistry;
  capture?: CaptureOptionGroup;
  build?: BuildOptionGroup;
}

export class RunCommand extends Command {
  static readonly DEFAULT_OUT_DIR = 'appii-out';
  static readonly CAPTURE_FILE = 'capture.json';
  static readonly MODEL_FILE = 'api.json';

  readonly spec: CommandSpec;
  readonly #runner: CaptureRunner;
  readonly #saver: CaptureSaver;
  readonly #step: BuildStep;
  readonly #registry: ExporterRegistry;
  readonly #capture: CaptureOptionGroup;
  readonly #build: BuildOptionGroup;

  constructor(deps: RunCommandDeps = {}) {
    super(deps);
    this.#runner = deps.runner ?? CaptureRunner.create();
    this.#saver = deps.saver ?? new CaptureSaver();
    this.#step = deps.step ?? BuildStep.create();
    this.#registry = deps.registry ?? ExporterRegistry.default();
    this.#capture = deps.capture ?? new CaptureOptionGroup();
    this.#build = deps.build ?? new BuildOptionGroup();
    const app = Meta.APP_NAME;
    this.spec = {
      name: 'run',
      summary: 'Capture, build and list in one step',
      usage: `${app} run <url> [options]`,
      options: { 'out-dir': { type: 'string' }, ...this.#capture.options, ...this.#build.options },
      allowPositionals: true,
      docs: {
        'out-dir': { value: 'dir', description: `Directory for ${RunCommand.CAPTURE_FILE} and ${RunCommand.MODEL_FILE} (default: ./${RunCommand.DEFAULT_OUT_DIR})` },
        ...this.#capture.docs,
        ...this.#build.docs,
      },
      examples: [`${app} run https://example.com`, `${app} run https://example.com/app --headless --duration 20 --out-dir shop`],
    };
  }

  static create(): RunCommand {
    return new RunCommand({
      runner: CaptureRunner.create(),
      saver: CaptureSaver.create(),
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
    this.expectArguments(positionals, 1);
    const outDir = OptionReader.string(values, 'out-dir');
    OutputTarget.refuseStdout('--out-dir', outDir, `run writes ${RunCommand.CAPTURE_FILE} and ${RunCommand.MODEL_FILE} into a directory; use --out-dir <dir>, or capture and build -o - for stdout`);
    const dir = ctx.resolve(outDir ?? RunCommand.DEFAULT_OUT_DIR);
    if ((await Fs.exists(dir)) && !(await Helpers.isDirectory(dir))) throw new UsageError(`--out-dir ${ctx.display(dir)} is a file, not a directory`);
    await Fs.ensureDir(dir);
    const captureFile = OutputTarget.file(ctx, join(dir, RunCommand.CAPTURE_FILE));
    const modelFile = OutputTarget.file(ctx, join(dir, RunCommand.MODEL_FILE));
    await this.#saver.preflight([captureFile, modelFile]);
    const capture = await this.#runner.record({ ...captureOptions, url }, ctx).catch(async (err: unknown) => {
      throw await this.#saver.keepPartial(err, captureFile);
    });
    await this.#saver.save(captureFile, capture);
    ctx.out(new PresenterFactory(ctx.presenterOptions()).captureSummary().render({ capture, file: captureFile.label }));
    ctx.out('');
    await this.#step.run(capture, { out: modelFile, source: RunCommand.CAPTURE_FILE, options: buildOptions, hints: false }, ctx);
    const formats = this.#registry.list().map((exporter) => exporter.format).join(', ');
    const model = BasePresenter.fileArgument(modelFile.label);
    ctx.out('');
    ctx.out(TextLayout.wrap(`Next: ${Meta.APP_NAME} export ${model} --format <format>, where <format> is one of ${formats}`, ctx.width).join('\n'));
    return ExitCode.OK;
  }
}
