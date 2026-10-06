import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder, ModelValidator } from '../src/build/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const ORIGIN = 'https://forms.example.test';
const CSRF = 'Hq4Lw9Zt2Xk7Mb3Np8Rc5Vd1';
const ANON = 'anon7d1e2f3a4b5c6d7e8f9a0b';
const AUTH = 'auth1a2b3c4d5e6f7a8b9c0d1e';

const LOGIN = CaptureFactory.page(
  'Log in',
  `<form method="post" action="/login"><input type="hidden" name="csrf_token" value="${CSRF}"><input name="username" autocomplete="username"><input type="password" name="password" autocomplete="current-password"><button>Log in</button></form>`,
);
const SIGNUP = CaptureFactory.page(
  'Register',
  '<form id="signup" method="post" action="/register"><input name="username"><input type="email" name="email"><input type="password" name="new_password" autocomplete="new-password"><input type="password" name="confirm_password" autocomplete="new-password"><button>Sign up</button></form>',
);
const PROFILE = CaptureFactory.page('Account', `<form id="profile" method="post" action="/account/profile"><input type="hidden" name="csrf_token" value="${CSRF}"><input name="display_name"><button>Save</button></form>`);
const SEARCH = '<form id="search" method="get" action="/search"><input type="search" name="q"><button>Go</button></form>';

function session(f: CaptureFactory, options: { search?: boolean } = {}): void {
  const search = options.search === true ? SEARCH : '';
  f.document('/login', LOGIN, { responseHeaders: { 'set-cookie': `sid=${ANON}; Path=/; HttpOnly` } });
  f.snapshot('/login', 'Log in', LOGIN);
  f.document('/register', SIGNUP, { requestHeaders: { cookie: `sid=${ANON}` } });
  f.snapshot('/register', 'Register', SIGNUP);
  f.document('/', CaptureFactory.page('Home', search), { requestHeaders: { cookie: `sid=${ANON}` } });
  f.snapshot('/', 'Home', CaptureFactory.page('Home', search));
  f.exchange({
    method: 'POST',
    url: '/login',
    resourceType: 'document',
    pageUrl: `${ORIGIN}/login`,
    requestHeaders: { cookie: `sid=${ANON}`, 'content-type': 'application/x-www-form-urlencoded' },
    requestBody: `csrf_token=${CSRF}&username=reader-one&password=Sesame-2026`,
    status: 302,
    responseHeaders: { location: '/account', 'set-cookie': `sid=${AUTH}; Path=/; HttpOnly` },
  });
  f.document('/account', PROFILE, { requestHeaders: { cookie: `sid=${AUTH}` } });
  f.snapshot('/account', 'Account', PROFILE);
  f.document('/', CaptureFactory.page('Home', search), { requestHeaders: { cookie: `sid=${AUTH}` } });
  f.snapshot('/', 'Home', CaptureFactory.page('Home', search));
}

function build(f: CaptureFactory): ApiModel {
  const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture({ startUrl: `${ORIGIN}/login` }));
  assert.deepEqual(new ModelValidator().validate(model), []);
  return model;
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((each) => `${each.method} ${each.path}`).join(', ')}`);
  return found;
}

describe('credentials of a form endpoint without traffic come from when its form was seen, not from the cookie jar at the end of the capture (LL-8)', () => {
  test('a capture that ends logged in: the sign-up form seen before the login needs no credential; the profile form seen after it needs the session', () => {
    const f = new CaptureFactory(ORIGIN);
    session(f);
    f.cookie('sid', AUTH, { httpOnly: true });
    const model = build(f);
    const signup = endpoint(model, 'POST', '/register');
    assert.equal(signup.count, 0);
    assert.deepEqual(signup.auth.sets, []);
    assert.equal(signup.auth.anonymous, 'untested');
    const profile = endpoint(model, 'POST', '/account/profile');
    assert.equal(profile.count, 0);
    assert.deepEqual(profile.auth.sets, [['cookie:sid']]);
    assert.equal(profile.auth.anonymous, 'untested');
    assert.deepEqual(profile.auth.csrf.map((token) => token.sessionCookies), [['sid']]);
  });

  test('a capture that ends after a logout deleted the session: the profile form seen while logged in still needs it', () => {
    const f = new CaptureFactory(ORIGIN);
    session(f);
    f.document('/logout', '', { status: 302, requestHeaders: { cookie: `sid=${AUTH}` }, responseHeaders: { location: '/', 'set-cookie': 'sid=; Path=/; HttpOnly; Max-Age=0' } });
    const model = build(f);
    assert.deepEqual(endpoint(model, 'POST', '/account/profile').auth.sets, [['cookie:sid']]);
    assert.deepEqual(endpoint(model, 'POST', '/register').auth.sets, []);
    assert.deepEqual(endpoint(model, 'POST', '/account/profile').auth.cookies, ['sid']);
  });

  test('a form seen both before and after the login lists the credential that the logged-in page would send, with anonymous access untested', () => {
    const f = new CaptureFactory(ORIGIN);
    session(f, { search: true });
    const search = endpoint(build(f), 'GET', '/search');
    assert.equal(search.count, 0);
    assert.deepEqual(search.auth.sets, [['cookie:sid']]);
    assert.equal(search.auth.anonymous, 'untested');
  });
});
