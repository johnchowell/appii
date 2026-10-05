import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { CaptureStore, HarConverter } from '../src/capture/index.js';
import { CaptureCommand, CaptureRunner, CaptureSaver, CommandRegistry, RunCommand } from '../src/cli/index.js';
import { ModelStore } from '../src/build/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import type { ApiModel, CookieInfo, Endpoint } from '../src/model/index.js';
import { AppiiError, Meta } from '../src/shared/index.js';
import { startFixtureSite } from './fixtures/site.js';
import type { FixtureSite } from './fixtures/site.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { CliHarness } from './helpers/cli-harness.js';
import type { CliRun } from './helpers/cli-harness.js';

const ENDPOINTS = 12;
const TSX = import.meta.resolve('tsx');
const ENTRY = resolve('src/cli.ts');

function json<T>(text: string): T {
  return JSON.parse(text) as T;
}

describe('cli commands', () => {
  let site: FixtureSite;
  let dir: string;
  let cli: CliHarness;
  let built: CliRun;
  let captured: CliRun;
  let model: ApiModel;

  before(async () => {
    site = await startFixtureSite();
    dir = await mkdtemp(join(tmpdir(), 'appii-cli-commands-'));
    cli = new CliHarness(dir);
    await new CaptureStore().save(join(dir, 'fixture.json'), CaptureFactory.fixture().capture);
    built = await cli.run(['build', 'fixture.json', '--width', '160']);
    model = await new ModelStore().load(join(dir, 'api.json'));
    captured = await cli.run(['capture', `${site.origin}/app`, '--headless', '--duration', '2', '-o', 'browser.json']);
  });

  after(async () => {
    await site?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  describe('capture', () => {
    test('a headless capture with --duration records the /app traffic and writes the file', async () => {
      assert.equal(captured.code, 0, captured.stderr);
      assert.equal(captured.stderr, 'Recording headless for 2.0 s. Press Ctrl+C to stop early.\n');
      assert.match(captured.stdout, /^Capture saved to browser\.json\n-+\n\nStart URL: +http:\/\/127\.0\.0\.1:\d+\/app\n/);
      assert.match(captured.stdout, /\nRequests: +\d+ \(1 page, \d+ fetch\/XHR, \d+ other\) to 1 origin\n/);
      assert.match(captured.stdout, /\nCookies: +\d+ \(1 HttpOnly\)\n/);
      assert.match(captured.stdout, /\n\nNext: appii build browser\.json\n$/);
      const capture = await new CaptureStore().load(join(dir, 'browser.json'));
      const urls = capture.exchanges.map((exchange) => `${exchange.request.method} ${new URL(exchange.request.url).pathname}`);
      for (const expected of ['GET /app', 'GET /api/items', 'GET /api/items/1', 'POST /api/items', 'POST /graphql']) assert.ok(urls.includes(expected), expected);
      assert.ok(capture.cookies.some((cookie) => cookie.name === 'sid' && cookie.httpOnly));
      assert.ok(capture.storage.some((entry) => Object.keys(entry.localStorage).length > 0));
      assert.equal((await stat(join(dir, 'browser.json'))).mode & 0o777, CaptureStore.FILE_MODE);
    });

    test('capture --user-agent, --max-total-body and --read-timeout reach the browser and the recorder', async () => {
      const agent = 'appii-cli-test/1.0 (X11; Linux x86_64)';
      const before = site.requests.length;
      const run = await cli.run(['capture', `${site.origin}/app`, '--headless', '--duration', '2', '--user-agent', agent, '--max-total-body', '0', '--read-timeout', '5', '-o', 'options.json']);
      assert.equal(run.code, 0, run.stderr);
      const seen = site.requests.slice(before);
      assert.ok(seen.length > 0);
      assert.ok(seen.every((request) => request.headers['user-agent'] === agent), JSON.stringify(seen.map((request) => request.headers['user-agent'])));
      const capture = await CaptureStore.create().load(join(dir, 'options.json'));
      const bodies = capture.exchanges.flatMap((exchange) => (exchange.response?.body ? [exchange.response.body] : []));
      assert.ok(bodies.length > 0);
      assert.ok(bodies.every((body) => body.truncated === true && body.data === ''), JSON.stringify(bodies.slice(0, 2)));
      const bad = await cli.run(['capture', site.url, '--headless', '--read-timeout', '0']);
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /^error: --read-timeout must be more than 0 seconds, got '0'\n/);
      const help = await cli.run(['help', 'capture', '--width', '200']);
      assert.match(help.stdout, /--max-total-body <bytes> +Total size of all kept bodies; later bodies are marked as truncated \(default: 268435456\)/);
      assert.match(help.stdout, /--read-timeout <sec> +Longest wait for one body after its request ends \(default: 10\)/);
      assert.match(help.stdout, /--user-agent <ua> +User-Agent that the browser sends and reports/);
      const runHelp = await cli.run(['help', 'run', '--width', '200']);
      for (const flag of ['--max-total-body', '--read-timeout', '--user-agent']) assert.match(runHelp.stdout, new RegExp(`\\n +${flag} <`));
    });

    test('a capture that cannot be saved is kept in a fallback file whose path the error names', async () => {
      const capture = CaptureFactory.fixture().capture;
      const fallbackDir = join(dir, 'rescue');
      await mkdir(fallbackDir, { recursive: true });
      const recorded: string[] = [];
      const runner = new CaptureRunner({
        sessions: (options) => ({
          run: async () => {
            recorded.push(options.url ?? '');
            options.onReady?.();
            return capture;
          },
          stop: () => undefined,
        }),
      });
      class FailingStore extends CaptureStore {
        override async save(path: string): Promise<void> {
          throw new AppiiError('IO', `Cannot write ${path}: ENOSPC: no space left on device`);
        }
      }
      const saver = new CaptureSaver({ store: new FailingStore(), fallbackDir: () => fallbackDir });
      const registry = new CommandRegistry().register(new CaptureCommand({ runner, saver })).register(new RunCommand({ runner, saver }));
      const failed = await cli.run(['capture', 'https://example.com/', '--headless', '-o', 'lost.json'], { registry });
      assert.equal(failed.code, 1);
      const match = /; the recording was saved to (\S+)\n$/.exec(failed.stderr);
      assert.ok(match, failed.stderr);
      assert.match(failed.stderr, /^Recording headless until the network is idle\. Press Ctrl\+C to stop early\.\nerror: Cannot write .*lost\.json: ENOSPC: no space left on device; the recording was saved to /);
      const rescued = match[1]!;
      assert.ok(rescued.startsWith(fallbackDir + '/appii-capture-'), rescued);
      assert.equal(await readFile(rescued, 'utf8'), CaptureStore.serialize(capture));
      assert.equal((await stat(rescued)).mode & 0o777, CaptureStore.FILE_MODE);
      assert.equal((await CaptureStore.create().load(rescued)).exchanges.length, capture.exchanges.length);
      const run = await cli.run(['run', 'https://example.com/', '--headless', '--out-dir', 'lost-run'], { registry });
      assert.equal(run.code, 1);
      const runMatch = /; the recording was saved to (\S+)\n$/.exec(run.stderr);
      assert.ok(runMatch, run.stderr);
      assert.equal(await readFile(runMatch[1]!, 'utf8'), CaptureStore.serialize(capture));
      assert.deepEqual(recorded, ['https://example.com/', 'https://example.com/']);
    });

    test('an output location that cannot be written fails before the recording starts', async () => {
      let records = 0;
      const runner = new CaptureRunner({
        sessions: () => ({
          run: async () => {
            records++;
            return CaptureFactory.fixture().capture;
          },
          stop: () => undefined,
        }),
      });
      await writeFile(join(dir, 'plain-file'), 'x');
      const registry = new CommandRegistry().register(new CaptureCommand({ runner, saver: new CaptureSaver() })).register(new RunCommand({ runner, saver: new CaptureSaver() }));
      const blocked = await cli.run(['capture', 'https://example.com/', '--headless', '-o', 'plain-file/capture.json'], { registry });
      assert.equal(blocked.code, 1);
      assert.match(blocked.stderr, /^error: Cannot write .*plain-file\/capture\.json: .*plain-file is not a directory\n$/);
      const denied = new CaptureSaver({ probe: async (path) => { throw new AppiiError('IO', `Cannot write ${path}: EACCES: permission denied`); } });
      const deniedRegistry = new CommandRegistry().register(new CaptureCommand({ runner, saver: denied })).register(new RunCommand({ runner, saver: denied }));
      const capture = await cli.run(['capture', 'https://example.com/', '--headless', '-o', 'denied.json'], { registry: deniedRegistry });
      assert.equal(capture.code, 1);
      assert.match(capture.stderr, /^error: Cannot write .*denied\.json: EACCES: permission denied\n$/);
      const run = await cli.run(['run', 'https://example.com/', '--headless', '--out-dir', 'denied-run'], { registry: deniedRegistry });
      assert.equal(run.code, 1);
      assert.match(run.stderr, /^error: Cannot write .*denied-run\/capture\.json: EACCES/);
      assert.equal(records, 0);
    });

    test('capture --from-har converts a DevTools HAR file', async () => {
      const capture = await new CaptureStore().load(join(dir, 'browser.json'));
      await writeFile(join(dir, 'devtools.har'), JSON.stringify(new HarConverter().toHar(capture)));
      const run = await cli.run(['capture', '--from-har', 'devtools.har', '-o', 'from-har.json']);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stderr, '');
      assert.match(run.stdout, /^Capture saved to from-har\.json\n/);
      assert.match(run.stdout, /Next: appii build from-har\.json\n$/);
      const converted = await new CaptureStore().load(join(dir, 'from-har.json'));
      assert.equal(converted.exchanges.length, capture.exchanges.length);
      const defaultOut = await cli.run(['capture', '--from-har', 'devtools.har']);
      assert.equal(defaultOut.code, 0);
      assert.match(defaultOut.stdout, /^Capture saved to capture\.json\n/);
      const intoDir = await cli.run(['capture', '--from-har', 'devtools.har', '-o', 'captures/']);
      assert.equal(intoDir.code, 0, intoDir.stderr);
      assert.match(intoDir.stdout, /^Capture saved to captures\/capture\.json\n/);
      assert.match(intoDir.stdout, /Next: appii build captures\/capture\.json\n$/);
      const existingDir = await cli.run(['build', 'captures/capture.json', '-o', 'captures']);
      assert.equal(existingDir.code, 0, existingDir.stderr);
      assert.match(existingDir.stdout, /^Wrote captures\/api\.json \(/);
      assert.equal((await new ModelStore().load(join(dir, 'captures', 'api.json'))).source.file, 'capture.json');
    });

    test('capture --from-har accepts a HAR file that starts with a UTF-8 byte order mark', async () => {
      const capture = await CaptureStore.create().load(join(dir, 'browser.json'));
      await writeFile(join(dir, 'bom.har'), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(JSON.stringify(HarConverter.create().toHar(capture)))]));
      const run = await cli.run(['capture', '--from-har', 'bom.har', '-o', 'from-bom.json']);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stderr, '');
      assert.equal((await CaptureStore.create().load(join(dir, 'from-bom.json'))).exchanges.length, capture.exchanges.length);
      const listed = await cli.run(['list', 'bom.har', '--json']);
      assert.equal(listed.code, 0, listed.stderr);
    });

    test('capture usage errors and failures', async () => {
      const both = await cli.run(['capture', 'https://example.com', '--from-har', 'devtools.har']);
      assert.equal(both.code, 2);
      assert.match(both.stderr, /^error: --from-har converts a file and takes no URL \(got 'https:\/\/example\.com'\)\nusage: appii capture <url> \[options\]\n       appii capture --from-har <file\.har> \[-o <file>\]\n/);
      const headless = await cli.run(['capture', '--from-har', 'devtools.har', '--headless']);
      assert.equal(headless.code, 2);
      assert.match(headless.stderr, /--headless applies to recording and cannot be combined with --from-har/);
      const overwrite = await cli.run(['capture', '--from-har', 'devtools.har', '-o', 'devtools.har']);
      assert.equal(overwrite.code, 2);
      const noUrl = await cli.run(['capture', '--headless']);
      assert.equal(noUrl.code, 2);
      assert.match(noUrl.stderr, /^error: missing <url>/);
      const duration = await cli.run(['capture', site.url, '--duration', 'soon']);
      assert.equal(duration.code, 2);
      assert.match(duration.stderr, /--duration must be a number of seconds, got 'soon'/);
      const badUrl = await cli.run(['capture', 'not a url', '--headless']);
      assert.equal(badUrl.code, 1);
      assert.match(badUrl.stderr, /^error: Capture URL is not an absolute URL: not a url\n$/);
      const missingHar = await cli.run(['capture', '--from-har', 'nope.har']);
      assert.equal(missingHar.code, 1);
      assert.match(missingHar.stderr, /^error: File not found: /);
      const state = await cli.run(['capture', site.url, '--headless', '--storage-state', 'state.json']);
      assert.equal(state.code, 1);
      assert.match(state.stderr, /^error: Storage state file not found: .*state\.json\n$/);
      assert.doesNotMatch(state.stderr, /Recording/);
      const refused = await cli.run(['capture', 'http://127.0.0.1:9/', '--headless', '-o', 'refused.json']);
      assert.equal(refused.code, 1);
      assert.match(refused.stderr, /error: Cannot open http:\/\/127\.0\.0\.1:9\/: /);
    });
  });

  describe('build', () => {
    test('build writes api.json and prints the summary and the endpoint table', async () => {
      assert.equal(built.code, 0, built.stderr);
      assert.equal(built.stderr, '');
      assert.match(built.stdout, new RegExp(`^Wrote api\\.json \\(${ENDPOINTS} endpoints\\)\\n\\nshop\\.example\\.com\\n-+\\n`));
      assert.match(built.stdout, /\nSource file: +fixture\.json\n/);
      assert.match(built.stdout, /\n\| +5 \| GET +\| \/api\/items\/\{itemId\} +\|/);
      assert.match(built.stdout, /\n\| +9 \| POST +\| \/login +\|/);
      assert.match(built.stdout, /\nDetails: appii list api\.json --show <#>\nExport: +appii export api\.json --format openapi\n$/);
      assert.match(built.stdout, /\nshop\.example\.com: 12 endpoints at https:\/\/shop\.example\.com\n-+\n\n\+-/);
      assert.doesNotMatch(built.stdout, /^https:\/\/shop\.example\.com \(/m);
      assert.equal(model.endpoints.length, ENDPOINTS);
      assert.equal(model.source.file, 'fixture.json');
      const text = await readFile(join(dir, 'api.json'), 'utf8');
      assert.ok(CliHarness.isAscii(text));
      assert.equal((await stat(join(dir, 'api.json'))).mode & 0o777, 0o644 & ~process.umask());
    });

    test('build options: --name, -o into a directory, --no-documents, --no-redact and --origin', async () => {
      const named = await cli.run(['build', 'fixture.json', '-o', 'out/shop.json', '--name', 'shop', '--no-documents']);
      assert.equal(named.code, 0, named.stderr);
      assert.match(named.stdout, /^Wrote out\/shop\.json \(\d+ endpoints\)\n\nshop\n----\n/);
      assert.match(named.stdout, /Details: appii list out\/shop\.json --show <#>/);
      const shop = await new ModelStore().load(join(dir, 'out', 'shop.json'));
      assert.equal(shop.name, 'shop');
      assert.equal(shop.source.file, '../fixture.json');
      assert.ok(shop.endpoints.every((endpoint) => endpoint.kind !== 'document'));
      assert.ok(shop.endpoints.some((endpoint) => endpoint.path === '/login' && endpoint.method === 'POST'));
      const raw = await cli.run(['build', 'fixture.json', '-o', 'raw.json', '--no-redact']);
      assert.equal(raw.code, 0);
      const rawModel = await new ModelStore().load(join(dir, 'raw.json'));
      const flow = CaptureFactory.fixture();
      assert.ok(rawModel.cookies.some((cookie) => cookie.valueExample === flow.sid));
      assert.ok(!model.cookies.some((cookie) => cookie.valueExample === flow.sid));
      assert.equal((await stat(join(dir, 'raw.json'))).mode & 0o777, 0o600);
      const other = await cli.run(['build', 'fixture.json', '-o', 'other.json', '--origin', 'https://elsewhere.example']);
      assert.equal(other.code, 0);
      assert.equal((await new ModelStore().load(join(dir, 'other.json'))).endpoints.length, 0);
    });

    test('build errors', async () => {
      const fromModel = await cli.run(['build', 'api.json', '-o', 'x.json']);
      assert.equal(fromModel.code, 1);
      assert.match(fromModel.stderr, /^error: .*api\.json is an API model \(api\.json\), not a capture or HAR file\n$/);
      const overwrite = await cli.run(['build', 'fixture.json', '-o', './fixture.json']);
      assert.equal(overwrite.code, 2);
      assert.match(overwrite.stderr, /^error: --out must not overwrite the input file\n/);
      const modelInput = await cli.run(['build', 'api.json']);
      assert.equal(modelInput.code, 1);
      assert.match(modelInput.stderr, /^error: .*api\.json is an API model \(api\.json\), not a capture or HAR file\n$/);
      const collide = join(dir, 'collide');
      await mkdir(collide, { recursive: true });
      await CaptureStore.create().save(join(collide, 'api.json'), CaptureFactory.fixture().capture);
      const named = await new CliHarness(collide).run(['build', 'api.json']);
      assert.equal(named.code, 2);
      assert.match(named.stderr, /^error: the default output api\.json is the input file; pass -o <file>\nusage: appii build /);
      const missing = await cli.run(['build', 'missing.json']);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /^error: File not found: /);
      const origin = await cli.run(['build', 'fixture.json', '--origin', 'nope']);
      assert.equal(origin.code, 2);
      assert.match(origin.stderr, /^error: --origin: Origin 'nope' must be an absolute http\(s\) URL/);
      const none = await cli.run(['build']);
      assert.equal(none.code, 2);
    });
  });

  describe('list', () => {
    test('list prints the endpoint table with stable numbers', async () => {
      const run = await cli.run(['list', 'api.json']);
      assert.equal(run.code, 0, run.stderr);
      assert.match(run.stdout, new RegExp(`^shop\\.example\\.com: ${ENDPOINTS} endpoints at https://shop\\.example\\.com\\n`));
      assert.match(run.stdout, /\/api\/items\/\{itemId\}/);
      assert.ok(CliHarness.widest(run.stdout) <= 100);
      assert.ok(CliHarness.isAscii(run.stdout));
      assert.ok(run.stdout.endsWith('--format openapi\n'));
      const fromCapture = await cli.run(['list', 'fixture.json']);
      assert.equal(fromCapture.code, 0);
      assert.equal(fromCapture.stdout.replace(/fixture\.json/g, 'api.json'), run.stdout);
    });

    test('list --show by number, id and name', async () => {
      const byNumber = await cli.run(['list', 'api.json', '--show', '5']);
      const byId = await cli.run(['list', 'api.json', '--show', 'get-api-items-itemid']);
      const byName = await cli.run(['list', 'api.json', '--show', 'getItem']);
      assert.equal(byNumber.code, 0);
      assert.equal(byNumber.stdout, byId.stdout);
      assert.equal(byNumber.stdout, byName.stdout);
      assert.match(byNumber.stdout, /^GET https:\/\/shop\.example\.com\/api\/items\/\{itemId\}\n#5 /);
      const first = await cli.run(['list', 'api.json', '--show', '1']);
      assert.match(first.stdout, /^GET https:\/\/shop\.example\.com\/\n#1 /);
      const login = await cli.run(['list', 'api.json', '--show', 'postLogin', '--width', '120']);
      assert.match(login.stdout, /hidden-field/);
      assert.match(login.stdout, /csrf_token/);
    });

    test('list --cookies, --filter, --method, --kind, --origin and --first-party', async () => {
      const cookies = await cli.run(['list', 'api.json', '--cookies']);
      assert.equal(cookies.code, 0);
      assert.match(cookies.stdout, /^shop\.example\.com: 4 cookies\n/);
      for (const name of ['auth', 'csrf', 'sid', 'theme']) assert.match(cookies.stdout, new RegExp(`\\| ${name} +\\|`));
      const filtered = await cli.run(['list', 'api.json', '--filter', 'items']);
      assert.match(filtered.stdout, /^shop\.example\.com: 3 of 12 endpoints at https:\/\/shop\.example\.com\n-+\nFilter: text "items"\n/);
      assert.ok(!filtered.stdout.includes('/login'));
      const posts = await cli.run(['list', 'api.json', '--method', 'post', '--kind', 'form']);
      assert.match(posts.stdout, /: 2 of 12 endpoints at https:\/\/shop\.example\.com\n/);
      assert.match(posts.stdout, /\/login/);
      assert.match(posts.stdout, /\/signup/);
      const origin = await cli.run(['list', 'api.json', '--origin', 'elsewhere.example']);
      assert.match(origin.stdout, /No endpoints match the filter\./);
      const firstParty = await cli.run(['list', 'api.json', '--first-party', '--kind', 'graphql']);
      assert.match(firstParty.stdout, /: 1 of 12 endpoints at https:\/\/shop\.example\.com\n/);
      const filteredCookies = await cli.run(['list', 'api.json', '--cookies', '--filter', 'login']);
      assert.match(filteredCookies.stdout, /cookies of endpoints matching/);
      const documents = await cli.run(['list', 'api.json', '--filter', 'document']);
      assert.match(documents.stdout, /No endpoints match the filter\./);
      const help = await cli.run(['help', 'list', '--width', '200']);
      assert.match(help.stdout, /--filter <text> +Only endpoints whose method, path, name, id or GraphQL operation contain every word/);
    });

    test('list --cookies with a filter selects the same cookies in the table and in JSON', async () => {
      for (const args of [['--filter', 'post-login'], ['--method', 'GET', '--kind', 'json'], ['--origin', 'nowhere.example']]) {
        const table = await cli.run(['list', 'api.json', '--cookies', '--width', '200', ...args]);
        const listed = json<CookieInfo[]>((await cli.run(['list', 'api.json', '--cookies', '--json', ...args])).stdout);
        const names = CliHarness.lines(table.stdout)
          .filter((line) => line.startsWith('| ') && !line.startsWith('| NAME'))
          .map((line) => line.split('|')[1]!.trim());
        assert.deepEqual(names, listed.map((cookie) => cookie.name), args.join(' '));
      }
    });

    test('list --show cannot be combined with endpoint filters', async () => {
      const run = await cli.run(['list', 'api.json', '--show', '3', '--method', 'POST']);
      assert.equal(run.code, 2);
      assert.equal(run.stdout, '');
      assert.match(run.stderr, /^error: --show selects one endpoint and cannot be combined with --method\nusage: appii list /);
      const many = await cli.run(['list', 'api.json', '--show', '3', '--filter', 'items', '--first-party', '--json']);
      assert.equal(many.code, 2);
      assert.match(many.stderr, /^error: --show selects one endpoint and cannot be combined with --filter, --first-party\n/);
      const negated = await cli.run(['list', 'api.json', '--show', '3', '--no-first-party']);
      assert.equal(negated.code, 0, negated.stderr);
    });

    test('list --json prints endpoints, one endpoint or cookies', async () => {
      const all = await cli.run(['list', 'api.json', '--json']);
      assert.equal(all.code, 0);
      assert.deepEqual(json<Endpoint[]>(all.stdout), model.endpoints);
      const some = json<Endpoint[]>((await cli.run(['list', 'api.json', '--json', '--method', 'GET', '--filter', 'items'])).stdout);
      assert.deepEqual(some.map((endpoint) => endpoint.id), ['get-api-items', 'get-api-items-itemid']);
      const one = json<Endpoint>((await cli.run(['list', 'api.json', '--json', '--show', 'getItem'])).stdout);
      assert.equal(one.path, '/api/items/{itemId}');
      const cookies = json<CookieInfo[]>((await cli.run(['list', 'api.json', '--json', '--cookies'])).stdout);
      assert.deepEqual(cookies, model.cookies);
      const loginCookies = json<CookieInfo[]>((await cli.run(['list', 'api.json', '--json', '--cookies', '--filter', 'post-login'])).stdout);
      assert.ok(loginCookies.length > 0 && loginCookies.length < cookies.length);
      assert.ok(loginCookies.every((cookie) => cookie.setBy.includes('post-login') || cookie.usedBy.includes('post-login')));
    });

    test('list --width 60 keeps every line within 60 columns', async () => {
      for (const args of [[], ['--show', '12'], ['--show', '9'], ['--cookies'], ['--filter', 'api']]) {
        const run = await cli.run(['list', 'api.json', '--width', '60', ...args]);
        assert.equal(run.code, 0, args.join(' '));
        assert.ok(CliHarness.widest(run.stdout) <= 60, `${args.join(' ')}: ${CliHarness.widest(run.stdout)}`);
      }
      const colored = await cli.run(['list', 'api.json', '--width', '60', '--color']);
      assert.ok(colored.stdout.includes('\x1b['));
      assert.ok(CliHarness.widest(colored.stdout) <= 60);
    });

    test('list errors: unknown --show reference, missing and invalid files', async () => {
      const unknown = await cli.run(['list', 'api.json', '--show', 'nothing-like-this']);
      assert.equal(unknown.code, 1);
      assert.equal(unknown.stdout, '');
      assert.equal(unknown.stderr, "error: No endpoint matches 'nothing-like-this' (use a list number, id, or name)\n");
      const suggested = await cli.run(['list', 'api.json', '--show', 'items']);
      assert.equal(suggested.code, 1);
      assert.match(suggested.stderr, /^error: No endpoint matches 'items' .*\nDid you mean:\n  3 listItems\n  4 createItem\n  5 getItem\n$/);
      const outOfRange = await cli.run(['list', 'api.json', '--show', '99']);
      assert.equal(outOfRange.code, 1);
      const missing = await cli.run(['list', 'missing.json']);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /^error: File not found: .*missing\.json\n$/);
      await writeFile(join(dir, 'broken.json'), JSON.stringify({ version: 1, endpoints: [{ id: 1 }] }));
      const broken = await cli.run(['list', 'broken.json']);
      assert.equal(broken.code, 1);
      assert.match(broken.stderr, /^error: .*broken\.json is not a valid API model \(api\.json\): .*\nProblems:\n  name: expected a string\n/);
      await writeFile(join(dir, 'garbage.json'), '{ nope');
      const garbage = await cli.run(['list', 'garbage.json']);
      assert.equal(garbage.code, 1);
      assert.match(garbage.stderr, /garbage\.json is not valid JSON/);
    });
  });

  describe('export', () => {
    const expected: Record<string, string> = {
      openapi: 'openapi.json',
      'openapi-yaml': 'openapi.yaml',
      postman: 'postman_collection.json',
      curl: 'endpoints.sh',
      typescript: 'shop-example-com-client.ts',
      har: 'capture.har',
      html: 'report.html',
      markdown: 'API.md',
      json: 'api.json',
    };

    test('export writes every format into the working directory or -o', async () => {
      const out = join(dir, 'exports');
      await mkdir(out);
      const registry = ExporterRegistry.default();
      for (const exporter of registry.list()) {
        const args = ['export', 'api.json', '--format', exporter.format, '-o', 'exports/'];
        if (exporter.format === 'har') args.push('--capture', 'fixture.json');
        const run = await cli.run(args);
        assert.equal(run.code, 0, `${exporter.format}: ${run.stderr}`);
        const filename = expected[exporter.format];
        assert.ok(filename, exporter.format);
        assert.equal(run.stdout, `Wrote exports/${filename} (${exporter.format}, ${ENDPOINTS} endpoints)\n`);
        const content = await readFile(join(out, filename), 'utf8');
        assert.ok(content.length > 100, exporter.format);
        assert.ok(CliHarness.isAscii(content), exporter.format);
      }
      const openapi = json<{ openapi: string; paths: Record<string, unknown> }>(await readFile(join(out, 'openapi.json'), 'utf8'));
      assert.equal(openapi.openapi, '3.1.0');
      assert.ok(openapi.paths['/api/items/{itemId}']);
      assert.deepEqual(parseYaml(await readFile(join(out, 'openapi.yaml'), 'utf8')), openapi);
      const har = json<{ log: { entries: unknown[] } }>(await readFile(join(out, 'capture.har'), 'utf8'));
      assert.ok(har.log.entries.length > 0);
      const plain = await cli.run(['export', 'api.json', '--format', 'md']);
      assert.equal(plain.stdout, `Wrote API.md (markdown, ${ENDPOINTS} endpoints)\n`);
      assert.ok((await readFile(join(dir, 'API.md'), 'utf8')).startsWith('#'));
      const named = await cli.run(['export', 'api.json', '-f', 'openapi', '-o', 'spec/v1.json', '--title', 'Shop', '--base-url', 'https://api.example.com/v1']);
      assert.equal(named.code, 0, named.stderr);
      const spec = json<{ info: { title: string }; servers: { url: string }[] }>(await readFile(join(dir, 'spec', 'v1.json'), 'utf8'));
      assert.equal(spec.info.title, 'Shop');
      assert.equal(spec.servers[0]?.url, 'https://api.example.com/v1');
    });

    test("export -o - writes the content to stdout and nothing else", async () => {
      const run = await cli.run(['export', 'api.json', '--format', 'openapi', '-o', '-']);
      assert.equal(run.code, 0);
      assert.equal(run.stderr, '');
      assert.equal(run.stdout, ExporterRegistry.default().export(model, 'openapi').content);
      const curl = await cli.run(['export', 'api.json', '--format', 'curl', '--endpoints', '3,getItem', '-o', '-']);
      assert.equal(curl.code, 0);
      assert.match(curl.stdout, /^#!\/usr\/bin\/env bash/);
      assert.equal(curl.stdout, ExporterRegistry.default().export(model, 'curl', { endpoints: ['3', 'getItem'] }).content);
    });

    test('export from a capture or HAR builds the model and supplies the capture', async () => {
      const har = await cli.run(['export', 'fixture.json', '--format', 'har', '-o', 'from-capture.har']);
      assert.equal(har.code, 0, har.stderr);
      assert.equal(har.stderr, '');
      const entries = json<{ log: { entries: { request: { headers: { name: string; value: string }[] } }[] } }>(await readFile(join(dir, 'from-capture.har'), 'utf8')).log.entries;
      assert.ok(entries.length > 0);
      const cookies = entries.flatMap((entry) => entry.request.headers.filter((header) => header.name.toLowerCase() === 'cookie').map((header) => header.value));
      assert.ok(!cookies.some((cookie) => cookie.includes(CaptureFactory.fixture().sid)));
      const raw = await cli.run(['export', 'fixture.json', '--format', 'har', '--no-redact', '-o', 'raw.har']);
      assert.equal(raw.code, 0);
      assert.ok((await readFile(join(dir, 'raw.har'), 'utf8')).includes(CaptureFactory.fixture().sid));
      assert.equal((await stat(join(dir, 'raw.har'))).mode & 0o777, 0o600);
      const mismatch = await cli.run(['export', 'api.json', '--format', 'har', '--capture', 'browser.json', '-o', 'mismatch.har']);
      assert.equal(mismatch.code, 0);
      assert.match(mismatch.stderr, /^warning: browser\.json holds none of the sample requests of the exported endpoints; was api\.json built from it\?\n$/);
      const devtools = await cli.run(['export', 'devtools.har', '--format', 'json', '-o', '-']);
      assert.equal(devtools.code, 0);
      assert.equal(json<ApiModel>(devtools.stdout).source.file, 'devtools.har');
    });

    test('export --formats lists the formats', async () => {
      const run = await cli.run(['export', '--formats']);
      assert.equal(run.code, 0);
      for (const format of Object.keys(expected)) assert.match(run.stdout, new RegExp(`\\| ${format} +\\|`));
      const narrow = await cli.run(['export', '--formats', '--width', '50']);
      assert.ok(CliHarness.widest(narrow.stdout) <= 50);
      const aliases = new Set(Object.keys(ExporterRegistry.ALIASES));
      for (const width of ['60', '70', '80', '100']) {
        const formats = await cli.run(['export', '--formats', '--width', width, '--no-color']);
        const header = CliHarness.lines(formats.stdout).find((line) => line.startsWith('| FORMAT'));
        const column = header?.split('|').findIndex((cell) => cell.trim() === 'ALIASES') ?? -1;
        if (column < 0) {
          assert.match(formats.stdout, /Columns hidden to fit \d+ characters: ALIASES/, width);
          continue;
        }
        const cells = CliHarness.lines(formats.stdout).filter((line) => line.startsWith('| ') && line !== header).map((line) => line.split('|')[column]!.trim());
        const words = cells.flatMap((cell) => cell.split(/[,\s]+/)).filter((word) => word !== '');
        assert.ok(words.length > 0, width);
        for (const word of words) assert.ok(aliases.has(word), `${width}: ${word}`);
      }
      const extra = await cli.run(['export', '--formats', 'api.json']);
      assert.equal(extra.code, 2);
    });

    test('export errors', async () => {
      const unknown = await cli.run(['export', 'api.json', '--format', 'wsdl-xml']);
      assert.equal(unknown.code, 2);
      assert.match(unknown.stderr, /^error: --format must be one of openapi, openapi-yaml, postman, curl, typescript, har, html, markdown, json; got 'wsdl-xml'\nusage: appii export /);
      const typo = await cli.run(['export', 'api.json', '--format', 'opnapi', '-o', '-']);
      assert.equal(typo.code, 2);
      assert.equal(typo.stdout, '');
      assert.match(typo.stderr, /^error: --format must be one of .*; got 'opnapi'; did you mean 'openapi'\?\nusage: appii export /);
      const alias = await cli.run(['export', 'api.json', '--format', 'swager', '-o', '-']);
      assert.match(alias.stderr, /did you mean 'swagger'\?/);
      const noFormat = await cli.run(['export', 'api.json']);
      assert.equal(noFormat.code, 2);
      assert.match(noFormat.stderr, /^error: missing --format <format> \(one of openapi, /);
      const noCapture = await cli.run(['export', 'api.json', '--format', 'har']);
      assert.equal(noCapture.code, 1);
      assert.match(noCapture.stderr, /^error: The har format needs the recorded traffic: add --capture <capture\.json\|file\.har>/);
      const badRef = await cli.run(['export', 'api.json', '--format', 'openapi', '--endpoints', '1,zzz']);
      assert.equal(badRef.code, 1);
      assert.match(badRef.stderr, /^error: No endpoint matches 'zzz'/);
      const badBase = await cli.run(['export', 'api.json', '--format', 'openapi', '--base-url', 'ftp://x']);
      assert.equal(badBase.code, 1);
      assert.match(badBase.stderr, /Invalid base URL 'ftp:\/\/x'/);
      const overwrite = await cli.run(['export', 'api.json', '--format', 'json', '-o', 'api.json']);
      assert.equal(overwrite.code, 2);
      assert.match(overwrite.stderr, /^error: --out must not overwrite the input file\n/);
      const defaultName = await cli.run(['export', 'api.json', '--format', 'json']);
      assert.equal(defaultName.code, 2);
      assert.match(defaultName.stderr, /^error: the default output api\.json is the input file; pass -o <file>\nusage: appii export /);
      const missing = await cli.run(['export', 'nope.json', '--format', 'openapi']);
      assert.equal(missing.code, 1);
      assert.match(missing.stderr, /^error: File not found: /);
      const noFile = await cli.run(['export', '--format', 'openapi']);
      assert.equal(noFile.code, 2);
      assert.match(noFile.stderr, /^error: missing <api\.json\|capture\.json\|file\.har>/);
    });
  });

  describe('run', () => {
    test('run captures, builds and lists into the output directory', async () => {
      const run = await cli.run(['run', `${site.origin}/app`, '--headless', '--duration', '2', '--out-dir', 'pipeline', '--name', 'fixture-app']);
      assert.equal(run.code, 0, run.stderr);
      assert.equal(run.stderr, 'Recording headless for 2.0 s. Press Ctrl+C to stop early.\n');
      assert.match(run.stdout, /^Capture saved to pipeline\/capture\.json\n/);
      assert.match(run.stdout, /\nWrote pipeline\/api\.json \(\d+ endpoints\)\n\nfixture-app\n/);
      assert.match(run.stdout, /\/api\/items\/\{itemId\}/);
      const tail = run.stdout.slice(run.stdout.lastIndexOf('\nNext: ') + 1);
      assert.ok(tail.endsWith('\n'));
      assert.ok(CliHarness.widest(tail) <= 100);
      assert.equal(tail.replace(/\s+/g, ' ').trim(), 'Next: appii export pipeline/api.json --format <format>, where <format> is one of openapi, openapi-yaml, postman, curl, typescript, har, html, markdown, json');
      assert.ok(!run.stdout.includes('Next: appii build'));
      assert.equal(run.stdout.match(/appii export /g)?.length, 1, run.stdout);
      assert.doesNotMatch(run.stdout, /\nDetails: /);
      const capture = await new CaptureStore().load(join(dir, 'pipeline', 'capture.json'));
      const api = await new ModelStore().load(join(dir, 'pipeline', 'api.json'));
      assert.ok(capture.exchanges.length > 0);
      assert.equal(api.name, 'fixture-app');
      assert.equal(api.source.file, 'capture.json');
      assert.ok(api.endpoints.some((endpoint) => endpoint.path === '/api/items/{itemId}'));
      const usage = await cli.run(['run']);
      assert.equal(usage.code, 2);
      const conflict = await cli.run(['run', site.url, '--origin', site.origin, '--all-origins']);
      assert.equal(conflict.code, 2);
      await writeFile(join(dir, 'occupied'), 'x');
      const occupied = await cli.run(['run', site.url, '--headless', '--out-dir', 'occupied']);
      assert.equal(occupied.code, 2);
      assert.match(occupied.stderr, /^error: --out-dir occupied is a file, not a directory\n/);
    });
  });

  describe('a real process', () => {
    test('SIGINT stops a long capture, saves it and exits 0', { timeout: 60_000 }, async () => {
      const child = spawn(process.execPath, ['--import', TSX, ENTRY, 'capture', `${site.origin}/app`, '--headless', '--duration', '60', '-o', 'interrupted.json'], {
        cwd: dir,
        env: { ...process.env, NO_COLOR: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      const recording = new Promise<void>((done) => {
        child.stderr.on('data', (chunk: Buffer) => {
          stderr += chunk.toString();
          if (stderr.includes('Recording headless')) done();
        });
      });
      const exited = new Promise<number | null>((done) => child.on('exit', (code) => done(code)));
      try {
        await Promise.race([recording, exited.then((code) => assert.fail(`exited early with ${code}: ${stderr}`))]);
        await new Promise((done) => setTimeout(done, 2500));
        const started = Date.now();
        child.kill('SIGINT');
        const code = await exited;
        assert.equal(code, 0, stderr);
        assert.ok(Date.now() - started < 30_000);
        assert.match(stderr, /Stopping and saving what was recorded\./);
        assert.match(stdout, /^Capture saved to interrupted\.json\n/);
        const capture = await new CaptureStore().load(join(dir, 'interrupted.json'));
        assert.ok(capture.exchanges.some((exchange) => exchange.request.url.endsWith('/api/items/1')));
        assert.ok(capture.pages.length > 0);
        assert.ok(capture.cookies.some((cookie) => cookie.name === 'sid'));
      } finally {
        if (child.exitCode === null) child.kill('SIGKILL');
      }
    });

    test('the entry point runs main() and sets the exit code', async () => {
      const run = (args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> =>
        new Promise((done) => {
          const child = spawn(process.execPath, ['--import', TSX, ENTRY, ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
          let stdout = '';
          let stderr = '';
          child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
          child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
          child.on('exit', (code) => done({ code, stdout, stderr }));
        });
      const version = await run(['--version']);
      assert.equal(version.code, 0);
      assert.equal(version.stdout, `${Meta.APP_NAME} ${Meta.appVersion()}\n`);
      const bad = await run(['nope']);
      assert.equal(bad.code, 2);
      assert.match(bad.stderr, /^error: unknown command 'nope'/);
      const missing = await run(['list', 'missing.json']);
      assert.equal(missing.code, 1);
    });
  });
});
