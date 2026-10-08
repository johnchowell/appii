import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ModelBuilder } from '../src/build/index.js';
import { CurlExporter } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { LoginShell } from './helpers/login-shell.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

class CountingSite {
  readonly requests: { url: string; cookie: string }[] = [];
  origin = '';
  host = '';
  #server: Server | undefined;

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      this.requests.push({ url: req.url ?? '', cookie: req.headers.cookie ?? '' });
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>book</title>');
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.host = `127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
    this.origin = `http://${this.host}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }
}

function run(file: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return LoginShell.run([file, ...args], dirname(file), env);
}

function shell(args: string[], input: string, cwd?: string): Promise<RunResult> {
  return LoginShell.run(args, cwd ?? process.cwd(), {}, input);
}

function booksModel(origin: string): ApiModel {
  const f = new CaptureFactory(origin);
  const cookie = { requestHeaders: { cookie: 'sessionid=SECRET123' } };
  f.document('/catalogue/the-exiled_247/index.html', CaptureFactory.page('The Exiled', '<h1>The Exiled</h1>'), cookie);
  f.json('GET', '/api/items/1', 200, { id: 1 }, cookie);
  f.json('GET', '/api/items/2', 200, { id: 2 }, cookie);
  f.json('GET', '/api/items/3', 200, { id: 3 }, cookie);
  return ModelBuilder.create().build(f.capture());
}

describe('the curl script and the shell that runs or sources it (BOOKS-R1, BOOKS-R2)', () => {
  const site = new CountingSite();
  const stray = new CountingSite();
  let dir = '';
  let file = '';
  let page = '';
  let item = '';

  before(async () => {
    await site.start();
    await stray.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-curl-shell-'));
    const model = booksModel(site.origin);
    file = join(dir, 'endpoints.sh');
    await writeFile(file, new CurlExporter().export(model).content);
    const names = new CurlExporter().functionNames(model.endpoints);
    const name = (path: string): string => names.get(model.endpoints.find((endpoint: Endpoint) => endpoint.path === path) as Endpoint) ?? '';
    page = name('/catalogue/the-exiled_247/index.html');
    item = name('/api/items/{itemId}');
    assert.ok(page && item, [...names.values()].join(', '));
  });

  after(async () => {
    await site.stop();
    await stray.stop();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('sourcing the script leaves the options of the shell alone and errors do not end an interactive shell (BOOKS-R1)', async () => {
    const same = await shell(['--norc', '--noprofile', '-c', `o=$-; source ${JSON.stringify(file)}; [[ $- == "$o" ]] && ! shopt -qo pipefail`], '', dir);
    assert.equal(same.code, 0, same.stderr);
    const lines = [
      `source ${JSON.stringify(file)}`,
      `${page} stray-value`,
      `APPII_BASE_URL=http://127.0.0.1:9 ${page}`,
      'nosuchcommand_appii',
      'echo "SURVIVED $-"',
      'shopt -qo pipefail && echo PIPEFAIL',
      'exit 0',
    ];
    const interactive = await shell(['--norc', '--noprofile', '-i'], lines.join('\n') + '\n', dir);
    const survived = /SURVIVED (\S+)/.exec(interactive.stdout);
    assert.ok(survived, interactive.stdout + interactive.stderr);
    assert.ok(!/[eu]/.test(survived[1] ?? ''), survived[1]);
    assert.ok(!interactive.stdout.includes('PIPEFAIL'));
    assert.match(interactive.stderr, /unexpected argument stray-value/);
    const strict = await run(file, [item, '2', '3']);
    assert.equal(strict.code, 2);
    const text = await readFile(file, 'utf8');
    assert.ok(text.endsWith('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then\n  set -euo pipefail\n  main "$@"\nfi\n'));
  });

  test('a value after "--" or after a curl option never reaches curl as a second URL (BOOKS-R2)', async () => {
    const env = { APPII_BASE_URL: site.origin, APPII_COOKIE: 'sessionid=SECRET123' };
    const out = join(dir, 'out.html');
    const before = site.requests.length;
    for (const args of [
      [page, '--', `${stray.host}/a-light-in-the-attic_1000`],
      [page, '-s', `${stray.host}/stray`],
      [page, '-i', 'a-light-in-the-attic_1000', '-o', out],
      [page, '-o', out, `${stray.host}/x`],
      [page, '--url', `${stray.host}/u`],
      [page, '--next', `${stray.host}/n`],
      [page, '-:', `${stray.host}/n`],
      [page, '-'],
      [item, '2', '--', '3'],
    ]) {
      const result = await run(file, args, env);
      assert.equal(result.code, 2, `${args.join(' ')}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /^[A-Za-z0-9_]+: (unexpected argument|curl option)/, result.stderr);
    }
    assert.equal(site.requests.length, before);
    assert.deepEqual(stray.requests, []);
  });

  test('curl options with values, attached values and option clusters still work', async () => {
    const env = { APPII_BASE_URL: site.origin };
    const out = join(dir, 'page.html');
    for (const args of [
      [page, '-o', out, '-w', '%{http_code}'],
      [page, '-so', out],
      [page, `-o${out}`],
      [page, '-H', 'X-A: 1', '-o', out],
      [page, '--max-time', '5', '--output', out],
      [page, '-sS', '-o', out],
      [item, '2', '-o', out],
    ]) {
      const before = site.requests.length;
      const result = await run(file, args, env);
      assert.equal(result.code, 0, `${args.join(' ')}: ${result.stderr}`);
      assert.equal(site.requests.length, before + 1, args.join(' '));
    }
    assert.deepEqual(stray.requests, []);
  });
});
