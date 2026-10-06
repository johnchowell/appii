import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureStore } from '../src/capture/index.js';
import { CaptureOptionGroup, CaptureProgress, CaptureRunner, CliContext, LoginReport } from '../src/cli/index.js';
import { ModelStore } from '../src/build/index.js';
import type { ApiModel, Capture, Exchange } from '../src/model/index.js';
import { UsageError } from '../src/cli/index.js';
import { LOGIN_USER, BAD_PASSWORD, startFormLoginSite, startFormVariantsSite } from './fixtures/login-sites.js';
import type { LoginSite } from './fixtures/login-sites.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { CliHarness, MemoryStream } from './helpers/cli-harness.js';

const ENV = { APPII_LOGIN_USERNAME: LOGIN_USER.username, APPII_LOGIN_PASSWORD: LOGIN_USER.password, NO_COLOR: '1' };

function paths(capture: Capture): string[] {
  return capture.exchanges.map((exchange) => `${exchange.request.method} ${new URL(exchange.request.url).pathname}`);
}

function endpoint(model: ApiModel, method: string, path: string): boolean {
  return model.endpoints.some((entry) => entry.method === method && entry.path === path);
}

function retagged(capture: Capture, tag: string, shiftMs: number): Capture {
  const move = (iso: string): string => new Date(Date.parse(iso) + shiftMs).toISOString();
  return {
    ...capture,
    startedAt: move(capture.startedAt),
    endedAt: move(capture.endedAt),
    exchanges: capture.exchanges.map((exchange) => ({ ...exchange, id: `${tag}-${exchange.id}`, startedAt: move(exchange.startedAt) })),
    pages: capture.pages.map((page) => ({ ...page, capturedAt: move(page.capturedAt) })),
  };
}

function anonymousCapture(): Capture {
  const f = new CaptureFactory();
  const html = CaptureFactory.loginHtml('0123456789abcdef0123456789abcdef');
  f.document('/login', html, { responseHeaders: { 'set-cookie': 'sid=anon0123456789abcdef; Path=/; HttpOnly' } });
  f.snapshot('/login', 'Login', html);
  f.document('/', CaptureFactory.page('Home', '<a href="/login">Login</a>'), { requestHeaders: { cookie: 'sid=anon0123456789abcdef' } });
  return retagged(f.capture({ startUrl: `${f.origin}/login` }), 'anon', 0);
}

function authenticatedCapture(): Capture {
  const f = new CaptureFactory();
  f.document('/account', CaptureFactory.page('Account', '<a href="/logout">Logout</a>'), { requestHeaders: { cookie: 'sid=authed0123456789abcdef' } });
  f.document('/orders', CaptureFactory.page('Orders', '<p>none</p>'), { requestHeaders: { cookie: 'sid=authed0123456789abcdef' } });
  f.cookie('sid', 'authed0123456789abcdef', { httpOnly: true });
  return retagged(f.capture({ startUrl: `${f.origin}/account` }), 'authed', 3_600_000);
}

describe('appii build with several captures', () => {
  let dir: string;
  let cli: CliHarness;
  const anon = anonymousCapture();
  const authed = authenticatedCapture();
  const authenticated = (): Capture => structuredClone(authed);

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-cli-login-build-'));
    cli = new CliHarness(dir);
    await new CaptureStore().save(join(dir, 'anon.json'), anon);
    await new CaptureStore().save(join(dir, 'authed.json'), authed);
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('build anon.json authed.json keeps what was found anonymously, adds what the logged-in capture found and lists both inputs', async () => {
    const run = await cli.run(['build', 'anon.json', 'authed.json', '-o', 'api.json', '--width', '160']);
    assert.equal(run.code, 0, run.stderr);
    const model = await new ModelStore().load(join(dir, 'api.json'));
    for (const [method, path] of [
      ['GET', '/login'],
      ['POST', '/login'],
      ['GET', '/'],
      ['GET', '/account'],
      ['GET', '/orders'],
    ] as const) {
      assert.ok(endpoint(model, method, path), `${method} ${path} in ${model.endpoints.map((entry) => `${entry.method} ${entry.path}`).join(', ')}`);
    }
    assert.equal(model.source.exchanges, anon.exchanges.length + authed.exchanges.length);
    assert.equal(model.source.file, undefined);
    assert.equal(model.source.startUrl, anon.startUrl);
    assert.equal(model.source.capturedFrom, anon.startedAt);
    assert.equal(model.source.capturedTo, authed.endedAt);
    assert.deepEqual(model.source.captures, [
      { file: 'anon.json', startUrl: anon.startUrl, capturedFrom: anon.startedAt, capturedTo: anon.endedAt, exchanges: anon.exchanges.length },
      { file: 'authed.json', startUrl: authed.startUrl, capturedFrom: authed.startedAt, capturedTo: authed.endedAt, exchanges: authed.exchanges.length },
    ]);
    assert.match(run.stdout, /^Wrote api\.json \(\d+ endpoints\)/);
  });

  test('export --format har takes every capture of a model built from several', async () => {
    const built = await cli.run(['build', 'anon.json', 'authed.json', '-o', 'merged.json']);
    assert.equal(built.code, 0, built.stderr);
    const both = await cli.run(['export', 'merged.json', '--format', 'har', '--capture', 'anon.json', '--capture', 'authed.json', '-o', 'both.har']);
    assert.equal(both.code, 0, both.stderr);
    assert.equal(both.stderr, '');
    const har = JSON.parse(await readFile(join(dir, 'both.har'), 'utf8')) as { log: { entries: { request: { url: string } }[] } };
    const urls = har.log.entries.map((entry) => new URL(entry.request.url).pathname);
    for (const path of ['/login', '/account', '/orders']) assert.ok(urls.includes(path), `${path} in ${urls.join(', ')}`);
  });

  test('the start URLs in the capture list are redacted like the model start URL, unless --no-redact', async () => {
    const signed = { ...authenticated(), startUrl: `${CaptureFactory.ORIGIN}/account?key=Secret-Api-Key-123456` };
    await new CaptureStore().save(join(dir, 'signed.json'), signed);
    const run = await cli.run(['build', 'anon.json', 'signed.json', '-o', 'signed-api.json']);
    assert.equal(run.code, 0, run.stderr);
    const text = await readFile(join(dir, 'signed-api.json'), 'utf8');
    assert.ok(!text.includes('Secret-Api-Key-123456'));
    const model = await new ModelStore().load(join(dir, 'signed-api.json'));
    assert.match(model.source.captures?.[1]?.startUrl ?? '', /^https:\/\/shop\.example\.com\/account\?key=(%3C|<)redacted(%3E|>)$/);
    const raw = await cli.run(['build', 'anon.json', 'signed.json', '-o', 'signed-raw.json', '--no-redact']);
    assert.equal(raw.code, 0, raw.stderr);
    assert.equal((await new ModelStore().load(join(dir, 'signed-raw.json'))).source.captures?.[1]?.startUrl, signed.startUrl);
  });

  test('a single input keeps the plain source file and no capture list', async () => {
    const run = await cli.run(['build', 'anon.json', '-o', 'single.json']);
    assert.equal(run.code, 0, run.stderr);
    const model = await new ModelStore().load(join(dir, 'single.json'));
    assert.equal(model.source.file, 'anon.json');
    assert.equal(model.source.captures, undefined);
  });

  test('the same file given twice counts each exchange once', async () => {
    const run = await cli.run(['build', 'authed.json', 'authed.json', '-o', 'twice.json']);
    assert.equal(run.code, 0, run.stderr);
    const model = await new ModelStore().load(join(dir, 'twice.json'));
    assert.equal(model.source.exchanges, authed.exchanges.length);
    assert.equal(model.endpoints.find((entry) => entry.path === '/account')?.count, 1);
    assert.equal(model.source.file, 'authed.json');
    assert.equal(model.source.captures, undefined);
  });

  test('a capture given twice is listed once in the model and in Built from, with a note that it is used once (P7)', async () => {
    await copyFile(join(dir, 'anon.json'), join(dir, 'anon-copy.json'));
    const run = await cli.run(['build', 'anon.json', 'anon.json', 'authed.json', './authed.json', 'anon-copy.json', '-o', 'repeated.json', '--width', '200']);
    assert.equal(run.code, 0, run.stderr);
    const model = await new ModelStore().load(join(dir, 'repeated.json'));
    assert.deepEqual(
      model.source.captures?.map((source) => [source.file, source.exchanges]),
      [
        ['anon.json', anon.exchanges.length],
        ['authed.json', authed.exchanges.length],
      ],
    );
    assert.equal(model.source.exchanges, anon.exchanges.length + authed.exchanges.length);
    const built = run.stdout.split('\n').filter((line) => /Built from/.test(line));
    assert.equal(built.length, 1, run.stdout);
    assert.equal(built[0]?.match(/anon\.json/g)?.length, 1, built[0]);
    assert.equal(built[0]?.match(/authed\.json/g)?.length, 1, built[0]);
    assert.deepEqual(run.stderr.trim().split('\n'), [
      'note: anon.json was given more than once; it is used once',
      'note: ./authed.json was given more than once; it is used once',
      'note: anon-copy.json holds the same requests as anon.json; it is used once',
    ]);
  });

  test('the output may not overwrite any of the inputs, and every input must exist', async () => {
    await copyFile(join(dir, 'anon.json'), join(dir, 'api.json'));
    const overwrite = await cli.run(['build', 'authed.json', 'api.json']);
    assert.equal(overwrite.code, 2);
    assert.match(overwrite.stderr, /^error: the default output api\.json is the input file; pass -o <file>/);
    const missing = await cli.run(['build', 'anon.json', 'nope.json', '-o', 'x.json']);
    assert.equal(missing.code, 1);
    assert.match(missing.stderr, /nope\.json/);
    const none = await cli.run(['build']);
    assert.equal(none.code, 2);
    assert.match(none.stderr, /^error: missing <capture\.json\|file\.har>\nusage: appii build <capture\.json\|file\.har>\.\.\. \[options\]/);
  });
});

describe('--login option parsing', () => {
  test('a name without a value reads APPII_LOGIN_<NAME>, with every character that is not a letter or digit turned into _', () => {
    assert.equal(CaptureOptionGroup.loginVariable('password'), 'APPII_LOGIN_PASSWORD');
    assert.equal(CaptureOptionGroup.loginVariable('user[email]'), 'APPII_LOGIN_USER_EMAIL_');
    assert.equal(CaptureOptionGroup.loginVariable('session-key.2'), 'APPII_LOGIN_SESSION_KEY_2');
    assert.deepEqual(CaptureOptionGroup.loginField('user[email]', { APPII_LOGIN_USER_EMAIL_: 'a@b.example' }), { name: 'user[email]', value: 'a@b.example' });
    assert.deepEqual(CaptureOptionGroup.loginField('remember=yes', {}), { name: 'remember', value: 'yes' });
    assert.deepEqual(CaptureOptionGroup.loginField('note=a=b', {}), { name: 'note', value: 'a=b' });
    assert.deepEqual(CaptureOptionGroup.loginField('empty=', {}), { name: 'empty', value: '' });
    assert.throws(() => CaptureOptionGroup.loginField('password', {}), (err: unknown) => err instanceof UsageError && err.message === '--login password: set the environment variable APPII_LOGIN_PASSWORD, or give password=<value>');
    assert.throws(() => CaptureOptionGroup.loginField('password', { APPII_LOGIN_PASSWORD: '' }), (err: unknown) => err instanceof UsageError && err.message === '--login password: the environment variable APPII_LOGIN_PASSWORD is empty');
    assert.throws(() => CaptureOptionGroup.loginField('=x', {}), (err: unknown) => err instanceof UsageError && err.message === '--login needs a field name, as name or name=value');
  });

  test('the instructions say that the capture logs in and opens the other URLs', () => {
    const login = [
      { name: 'username', value: 'u' },
      { name: 'password', value: 'p' },
    ];
    assert.equal(
      CaptureRunner.instructions({ headless: true, login, visits: ['https://example.com/a'] }),
      'Recording headless: logging in with the form that has username, password, then opening 1 more URL in order, then waiting until the network is idle. Press Ctrl+C to stop early.',
    );
    assert.equal(CaptureRunner.instructions({ headless: true, visits: ['https://example.com/a', 'https://example.com/b'] }), 'Recording headless: opening 2 more URLs in order, then waiting until the network is idle. Press Ctrl+C to stop early.');
    assert.equal(CaptureRunner.instructions({ headless: false, login }), 'Recording: logging in with the form that has username, password. Then browse the site, and close the window or press Ctrl+C.');
    assert.equal(CaptureRunner.instructions({ headless: true, login, durationMs: 20000 }), 'Recording headless for 20 s: logging in with the form that has username, password. Press Ctrl+C to stop early.');
  });

  test('login values are hidden in printed URLs: query and fragment values, path segments, and long values anywhere', () => {
    const report = LoginReport.create([
      { name: 'user', value: 'bob' },
      { name: 'pass', value: 'Hunter-22-Secret' },
    ]);
    assert.equal(report.url('https://example.com/submit?user=bob&pass=Hunter-22-Secret&keep=1'), 'https://example.com/submit?user=<redacted>&pass=<redacted>&keep=1');
    assert.equal(report.url('https://example.com/u/bob/home#pass=Hunter-22-Secret'), 'https://example.com/u/<redacted>/home#pass=<redacted>');
    assert.equal(report.url('https://example.com/x?blob=pre-Hunter-22-Secret-post'), 'https://example.com/x?blob=<redacted>');
    assert.equal(report.url('https://example.com/bobcat?q=bobby'), 'https://example.com/bobcat?q=bobby');
    assert.equal(report.text('said Hunter-22-Secret twice'), 'said <redacted> twice');
    const exchange: Exchange = {
      id: 'x',
      source: 'browser',
      resourceType: 'document',
      startedAt: '2026-01-01T00:00:00.000Z',
      durationMs: 1,
      request: { method: 'GET', url: 'https://example.com/submit?user=bob&pass=Hunter-22-Secret', headers: [] },
      response: { status: 200, statusText: 'OK', headers: [] },
    };
    const stderr = new MemoryStream({ isTTY: true });
    const ctx = CliContext.create({ stdout: new MemoryStream(), stderr, env: {}, cwd: '/' });
    const progress = new CaptureProgress(ctx, { url: (url) => report.url(url) });
    progress.record(exchange);
    progress.finish();
    assert.match(stderr.text, /Recording: 1 request, last GET 200 https:\/\/example\.com\/submit\?user=<redacted>&pass=<redacted>/);
    assert.ok(!stderr.text.includes('Hunter-22-Secret'));
  });
});

describe('appii capture --login and several URLs in a real browser', () => {
  let site: LoginSite;
  let variants: LoginSite;
  let dir: string;
  let cli: CliHarness;

  before(async () => {
    site = await startFormLoginSite();
    variants = await startFormVariantsSite();
    dir = await mkdtemp(join(tmpdir(), 'appii-cli-login-'));
    cli = new CliHarness(dir);
  });

  after(async () => {
    await site?.close();
    await variants?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('logs in with values from APPII_LOGIN_*, opens the other URLs, says where the login went and never prints a value', async () => {
    const run = await cli.run(['capture', `${site.origin}/login`, `${site.origin}/account`, `${site.origin}/page/2/`, '--headless', '--idle', '0.3', '--login', 'username', '--login', 'password', '-o', 'authed.json', '--width', '200'], { env: ENV, stderrTty: true });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /Recording headless: logging in with the form that has username, password, then opening 2 more URLs in order, then waiting until the network is idle\. Press Ctrl\+C to stop early\.\n/);
    assert.match(run.stdout, new RegExp(`\\n\\nLogin: submitted the form on ${site.origin}/login \\(username, password\\) by clicking its submit button; POST ${site.origin}/login answered 302; now on ${site.origin}/\\n\\nNext: appii build authed\\.json\\n$`));
    for (const value of [LOGIN_USER.username, LOGIN_USER.password]) {
      assert.ok(!run.stdout.includes(value), 'stdout holds a login value');
      assert.ok(!run.stderr.includes(value), 'stderr holds a login value');
    }
    const capture = await new CaptureStore().load(join(dir, 'authed.json'));
    const sequence = paths(capture);
    assert.deepEqual(
      sequence.filter((entry) => ['POST /login', 'GET /account', 'GET /page/2/'].includes(entry)),
      ['POST /login', 'GET /account', 'GET /page/2/'],
    );
    assert.equal(capture.exchanges.find((exchange) => new URL(exchange.request.url).pathname === '/account')?.response?.status, 200);
  });

  test('wrong credentials give warnings on stderr and still save the capture', async () => {
    const run = await cli.run(['capture', `${site.origin}/login`, '--headless', '--idle', '0.3', '--login', 'username', '--login', `password=${BAD_PASSWORD}`, '-o', 'wrong.json'], { env: ENV });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, new RegExp(`\\nwarning: the login submission POST ${site.origin}/login answered 401; the credentials are probably wrong\\nwarning: the login form is still on the page with an empty password after submitting; the credentials were probably not accepted\\n`));
    assert.match(run.stdout, /POST .*\/login answered 401/);
    assert.ok(!`${run.stdout}${run.stderr}`.includes(BAD_PASSWORD));
  });

  test('a submission that the browser\'s form validation refuses is reported with the field and the browser\'s message, says not submitted, and never prints the value (LV2-6)', async () => {
    const run = await cli.run(['capture', `${variants.origin}/email`, '--headless', '--idle', '0.3', '--login', 'user[email]=not-an-email-5c2e', '--login', 'user[password]=Long-Enough-Pass-1', '-o', 'invalid.json', '--width', '400']);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /\nwarning: the browser did not submit the login form: its form validation refused user\[email\] \("Please include an '@' in the email address\. '<hidden>' is missing an '@'\."\)\n/);
    assert.doesNotMatch(run.stderr, /sent no request/);
    assert.match(run.stdout, new RegExp(`\\n\\nLogin: filled the form on ${variants.origin}/email \\(user\\[email\\], user\\[password\\]\\) and tried to submit it by clicking its submit button; not submitted: the browser's form validation refused user\\[email\\]; now on ${variants.origin}/email\\n`));
    for (const value of ['not-an-email-5c2e', 'Long-Enough-Pass-1']) assert.ok(!`${run.stdout}${run.stderr}`.includes(value), value);
  });

  test('a GET login form keeps the values out of the summary', async () => {
    const run = await cli.run(['capture', `${variants.origin}/get`, '--headless', '--idle', '0.3', '--login', 'user=get-user-name', '--login', 'pass=Get-Pass-Secret-1', '-o', 'get.json', '--width', '400'], { stderrTty: true });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /GET http:\/\/127\.0\.0\.1:\d+\/submit\?user=<redacted>&pass=<redacted> answered 200; now on http:\/\/127\.0\.0\.1:\d+\/submit\?user=<redacted>&pass=<redacted>/);
    assert.ok(!`${run.stdout}${run.stderr}`.includes('Get-Pass-Secret-1'));
    assert.ok(!`${run.stdout}${run.stderr}`.includes('get-user-name'));
  });

  test('a missing environment variable is a usage error that names it, before any browser starts', async () => {
    const before = site.requests.length;
    const run = await cli.run(['capture', `${site.origin}/login`, '--headless', '--login', 'username', '--login', 'password'], { env: { APPII_LOGIN_USERNAME: 'x' } });
    assert.equal(run.code, 2);
    assert.match(run.stderr, /^error: --login password: set the environment variable APPII_LOGIN_PASSWORD, or give password=<value>\nusage: appii capture <url> \[<url>\.\.\.\] \[options\]/);
    assert.equal(site.requests.length, before);
  });

  test('no matching form fails with the forms that were found, and the value stays hidden even with APPII_DEBUG', async () => {
    const run = await cli.run(['capture', `${variants.origin}/nothing`, '--headless', '--idle', '0.3', '--read-timeout', '1', '--login', 'user=x', '--login', 'pass', '-o', 'none.json'], { env: { APPII_LOGIN_PASS: 'Debug-Secret-55', APPII_DEBUG: '1' } });
    assert.equal(run.code, 1);
    assert.match(run.stderr, new RegExp(`error: No form on ${variants.origin}/nothing has controls named user, pass \\(waited 1\\.0 s\\)\\. forms found: form 1 \\(GET ${variants.origin}/search\\): q\\. controls outside any form: loose`));
    assert.ok(!run.stderr.includes('Debug-Secret-55'));
  });

  test('without --login a headless capture opens every URL in order', async () => {
    const run = await cli.run(['capture', `${site.origin}/page/2/`, `${site.origin}/login`, `${site.origin}/`, '--headless', '--idle', '0.3', '-o', 'many.json']);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /^Recording headless: opening 2 more URLs in order, then waiting until the network is idle\./);
    assert.ok(!run.stdout.includes('Login:'));
    const capture = await new CaptureStore().load(join(dir, 'many.json'));
    assert.deepEqual(
      paths(capture).filter((entry) => entry.startsWith('GET ')),
      ['GET /page/2/', 'GET /login', 'GET /'],
    );
  });

  test('run --with builds one model from an earlier anonymous capture and the new logged-in one, and an earlier capture given twice is used once', async () => {
    const anon = await cli.run(['capture', `${site.origin}/login`, '--headless', '--idle', '0.3', '-o', 'anon.json']);
    assert.equal(anon.code, 0, anon.stderr);
    const run = await cli.run(['run', `${site.origin}/login`, `${site.origin}/account`, '--headless', '--idle', '0.3', '--login', 'username', '--login', 'password', '--with', 'anon.json', '--with', 'anon.json', '--out-dir', 'authed', '--width', '200'], { env: ENV });
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stderr, /\nnote: anon\.json was given more than once; it is used once\n/);
    assert.match(run.stdout, /\n\nLogin: submitted the form on .*\/login \(username, password\) by clicking its submit button; POST .*\/login answered 302; now on .*\/\n/);
    const model = await new ModelStore().load(join(dir, 'authed', 'api.json'));
    assert.deepEqual(
      model.source.captures?.map((entry) => entry.file),
      ['../anon.json', 'capture.json'],
    );
    const anonCapture = await new CaptureStore().load(join(dir, 'anon.json'));
    const authedCapture = await new CaptureStore().load(join(dir, 'authed', 'capture.json'));
    assert.equal(model.source.exchanges, anonCapture.exchanges.length + authedCapture.exchanges.length);
    assert.ok(endpoint(model, 'GET', '/account'));
    assert.ok(endpoint(model, 'POST', '/login'));
    assert.equal(model.endpoints.find((entry) => entry.method === 'POST' && entry.path === '/login')?.count, 1);
    for (const value of [LOGIN_USER.password]) assert.ok(!(await readFile(join(dir, 'authed', 'api.json'), 'utf8')).includes(value));
  });

  test('capture --probe-login records what the login form would send, says so, and nothing reaches the server (LV2-4)', async () => {
    const before = site.requests.filter((request) => request.method === 'POST').length;
    const run = await cli.run(['capture', `${site.origin}/login`, '--headless', '--idle', '0.3', '--probe-login', '-o', 'probe.json', '--width', '400']);
    assert.equal(run.code, 0, run.stderr);
    assert.equal(site.requests.filter((request) => request.method === 'POST').length, before, 'the probe reached the server');
    assert.match(run.stderr, /^Recording headless: probing the login form with placeholder values, then waiting until the network is idle\./);
    assert.match(run.stdout, /\nProbed: +POST \/login \(stopped in the browser while probing the login form; not sent\)\n/);
    assert.match(run.stdout, new RegExp(`\\n\\nProbe: filled the login form on ${site.origin}/login \\(username, password\\) with placeholder values and clicked its submit button; the page tried to send POST /login; appii stopped it in the browser, so nothing reached the server; opened ${site.origin}/login again\\n`));
    const capture = await new CaptureStore().load(join(dir, 'probe.json'));
    assert.deepEqual(
      capture.exchanges.filter((exchange) => exchange.source === 'probe').map((exchange) => `${exchange.request.method} ${new URL(exchange.request.url).pathname}`),
      ['POST /login'],
    );
  });

  test('run --probe-login gives the anonymous model a login endpoint known from the form, and --probe-login with --login is refused before a browser starts', async () => {
    const run = await cli.run(['run', `${site.origin}/login`, '--headless', '--idle', '0.3', '--probe-login', '--out-dir', 'probed', '--width', '200']);
    assert.equal(run.code, 0, run.stderr);
    assert.match(run.stdout, /\nLogin: +#\d+ POST \/login with username and password, known from a form; not submitted yet\n/);
    const model = await new ModelStore().load(join(dir, 'probed', 'api.json'));
    const login = model.endpoints.find((entry) => entry.method === 'POST' && entry.path === '/login');
    assert.equal(login?.role, 'login');
    assert.equal(login?.count, 0);
    const requests = site.requests.length;
    const both = await cli.run(['capture', `${site.origin}/login`, '--headless', '--probe-login', '--login', 'username=x'], { env: ENV });
    assert.equal(both.code, 2);
    assert.match(both.stderr, /^error: --probe-login and --login cannot be combined/);
    assert.equal(site.requests.length, requests);
  });

  test('run --with refuses the capture file that the run itself overwrites', async () => {
    const run = await cli.run(['run', `${site.origin}/login`, '--headless', '--with', 'authed/capture.json', '--out-dir', 'authed']);
    assert.equal(run.code, 2);
    assert.match(run.stderr, /^error: --with authed\/capture\.json is the authed\/capture\.json that this run writes; copy it elsewhere or use another --out-dir/);
  });
});
