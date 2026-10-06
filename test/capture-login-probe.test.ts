import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import { CaptureSession, LoginProbe } from '../src/capture/index.js';
import type { CaptureSessionOptions, ProbeOutcome } from '../src/capture/index.js';
import type { ApiModel, Capture, Endpoint, Exchange } from '../src/model/index.js';
import { AppiiError, Http } from '../src/shared/index.js';
import { startFormLoginSite, startProbeEdgeSite, startSpaLoginSite, startTokenLoginSite } from './fixtures/login-sites.js';
import type { LoginSite } from './fixtures/login-sites.js';

interface Probed {
  capture: Capture;
  outcome: ProbeOutcome | undefined;
}

const PLACEHOLDERS = [LoginProbe.USER, LoginProbe.EMAIL, LoginProbe.PASSWORD, LoginProbe.TEXT];

async function probe(url: string, options: Partial<CaptureSessionOptions> = {}): Promise<Probed> {
  let outcome: ProbeOutcome | undefined;
  const capture = await CaptureSession.create({
    url,
    headless: true,
    idleMs: 300,
    probeLogin: true,
    recorder: { readTimeoutMs: 5000 },
    onProbe: (value) => {
      outcome = value;
    },
    ...options,
  }).run();
  return { capture, outcome };
}

function pathOf(url: string): string {
  return new URL(url).pathname;
}

function probes(capture: Capture): Exchange[] {
  return capture.exchanges.filter((exchange) => exchange.source === 'probe');
}

function sent(site: LoginSite, method: string, path: string): number {
  return site.requests.filter((request) => request.method === method && request.path.split('?')[0] === path).length;
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((entry) => entry.method === method && entry.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((entry) => `${entry.method} ${entry.path}`).join(', ')}`);
  return found;
}

function noPlaceholders(value: unknown): void {
  const text = JSON.stringify(value);
  for (const placeholder of PLACEHOLDERS) assert.ok(!text.includes(placeholder), `${placeholder} reached the model`);
}

describe('capture --probe-login: a script login that posts JSON (pattern c)', () => {
  let site: LoginSite;

  before(async () => {
    site = await startTokenLoginSite();
  });

  after(async () => {
    await site?.close();
  });

  test('the request the page tries to send is recorded as a probe without a response, nothing reaches the server, and the start page is opened again', async () => {
    const { capture, outcome } = await probe(`${site.origin}/signin`);
    assert.equal(sent(site, 'POST', '/api/auth/login'), 0, 'the probe reached the server');
    const [probed, ...others] = probes(capture);
    assert.equal(others.length, 0);
    assert.ok(probed);
    assert.equal(probed.request.method, 'POST');
    assert.equal(pathOf(probed.request.url), '/api/auth/login');
    assert.equal(probed.resourceType, 'fetch');
    assert.equal(probed.response, undefined);
    assert.equal(Http.getHeader(probed.request.headers, 'content-type'), 'application/json');
    assert.deepEqual(JSON.parse(Http.bodyText(probed.request.body)), { username: LoginProbe.USER, password: LoginProbe.PASSWORD });
    assert.ok(outcome);
    assert.equal(outcome.found, true);
    assert.equal(outcome.pageUrl, `${site.origin}/signin`);
    assert.deepEqual(outcome.fields, ['username', 'password']);
    assert.equal(outcome.trigger, 'button');
    assert.deepEqual(outcome.requests, [{ method: 'POST', url: `${site.origin}/api/auth/login` }]);
    assert.equal(outcome.reloaded, `${site.origin}/signin`);
    assert.deepEqual(outcome.warnings, []);
    const loads = capture.exchanges.filter((exchange) => exchange.request.method === 'GET' && pathOf(exchange.request.url) === '/signin');
    assert.equal(loads.length, 2, 'the start page was opened again after the probe');
    assert.ok(loads.every((exchange) => exchange.response?.status === 200));
    assert.ok(capture.pages.every((page) => pathOf(page.url) === '/signin'), capture.pages.map((page) => page.url).join(', '));
    for (const page of capture.pages) for (const placeholder of PLACEHOLDERS) assert.ok(!page.html.includes(placeholder), `a page snapshot holds ${placeholder}`);
  });

  test('the anonymous model gets the login endpoint with the JSON body shape, 0 hits and anonymous access not tested', async () => {
    const { capture } = await probe(`${site.origin}/signin`);
    const model = ModelBuilder.create().build(capture);
    const login = endpoint(model, 'POST', '/api/auth/login');
    assert.equal(login.role, 'login');
    assert.deepEqual(login.login, { evidence: 'form', identifier: 'username', password: 'password', issues: { cookies: [], tokens: [] } });
    assert.equal(login.requestBody?.mimeType, 'application/json');
    assert.equal(login.count, 0);
    assert.equal(login.auth.anonymous, 'untested');
    noPlaceholders(model);
  });
});

describe('capture --probe-login: a server-rendered form with a CSRF token (pattern a)', () => {
  let site: LoginSite;

  before(async () => {
    site = await startFormLoginSite();
  });

  after(async () => {
    await site?.close();
  });

  test('the blocked form navigation is a probe, the error page is not a page snapshot, and the form endpoint is the login endpoint with 0 hits', async () => {
    const { capture, outcome } = await probe(`${site.origin}/login`, { visits: [`${site.origin}/page/2/`] });
    assert.equal(sent(site, 'POST', '/login'), 0, 'the probe reached the server');
    const [probed, ...others] = probes(capture);
    assert.equal(others.length, 0);
    assert.ok(probed);
    assert.equal(probed.resourceType, 'document');
    assert.equal(probed.request.method, 'POST');
    assert.equal(probed.response, undefined);
    const fields = new URLSearchParams(Http.bodyText(probed.request.body));
    assert.deepEqual([...fields.keys()], ['csrf_token', 'username', 'password']);
    assert.equal(fields.get('password'), LoginProbe.PASSWORD);
    assert.equal(outcome?.method, 'POST');
    assert.equal(outcome?.action, `${site.origin}/login`);
    assert.ok(
      capture.pages.every((page) => ['/login', '/page/2/'].includes(pathOf(page.url))),
      capture.pages.map((page) => page.url).join(', '),
    );
    assert.ok(capture.pages.every((page) => !page.html.includes('ERR_BLOCKED_BY_CLIENT')));
    const sequence = capture.exchanges.map((exchange) => `${exchange.source} ${exchange.request.method} ${pathOf(exchange.request.url)}`);
    assert.ok(sequence.indexOf('probe POST /login') < sequence.lastIndexOf('browser GET /login'), sequence.join('\n'));
    assert.ok(sequence.lastIndexOf('browser GET /login') < sequence.indexOf('browser GET /page/2/'), sequence.join('\n'));
    const model = ModelBuilder.create().build(capture);
    const login = endpoint(model, 'POST', '/login');
    assert.equal(login.role, 'login');
    assert.equal(login.count, 0);
    assert.equal(login.login?.evidence, 'form');
    noPlaceholders(model);
  });
});

describe('capture --probe-login: a single-page app that renders its login form late inside a shadow root (pattern b)', () => {
  let site: LoginSite;

  before(async () => {
    site = await startSpaLoginSite();
  });

  after(async () => {
    await site?.close();
  });

  test('waits for the form, fills it so the button is enabled, and records the JSON login with its CSRF header without sending it', async () => {
    const { capture, outcome } = await probe(`${site.origin}/`);
    assert.equal(sent(site, 'POST', '/api/login'), 0, 'the probe reached the server');
    const [probed] = probes(capture);
    assert.ok(probed, JSON.stringify(outcome));
    assert.equal(pathOf(probed.request.url), '/api/login');
    assert.ok(Http.getHeader(probed.request.headers, 'x-csrf-token'));
    assert.deepEqual(outcome?.fields, ['username', 'password']);
    assert.equal(probed.response, undefined);
    const login = endpoint(ModelBuilder.create().build(capture), 'POST', '/api/login');
    assert.equal(login.count, 0);
    assert.equal(login.requestBody?.mimeType, 'application/json');
  });
});

describe('capture --probe-login: requests from a service worker and a cross-site frame are stopped too', () => {
  let site: LoginSite;

  before(async () => {
    site = await startProbeEdgeSite();
  });

  after(async () => {
    await site?.close();
  });

  for (const args of [[], ['--site-per-process']]) {
    test(`a login sent through a service worker and a beacon from a cross-site frame never reach the server${args.length > 0 ? ' (out-of-process frames)' : ''}`, async () => {
      const { capture, outcome } = await probe(`${site.origin}/sw-login`, { args });
      assert.equal(sent(site, 'POST', '/api/session'), 0, 'the login reached the server');
      assert.equal(sent(site, 'POST', '/api/frame-beacon'), 0, 'the frame beacon reached the server');
      assert.deepEqual(
        probes(capture)
          .map((exchange) => `${exchange.request.method} ${exchange.request.url}`)
          .sort(),
        [`POST ${site.origin}/api/session`, `POST ${site.origin.replace('127.0.0.1', 'localhost')}/api/frame-beacon`],
      );
      assert.ok(
        capture.exchanges.every((exchange) => exchange.source === 'probe' || pathOf(exchange.request.url) !== '/api/session'),
        'the service worker copy of the probed request is not recorded as a second request',
      );
      const login = probes(capture).find((exchange) => pathOf(exchange.request.url) === '/api/session');
      const body = JSON.parse(Http.bodyText(login?.request.body)) as Record<string, unknown>;
      assert.equal(body.email, LoginProbe.EMAIL);
      assert.equal(String(body.secret).length, 24, 'the placeholder password respects minlength');
      assert.equal(body.terms, true, 'a required checkbox is checked');
      assert.equal(body.remember, false, 'an optional checkbox is left alone');
      assert.deepEqual(outcome?.fields, ['email', 'secret', 'terms']);
    });
  }

  test('a sign-up form with two password fields and a new-password form are not login forms, so nothing is probed and the capture goes on', async () => {
    for (const path of ['/signup', '/new-password']) {
      const { capture, outcome } = await probe(`${site.origin}${path}`, { recorder: { readTimeoutMs: 1000 } });
      assert.deepEqual(probes(capture), [], path);
      assert.equal(outcome?.found, false, path);
      assert.match(outcome?.warnings[0] ?? '', /^no login form \(a form with one password field that is not for a new password\) appeared on .* within 1\.0 s; nothing was probed$/);
      assert.equal(sent(site, 'POST', '/register'), 0);
      assert.ok(capture.exchanges.some((exchange) => pathOf(exchange.request.url) === path));
    }
  });

  test('when the browser refuses the placeholder values, the probe names the field and the browser message and sends nothing', async () => {
    const { capture, outcome } = await probe(`${site.origin}/pattern`);
    assert.deepEqual(probes(capture), []);
    assert.equal(sent(site, 'POST', '/session'), 0);
    assert.deepEqual(
      outcome?.invalid?.map((field) => field.name),
      ['member'],
    );
    assert.match(outcome?.warnings[0] ?? '', /^the browser did not submit the login form with placeholder values: its form validation refused member \(".+"\)$/);
  });

  test('probing and logging in cannot be combined', () => {
    assert.throws(
      () => CaptureSession.create({ url: `${site.origin}/signup`, probeLogin: true, login: [{ name: 'user', value: 'x' }] }),
      (err: unknown) => err instanceof AppiiError && err.code === 'BAD_INPUT' && /probeLogin and login cannot be combined/.test(err.message),
    );
  });
});
