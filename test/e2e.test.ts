import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Page } from 'playwright';
import { Build, Capture, Cli, Export, Present, Shared, main } from '../src/index.js';
import type { Model } from '../src/index.js';
import { FIXTURE_USER, startFixtureSite } from './fixtures/site.js';
import type { FixtureSite } from './fixtures/site.js';
import { CliHarness } from './helpers/cli-harness.js';

const TSC = resolve('node_modules/.bin/tsc');
const TSX = import.meta.resolve('tsx');
const STRICT = ['--strict', '--target', 'ES2022', '--lib', 'ES2022,DOM', '--module', 'ESNext', '--moduleResolution', 'Bundler', '--noEmit', '--skipLibCheck', '--types', ''];

interface ProcessResult {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(file: string, args: string[], cwd: string, timeout = 120_000): Promise<ProcessResult> {
  return new Promise((done) => {
    execFile(file, args, { cwd, timeout, env: { ...process.env, NO_COLOR: '1' } }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

function script(site: FixtureSite): (page: Page) => Promise<void> {
  return async (page) => {
    await page.goto(`${site.origin}/login`);
    await page.evaluate("fetch('/api/me').then((r) => r.text())");
    await page.fill('#email', FIXTURE_USER.email);
    await page.fill('#password', FIXTURE_USER.password);
    await Promise.all([page.waitForURL('**/account'), page.click('#login button[type=submit]')]);
    await page.evaluate("fetch('/api/me').then((r) => r.json())");
    await page.goto(`${site.origin}/app`);
    await page.waitForFunction("document.getElementById('out') && document.getElementById('out').textContent === 'done 2'");
    await page.goto(`${site.origin}/signup`);
  };
}

function endpoint(model: Model.ApiModel, method: string, path: string): Model.Endpoint {
  const found = model.endpoints.find((e) => e.method === method && e.path === path);
  assert.ok(found, `${method} ${path}`);
  return found;
}

describe('end to end: capture, build, list and export the fixture site through the root barrel', () => {
  let site: FixtureSite;
  let fresh: FixtureSite;
  let dir: string;
  let capture: Model.Capture;
  let model: Model.ApiModel;

  before(async () => {
    site = await startFixtureSite();
    fresh = await startFixtureSite();
    dir = await mkdtemp(join(tmpdir(), 'appii-e2e-'));
    capture = await Capture.CaptureSession.create({ url: site.url, headless: true, idleMs: 400, script: script(site) }).run();
    model = Build.ModelBuilder.create().build(capture);
    await new Capture.CaptureStore().save(join(dir, 'capture.json'), capture);
    await new Cli.ModelStore().save(join(dir, 'api.json'), model);
  });

  after(async () => {
    await site?.close();
    await fresh?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the capture recorded the scripted session', () => {
    const paths = capture.exchanges.map((e) => `${e.request.method} ${new URL(e.request.url).pathname}`);
    for (const expected of ['GET /login', 'POST /login', 'GET /account', 'GET /api/me', 'GET /app', 'GET /api/items/1', 'POST /graphql', 'GET /signup']) {
      assert.ok(paths.includes(expected), expected);
    }
    assert.ok(capture.cookies.some((cookie) => cookie.name === 'auth' && cookie.httpOnly));
    assert.ok(capture.pages.some((page) => page.url.endsWith('/signup')));
  });

  test('the endpoint list shows the templated item path and the login form endpoint with its CSRF source', () => {
    const presenters = new Present.PresenterFactory({ width: 160 });
    const list = presenters.list().render(model);
    assert.match(list, /\/api\/items\/\{itemId\}/);
    assert.match(list, /\| POST +\| \/login +\|/);
    const login = endpoint(model, 'POST', '/login');
    assert.equal(login.kind, 'form');
    assert.deepEqual(login.auth.csrf.map((token) => [token.location, token.name, token.source]), [['body', 'csrf_token', 'hidden-field']]);
    assert.equal(login.form?.enctype, 'application/x-www-form-urlencoded');
    const detail = presenters.detail().render({ model, ref: login.name });
    assert.match(detail, /csrf_token/);
    assert.match(detail, /hidden-field/);
    const signup = endpoint(model, 'POST', '/signup');
    assert.equal(signup.form?.enctype, 'multipart/form-data');
    const index = Shared.EndpointIndex.of(model);
    assert.equal(index.require(login.name), login);
  });

  test('the TypeScript client compiles with tsc --strict and logs in against a fresh fixture', async () => {
    const result = Export.ExporterRegistry.default().export(model, 'typescript');
    const clientName = Export.TypeScriptExporter.clientName(model);
    const login = endpoint(model, 'POST', '/login').name;
    const me = endpoint(model, 'GET', '/api/me').name;
    const work = join(dir, 'ts');
    await mkdir(work);
    await writeFile(join(work, 'package.json'), JSON.stringify({ type: 'module' }));
    await writeFile(join(work, 'client.ts'), result.content);
    await writeFile(
      join(work, 'usage.ts'),
      [
        `import { ${clientName} } from './client.js';`,
        '',
        'export async function loginAndMe(baseUrl: string, email: string, password: string): Promise<{ login: number; me: number; email: string }> {',
        `  const client = new ${clientName}({ baseUrl });`,
        `  const login = await client.${login}({ body: { email, password } });`,
        `  const me = await client.${me}();`,
        "  return { login: login.status, me: me.status, email: me.status === 200 ? me.data.email : '' };",
        '}',
      ].join('\n'),
    );
    const compiled = await exec(TSC, [...STRICT, 'client.ts', 'usage.ts'], work);
    assert.equal(compiled.stdout + compiled.stderr, '');
    assert.equal(compiled.code, 0);
    const usage = (await import(pathToFileURL(join(work, 'usage.ts')).href)) as {
      loginAndMe(baseUrl: string, email: string, password: string): Promise<{ login: number; me: number; email: string }>;
    };
    assert.deepEqual(await usage.loginAndMe(fresh.origin, FIXTURE_USER.email, FIXTURE_USER.password), { login: 200, me: 200, email: FIXTURE_USER.email });
    const session = [...fresh.sessions.values()].find((s) => s.user === FIXTURE_USER.email);
    assert.ok(session);
    const post = fresh.requests.find((r) => r.method === 'POST' && r.path === '/login');
    assert.equal(new URLSearchParams(post?.body).get('csrf_token'), session.csrf);
  });

  test('the OpenAPI export has the expected paths and operations', () => {
    const doc = new Export.OpenApiExporter().document(model, model.endpoints) as {
      openapi: string;
      paths: Record<string, Record<string, { requestBody?: { content: Record<string, unknown> } }>>;
    };
    assert.equal(doc.openapi, '3.1.0');
    for (const path of ['/login', '/api/me', '/api/items', '/api/items/{itemId}', '/graphql', '/signup', '/app']) assert.ok(doc.paths[path], path);
    assert.ok(doc.paths['/api/items']?.get);
    assert.ok(doc.paths['/api/items']?.post);
    assert.ok(doc.paths['/login']?.post?.requestBody?.content['application/x-www-form-urlencoded']);
    assert.ok(doc.paths['/signup']?.post?.requestBody?.content['multipart/form-data']);
    const exported = JSON.parse(Export.ExporterRegistry.default().export(model, 'openapi').content) as typeof doc;
    assert.deepEqual(Object.keys(exported.paths).sort(), Object.keys(doc.paths).sort());
  });

  test('main() runs the CLI in process and a real process lists the saved model', async () => {
    const harness = new CliHarness(dir);
    const io = harness.io();
    assert.equal(await main(['list', 'api.json', '--width', '140'], io.io), 0);
    assert.match(io.stdout.text, /\/api\/items\/\{itemId\}/);
    const run = await exec(process.execPath, ['--import', TSX, resolve('src/cli.ts'), 'list', join(dir, 'api.json'), '--no-color'], dir);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(run.stderr, '');
    assert.ok(!run.stdout.includes('\x1b['));
    assert.match(run.stdout, /\/api\/items\/\{itemId\}/);
    assert.match(run.stdout, /\| POST +\| \/login +\|/);
    assert.match(run.stdout, /Details: appii list \S+api\.json --show <#>/);
    const show = await exec(process.execPath, ['--import', TSX, resolve('src/cli.ts'), 'list', 'api.json', '--show', endpoint(model, 'POST', '/login').name, '--no-color'], dir);
    assert.equal(show.code, 0, show.stderr);
    assert.match(show.stdout, /hidden-field/);
  });

  test('the build output compiles and dist/cli.js --help works', { timeout: 180_000 }, async () => {
    const root = resolve('node_modules/.cache', `appii-e2e-${process.pid}`);
    const out = join(root, 'dist');
    try {
      await mkdir(root, { recursive: true });
      await copyFile(resolve('package.json'), join(root, 'package.json'));
      const build = await exec(TSC, ['-p', 'tsconfig.build.json', '--outDir', out], resolve('.'), 170_000);
      assert.equal(build.stdout + build.stderr, '');
      assert.equal(build.code, 0);
      const help = await exec(process.execPath, [join(out, 'cli.js'), '--help'], dir);
      assert.equal(help.code, 0, help.stderr);
      assert.match(help.stdout, new RegExp(`^appii ${Shared.Meta.appVersion().replace(/\./g, '\\.')} - `));
      assert.match(help.stdout, /\n  export +Export to OpenAPI/);
      const list = await exec(process.execPath, [join(out, 'cli.js'), 'list', 'api.json', '--json'], dir);
      assert.equal(list.code, 0, list.stderr);
      assert.equal((JSON.parse(list.stdout) as unknown[]).length, model.endpoints.length);
      const library = (await import(pathToFileURL(join(out, 'index.js')).href)) as Record<string, unknown>;
      assert.deepEqual(Object.keys(library).sort(), ['Build', 'Capture', 'Cli', 'Export', 'Forms', 'Present', 'Shared', 'main']);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
