import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readlink, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureStore, HarConverter } from '../src/capture/index.js';
import { Fs } from '../src/shared/index.js';
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
