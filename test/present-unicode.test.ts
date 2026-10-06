import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelBuilder } from '../src/build/index.js';
import type { ApiModel } from '../src/model/index.js';
import { EndpointDetailPresenter } from '../src/present/index.js';
import { Text } from '../src/shared/index.js';
import { CliHarness } from './helpers/cli-harness.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const AUTHOR = 'Andr\u00e9 Gide';
const WIDE = '\u4e2d\u6587\u6807\u9898';
const BIDI = 'x\u202ey';

function capture(): ReturnType<CaptureFactory['capture']> {
  const f = new CaptureFactory();
  for (const q of [AUTHOR, WIDE, BIDI]) f.json('GET', `/api/search?q=${encodeURIComponent(q)}`, 200, { hits: [q] });
  return f.capture();
}

function model(): ApiModel {
  return ModelBuilder.create({ now: new Date(0) }).build(capture());
}

function tableLines(text: string): string[] {
  return text.split('\n').filter((line) => line.startsWith('|') || line.startsWith('+'));
}

describe('terminal output stays ASCII by default, and --unicode shows site text as UTF-8 (QTS-7)', () => {
  const built = model();
  const ref = built.endpoints[0]?.id ?? '';
  let dir = '';
  let cli: CliHarness;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-unicode-'));
    await writeFile(join(dir, 'api.json'), JSON.stringify(built));
    await writeFile(join(dir, 'capture.json'), JSON.stringify(capture()));
    cli = new CliHarness(dir);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test('the default is ASCII with \\u escapes', () => {
    const out = new EndpointDetailPresenter({ width: 120 }).render({ model: built, ref });
    assert.ok(CliHarness.isAscii(out));
    assert.ok(out.includes('Andr\\u00e9 Gide'), out);
  });

  test('unicode shows the text, keeps control and bidi characters escaped, and aligns tables by display width', () => {
    const out = new EndpointDetailPresenter({ width: 120, unicode: true }).render({ model: built, ref });
    assert.ok(out.includes(AUTHOR), out);
    assert.ok(out.includes(WIDE), out);
    assert.ok(out.includes('x\\u202ey'), out);
    assert.ok(!out.includes('\u202e'));
    const widths = new Set(tableLines(out.slice(out.indexOf('Query parameters'), out.indexOf('Responses'))).map((line) => Text.displayWidth(line)));
    assert.equal(widths.size, 1, out);
  });

  test('every printing command accepts --unicode, and help documents it', async () => {
    const ascii = await cli.run(['list', 'api.json', '--show', '1', '--width', '120']);
    assert.equal(ascii.code, 0, ascii.stderr);
    assert.ok(CliHarness.isAscii(ascii.stdout));
    const unicode = await cli.run(['list', 'api.json', '--show', '1', '--width', '120', '--unicode']);
    assert.equal(unicode.code, 0, unicode.stderr);
    assert.ok(unicode.stdout.includes(AUTHOR), unicode.stdout);
    assert.ok(unicode.stdout.includes('x\\u202ey'));
    const build = await cli.run(['build', 'capture.json', '-o', 'copy.json', '--unicode', '--width', '160']);
    assert.equal(build.code, 0, build.stderr);
    assert.ok(build.stdout.includes('q*'), build.stdout);
    for (const command of ['list', 'build', 'export', 'capture', 'run']) {
      const help = await cli.run(['help', command]);
      assert.match(help.stdout, /--unicode +Show site text as UTF-8/, command);
    }
  });
});
