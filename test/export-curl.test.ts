import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CurlExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { Text } from '../src/shared/index.js';
import { LiteralPlaceholderSite } from './fixtures/foundation-literal-placeholders.js';
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
    execFile('bash', [file, ...args], { cwd: dirname(file), env: clean, timeout: 20_000 }, (err, stdout, stderr) => {
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
    assert.ok(content.endsWith('\nif [[ "${BASH_SOURCE[0]}" == "$0" ]]; then\n  set -euo pipefail\n  main "$@"\nfi\n'), content.slice(-200));
    assert.equal(content.match(/set -euo pipefail/g)?.length, 1);
    assert.match(content, new RegExp(`\\nappii_default_base_url='${fixture.site.origin.replace(/\./g, '\\.')}'\\nAPPII_BASE_URL="\\$\\{APPII_BASE_URL:-\\$appii_default_base_url\\}"\\n`));
    assert.match(content, /\nappii_default_cookie='theme=dark'\nAPPII_COOKIE="\$\{APPII_COOKIE-\$appii_default_cookie\}"\n/);
    assert.ok(content.includes(': "${APPII_CSRF:=}"\n'));
    for (const name of ['APPII_CSRF_TOKEN', 'APPII_PASSWORD']) assert.ok(content.includes(`\n  local ${name}="\${${name}:-}"\n`), name);
    assert.ok(!content.includes('X_CSRF_TOKEN'));
    assert.match(content, /\ncreateItem\(\) \{\n {2}local appii_value\n {2}local APPII_CSRF="\$\{APPII_CSRF:-\$\(appii_unpct "\$\(appii_cookie 'csrf'\)"\)\}"\n/);
    assert.match(content, /\n {2}appii_curl_args 'createItem' 'Arguments: \[name=\] \[price=\]\. [^\n]+' "\$@" \|\| return 2\n(?: {2}[^\n]*\n)*? {2}appii_jar \|\| return 2\n {2}curl -sS -X POST "\$\{APPII_BASE_URL\}\/api\/items" \\\n {4}-H [^\n]+\n(?: {4}-H [^\n]+\n)* {4}-b "\$\{APPII_COOKIE\}" \\\n {4}-b "\$APPII_COOKIE_JAR" -c "\$APPII_COOKIE_JAR" \\\n/);
    assert.match(content, /\nappii_default_cookie_jar="\$\(pwd\)"\/'[a-z0-9-]+-cookies\.txt'\nAPPII_COOKIE_JAR="\$\{APPII_COOKIE_JAR:-\$appii_default_cookie_jar\}"\n/);
    const syntax = await new Promise<RunResult>((resolve) =>
      execFile('bash', ['-n', script], (err, stdout, stderr) => resolve({ code: err ? 1 : 0, stdout, stderr })),
    );
    assert.deepEqual(syntax, { code: 0, stdout: '', stderr: '' });
  });

  test('without arguments the script lists the endpoints with numbers', async () => {
    const result = await run(script, []);
    assert.equal(result.code, 0);
    const lines = result.stdout.trimEnd().split('\n');
    assert.match(lines[0] ?? '', /^ #\s+METHOD\s+PATH\s+FUNCTION\s+ARGUMENTS$/);
    assert.equal(lines.length, model.endpoints.length + 1);
    assert.match(result.stdout, /\n 5 {2}GET {5}\/api\/items\/\{itemId\} {2}getItem +\[ITEM_ID\]\n/);
  });

  test('endpoint functions run against the site by name and by number', async () => {
    const env = { APPII_BASE_URL: fixture.site.origin };
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
    const env = { APPII_BASE_URL: fixture.site.origin };
    const head = await run(script, ['getItem', '-i'], env);
    const second = await run(script, ['getItem', '2'], env);
    assert.deepEqual(JSON.parse(second.stdout), fixture.site.items[1]);
    assert.equal(fixture.site.requests.at(-1)?.path, '/api/items/2');
    assert.match(head.stdout, /^HTTP\/1\.1 200 OK\r\n/);
    const unknown = await run(script, ['nope'], env);
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /^Unknown endpoint: nope\n\n #\s+METHOD/);
    const help = await run(script, ['--help']);
    assert.match(help.stdout, /^Usage: bash endpoints\.sh/);
  });

  test('a CSRF header sourced from a cookie is taken from APPII_COOKIE', async () => {
    const before = fixture.site.items.length;
    const result = await run(script, ['createItem'], { APPII_BASE_URL: fixture.site.origin, APPII_COOKIE: 'theme=dark; csrf=0123456789abcdef' });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).name, 'Thing');
    assert.equal(fixture.site.items.length, before + 1);
    const request = fixture.site.requests.at(-1);
    assert.equal(request?.headers['x-csrf-token'], '0123456789abcdef');
    const explicit = await run(script, ['createItem'], { APPII_BASE_URL: fixture.site.origin, APPII_COOKIE: 'csrf=aaaaaaaaaaaa', APPII_CSRF: 'bbbbbbbbbbbb' });
    assert.equal(JSON.parse(explicit.stdout).error, 'csrf token mismatch');
    const empty = await run(script, ['getMe'], { APPII_BASE_URL: fixture.site.origin, APPII_COOKIE: '', APPII_COOKIE_JAR: join(dir, 'empty-jar.txt') });
    assert.equal(JSON.parse(empty.stdout).error, 'unauthorized');
    assert.equal(fixture.site.requests.at(-1)?.headers.cookie, undefined);
    const jarred = await run(script, ['getMe'], { APPII_BASE_URL: fixture.site.origin, APPII_COOKIE: '' });
    assert.equal(jarred.code, 0, jarred.stderr);
    assert.match(String(fixture.site.requests.at(-1)?.headers.cookie ?? ''), /\bsid=/, 'the default cookie jar keeps the cookies that earlier calls received, as a browser does');
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
    const json = await run(file, ['testEndpoint'], { APPII_BASE_URL: fixture.site.origin });
    assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(JSON.parse(json.stdout).body), { name: 'Caf\u00e9 \u{1F600}', note: "it's \"quoted\" $HOME `x`" });
    const urlencoded = await run(file, ['putEcho'], { APPII_BASE_URL: fixture.site.origin });
    const echoed = JSON.parse(urlencoded.stdout) as { method: string; body: string };
    assert.equal(echoed.method, 'PUT');
    assert.deepEqual([...new URLSearchParams(echoed.body)], [
      ['bio', 'Hello\nw\u00f6rld'],
      ['tag', 'a b'],
      ['tag', 'c'],
    ]);
  });
});


describe('CurlExporter keeps captured text literal', () => {
  test('captured values that look like placeholders never read environment variables', async () => {
    const model = LiteralPlaceholderSite.model();
    const exporter = new CurlExporter();
    const text = exporter.export(model).content;
    assert.doesNotMatch(text, /: "\$\{[A-Z0-9_]+:=\}"/);
    assert.ok(!/\$\{(?:AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|HOME|PATH|USER|1)\}/.test(text));
    const dir = await mkdtemp(join(tmpdir(), 'appii-curl-literal-'));
    try {
      const file = join(dir, 'endpoints.sh');
      const bin = join(dir, 'bin');
      await mkdir(bin);
      await writeFile(file, text);
      await writeFile(join(bin, 'curl'), '#!/usr/bin/env bash\nfor arg in "$@"; do printf \'ARG[%s]\\n\' "$arg"; done\n', { mode: 0o755 });
      const env = { ...LiteralPlaceholderSite.LEAK_ENV, PATH: `${bin}:${process.env.PATH ?? '/usr/bin:/bin'}` };
      const list = await run(file, [], env);
      assert.equal(list.code, 0, list.stderr);
      const names = [...exporter.functionNames(model.endpoints).values()];
      const outputs: string[] = [];
      for (const name of names) {
        const result = await run(file, [name], env);
        assert.equal(result.code, 0, `${name}: ${result.stderr}`);
        outputs.push(result.stdout);
      }
      const all = outputs.join('');
      assert.ok(!all.includes('leak'), all);
      for (const arg of [
        'https://evil.example.com/api/search?q=%7B%7Baws_secret_access_key%7D%7D',
        'x-trace: {{github_token}}',
        '{"note":"{{home}}","n2":"x{{path}}y"}',
        'comment=%7B%7Buser%7D%7D',
        'c=%7B%7B1%7D%7D',
      ]) {
        assert.ok(all.includes(`ARG[${arg}]`), arg);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('CurlExporter request variables agree with the other renderers', () => {
  test('a bearer endpoint reads APPII_ACCESS_TOKEN and a cookie-sourced CSRF header reads the cookie variable', () => {
    const me = ExportModel.endpoint({
      method: 'POST',
      path: '/api/me',
      headerParams: [
        { name: 'authorization', in: 'header', required: true, schema: { type: 'string' }, examples: ['Bearer <redacted>'] },
        { name: 'x-csrf-token', in: 'header', required: true, schema: { type: 'string' }, examples: ['<redacted>'] },
      ],
      auth: { cookies: ['csrftoken'], headers: ['authorization'], anonymous: 'untested', bearer: true, csrf: [{ location: 'header', name: 'x-csrf-token', source: 'cookie', sourceName: 'csrftoken' }] },
    });
    const text = new CurlExporter().export(ExportModel.model([me])).content;
    assert.ok(text.includes(': "${APPII_ACCESS_TOKEN:=}"\n'), text);
    assert.ok(text.includes('-H "authorization: Bearer ${APPII_ACCESS_TOKEN}"'), text);
    assert.ok(text.includes(`local APPII_CSRFTOKEN="\${APPII_CSRFTOKEN:-$(appii_unpct "$(appii_cookie 'csrftoken')")}"`), text);
    assert.ok(text.includes('-H "x-csrf-token: ${APPII_CSRFTOKEN}"'), text);
    assert.ok(!text.includes('AUTHORIZATION'));
    assert.ok(!text.includes('X_CSRF_TOKEN'));
  });
});

describe('the default cookie of the curl script follows the shared cookie selection (ARCH-3)', () => {
  test('two cookies with the same name on different sites: each endpoint gets the cookie of its own site', () => {
    const auth = { cookies: ['sid'], anonymous: 'untested' as const, bearer: false, headers: [], csrf: [] };
    const a = ExportModel.endpoint({ method: 'GET', path: '/a', origin: 'https://a.example.com', auth });
    const b = ExportModel.endpoint({ method: 'GET', path: '/b', origin: 'https://b.example.org', auth });
    const cookie = (domain: string, value: string, usedBy: string[]): ApiModel['cookies'][number] => ({
      name: 'sid', domain, path: '/', valueExample: value, httpOnly: true, secure: true, sameSite: 'Lax', session: true, expires: null, role: 'session', setBy: [], usedBy,
    });
    const model = ExportModel.model([a, b], { cookies: [cookie('a.example.com', 'A-VALUE', [a.id]), cookie('b.example.org', 'B-VALUE', [b.id])], origins: ['https://a.example.com', 'https://b.example.org'] });
    const curl = new CurlExporter();
    assert.equal(curl.defaultCookie(model, [b]), 'sid=B-VALUE');
    assert.equal(curl.defaultCookie(model, [a]), 'sid=A-VALUE');
    assert.ok(curl.export(model, { endpoints: [b.id] }).content.includes("sid=B-VALUE"));
    assert.ok(!curl.export(model, { endpoints: [b.id] }).content.includes('A-VALUE'));
  });
});
