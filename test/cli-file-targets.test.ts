import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureSession, CaptureStore, HarConverter } from '../src/capture/index.js';
import { CaptureCommand, CaptureRunner, CaptureSaver, CommandRegistry, RunCommand } from '../src/cli/index.js';
import { ModelStore } from '../src/build/index.js';
import type { Capture } from '../src/model/index.js';
import { AppiiError, Fs } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { CliHarness } from './helpers/cli-harness.js';

describe('output files that are links, special files or the input under another name', () => {
  let dir: string;
  let cli: CliHarness;
  let captureBytes: Buffer;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-file-targets-'));
    cli = new CliHarness(dir);
    const capture = CaptureFactory.fixture().capture;
    await new CaptureStore().save(join(dir, 'capture.json'), capture);
    captureBytes = await readFile(join(dir, 'capture.json'));
    await writeFile(join(dir, 'devtools.har'), JSON.stringify(new HarConverter().toHar(capture)));
    const built = await cli.run(['build', 'capture.json', '-o', 'api.json']);
    assert.equal(built.code, 0, built.stderr);
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('-o through a symbolic link writes the file the link points to and keeps the link (NEW-FS-SPECIAL)', async () => {
    await mkdir(join(dir, 'real'), { recursive: true });
    await writeFile(join(dir, 'real', 'target.json'), 'old');
    await symlink(join('real', 'target.json'), join(dir, 'link.json'));
    const run = await cli.run(['export', 'api.json', '--format', 'json', '-o', 'link.json']);
    assert.equal(run.code, 0, run.stderr);
    assert.ok((await lstat(join(dir, 'link.json'))).isSymbolicLink());
    assert.equal(await readlink(join(dir, 'link.json')), join('real', 'target.json'));
    assert.match(await readFile(join(dir, 'real', 'target.json'), 'utf8'), /^\{\n/);
  });

  test('-o to a FIFO writes into the FIFO and leaves it a FIFO (NEW-FS-SPECIAL)', async () => {
    const fifo = join(dir, 'pipe');
    execFileSync('mkfifo', [fifo]);
    const received = new Promise<string>((resolve, reject) => {
      const chunks: Buffer[] = [];
      createReadStream(fifo)
        .on('data', (chunk) => chunks.push(Buffer.from(chunk)))
        .on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        .on('error', reject);
    });
    const run = await cli.run(['export', 'api.json', '--format', 'json', '-o', 'pipe']);
    assert.equal(run.code, 0, run.stderr);
    assert.match(await received, /^\{\n/);
    assert.ok((await lstat(fifo)).isFIFO());
  });

  test('rewriting an existing file keeps its permissions and never widens them', async () => {
    const path = join(dir, 'kept.json');
    await writeFile(path, 'x');
    await chmod(path, 0o640);
    const run = await cli.run(['export', 'api.json', '--format', 'json', '-o', 'kept.json']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal((await stat(path)).mode & 0o777, 0o640);
    await Fs.writeFileAtomic(path, 'secret', { mode: 0o600 });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await Fs.writeFileAtomic(path, 'shared', { mode: 0o644 });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await Fs.assertWritable(join(dir, 'pipe-check'));
    await assert.rejects(Fs.assertWritable(join(dir, 'real')), /it is a directory/);
  });

  test('build, export and capture --from-har refuse an output that is the input under another name (NEW-OVERWRITE-ALIAS)', async () => {
    await symlink('capture.json', join(dir, 'capture-link.json'));
    await link(join(dir, 'capture.json'), join(dir, 'capture-hard.json'));
    for (const args of [
      ['build', 'capture-link.json', '-o', 'capture.json'],
      ['build', 'capture.json', '-o', 'capture-link.json'],
      ['build', 'capture-hard.json', '-o', 'capture.json'],
    ]) {
      const run = await cli.run(args);
      assert.equal(run.code, 2, `${args.join(' ')}: ${run.stderr}`);
      assert.match(run.stderr, /^error: --out must not overwrite the input file\n/);
    }
    assert.deepEqual(await readFile(join(dir, 'capture.json')), captureBytes);
    await link(join(dir, 'api.json'), join(dir, 'api-hard.json'));
    const exported = await cli.run(['export', 'api-hard.json', '--format', 'json', '-o', 'api.json']);
    assert.equal(exported.code, 2, exported.stderr);
    assert.match(exported.stderr, /^error: --out must not overwrite the input file\n/);
    await symlink('devtools.har', join(dir, 'har-link.json'));
    const converted = await cli.run(['capture', '--from-har', 'devtools.har', '-o', 'har-link.json']);
    assert.equal(converted.code, 2, converted.stderr);
    assert.match(converted.stderr, /^error: --out must not overwrite the HAR file\n/);
  });
});

describe('-o - writes to stdout in every command that writes one file, and never creates a file named - (QTS-R4)', () => {
  let dir: string;
  let cli: CliHarness;
  let capture: Capture;
  const dash = (): string => join(dir, '-');

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-stdout-'));
    cli = new CliHarness(dir);
    capture = CaptureFactory.fixture().capture;
    await new CaptureStore().save(join(dir, 'capture.json'), capture);
    await writeFile(join(dir, 'devtools.har'), JSON.stringify(new HarConverter().toHar(capture)));
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  const runner = (behavior: { fail?: AppiiError } = {}): CaptureRunner =>
    new CaptureRunner({
      sessions: (options) => ({
        run: async () => {
          options.onReady?.();
          if (behavior.fail) throw behavior.fail;
          return capture;
        },
        stop: () => undefined,
      }),
    });

  const registry = (behavior: { fail?: AppiiError } = {}): CommandRegistry => {
    const saver = new CaptureSaver();
    return new CommandRegistry().register(new CaptureCommand({ runner: runner(behavior), saver })).register(new RunCommand({ runner: runner(behavior), saver }));
  };

  test('build -o - prints the API model on stdout and the report on stderr', async () => {
    const run = await cli.run(['build', 'capture.json', '-o', '-']);
    assert.equal(run.code, 0, run.stderr);
    const model = JSON.parse(run.stdout) as { endpoints: unknown[]; source: { file?: string } };
    assert.equal(model.endpoints.length, 12);
    assert.equal(model.source.file, 'capture.json');
    assert.equal(run.stdout, ModelStore.serialize(model as never));
    assert.match(run.stderr, /^Wrote the API model to stdout \(12 endpoints\)\n/);
    assert.doesNotMatch(run.stderr, /Next|list - /);
    assert.equal(await Fs.exists(dash()), false);
  });

  test('capture --from-har -o - prints the capture on stdout and the summary on stderr', async () => {
    const run = await cli.run(['capture', '--from-har', 'devtools.har', '-o', '-']);
    assert.equal(run.code, 0, run.stderr);
    const converted = JSON.parse(run.stdout) as Capture;
    assert.ok(CaptureStore.isCapture(converted));
    assert.equal(converted.exchanges.length, capture.exchanges.length);
    assert.match(run.stderr, /^Capture written to stdout\n/);
    assert.doesNotMatch(run.stderr, /Next: appii build/);
    assert.equal(await Fs.exists(dash()), false);
  });

  test('a recording with -o - prints the capture on stdout, and a partial recording also goes to stdout', async () => {
    const run = await cli.run(['capture', 'https://example.com/', '--headless', '-o', '-'], { registry: registry() });
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stdout, CaptureStore.serialize(capture));
    assert.match(run.stderr, /^Recording headless until the network is idle\. Press Ctrl\+C to stop early\.\nCapture written to stdout\n/);
    const crashed = await cli.run(['capture', 'https://example.com/', '--headless', '-o', '-'], { registry: registry({ fail: new AppiiError('BROWSER', CaptureSession.BROWSER_LOST, { details: { capture } }) }) });
    assert.equal(crashed.code, 1);
    assert.equal(crashed.stdout, CaptureStore.serialize(capture));
    assert.match(crashed.stderr, new RegExp(`\\nerror: ${CaptureSession.BROWSER_LOST}\\. The ${capture.exchanges.length} requests recorded until then were written to stdout\\n$`));
    assert.equal(await Fs.exists(dash()), false);
  });

  test('run --out-dir - is refused, because run writes two files', async () => {
    const run = await cli.run(['run', 'https://example.com/', '--headless', '--out-dir', '-'], { registry: registry() });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /^error: --out-dir - is not supported: run writes capture\.json and api\.json into a directory; use --out-dir <dir>/);
    assert.equal(await Fs.exists(dash()), false);
  });

  test('an existing file named - is never touched by -o -, and ./- still names that file', async () => {
    await writeFile(dash(), 'keep me');
    for (const args of [
      ['build', 'capture.json', '-o', '-'],
      ['capture', '--from-har', 'devtools.har', '-o', '-'],
    ]) {
      const run = await cli.run(args);
      assert.equal(run.code, 0, `${args.join(' ')}: ${run.stderr}`);
      assert.equal(await readFile(dash(), 'utf8'), 'keep me');
    }
    const exported = await cli.run(['export', 'capture.json', '--format', 'json', '-o', '-']);
    assert.equal(exported.code, 0, exported.stderr);
    assert.equal(await readFile(dash(), 'utf8'), 'keep me');
    const explicit = await cli.run(['build', 'capture.json', '-o', './-']);
    assert.equal(explicit.code, 0, explicit.stderr);
    assert.match(await readFile(dash(), 'utf8'), /^\{\n/);
    assert.deepEqual((await readdir(dir)).filter((name) => name.startsWith('-')), ['-']);
  });

  test('the help of build and capture documents - for stdout', async () => {
    for (const command of ['build', 'capture', 'export']) {
      const help = await cli.run(['help', command, '--width', '200']);
      assert.match(help.stdout, /-o, --out <file> +.*or - for stdout/, command);
    }
  });
});
