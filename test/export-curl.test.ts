import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CurlExporter, ShellScript } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { Text } from '../src/shared/index.js';
import { ExportModel } from './helpers/export-model.js';
import type { ExportFixture } from './helpers/export-model.js';

interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function run(file: string, args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    const clean: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C', ...env };
    execFile('bash', [file, ...args], { env: clean, timeout: 20_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout, stderr });
    });
  });
}

describe('CurlExporter against the fixture site', () => {
  let fixture: ExportFixture;
  let model: ApiModel;
  let dir: string;
  let script: string;
  let content: string;
  const exporter = new CurlExporter();

  before(async () => {
    fixture = await ExportModel.fixture();
    model = fixture.model;
    dir = await mkdtemp(join(tmpdir(), 'appii-curl-'));
    script = join(dir, 'endpoints.sh');
    content = exporter.export(model).content;
    await writeFile(script, content);
  });

  after(async () => {
    await fixture?.site.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the script header, variables and syntax', async () => {
    const result = exporter.export(model);
    assert.equal(result.filename, 'endpoints.sh');
    assert.equal(result.format, 'curl');
    assert.ok(Text.isAscii(content));
    assert.ok(content.startsWith('#!/usr/bin/env bash\n'));
    assert.match(content, /\nset -euo pipefail\n/);
    assert.match(content, new RegExp(`\\nDEFAULT_BASE_URL='${fixture.site.origin.replace(/\./g, '\\.')}'\\nBASE_URL="\\$\\{BASE_URL:-\\$DEFAULT_BASE_URL\\}"\\n`));
    assert.match(content, /\nDEFAULT_COOKIE='theme=dark'\nCOOKIE="\$\{COOKIE-\$DEFAULT_COOKIE\}"\n/);
    for (const name of ['CSRF_TOKEN', 'PASSWORD', 'X_CSRF_TOKEN']) assert.ok(content.includes(`: "\${${name}:=}"\n`), name);
    assert.match(content, /\ncreateItem\(\) \{\n {2}local X_CSRF_TOKEN="\$\{X_CSRF_TOKEN:-\$\(appii_cookie 'csrf'\)\}"\n {2}curl -sS -X POST "\$\{BASE_URL\}\/api\/items" \\\n/);
    const syntax = await new Promise<RunResult>((resolve) =>
      execFile('bash', ['-n', script], (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr })),
    );
    assert.deepEqual(syntax, { code: 0, stdout: '', stderr: '' });
  });

  test('without arguments the script lists the endpoints with numbers', async () => {
    const result = await run(script, []);
    assert.equal(result.code, 0);
    const lines = result.stdout.trimEnd().split('\n');
    assert.match(lines[0] ?? '', /^ #\s+METHOD\s+PATH\s+FUNCTION$/);
    assert.equal(lines.length, model.endpoints.length + 1);
    assert.match(result.stdout, /\n 5 {2}GET {5}\/api\/items\/\{itemId\} {2}getItem\n/);
  });

  test('endpoint functions run against the site by name and by number', async () => {
    const env = { BASE_URL: fixture.site.origin };
    const item = await run(script, ['getItem'], env);
    assert.equal(item.code, 0, item.stderr);
    assert.deepEqual(JSON.parse(item.stdout), fixture.site.items[0]);
    const byNumber = await run(script, ['5'], env);
    assert.deepEqual(JSON.parse(byNumber.stdout), fixture.site.items[0]);
    const list = await run(script, ['listItems'], env);
    const page = JSON.parse(list.stdout) as { items: { id: number }[]; page: number };
    assert.equal(page.page, 1);
    assert.deepEqual(page.items.map((i) => i.id), [1, 2]);
    const last = fixture.site.requests.at(-1);
    assert.equal(last?.path, '/api/items?page=1&limit=2');
    assert.equal(last?.headers.cookie, 'theme=dark');
  });

  test('extra arguments are passed to curl and unknown endpoints fail with status 2', async () => {
    const env = { BASE_URL: fixture.site.origin };
    const head = await run(script, ['getItem', '-i'], env);
    assert.match(head.stdout, /^HTTP\/1\.1 200 OK\r\n/);
    const unknown = await run(script, ['nope'], env);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /^Unknown endpoint: nope\n\n #\s+METHOD/);
    const help = await run(script, ['--help']);
    assert.match(help.stdout, /^Usage: bash endpoints\.sh/);
  });

  test('a CSRF header sourced from a cookie is taken from COOKIE', async () => {
    const before = fixture.site.items.length;
    const result = await run(script, ['createItem'], { BASE_URL: fixture.site.origin, COOKIE: 'theme=dark; csrf=0123456789abcdef' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).name, 'Thing');
    assert.equal(fixture.site.items.length, before + 1);
    const request = fixture.site.requests.at(-1);
    assert.equal(request?.headers['x-csrf-token'], '0123456789abcdef');
    const explicit = await run(script, ['createItem'], { BASE_URL: fixture.site.origin, COOKIE: 'csrf=aaaaaaaaaaaa', X_CSRF_TOKEN: 'bbbbbbbbbbbb' });
    assert.equal(JSON.parse(explicit.stdout).error, 'csrf token mismatch');
    const empty = await run(script, ['getMe'], { BASE_URL: fixture.site.origin, COOKIE: '' });
    assert.equal(JSON.parse(empty.stdout).error, 'unauthorized');
    assert.equal(fixture.site.requests.at(-1)?.headers.cookie, undefined);
  });

  test('non-ASCII and multi-line values survive the ASCII-only script', async () => {
    const echo = ExportModel.endpoint({
      method: 'POST',
      path: '/echo',
      origin: 'https://shop.example.com',
      id: 'post-echo',
      name: 'test',
      requestBody: { mimeType: 'application/json', kind: 'json', examples: [{ name: 'Caf\u00e9 \u{1F600}', note: "it's \"quoted\" $HOME `x`" }] },
    });
    const form = ExportModel.endpoint({
      method: 'PUT',
      path: '/echo',
      kind: 'form',
      id: 'put-echo',
      name: 'putEcho',
      requestBody: { mimeType: 'application/x-www-form-urlencoded', kind: 'form', examples: [{ bio: 'Hello\nw\u00f6rld', tag: ['a b', 'c'] }] },
    });
    const text = new CurlExporter().export(ExportModel.model([echo, form])).content;
    assert.ok(Text.isAscii(text));
    assert.match(text, /\ntestEndpoint\(\) \{\n/);
    const file = join(dir, 'echo.sh');
    await writeFile(file, text);
    const json = await run(file, ['testEndpoint'], { BASE_URL: fixture.site.origin });
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(json.stdout).body), { name: 'Caf\u00e9 \u{1F600}', note: "it's \"quoted\" $HOME `x`" });
    const urlencoded = await run(file, ['putEcho'], { BASE_URL: fixture.site.origin });
    const echoed = JSON.parse(urlencoded.stdout) as { method: string; body: string };
    assert.equal(echoed.method, 'PUT');
    assert.deepEqual([...new URLSearchParams(echoed.body)], [
      ['bio', 'Hello\nw\u00f6rld'],
      ['tag', 'a b'],
      ['tag', 'c'],
    ]);
  });
});

describe('ShellScript', () => {
  test('ascii encodes non-ASCII characters per quoting context', () => {
    assert.equal(ShellScript.ascii("echo 'caf\u00e9'"), "echo 'caf'$'\\303\\251'''");
    assert.equal(ShellScript.ascii('echo "caf\u00e9"'), `echo "caf"$'\\303\\251'""`);
    assert.equal(ShellScript.ascii('echo caf\u00e9'), "echo caf$'\\303\\251'");
    assert.equal(ShellScript.ascii('echo \\\u00e9'), "echo $'\\303\\251'");
    assert.equal(ShellScript.ascii('echo "\\\u00e9"'), `echo "\\\\"$'\\303\\251'""`);
    assert.equal(ShellScript.ascii("echo '\\' \u00e9"), "echo '\\' $'\\303\\251'");
  });

  test('indent only indents lines that start outside quotes', () => {
    assert.equal(ShellScript.indent("curl 'a\nb' \\\n  -x", 2), "  curl 'a\nb' \\\n    -x");
    assert.equal(ShellScript.indent('x "a\\\nb"\ny', 2), '  x "a\\\nb"\n  y');
  });

  test('the encoded strings evaluate to the original bytes in bash', async () => {
    const value = "a'b\"c\u00e9 \u{1F600} $x `y` \\z\nnext";
    const command = ShellScript.ascii(`printf '%s' ${Text.shellQuote(value)}`);
    assert.ok(Text.isAscii(command));
    const out = await new Promise<string>((resolve, reject) =>
      execFile('bash', ['-c', command], { env: { LANG: 'C' } }, (err, stdout) => (err ? reject(err) : resolve(stdout))),
    );
    assert.equal(out, value);
  });
});
