import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder, ModelValidator } from '../src/build/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { EndpointDetailPresenter, EndpointListPresenter } from '../src/present/index.js';
import { Ansi, EndpointIndex, FormSource } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const ORIGIN = 'https://shelf.example.test';
const ANON = 'anon-0a1b2c3d4e5f60718293a4b5';
const USER = 'user-9f8e7d6c5b4a39281706f5e4';
const LOGIN = CaptureFactory.page('Sign in', '<form method="post" action="/session"><input type="email" name="email" autocomplete="username"><input type="password" name="password" autocomplete="current-password"><button>Sign in</button></form>');
const SEARCH = '<form action="/search"><input name="q"><button>Search</button></form>';
const ACCOUNT = CaptureFactory.page('Account', `<h1>Account</h1>${SEARCH}<form method="post" action="/account/password"><input type="password" name="current" autocomplete="current-password"><input type="password" name="fresh" autocomplete="new-password"><button>Change</button></form>`);

function model(): ApiModel {
  const f = new CaptureFactory(ORIGIN);
  f.document('/', CaptureFactory.page('Shelf', SEARCH), { responseHeaders: { 'set-cookie': `sid=${ANON}; Path=/; HttpOnly` } });
  f.snapshot('/', 'Shelf', CaptureFactory.page('Shelf', SEARCH));
  const refused = f.document('/account', '', { status: 302, requestHeaders: { cookie: `sid=${ANON}` }, responseHeaders: { location: '/login' } });
  f.document('/login', LOGIN, { redirectedFrom: refused.id, requestHeaders: { cookie: `sid=${ANON}` } });
  f.snapshot('/login', 'Sign in', LOGIN);
  const login = f.exchange({
    method: 'POST',
    url: '/session',
    resourceType: 'document',
    pageUrl: `${ORIGIN}/login`,
    requestHeaders: { cookie: `sid=${ANON}`, 'content-type': 'application/x-www-form-urlencoded' },
    requestBody: 'email=reader%40example.test&password=Shelf-Pass-2026',
    status: 302,
    responseHeaders: { location: '/account', 'set-cookie': `sid=${USER}; Path=/; HttpOnly` },
  });
  f.document('/account', ACCOUNT, { redirectedFrom: login.id, requestHeaders: { cookie: `sid=${USER}` } });
  f.snapshot('/account', 'Account', ACCOUNT);
  const built = ModelBuilder.create({ now: new Date(0) }).build(f.capture({ startUrl: `${ORIGIN}/` }));
  assert.deepEqual(new ModelValidator().validate(built), []);
  return built;
}

function endpoint(built: ApiModel, method: string, path: string): Endpoint {
  const found = built.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${built.endpoints.map((each) => `${each.method} ${each.path}`).join(', ')}`);
  return found;
}

describe('an endpoint known only from a form on a page that loads only while logged in (LV3-8)', () => {
  test('the list names it under After login with a note that no request was observed; a form on a public page is not listed', () => {
    const built = model();
    const index = EndpointIndex.of(built);
    const change = endpoint(built, 'POST', '/account/password');
    const search = endpoint(built, 'GET', '/search');
    assert.equal(change.count, 0);
    assert.equal(search.count, 0);
    assert.equal(endpoint(built, 'GET', '/account').auth.anonymous, 'refused');
    const lines = Ansi.strip(new EndpointListPresenter({ width: 200 }).render(built)).split('\n');
    const after = lines.find((line) => line.startsWith('After login:'));
    assert.equal(after?.replace(/^After login: +/, ''), `${index.numberOf(change)} (found only on pages loaded while logged in; no request observed)`, lines.join('\n'));
  });

  test('--show says the form was found only on pages loaded while logged in, and nothing for a public form', () => {
    const built = model();
    const show = (ref: string): string[] => Ansi.strip(new EndpointDetailPresenter({ width: 200 }).render({ model: built, ref })).split('\n');
    assert.ok(show(endpoint(built, 'POST', '/account/password').id).some((line) => /^Seen: +not observed; its form was found only on pages loaded while logged in$/.test(line)));
    assert.ok(show(endpoint(built, 'GET', '/search').id).some((line) => /^Seen: +not observed$/.test(line)));
  });
});

describe('a form selector that enters a shadow root names its notation in --show (LV3-7)', () => {
  test('the Notation line follows a selector with >>, and only then', () => {
    const f = new CaptureFactory(ORIGIN);
    const html = CaptureFactory.page('Login', '<x-login><template shadowrootmode="open"><form method="post" action="/session"><input name="email"><input type="password" name="password"><button>Sign in</button></form></template></x-login><form action="/search"><input name="q"></form>');
    f.document('/login', html);
    f.snapshot('/login', 'Login', html);
    const built = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
    const session = endpoint(built, 'POST', '/session');
    assert.equal(session.form?.selector, ':root > body:nth-child(2) > x-login:nth-child(1) >> form:nth-child(1)');
    const show = (ref: string): string[] => Ansi.strip(new EndpointDetailPresenter({ width: 200 }).render({ model: built, ref })).split('\n');
    assert.ok(show(session.id).some((line) => /^Notation: +each >> enters the open shadow root of the element matched before it; Playwright reads the selector as is$/.test(line)));
    assert.ok(!show(endpoint(built, 'GET', '/search').id).some((line) => line.startsWith('Notation:')));
    assert.equal(FormSource.describe(session), `Submitted by the form ${session.form?.selector} (${FormSource.SHADOW_NOTE}) on ${ORIGIN}/login (application/x-www-form-urlencoded).`);
    assert.equal(FormSource.selectorNote(endpoint(built, 'GET', '/search').form?.selector ?? ''), undefined);
  });
});
