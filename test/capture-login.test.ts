import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import { CaptureSession } from '../src/capture/index.js';
import type { LoginField, LoginOutcome } from '../src/capture/index.js';
import type { Capture, Exchange } from '../src/model/index.js';
import { AppiiError, Http } from '../src/shared/index.js';
import { BAD_PASSWORD, LOGIN_USER, startFormLoginSite, startFormVariantsSite, startLateLoginPageSite, startSpaLoginSite, startTokenLoginSite } from './fixtures/login-sites.js';
import type { LoginSite } from './fixtures/login-sites.js';

interface LoggedIn {
  capture: Capture;
  outcome: LoginOutcome | undefined;
}

const CREDENTIALS: LoginField[] = [
  { name: 'username', value: LOGIN_USER.username },
  { name: 'password', value: LOGIN_USER.password },
];

async function capture(url: string, login: readonly LoginField[], visits: readonly string[] = [], readTimeoutMs = 5000): Promise<LoggedIn> {
  let outcome: LoginOutcome | undefined;
  const result = await CaptureSession.create({
    url,
    visits,
    login,
    headless: true,
    idleMs: 300,
    recorder: { readTimeoutMs },
    onLogin: (value) => {
      outcome = value;
    },
  }).run();
  return { capture: result, outcome };
}

function path(exchange: Exchange): string {
  const url = new URL(exchange.request.url);
  return `${exchange.request.method} ${url.pathname}${url.search}`;
}

function paths(result: Capture): string[] {
  return result.exchanges.map((exchange) => path(exchange));
}

function find(result: Capture, method: string, pathname: string): Exchange[] {
  return result.exchanges.filter((exchange) => exchange.request.method === method && new URL(exchange.request.url).pathname === pathname);
}

function received(site: LoginSite, pathname = '/submit'): URLSearchParams[] {
  return site.requests.filter((request) => request.path.split('?')[0] === pathname).map((request) => new URLSearchParams(request.method === 'POST' ? request.body : (request.path.split('?')[1] ?? '')));
}

function rejectsWith(pattern: RegExp, secret?: string) {
  return (err: unknown): boolean => {
    assert.ok(err instanceof AppiiError, String(err));
    assert.equal(err.code, 'CAPTURE');
    assert.match(err.message, pattern);
    if (secret !== undefined) {
      assert.ok(!err.message.includes(secret), err.message);
      assert.ok(!String(err.stack).includes(secret));
      assert.ok(!String((err.cause as Error | undefined)?.stack ?? '').includes(secret));
    }
    return true;
  };
}

describe('capture --login: a server-rendered form with a CSRF token bound to a rotating session cookie', () => {
  let site: LoginSite;

  before(async () => {
    site = await startFormLoginSite();
  });

  after(async () => {
    await site?.close();
  });

  test('fills the form like a user, clicks its submit button, follows the redirect and then opens the other URLs in order', async () => {
    const { capture: result, outcome } = await capture(`${site.origin}/login`, CREDENTIALS, [`${site.origin}/account`, `${site.origin}/page/2/`, `${site.origin}/logout`]);
    const sequence = paths(result);
    const login = find(result, 'POST', '/login');
    assert.equal(login.length, 1, sequence.join('\n'));
    const fields = new URLSearchParams(Http.bodyText(login[0]!.request.body));
    assert.deepEqual([...fields.keys()], ['csrf_token', 'username', 'password']);
    assert.equal(fields.get('username'), LOGIN_USER.username);
    assert.equal(fields.get('password'), LOGIN_USER.password);
    assert.equal(login[0]!.response?.status, 302);
    const anonymous = find(result, 'GET', '/login')[0]!;
    const anonymousSession = /session=([^;]+)/.exec(Http.getHeaderAll(anonymous.response!.headers, 'set-cookie').join('\n'))?.[1];
    assert.ok(anonymousSession);
    assert.match(Http.getHeader(login[0]!.request.headers, 'cookie') ?? '', new RegExp(`session=${anonymousSession}`));
    const account = find(result, 'GET', '/account');
    assert.equal(account.length, 1);
    assert.equal(account[0]!.response?.status, 200, 'the protected page answers 200 after the login');
    assert.ok(sequence.indexOf('GET /account') < sequence.indexOf('GET /page/2/') && sequence.indexOf('GET /page/2/') < sequence.indexOf('GET /logout'), sequence.join('\n'));
    assert.ok(outcome);
    assert.equal(outcome.pageUrl, `${site.origin}/login`);
    assert.equal(outcome.action, `${site.origin}/login`);
    assert.equal(outcome.method, 'POST');
    assert.deepEqual(outcome.fields, ['username', 'password']);
    assert.equal(outcome.trigger, 'button');
    assert.deepEqual(outcome.submission, { method: 'POST', url: `${site.origin}/login`, status: 302 });
    assert.equal(outcome.finalUrl, `${site.origin}/`);
    assert.deepEqual(outcome.warnings, []);
  });

  test('warns, without failing, when the submission answers 4xx and the form comes back with an empty password', async () => {
    const { capture: result, outcome } = await capture(`${site.origin}/login`, [
      { name: 'username', value: LOGIN_USER.username },
      { name: 'password', value: BAD_PASSWORD },
    ]);
    assert.equal(find(result, 'POST', '/login')[0]?.response?.status, 401);
    assert.ok(outcome);
    assert.deepEqual(outcome.warnings, [
      `the login submission POST ${site.origin}/login answered 401; the credentials are probably wrong`,
      'the login form is still on the page with an empty password after submitting; the credentials were probably not accepted',
    ]);
    assert.ok(outcome.warnings.every((warning) => !warning.includes(BAD_PASSWORD)));
  });
});

describe('capture --login: a single-page app that renders its login form late, inside a shadow root', () => {
  let site: LoginSite;

  before(async () => {
    site = await startSpaLoginSite();
  });

  after(async () => {
    await site?.close();
  });

  test('waits for the form, fires input events that enable the button, and records the JSON login and the API calls it unlocks', async () => {
    const { capture: result, outcome } = await capture(`${site.origin}/`, CREDENTIALS);
    const login = find(result, 'POST', '/api/login');
    assert.equal(login.length, 1, paths(result).join('\n'));
    assert.deepEqual(JSON.parse(Http.bodyText(login[0]!.request.body)), { username: LOGIN_USER.username, password: LOGIN_USER.password });
    assert.match(Http.getHeader(login[0]!.request.headers, 'x-csrf-token') ?? '', /^[0-9a-f]{32}$/);
    assert.equal(login[0]!.response?.status, 200);
    assert.deepEqual(
      find(result, 'GET', '/api/me').map((exchange) => exchange.response?.status),
      [401, 200],
    );
    assert.equal(find(result, 'GET', '/api/items')[0]?.response?.status, 200);
    assert.ok(outcome);
    assert.equal(outcome.trigger, 'button');
    assert.deepEqual(outcome.submission, { method: 'POST', url: `${site.origin}/api/login`, status: 200 });
    assert.equal(outcome.finalUrl, `${site.origin}/dashboard`);
    assert.deepEqual(outcome.warnings, []);
  });

  test('the user name typed into the late-rendered form is not recorded as its default value, so the model gives the field no default', async () => {
    const { capture: result } = await capture(`${site.origin}/`, CREDENTIALS);
    const snapshots = result.pages.filter((page) => page.html.includes('name="username"'));
    assert.ok(snapshots.length > 0, result.pages.map((page) => page.url).join('\n'));
    assert.ok(result.pages.every((page) => !page.html.includes(`value="${LOGIN_USER.username}"`)), 'no snapshot holds the typed user name as a value');
    const model = ModelBuilder.create({ now: new Date(0) }).build(result);
    const fields = model.forms.flatMap((form) => form.fields).filter((field) => field.name === 'username');
    assert.ok(fields.length > 0, JSON.stringify(model.forms));
    for (const field of fields) {
      assert.equal(field.hasValueAttribute, false, JSON.stringify(field));
      assert.equal(field.value, '');
    }
  });

  test('a wrong password in a script login is reported by the 401 and by the cleared password', async () => {
    const { outcome } = await capture(`${site.origin}/`, [
      { name: 'username', value: LOGIN_USER.username },
      { name: 'password', value: BAD_PASSWORD },
    ]);
    assert.ok(outcome);
    assert.deepEqual(outcome.submission, { method: 'POST', url: `${site.origin}/api/login`, status: 401 });
    assert.equal(outcome.warnings.length, 2, outcome.warnings.join('\n'));
  });
});

describe('capture --login: a script login that posts JSON and gets a token', () => {
  test('the token comes back as a cookie that later requests send', async () => {
    const site = await startTokenLoginSite();
    try {
      const { capture: result, outcome } = await capture(`${site.origin}/signin`, CREDENTIALS);
      const login = find(result, 'POST', '/api/auth/login')[0];
      assert.ok(login, paths(result).join('\n'));
      assert.equal(Http.getHeader(login.request.headers, 'content-type'), 'application/json');
      assert.match(Http.getHeaderAll(login.response!.headers, 'set-cookie').join('\n'), /^token=/);
      const profile = find(result, 'GET', '/api/profile')[0];
      assert.equal(profile?.response?.status, 200);
      assert.match(Http.getHeader(profile!.request.headers, 'cookie') ?? '', /token=/);
      assert.deepEqual(outcome?.submission, { method: 'POST', url: `${site.origin}/api/auth/login`, status: 200 });
      assert.deepEqual(outcome?.warnings, []);
    } finally {
      await site.close();
    }
  });

  test('the token comes back in the JSON body and later requests send it as a bearer', async () => {
    const site = await startTokenLoginSite({ bearer: true });
    try {
      const { capture: result, outcome } = await capture(`${site.origin}/signin`, CREDENTIALS);
      const login = find(result, 'POST', '/api/auth/login')[0];
      const token = (Http.bodyJson(login?.response?.body) as { token?: string }).token;
      assert.ok(token);
      const profile = find(result, 'GET', '/api/profile')[0];
      assert.equal(Http.getHeader(profile!.request.headers, 'authorization'), `Bearer ${token}`);
      assert.equal(profile?.response?.status, 200);
      assert.deepEqual(outcome?.warnings, []);
    } finally {
      await site.close();
    }
  });
});

describe('capture --login: finding, filling and submitting the form the way the HTML standard defines', () => {
  let site: LoginSite;

  before(async () => {
    site = await startFormVariantsSite();
  });

  after(async () => {
    await site?.close();
  });

  test('controls associated by the form attribute belong to their form owner; select, checkbox and radio are set like a user, and the default button is the first submit button in tree order', async () => {
    const before = received(site).length;
    const { outcome } = await capture(`${site.origin}/owner`, [
      { name: 'user', value: 'owner-user' },
      { name: 'pass', value: 'Owner-Pass-1' },
      { name: 'tenant', value: 'b' },
      { name: 'remember', value: 'yes' },
      { name: 'realm', value: 'staff' },
    ]);
    const sent = received(site).slice(before);
    assert.equal(sent.length, 1);
    assert.deepEqual([...sent[0]!], [
      ['user', 'owner-user'],
      ['pass', 'Owner-Pass-1'],
      ['tenant', 'b'],
      ['remember', 'yes'],
      ['realm', 'staff'],
      ['go', 'first'],
    ]);
    assert.equal(outcome?.action, `${site.origin}/submit`);
    assert.deepEqual(outcome?.fields, ['user', 'pass', 'tenant', 'remember', 'realm']);
  });

  test('a --login name that matches submit buttons picks the submitter by its value', async () => {
    const before = received(site).length;
    await capture(`${site.origin}/owner`, [
      { name: 'user', value: 'owner-user' },
      { name: 'pass', value: 'Owner-Pass-1' },
      { name: 'go', value: 'second' },
    ]);
    const sent = received(site).slice(before);
    assert.equal(sent[0]?.get('go'), 'second');
  });

  test('when the browser\'s constraint validation refuses the form, the outcome names each refused field with the browser\'s message and never the value (LV2-6)', async () => {
    const before = received(site).length;
    const value = 'not-an-email-7f3a';
    const { outcome } = await capture(`${site.origin}/email`, [
      { name: 'user[email]', value },
      { name: 'user[password]', value: 'Short-1' },
    ]);
    assert.equal(received(site).length, before, 'nothing was sent');
    assert.ok(outcome);
    assert.equal(outcome.submission, undefined);
    assert.equal(outcome.trigger, 'button');
    assert.deepEqual(
      outcome.invalid?.map((field) => field.name),
      ['user[email]', 'user[password]'],
    );
    assert.match(outcome.invalid?.[0]?.message ?? '', /@/);
    assert.match(outcome.invalid?.[1]?.message ?? '', /8/);
    assert.equal(outcome.warnings.length, 1, outcome.warnings.join('\n'));
    assert.match(outcome.warnings[0]!, /^the browser did not submit the login form: its form validation refused user\[email\] \(".+@.+"\) and user\[password\] \(".+8.+"\)$/);
    assert.ok(!JSON.stringify(outcome).includes(value), JSON.stringify(outcome));
    assert.ok(!JSON.stringify(outcome).includes('Short-1'));
  });

  test('a form with novalidate, or a submitter with formnovalidate, is submitted as in a browser and no field is reported as refused', async () => {
    for (const page of ['/email-novalidate', '/email-formnovalidate']) {
      const before = received(site).length;
      const { outcome } = await capture(`${site.origin}${page}`, [
        { name: 'user[email]', value: 'not-an-email' },
        { name: 'user[password]', value: 'Short-1' },
      ]);
      assert.equal(received(site).slice(before)[0]?.get('user[email]'), 'not-an-email', page);
      assert.equal(outcome?.invalid, undefined, page);
      assert.deepEqual(outcome?.warnings, [], page);
    }
  });

  test('a form without a submit button and one field that blocks implicit submission is submitted by pressing Enter', async () => {
    const before = received(site).length;
    const { outcome } = await capture(`${site.origin}/enter`, [
      { name: 'pass', value: 'Enter-Pass-1' },
      { name: 'trust', value: '1' },
    ]);
    assert.equal(outcome?.trigger, 'enter');
    assert.deepEqual([...received(site).slice(before)[0]!], [
      ['user', 'preset'],
      ['pass', 'Enter-Pass-1'],
      ['trust', '1'],
    ]);
    assert.deepEqual(outcome?.warnings, []);
  });

  test('pressing Enter in a form without a submit button and two blocking fields submits nothing, as in a real browser, and says so', async () => {
    const before = received(site).length;
    const { outcome } = await capture(`${site.origin}/enter-blocked`, [
      { name: 'user', value: 'enter-user' },
      { name: 'pass', value: 'Enter-Pass-1' },
    ]);
    assert.equal(outcome?.trigger, 'enter');
    assert.equal(received(site).length, before);
    assert.equal(outcome?.submission, undefined);
    assert.deepEqual(outcome?.warnings, ['submitting the login form sent no request and stayed on the same page']);
  });

  test('a hidden default button is used through implicit submission, so its name and value are submitted', async () => {
    const before = received(site).length;
    const { outcome } = await capture(`${site.origin}/hidden-default`, [
      { name: 'user', value: 'enter-user' },
      { name: 'pass', value: 'Enter-Pass-1' },
    ]);
    assert.equal(outcome?.trigger, 'enter');
    assert.equal(received(site).slice(before)[0]?.get('kind'), 'hidden-default');
  });

  test('of two matching forms the visible one is used', async () => {
    const before = site.requests.length;
    const { outcome } = await capture(`${site.origin}/twice`, [
      { name: 'user', value: 'twice-user' },
      { name: 'pass', value: 'Twice-Pass-1' },
    ]);
    assert.equal(outcome?.action, `${site.origin}/submit?copy=shown`);
    assert.ok(site.requests.slice(before).some((request) => request.path === '/submit?copy=shown'));
  });

  test('a form rendered late by a script is waited for', async () => {
    const before = received(site).length;
    const { outcome } = await capture(`${site.origin}/late`, [
      { name: 'user', value: 'late-user' },
      { name: 'pass', value: 'Late-Pass-1' },
    ]);
    assert.equal(outcome?.pageUrl, `${site.origin}/late`);
    assert.equal(received(site).slice(before)[0]?.get('user'), 'late-user');
  });

  test('when no form has every given name, the error lists the forms and their control names and never a value', async () => {
    const secret = 'Never-Printed-77';
    await assert.rejects(
      capture(`${site.origin}/nothing`, [
        { name: 'user', value: 'someone' },
        { name: 'pass', value: secret },
      ], [], 1000),
      rejectsWith(new RegExp(`^No form on ${site.origin}/nothing has controls named user, pass \\(waited 1\\.0 s\\)\\. forms found: form 1 \\(GET ${site.origin}/search\\): q\\. controls outside any form: loose$`), secret),
    );
  });

  test('a matching form that never becomes visible is reported as such', async () => {
    await assert.rejects(
      capture(`${site.origin}/invisible`, [
        { name: 'user', value: 'someone' },
        { name: 'pass', value: 'Invisible-Pass-1' },
      ], [], 1000),
      rejectsWith(/^The form with user, pass on .*\/invisible did not become visible within 1\.0 s$/),
    );
  });

  test('a value that cannot be chosen is an error that names the field but not the value', async () => {
    const secret = 'Unknown-Option-99';
    await assert.rejects(
      capture(`${site.origin}/owner`, [
        { name: 'user', value: 'owner-user' },
        { name: 'tenant', value: secret },
      ], [], 1000),
      rejectsWith(/^Cannot use the login field tenant: it did not become ready within 1\.0 s$/, secret),
    );
    await assert.rejects(
      capture(`${site.origin}/owner`, [
        { name: 'user', value: 'owner-user' },
        { name: 'remember', value: secret },
      ], [], 1000),
      rejectsWith(/^--login remember: no checkbox or radio button named remember has the given value$/, secret),
    );
    await assert.rejects(
      capture(`${site.origin}/owner`, [{ name: 'help', value: 'x' }], [], 1000),
      rejectsWith(/^--login help: the control named help \(button\) cannot be filled like a user would/),
    );
  });
});

describe('capture of several URLs without --login: each page settles before the next one opens', () => {
  test('a login form that a script renders after a slow fetch is recorded before the second URL opens, and the build knows the login endpoint from it', async () => {
    const site = await startLateLoginPageSite();
    try {
      const result = await CaptureSession.create({ url: `${site.origin}/login`, visits: [`${site.origin}/about`], headless: true, idleMs: 800, recorder: { readTimeoutMs: 5000 } }).run();
      const config = find(result, 'GET', '/api/config');
      assert.equal(config.length, 1, paths(result).join('\n'));
      assert.equal(config[0]!.response?.status, 200, config[0]!.error);
      assert.equal(config[0]!.error, undefined);
      const sequence = paths(result);
      assert.ok(sequence.indexOf('GET /api/config') < sequence.indexOf('GET /about'), sequence.join('\n'));
      assert.ok(
        result.pages.some((page) => page.url === `${site.origin}/login` && page.html.includes('action="/session"')),
        result.pages.map((page) => page.url).join('\n'),
      );
      const model = ModelBuilder.create({ now: new Date(0) }).build(result);
      const login = model.endpoints.find((endpoint) => endpoint.method === 'POST' && endpoint.path === '/session');
      assert.ok(login, model.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`).join(', '));
      assert.equal(login.count, 0);
      assert.equal(login.role, 'login');
      assert.equal(login.login?.evidence, 'form');
      assert.equal(login.login?.password, 'pass');
    } finally {
      await site.close();
    }
  });
});
