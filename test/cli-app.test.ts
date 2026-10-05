import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserLauncher, CaptureSession, CaptureStore, HarConverter, TrafficRecorder } from '../src/capture/index.js';
import {
  BuildOptionGroup,
  CaptureOptionGroup,
  CaptureProgress,
  CaptureRunner,
  CliApp,
  CliContext,
  Command,
  CommandRegistry,
  DisplayOptionGroup,
  ErrorReporter,
  ExitCode,
  ExportFormatsPresenter,
  HelpFormatter,
  InputLoader,
  OptionReader,
  StatusLine,
  UsageError,
  VersionCommand,
} from '../src/cli/index.js';
import type { CommandSpec, OptionValues, RecordingSession } from '../src/cli/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import type { ApiModel, Capture, Exchange } from '../src/model/index.js';
import { Ansi, AppiiError, Fs, Meta, Text } from '../src/shared/index.js';
import { ModelBuilder, ModelStore } from '../src/build/index.js';
import { CaptureSummaryPresenter } from '../src/present/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { CliHarness, FakeSignals, MemoryStream } from './helpers/cli-harness.js';
import { PresentModels } from './helpers/present-models.js';

const ESC = '\x1b[';

class ThrowingCommand extends Command {
  readonly spec: CommandSpec = { name: 'boom', summary: 'Throws', usage: 'appii boom', options: { kind: { type: 'string' } }, allowPositionals: false, docs: { kind: { value: 'kind', description: 'What to throw' } } };

  protected async execute(values: OptionValues): Promise<number> {
    const kind = OptionReader.string(values, 'kind');
    if (kind === 'usage') throw new UsageError('bad usage here');
    if (kind === 'suggest') throw new AppiiError('NOT_FOUND', 'No such thing', { details: { suggestions: ['1 alpha', '2 beta'] } });
    if (kind === 'problems') throw new AppiiError('BAD_INPUT', 'Invalid', { details: { problems: Array.from({ length: 12 }, (_, i) => `p${i}: bad`) } });
    if (kind === 'escape') throw new AppiiError('IO', 'bad \x1b[31mred\u00e9');
    throw new Error('boom');
  }
}

function fakeSession(capture: Capture, behavior: { fail?: unknown } = {}): { session: RecordingSession; stopped: () => number; options: () => unknown } {
  let stops = 0;
  let resolveRun: (c: Capture) => void = () => undefined;
  let seen: unknown;
  const session: RecordingSession = {
    run: () =>
      behavior.fail === undefined
        ? new Promise<Capture>((done) => {
            resolveRun = done;
          })
        : Promise.reject(behavior.fail),
    stop: () => {
      stops++;
      resolveRun(capture);
    },
  };
  return { session, stopped: () => stops, options: () => seen };
}

describe('CliApp: global behavior', () => {
  let dir: string;
  let cli: CliHarness;
  let model: ApiModel;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-cli-app-'));
    cli = new CliHarness(dir);
    model = PresentModels.fixture();
    await new ModelStore().save(join(dir, 'api.json'), model);
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('--help, -h and help print the overview on stdout', async () => {
    for (const args of [['--help'], ['-h'], ['help']]) {
      const run = await cli.run(args);
      assert.equal(run.code, 0, args.join(' '));
      assert.equal(run.stderr, '');
      assert.match(run.stdout, new RegExp(`^${Meta.APP_NAME} ${Meta.appVersion().replace(/\./g, '\\.')} - `));
      for (const name of ['capture', 'build', 'list', 'export', 'run', 'help', 'version']) assert.match(run.stdout, new RegExp(`\\n  ${name} +\\S`));
      assert.match(run.stdout, /Workflow:\n  appii capture https:\/\/example\.com/);
      assert.match(run.stdout, /\n      --color, --no-color +Force/);
      assert.match(run.stdout, /\nGlobal options \(before the command\):\n  -V, --version +Print the version\n/);
      const common = run.stdout.slice(run.stdout.indexOf('Common options:'), run.stdout.indexOf('Global options'));
      assert.doesNotMatch(common, /--version/);
      assert.ok(CliHarness.isAscii(run.stdout));
    }
  });

  test('help <command>, <command> --help and <command> -h print the command help', async () => {
    const viaHelp = await cli.run(['help', 'export']);
    const viaFlag = await cli.run(['export', '--help']);
    const viaShort = await cli.run(['export', '-h']);
    assert.equal(viaHelp.code, 0);
    assert.equal(viaHelp.stdout, viaFlag.stdout);
    assert.equal(viaHelp.stdout, viaShort.stdout);
    assert.match(viaHelp.stdout, /^appii export - Export to OpenAPI/);
    assert.match(viaHelp.stdout, /Usage:\n  appii export <api\.json\|capture\.json\|file\.har> --format <format> \[options\]\n  appii export --formats/);
    assert.match(viaHelp.stdout, /\n  -f, --format <format> +One of openapi, openapi-yaml, postman/);
    assert.match(viaHelp.stdout, /\n      --no-redact +Keep secret values/);
    assert.match(viaHelp.stdout, /Examples:\n  appii export api\.json --format openapi/);
    const global = await cli.run(['--help', 'list']);
    assert.match(global.stdout, /^appii list - /);
  });

  test('help for an unknown command is a usage error with a suggestion', async () => {
    const run = await cli.run(['help', 'exprot']);
    assert.equal(run.code, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /^error: unknown command 'exprot'; did you mean 'export'\?\nusage: appii help \[command\]/);
  });

  test('version, --version and -V print the version', async () => {
    for (const args of [['version'], ['--version'], ['-V']]) {
      const run = await cli.run(args);
      assert.equal(run.code, 0);
      assert.equal(run.stdout, `${Meta.APP_NAME} ${Meta.appVersion()}\n`);
    }
    assert.equal(VersionCommand.line(), `appii ${Meta.appVersion()}`);
    const extra = await cli.run(['version', 'now']);
    assert.equal(extra.code, 2);
    assert.match(extra.stderr, /^error: unexpected argument 'now'/);
  });

  test('no command prints the overview on stderr with exit code 2', async () => {
    const run = await cli.run([]);
    assert.equal(run.code, 2);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /Commands:\n  capture/);
  });

  test('an unknown command is a usage error with a suggestion', async () => {
    const run = await cli.run(['lsit', 'api.json']);
    assert.equal(run.code, 2);
    assert.equal(run.stdout, '');
    assert.equal(
      run.stderr,
      "error: unknown command 'lsit'; did you mean 'list'?\nusage: appii <command> [options]\nCommands: capture, build, list, export, run, help, version\nRun 'appii help' for details.\n",
    );
    const far = await cli.run(['frobnicate']);
    assert.match(far.stderr, /^error: unknown command 'frobnicate'\n/);
    const control = await cli.run(['bad\x1bname']);
    assert.match(control.stderr, /unknown command 'bad\\x1bname'/);
  });

  test('global options before the command: color, width and unknown ones', async () => {
    const plain = await cli.run(['--no-color', 'list', 'api.json'], { tty: true });
    assert.equal(plain.code, 0);
    assert.ok(!plain.stdout.includes(ESC));
    const colored = await cli.run(['--color', 'list', 'api.json']);
    assert.ok(colored.stdout.includes(ESC));
    const narrow = await cli.run(['--width', '60', 'list', 'api.json']);
    assert.ok(CliHarness.widest(narrow.stdout) <= 60);
    const inline = await cli.run(['--width=70', 'list', 'api.json']);
    assert.ok(CliHarness.widest(inline.stdout) <= 70);
    assert.ok(CliHarness.widest(inline.stdout) > 60);
    const unknown = await cli.run(['--colr', 'list', 'api.json']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /^error: unknown option '--colr' before the command; did you mean '--color'\?/);
    const missing = await cli.run(['--width']);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /--width needs a value/);
    const bad = await cli.run(['--width', '0', 'list', 'api.json']);
    assert.equal(bad.code, 2);
    assert.match(bad.stderr, /--width must be at least 1, got 0/);
    const separator = await cli.run(['--', 'version']);
    assert.equal(separator.code, 0);
  });

  test('color follows the terminal and NO_COLOR, and --color/--no-color override it', async () => {
    const tty = await cli.run(['list', 'api.json'], { tty: true });
    assert.ok(tty.stdout.includes(ESC));
    const pipe = await cli.run(['list', 'api.json']);
    assert.ok(!pipe.stdout.includes(ESC));
    const noColor = await cli.run(['list', 'api.json'], { tty: true, env: { NO_COLOR: '1' } });
    assert.ok(!noColor.stdout.includes(ESC));
    const emptyNoColor = await cli.run(['list', 'api.json'], { tty: true, env: { NO_COLOR: '' } });
    assert.ok(emptyNoColor.stdout.includes(ESC));
    const forced = await cli.run(['list', 'api.json', '--color'], { env: { NO_COLOR: '1' } });
    assert.ok(forced.stdout.includes(ESC));
    const off = await cli.run(['list', 'api.json', '--no-color'], { tty: true });
    assert.ok(!off.stdout.includes(ESC));
    const last = await cli.run(['--color', 'list', 'api.json', '--no-color']);
    assert.ok(!last.stdout.includes(ESC));
  });

  test('width comes from --width, then the terminal columns, then 100', async () => {
    const terminal = await cli.run(['list', 'api.json'], { tty: true, columns: 72 });
    assert.ok(CliHarness.widest(terminal.stdout) <= 72);
    assert.ok(CliHarness.widest(terminal.stdout) > 60);
    const option = await cli.run(['list', 'api.json', '--width', '60'], { tty: true, columns: 200 });
    assert.ok(CliHarness.widest(option.stdout) <= 60);
    const fallback = await cli.run(['list', 'api.json', '--width', '100']);
    const auto = await cli.run(['list', 'api.json']);
    assert.equal(auto.stdout, fallback.stdout);
  });

  test('command option errors are usage errors with exit code 2', async () => {
    const unknown = await cli.run(['list', 'api.json', '--shw', '1']);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /^error: unknown option '--shw'; did you mean '--show'\?\nusage: appii list <api\.json\|capture\.json\|file\.har> \[options\]\nRun 'appii help list' for all options\.\n$/);
    const negated = await cli.run(['list', 'api.json', '--no-colour']);
    assert.match(negated.stderr, /unknown option '--no-colour'; did you mean '--no-color'\?/);
    const short = await cli.run(['list', 'api.json', '-z']);
    assert.match(short.stderr, /^error: unknown option '-z'\n/);
    const missingValue = await cli.run(['list', 'api.json', '--show']);
    assert.equal(missingValue.code, 2);
    assert.match(missingValue.stderr, /^error: option '--show <value>' argument missing/);
    const missingFile = await cli.run(['list']);
    assert.equal(missingFile.code, 2);
    assert.match(missingFile.stderr, /^error: missing <api\.json\|capture\.json\|file\.har>/);
    const extra = await cli.run(['list', 'api.json', 'more']);
    assert.match(extra.stderr, /^error: unexpected argument 'more'/);
    for (const width of ['0', 'abc', '1.5', '-3']) {
      const run = await cli.run(['list', 'api.json', `--width=${width}`]);
      assert.equal(run.code, 2, width);
      assert.match(run.stderr, /--width must be/);
    }
    const empty = await cli.run(['list', 'api.json', '--filter', '']);
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /--filter needs a non-empty value/);
    const kind = await cli.run(['list', 'api.json', '--kind', 'json,soap']);
    assert.equal(kind.code, 2);
    assert.match(kind.stderr, /--kind must be one of json, form, graphql, document, other; got 'soap'/);
    const both = await cli.run(['list', 'api.json', '--show', '1', '--cookies']);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /--show and --cookies cannot be combined/);
  });

  test('errors: AppiiError details, unexpected errors, terminal-safe messages and APPII_DEBUG', async () => {
    const registry = new CommandRegistry().register(new ThrowingCommand());
    const suggest = await cli.run(['boom', '--kind', 'suggest'], { registry });
    assert.equal(suggest.code, 1);
    assert.equal(suggest.stderr, 'error: No such thing\nDid you mean:\n  1 alpha\n  2 beta\n');
    const problems = await cli.run(['boom', '--kind', 'problems'], { registry });
    assert.equal(problems.code, 1);
    assert.match(problems.stderr, /^error: Invalid\nProblems:\n  p0: bad\n/);
    assert.match(problems.stderr, /  p9: bad\n  \.\.\. and 2 more\n$/);
    const plain = await cli.run(['boom'], { registry });
    assert.equal(plain.code, 1);
    assert.equal(plain.stderr, 'error: boom\n');
    const debug = await cli.run(['boom'], { registry, env: { APPII_DEBUG: '1' } });
    assert.match(debug.stderr, /^error: boom\nError: boom\n    at /);
    const usage = await cli.run(['boom', '--kind', 'usage'], { registry });
    assert.equal(usage.code, 2);
    assert.match(usage.stderr, /^error: bad usage here\nusage: appii boom\n/);
    const escaped = await cli.run(['boom', '--kind', 'escape'], { registry });
    assert.equal(escaped.stderr, 'error: bad \\x1b[31mred\\u00e9\n');
    const missing = await cli.run(['list', 'nope.json']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /^error: File not found: .*nope\.json\n$/);
  });

  test('ErrorReporter maps errors to exit codes and lists details', () => {
    const io = cli.io();
    const ctx = new CliContext(io.io);
    const reporter = new ErrorReporter();
    assert.equal(reporter.report(new UsageError('x'), ctx), ExitCode.USAGE);
    assert.equal(reporter.report(new AppiiError('IO', 'y'), ctx), ExitCode.ERROR);
    assert.equal(reporter.report('plain string', ctx), ExitCode.ERROR);
    assert.equal(io.stderr.text, 'error: x\nerror: y\nerror: plain string\n');
    assert.deepEqual(ErrorReporter.details({ suggestions: [], problems: 'no' }), []);
    assert.deepEqual(ErrorReporter.details(undefined), []);
  });

  test('APPII_DEBUG prints the chain of causes, not only the outer stack', () => {
    const io = cli.io({ env: { APPII_DEBUG: '1' } });
    const ctx = new CliContext(io.io);
    const root = new Error('browserType.launch: closed\nLooks like you launched a headed browser without having a XServer running.');
    const wrapped = new AppiiError('BROWSER', 'Cannot open a browser window', { cause: new AppiiError('BROWSER', 'inner', { cause: root }) });
    assert.equal(new ErrorReporter().report(wrapped, ctx), ExitCode.ERROR);
    const text = io.stderr.text;
    assert.match(text, /^error: Cannot open a browser window\nAppiiError: Cannot open a browser window\n    at /);
    assert.match(text, /\nCaused by: AppiiError: inner\n    at /);
    assert.match(text, /\nCaused by: Error: browserType\.launch: closed\nLooks like you launched a headed browser without having a XServer running\.\n    at /);
    const loop = new Error('loop');
    (loop as { cause?: unknown }).cause = loop;
    assert.equal(ErrorReporter.trace(loop).length, 1);
    assert.deepEqual(ErrorReporter.trace('text'), []);
    assert.deepEqual(ErrorReporter.trace(new Error('outer', { cause: 'plain cause' })).slice(1), ['Caused by: plain cause']);
    const quiet = cli.io();
    new ErrorReporter().report(wrapped, new CliContext(quiet.io));
    assert.equal(quiet.stderr.text, 'error: Cannot open a browser window\n');
  });
});

describe('CliContext, StatusLine and the option groups', () => {
  test('autoColor, autoWidth and withOptions', () => {
    const tty = new MemoryStream({ isTTY: true, columns: 132 });
    const pipe = new MemoryStream();
    assert.equal(CliContext.autoColor({ stdout: tty, env: {} }), true);
    assert.equal(CliContext.autoColor({ stdout: tty, env: { NO_COLOR: 'yes' } }), false);
    assert.equal(CliContext.autoColor({ stdout: pipe, env: {} }), false);
    assert.equal(CliContext.autoWidth({ stdout: tty }), 132);
    assert.equal(CliContext.autoWidth({ stdout: pipe }), 100);
    assert.equal(CliContext.autoWidth({ stdout: new MemoryStream({ isTTY: true, columns: 0 }) }), 100);
    const ctx = new CliContext({ stdout: tty, stderr: pipe, env: {}, cwd: '/work', signals: new FakeSignals() });
    assert.equal(ctx.color, true);
    assert.equal(ctx.width, 132);
    const narrowed = ctx.withOptions({ width: 50 });
    assert.equal(narrowed.width, 50);
    assert.equal(narrowed.color, true);
    const plain = narrowed.withOptions({ color: false });
    assert.equal(plain.width, 50);
    assert.equal(plain.color, false);
    assert.equal(plain.ansi.enabled, false);
    assert.equal(plain.withOptions({}).width, 50);
    assert.deepEqual(plain.options, { width: 50, color: false });
    assert.equal(plain.signals, ctx.signals);
    assert.throws(() => new CliContext({ stdout: pipe, stderr: pipe, env: {}, cwd: '/' }, { width: 0 }), /positive number of columns/);
  });

  test('resolve and display paths against the working directory', () => {
    const ctx = new CliContext({ stdout: new MemoryStream(), stderr: new MemoryStream(), env: {}, cwd: '/work/project' });
    assert.equal(ctx.resolve('api.json'), '/work/project/api.json');
    assert.equal(ctx.resolve('/tmp/x.json'), '/tmp/x.json');
    assert.equal(ctx.display('/work/project/out/api.json'), 'out/api.json');
    assert.equal(ctx.display('api.json'), 'api.json');
    assert.equal(ctx.display('/work/other/api.json'), '/work/other/api.json');
    assert.equal(ctx.display('/work/project'), '.');
    assert.equal(ctx.display('/work/project/..data/x'), '..data/x');
    assert.deepEqual(ctx.presenterOptions({ file: 'a' }), { color: false, width: 100, file: 'a' });
  });

  test('progress writes a transient line only to a terminal and out() clears it first', () => {
    const stdout = new MemoryStream();
    const stderr = new MemoryStream({ isTTY: true });
    const ctx = new CliContext({ stdout, stderr, env: {}, cwd: '/' }, { width: 20 });
    const read = (): string => stderr.text;
    assert.equal(ctx.interactive, true);
    ctx.progress('Recording: 3 requests and a very long URL that does not fit');
    assert.equal(read(), '\rRecording: 3 req...\x1b[K');
    ctx.withOptions({ width: 30 }).out('result');
    assert.equal(read(), '\rRecording: 3 req...\x1b[K\r\x1b[K');
    assert.equal(stdout.text, 'result\n');
    ctx.out('again');
    assert.equal(read().match(/\r\x1b\[K/g)?.length, 1);
    ctx.progress('bad \x07 bell');
    assert.match(read(), /bad \\x07 bell\x1b\[K$/);
    ctx.progress('');
    assert.ok(read().endsWith('\r\x1b[K'));
    ctx.write('raw');
    assert.equal(stdout.text, 'result\nagain\nraw');
    const pipe = new MemoryStream();
    const quiet = new CliContext({ stdout, stderr: pipe, env: {}, cwd: '/' });
    assert.equal(quiet.interactive, false);
    quiet.progress('hidden');
    quiet.err('shown');
    assert.equal(pipe.text, 'shown\n');
    const line = new StatusLine(new MemoryStream());
    line.show('x');
    assert.equal(line.visible, false);
    const narrowTerminal = new MemoryStream({ isTTY: true, columns: 12 });
    const narrow = new CliContext({ stdout, stderr: narrowTerminal, env: {}, cwd: '/' }, { width: 100 });
    assert.equal(narrow.progressWidth, 12);
    narrow.progress('Recording: 3 requests');
    assert.equal(narrowTerminal.text, '\rRecordin...\x1b[K');
    assert.equal(new CliContext({ stdout, stderr: new MemoryStream({ isTTY: true, columns: 300 }), env: {}, cwd: '/' }, { width: 90 }).progressWidth, 90);
  });

  test('out() and err() never pass raw control characters to the terminal; only the Ansi styles stay', () => {
    const raw = 'a\x1b]0;pwned\x07b\x1b[2Jc\rd\x08e\x9bf';
    const stdout = new MemoryStream();
    const stderr = new MemoryStream();
    const plain = new CliContext({ stdout, stderr, env: {}, cwd: '/' }, { color: false });
    plain.out(`${raw}\nnext`);
    plain.err(raw);
    assert.equal(stdout.text, 'a\\x1b]0;pwned\\x07b\\x1b[2Jc\\x0dd\\x08e\\x9bf\nnext\n');
    assert.equal(stderr.text, 'a\\x1b]0;pwned\\x07b\\x1b[2Jc\\x0dd\\x08e\\x9bf\n');
    plain.out(Ansi.color.red('styled'));
    assert.ok(stdout.text.endsWith('\\x1b[31mstyled\\x1b[39m\n'));
    const colorOut = new MemoryStream();
    const colored = new CliContext({ stdout: colorOut, stderr: new MemoryStream(), env: {}, cwd: '/' }, { color: true });
    colored.out(Ansi.color.red('styled') + raw);
    assert.equal(colorOut.text, '\x1b[31mstyled\x1b[39ma\\x1b]0;pwned\\x07b\\x1b[2Jc\\x0dd\\x08e\\x9bf\n');
    colored.write(raw);
    assert.ok(colorOut.text.endsWith(raw));
    const terminal = new MemoryStream({ isTTY: true });
    new StatusLine(terminal).show(`busy ${raw}\nmore`);
    assert.equal(terminal.text, '\rbusy a\\x1b]0;pwned\\x07b\\x1b[2Jc d\\x08e\\x9bf more\x1b[K');
  });

  test('OptionReader parses strings, lists, integers and seconds strictly', () => {
    const values: OptionValues = { a: 'x', many: ['1,2', ' 3 ', ','], flag: true, num: '42', dur: '1.5', zero: '0', bad: '1e3', empty: '' };
    assert.equal(OptionReader.string(values, 'a'), 'x');
    assert.equal(OptionReader.string(values, 'missing'), undefined);
    assert.equal(OptionReader.string(values, 'many'), ',');
    assert.deepEqual(OptionReader.strings(values, 'a'), ['x']);
    assert.deepEqual(OptionReader.list(values, 'many'), ['1', '2', '3']);
    assert.equal(OptionReader.boolean(values, 'flag'), true);
    assert.equal(OptionReader.boolean(values, 'a'), undefined);
    assert.equal(OptionReader.integer(values, 'num', { min: 1, max: 100 }), 42);
    assert.throws(() => OptionReader.integer(values, 'num', { max: 10 }), /--num must be at most 10, got 42/);
    assert.throws(() => OptionReader.integer(values, 'bad'), (err: unknown) => err instanceof UsageError && /--bad must be a whole number, got '1e3'/.test(err.message));
    assert.equal(OptionReader.seconds(values, 'dur'), 1500);
    assert.equal(OptionReader.seconds(values, 'zero'), 0);
    assert.throws(() => OptionReader.seconds(values, 'zero', { positive: true }), /more than 0 seconds/);
    assert.throws(() => OptionReader.seconds(values, 'bad'), /number of seconds/);
    assert.throws(() => OptionReader.seconds({ s: '9999999' }, 's'), /at most 2147483 seconds/);
    assert.equal(OptionReader.seconds({ s: '.25' }, 's'), 250);
    assert.throws(() => OptionReader.string(values, 'empty'), /--empty needs a non-empty value/);
    assert.throws(() => OptionReader.strings({ e: ['a', ''] }, 'e'), /needs a non-empty value/);
  });

  test('CaptureOptionGroup reads capture options with CLI defaults', () => {
    const group = new CaptureOptionGroup();
    const ctx = new CliContext({ stdout: new MemoryStream(), stderr: new MemoryStream(), env: {}, cwd: '/work' });
    assert.deepEqual(group.read({}, ctx), { headless: false });
    assert.deepEqual(group.read({ headless: true, duration: '2.5', idle: '0', 'storage-state': 'state.json', 'max-body': '1024' }, ctx), {
      headless: true,
      durationMs: 2500,
      idleMs: 0,
      storageState: '/work/state.json',
      recorder: { maxBodyBytes: 1024 },
    });
    assert.deepEqual(group.read({ 'max-total-body': '0', 'read-timeout': '2.5', 'user-agent': ' Mozilla/5.0 (X11) Test/1 ' }, ctx), {
      headless: false,
      userAgent: 'Mozilla/5.0 (X11) Test/1',
      recorder: { maxTotalBodyBytes: 0, readTimeoutMs: 2500 },
    });
    assert.throws(() => group.read({ duration: '0' }, ctx), /--duration must be more than 0 seconds/);
    assert.throws(() => group.read({ 'max-body': '-1' }, ctx), /--max-body must be a whole number/);
    assert.throws(() => group.read({ 'max-total-body': '1.5' }, ctx), (err: unknown) => err instanceof UsageError && /--max-total-body must be a whole number/.test(err.message));
    assert.throws(() => group.read({ 'read-timeout': '0' }, ctx), (err: unknown) => err instanceof UsageError && /--read-timeout must be more than 0 seconds/.test(err.message));
    assert.throws(() => group.read({ 'user-agent': 'a\r\nX-Evil: 1' }, ctx), (err: unknown) => err instanceof UsageError && /--user-agent must not contain NUL, CR or LF/.test(err.message));
    assert.throws(() => group.read({ 'user-agent': '   ' }, ctx), (err: unknown) => err instanceof UsageError && /--user-agent needs a non-empty value/.test(err.message));
  });

  test('CaptureOptionGroup help shows the defaults of the capture classes', () => {
    const docs = new CaptureOptionGroup().docs;
    assert.ok(docs.idle?.description.endsWith(`(default: ${CaptureSession.DEFAULT_IDLE_MS / 1000})`), docs.idle?.description);
    assert.ok(docs['max-body']?.description.endsWith(`(default: ${TrafficRecorder.DEFAULT_MAX_BODY_BYTES})`), docs['max-body']?.description);
    assert.ok(docs['max-total-body']?.description.endsWith(`(default: ${TrafficRecorder.DEFAULT_MAX_TOTAL_BODY_BYTES})`), docs['max-total-body']?.description);
    assert.ok(docs['read-timeout']?.description.endsWith(`(default: ${TrafficRecorder.READ_TIMEOUT_MS / 1000})`), docs['read-timeout']?.description);
    assert.ok(docs['user-agent']?.description.includes('default: the identity of the installed Chromium'));
    assert.equal(CaptureOptionGroup.seconds(2500), '2.5');
  });

  test('BuildOptionGroup reads build options, normalizes origins and rejects conflicts', () => {
    const group = new BuildOptionGroup();
    assert.deepEqual(group.read({}), { includeDocuments: true, redact: true });
    assert.deepEqual(group.read({ documents: false, redact: false, name: 'shop', origin: ['https://Shop.Example.com/path', 'http://localhost:3000'], 'include-static': true }), {
      includeDocuments: false,
      redact: false,
      name: 'shop',
      origins: ['https://shop.example.com', 'http://localhost:3000'],
      includeStatic: true,
    });
    assert.deepEqual(group.read({ 'all-origins': true }), { includeDocuments: true, redact: true, allOrigins: true });
    assert.throws(() => group.read({ origin: ['ftp://x'] }), (err: unknown) => err instanceof UsageError && /^--origin: /.test(err.message));
    assert.throws(() => group.read({ origin: ['https://a.example'], 'all-origins': true }), /cannot be combined/);
  });

  test('DisplayOptionGroup reads color and width', () => {
    const group = new DisplayOptionGroup();
    assert.deepEqual(group.read({}), {});
    assert.deepEqual(group.read({ color: false, width: '80' }), { color: false, width: 80 });
    assert.equal(group.wantsHelp({ help: true }), true);
    assert.equal(group.wantsHelp({}), false);
  });
});

describe('Commands, registry and help', () => {
  test('the default registry has every command and every option is documented', () => {
    const registry = CommandRegistry.default();
    assert.deepEqual(registry.names(), ['capture', 'build', 'list', 'export', 'run', 'help', 'version']);
    assert.equal(registry.get('nope'), undefined);
    assert.equal(registry.has('list'), true);
    const display = new DisplayOptionGroup();
    const shorts = new Set<string>();
    for (const command of registry.list()) {
      const spec = command.spec;
      assert.match(spec.usage, new RegExp(`^appii ${spec.name}`, 'm'));
      for (const [name, config] of Object.entries(spec.options)) {
        assert.ok(!Object.hasOwn(display.options, name), `${spec.name} --${name} collides with a common option`);
        assert.ok(spec.docs?.[name]?.description, `${spec.name} --${name} has no description`);
        if (config.type === 'string' && spec.docs?.[name]?.flag === undefined) assert.ok(spec.docs?.[name]?.value, `${spec.name} --${name} has no value name`);
        if (config.short) assert.ok(!['h'].includes(config.short), `${spec.name} -${config.short}`);
      }
      shorts.clear();
      for (const config of Object.values(command.options())) {
        if (!config.short) continue;
        assert.ok(!shorts.has(config.short), `${spec.name} reuses -${config.short}`);
        shorts.add(config.short);
      }
      for (const [name, doc] of Object.entries(spec.docs ?? {})) assert.ok(Object.hasOwn(spec.options, name), `${spec.name} documents unknown --${name} (${doc.description})`);
    }
    const custom = new CommandRegistry().register(new VersionCommand()).register(new VersionCommand());
    assert.equal(custom.list().length, 1);
  });

  test('command help fits narrow widths and stays ASCII', () => {
    const registry = CommandRegistry.default();
    for (const width of [40, 60, 100]) {
      const ctx = new CliContext({ stdout: new MemoryStream(), stderr: new MemoryStream(), env: {}, cwd: '/' }, { width, color: true });
      for (const command of registry.list()) {
        const help = command.help(ctx);
        assert.ok(CliHarness.widest(help) <= width, `${command.spec.name} at ${width}`);
        assert.ok(CliHarness.isAscii(help));
      }
    }
  });

  test('HelpFormatter lays out flags and rows', () => {
    assert.equal(HelpFormatter.flags('out', { type: 'string', short: 'o' }, { description: 'x', value: 'file' }), '-o, --out <file>');
    assert.equal(HelpFormatter.flags('origin', { type: 'string', multiple: true }, { description: 'x', value: 'url' }), '--origin <url>...');
    assert.equal(HelpFormatter.flags('json', { type: 'boolean' }), '--json');
    assert.equal(HelpFormatter.flags('redact', { type: 'boolean' }, { flag: '--no-redact', description: 'x' }), '--no-redact');
    assert.deepEqual(HelpFormatter.align([['-o, --out <f>', 'a'], ['--json', 'b']]), [['-o, --out <f>', 'a'], ['    --json', 'b']]);
    assert.deepEqual(HelpFormatter.align([['--json', 'b']]), [['--json', 'b']]);
    const help = new HelpFormatter({ ansi: Ansi.plain, width: 40 });
    assert.deepEqual(help.rows([['--a', 'one two three four five six seven eight nine']]), ['  --a  one two three four five six seven', '       eight nine']);
    const wide = help.rows([['--short', 'fits'], ['--a-very-long-flag-name-that-is-wide <value>', 'described below the flag']]);
    assert.ok(wide.every((line) => line.length <= 40));
    assert.equal(wide[0], '  --short');
    assert.equal(wide[1], '    fits');
    assert.equal(wide[wide.length - 1], '    described below the flag');
    const mixed = new HelpFormatter({ ansi: Ansi.plain, width: 80 }).rows([['--x', 'a'], ['--a-flag-longer-than-thirty-characters', 'next line']]);
    assert.deepEqual(mixed, ['  --x                             a', '  --a-flag-longer-than-thirty-characters', '                                  next line']);
    const tiny = new HelpFormatter({ ansi: Ansi.plain, width: 20 });
    assert.deepEqual(tiny.rows([['--x', 'alpha beta gamma delta']]), ['  --x', '    alpha beta gamma', '    delta']);
    assert.deepEqual(help.rows([]), []);
  });

  test('README documents the commands and the export formats generated from the registry', async () => {
    const readme = await readFile(resolve('README.md'), 'utf8');
    assert.ok(CliHarness.isAscii(readme));
    assert.ok(readme.includes(ExportFormatsPresenter.markdown(ExporterRegistry.default())));
    for (const example of ['appii capture https://example.com', 'appii build capture.json', 'appii list api.json', 'appii export api.json --format openapi']) {
      assert.ok(readme.includes(example), example);
    }
  });

  test('ExportFormatsPresenter lists every format with aliases', () => {
    const registry = ExporterRegistry.default();
    const rows = ExportFormatsPresenter.rows(registry);
    assert.deepEqual(rows.map((row) => row.format), ['openapi', 'openapi-yaml', 'postman', 'curl', 'typescript', 'har', 'html', 'markdown', 'json']);
    assert.deepEqual(rows.find((row) => row.format === 'openapi-yaml')?.aliases, ['openapi-yml', 'yaml', 'yml']);
    assert.equal(rows.find((row) => row.format === 'typescript')?.extension, '.ts');
    for (const width of [40, 60, 120]) {
      const text = new ExportFormatsPresenter({ width }).render(registry);
      assert.ok(CliHarness.widest(text) <= width, String(width));
      assert.match(text, /^Export formats: 9/);
    }
    assert.match(ExportFormatsPresenter.markdown(registry), /^\| Format \| Extension \| Aliases \| Description \|\n\| --- \| --- \| --- \| --- \|\n\| `openapi` \| `\.json` \| `oas`, `openapi-json`, `swagger` \| OpenAPI 3\.1 document \(JSON\) \|/);
  });

  test('CliApp.isEntryPoint compares the module URL with the real script path', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'appii-entry-'));
    try {
      const script = join(dir, 'cli.js');
      await writeFile(script, '');
      const link = join(dir, 'appii');
      await symlink(script, link);
      const url = pathToFileURL(script).href;
      assert.equal(CliApp.isEntryPoint(url, script), true);
      assert.equal(CliApp.isEntryPoint(url, link), true);
      assert.equal(CliApp.isEntryPoint(url, join(dir, 'missing.js')), false);
      assert.equal(CliApp.isEntryPoint(url, undefined), false);
      assert.equal(CliApp.isEntryPoint(pathToFileURL(join(dir, 'other.js')).href, script), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('CliApp.globals splits global options from the command', () => {
    assert.deepEqual(CliApp.globals(['--no-color', '--width', '80', 'list', '--color']), { options: { color: false, width: 80 }, rest: ['list', '--color'] });
    assert.deepEqual(CliApp.globals(['-h', 'list']), { options: {}, rest: ['help', 'list'] });
    assert.deepEqual(CliApp.globals(['--color', '--version']), { options: { color: true }, rest: ['version'] });
    assert.deepEqual(CliApp.globals([]), { options: {}, rest: [] });
    assert.deepEqual(CliApp.globals(['-', 'x']), { options: {}, rest: ['-', 'x'] });
    assert.throws(() => CliApp.globals(['--width=abc']), /--width must be a whole number/);
  });

  test('CliApp.crash reports a failure outside the app and returns exit code 1', () => {
    const stderr = new MemoryStream();
    assert.equal(CliApp.crash(new Error('cwd \x1b gone'), stderr), 1);
    assert.equal(stderr.text, 'error: cwd \\x1b gone\n');
  });

  test('CliApp.create fills the io from the process', () => {
    const io = CliApp.io({ cwd: '/somewhere' });
    assert.equal(io.stdout, process.stdout);
    assert.equal(io.stderr, process.stderr);
    assert.equal(io.env, process.env);
    assert.equal(io.cwd, '/somewhere');
    assert.equal(io.signals, undefined);
    assert.equal(CliApp.io().cwd, process.cwd());
  });
});

describe('Cli services', () => {
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-cli-services-'));
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('InputLoader reads api.json, capture.json and HAR files', async () => {
    const flow = CaptureFactory.fixture();
    const model = PresentModels.fixture();
    await new ModelStore().save(join(dir, 'api.json'), model);
    await new CaptureStore().save(join(dir, 'capture.json'), flow.capture);
    await writeFile(join(dir, 'capture.har'), JSON.stringify(new HarConverter().toHar(flow.capture)));
    await writeFile(join(dir, 'text.txt'), 'not json');
    const loader = InputLoader.create();
    const fromModel = await loader.load(join(dir, 'api.json'));
    assert.equal(fromModel.kind, 'model');
    assert.equal(fromModel.capture, undefined);
    assert.deepEqual(fromModel.model, JSON.parse(JSON.stringify(model)));
    const fromCapture = await loader.load(join(dir, 'capture.json'));
    assert.equal(fromCapture.kind, 'capture');
    assert.equal(fromCapture.capture?.exchanges.length, flow.capture.exchanges.length);
    assert.equal(fromCapture.model.source.file, 'capture.json');
    assert.equal(fromCapture.model.endpoints.length, model.endpoints.length);
    const fromHar = await loader.load(join(dir, 'capture.har'));
    assert.equal(fromHar.kind, 'har');
    assert.deepEqual(fromHar.model.endpoints.map((e) => e.key), fromCapture.model.endpoints.map((e) => e.key));
    const raw = await loader.load(join(dir, 'capture.json'), { redact: false });
    assert.ok(raw.model.cookies.some((cookie) => cookie.valueExample === flow.sid));
    assert.ok(!fromCapture.model.cookies.some((cookie) => cookie.valueExample === flow.sid));
    await assert.rejects(loader.load(join(dir, 'missing.json')), (err: unknown) => err instanceof AppiiError && err.code === 'NOT_FOUND');
    await assert.rejects(loader.load(join(dir, 'text.txt')), (err: unknown) => err instanceof AppiiError && err.code === 'BAD_INPUT');
    assert.equal((await loader.capture(join(dir, 'capture.har'))).exchanges.length, flow.capture.exchanges.length);
    const seen: unknown[] = [];
    const custom = new InputLoader({
      builder: (options) => {
        seen.push(options);
        return ModelBuilder.create(options);
      },
    });
    await custom.load(join(dir, 'capture.json'), { name: 'x' });
    assert.deepEqual(seen, [{ name: 'x' }]);
  });

  test('InputLoader reads and parses each input file once', async () => {
    const flow = CaptureFactory.fixture();
    await new ModelStore().save(join(dir, 'once-api.json'), PresentModels.fixture());
    await new CaptureStore().save(join(dir, 'once-capture.json'), flow.capture);
    await writeFile(join(dir, 'once-capture.har'), JSON.stringify(new HarConverter().toHar(flow.capture)));
    const reads: string[] = [];
    let loads = 0;
    class CountingStore extends CaptureStore {
      override load(path: string): Promise<Capture> {
        loads++;
        return super.load(path);
      }
    }
    const store = new CountingStore({
      reader: async (path: string) => {
        reads.push(path);
        return Fs.readJson(path);
      },
    });
    const loader = new InputLoader({ store, models: new ModelStore() });
    const parse = JSON.parse;
    const parsed: number[] = [];
    JSON.parse = ((text: string, reviver?: (this: unknown, key: string, value: unknown) => unknown) => {
      if (typeof text === 'string' && text.length > 10000) parsed.push(text.length);
      return parse(text, reviver);
    }) as typeof JSON.parse;
    try {
      for (const [name, kind] of [['once-capture.json', 'capture'], ['once-capture.har', 'har'], ['once-api.json', 'model']] as const) {
        reads.length = 0;
        parsed.length = 0;
        const loaded = await loader.load(join(dir, name));
        assert.equal(loaded.kind, kind, name);
        assert.equal(parsed.length, 1, name);
        assert.deepEqual(reads, [join(dir, name)], name);
      }
    } finally {
      JSON.parse = parse;
    }
    assert.equal(loads, 0);
    reads.length = 0;
    assert.equal((await loader.capture(join(dir, 'once-capture.har'))).exchanges.length, flow.capture.exchanges.length);
    assert.deepEqual(reads, [join(dir, 'once-capture.har')]);
    assert.equal(loads, 1);
  });

  test('CaptureSummaryPresenter describes a capture', () => {
    const capture = CaptureFactory.fixture().capture;
    const text = new CaptureSummaryPresenter({ width: 100 }).render({ capture, file: 'capture.json', next: 'appii build capture.json' });
    assert.match(text, /^Capture saved to capture\.json\n-+\n/);
    assert.match(text, /\nRequests: +14 \(6 pages, 8 fetch\/XHR, 0 other\) to 1 origin\n/);
    assert.match(text, /\nPages: +2 snapshots of 2 URLs\n/);
    assert.match(text, /\nCookies: +4 \(2 HttpOnly\)\n/);
    assert.match(text, /\nWebSockets: +0\n/);
    assert.match(text, /\n\nNext: appii build capture\.json$/);
    const empty: Capture = { ...capture, exchanges: [], pages: [], cookies: [], storage: [], websockets: [] };
    const plain = new CaptureSummaryPresenter().render({ capture: empty });
    assert.match(plain, /^Capture\n-------\n/);
    assert.match(plain, /Requests: +0\n/);
    assert.match(plain, /Storage: +none\n/);
    assert.ok(!plain.includes('Next'));
    const failed: Exchange = { ...capture.exchanges[0]!, id: 'f', request: { ...capture.exchanges[0]!.request, url: 'data:text/plain,x' } };
    delete failed.response;
    assert.match(new CaptureSummaryPresenter().render({ capture: { ...empty, exchanges: [failed] } }), /Requests: +1 \(1 page, 0 fetch\/XHR, 0 other, 1 failed\) to 0 origins/);
    assert.deepEqual(CaptureSummaryPresenter.origins(capture), [CaptureFactory.ORIGIN]);
  });

  test('CaptureRunner: instructions, progress, the first signal stops and saves, the second one exits', async () => {
    const capture = CaptureFactory.fixture().capture;
    const fake = fakeSession(capture);
    let received: Record<string, unknown> | undefined;
    const runner = new CaptureRunner({
      sessions: (options) => {
        received = options as unknown as Record<string, unknown>;
        return fake.session;
      },
    });
    const signals = new FakeSignals();
    const stdout = new MemoryStream();
    const stderr = new MemoryStream({ isTTY: true });
    const ctx = new CliContext({ stdout, stderr, env: {}, cwd: '/', signals }, { width: 60 });
    const forwarded: string[] = [];
    let ready = 0;
    const pending = runner.record({ url: 'https://example.com/', headless: false, onExchange: (e) => forwarded.push(e.id), onReady: () => ready++ }, ctx);
    assert.equal(signals.count('SIGINT'), 1);
    assert.equal(signals.count('SIGTERM'), 1);
    assert.equal(received?.url, 'https://example.com/');
    assert.equal(stderr.text, '', 'no instructions before the browser is ready');
    (received?.onReady as () => void)();
    assert.equal(ready, 1);
    const onExchange = received?.onExchange as (e: Exchange) => void;
    onExchange(capture.exchanges[0]!);
    assert.deepEqual(forwarded, [capture.exchanges[0]!.id]);
    assert.match(stderr.text, /^Recording\. Browse the site, then close the window or press Ctrl\+C\.\n\rRecording: 1 request, last GET 200 https:\/\/shop\.example[^\x1b]*\.\.\.\x1b\[K$/);
    signals.emit('SIGINT');
    assert.equal(fake.stopped(), 1);
    assert.equal(await pending, capture);
    assert.match(stderr.text, /\r\x1b\[KStopping and saving what was recorded\. Press Ctrl\+C again to quit without saving\.\n/);
    assert.equal(signals.count('SIGINT'), 0);
    assert.equal(signals.count('SIGTERM'), 0);
    assert.deepEqual(signals.exits, []);

    const second = fakeSession(capture);
    const twice = new CaptureRunner({ sessions: () => ({ run: () => new Promise<Capture>(() => undefined), stop: () => second.session.stop() }) });
    const signals2 = new FakeSignals();
    const ctx2 = new CliContext({ stdout, stderr: new MemoryStream(), env: {}, cwd: '/', signals: signals2 });
    void twice.record({ url: 'https://example.com/', headless: true, durationMs: 5000 }, ctx2);
    signals2.emit('SIGTERM');
    signals2.emit('SIGTERM');
    assert.deepEqual(signals2.exits, [ExitCode.SIGNALS.SIGTERM]);
    signals2.emit('SIGINT');
    assert.deepEqual(signals2.exits, [143, 130]);
  });

  test('CaptureRunner explains headed browser launch failures and forwards other errors', async () => {
    const capture = CaptureFactory.fixture().capture;
    const ctx = new CliContext({ stdout: new MemoryStream(), stderr: new MemoryStream(), env: {}, cwd: '/', signals: new FakeSignals() });
    const browser = BrowserLauncher.launchError(new Error('browserType.launch: Target page, context or browser has been closed\nBrowser logs:\nLooks like you launched a headed browser without having a XServer running.'));
    assert.equal(browser.message, 'Cannot open a browser window: no display (X server) is available');
    const headed = new CaptureRunner({ sessions: () => fakeSession(capture, { fail: browser }).session });
    await assert.rejects(headed.record({ url: 'https://example.com/', headless: false }, ctx), (err: unknown) => err instanceof AppiiError && err.code === 'BROWSER' && err.message === 'Cannot open a browser window: no display (X server) is available. To record without a browser window, add --headless.');
    await assert.rejects(headed.record({ url: 'https://example.com/', headless: true }, ctx), (err: unknown) => err === browser);
    const missing = new AppiiError('BROWSER', 'Cannot launch Chromium: Chromium is not installed.');
    await assert.rejects(new CaptureRunner({ sessions: () => fakeSession(capture, { fail: missing }).session }).record({ url: 'https://example.com/', headless: false }, ctx), (err: unknown) => err === missing);
    const other = new AppiiError('CAPTURE', 'nav failed');
    const failing = new CaptureRunner({ sessions: () => fakeSession(capture, { fail: other }).session });
    await assert.rejects(failing.record({ url: 'https://example.com/', headless: false }, ctx), (err: unknown) => err === other);
    assert.equal(ctx.signals instanceof FakeSignals && (ctx.signals as FakeSignals).count('SIGINT'), 0);
    assert.equal(CaptureRunner.instructions({ headless: true }), 'Recording headless until the network is idle. Press Ctrl+C to stop early.');
    assert.equal(CaptureRunner.instructions({}), 'Recording headless until the network is idle. Press Ctrl+C to stop early.');
    assert.equal(CaptureRunner.instructions({ headless: true, durationMs: 30000 }), 'Recording headless for 30 s. Press Ctrl+C to stop early.');
    assert.equal(CaptureRunner.instructions({ headless: true, script: async () => undefined }), 'Recording headless while the capture script runs. Press Ctrl+C to stop early.');
    assert.equal(CaptureRunner.instructions({ headless: false }), CaptureRunner.HEADED);
  });

  test('CaptureProgress throttles terminal updates and counts every exchange', () => {
    const capture = CaptureFactory.fixture().capture;
    const stderr = new MemoryStream({ isTTY: true });
    let now = 0;
    const ctx = new CliContext({ stdout: new MemoryStream(), stderr, env: {}, cwd: '/' }, { width: 200 });
    const progress = new CaptureProgress(ctx, { intervalMs: 100, now: () => now });
    progress.record(capture.exchanges[0]!);
    now = 50;
    progress.record(capture.exchanges[1]!);
    now = 150;
    progress.record(capture.exchanges[2]!);
    assert.equal(progress.count, 3);
    assert.equal(stderr.text.match(/Recording: /g)?.length, 2);
    assert.match(stderr.text, /Recording: 3 requests, last /);
    progress.finish();
    assert.ok(stderr.text.endsWith('\r\x1b[K'));
    const quiet = new MemoryStream();
    const silent = new CaptureProgress(new CliContext({ stdout: new MemoryStream(), stderr: quiet, env: {}, cwd: '/' }));
    silent.record(capture.exchanges[0]!);
    assert.equal(silent.count, 1);
    assert.equal(quiet.text, '');
    const failed = { ...capture.exchanges[0]! };
    delete failed.response;
    assert.match(CaptureProgress.line(1, failed), /^Recording: 1 request, last GET failed https:/);
  });

  test('Helpers through the commands: suggestions use an edit distance with transpositions', async () => {
    const { Helpers } = await import('../src/cli/helpers.js');
    assert.equal(Text.editDistance('lsit', 'list'), 1);
    assert.equal(Text.editDistance('', 'abc'), 3);
    assert.equal(Text.editDistance('kitten', 'sitting'), 3);
    assert.equal(Text.closest('exp', ['export', 'build']), 'export');
    assert.equal(Text.closest('LIST', ['list']), 'list');
    assert.equal(Text.closest('xyz', ['list', 'build']), undefined);
    assert.equal(Text.closest('', ['list']), undefined);
    assert.equal(Text.closest('b', ['build', 'boom']), undefined);
    assert.deepEqual(Helpers.splitList(['a, b', ',c,,']), ['a', 'b', 'c']);
    assert.equal(await Helpers.isDirectory(dir), true);
    assert.equal(await Helpers.isDirectory(join(dir, 'nope')), false);
  });
});
