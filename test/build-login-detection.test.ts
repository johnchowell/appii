import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CredentialAnalyzer, ModelBuilder, ModelValidator } from '../src/build/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';

function build(f: CaptureFactory, redact = true): ApiModel {
  const model = ModelBuilder.create({ now: new Date(0), redact }).build(f.capture());
  assert.deepEqual(new ModelValidator().validate(model), []);
  return model;
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

describe('CredentialAnalyzer.loginSubmission', () => {
  const analyzer = CredentialAnalyzer.create();
  const f = new CaptureFactory();

  test('finds the one filled password field and the identifier next to it, in form bodies, nested JSON and the query', () => {
    const form = f.exchange({ method: 'POST', url: '/login', requestHeaders: { 'content-type': FORM }, requestBody: 'csrf=abc&login_field=octo&pwd=Secret-1234' });
    assert.deepEqual(analyzer.loginSubmission(form, { passwordFields: new Set(['pwd']), identifierFields: new Set(['login_field']) }), {
      password: 'pwd',
      identifier: 'login_field',
      values: [{ name: 'pwd', value: 'Secret-1234', password: true }, { name: 'login_field', value: 'octo', password: false }],
    });
    const nested = f.exchange({ method: 'POST', url: '/api/session', requestHeaders: { 'content-type': JSON_TYPE }, requestBody: { json: { user: { emailAddress: 'a@b.example', password: 'Secret-1234' }, remember: true } } });
    assert.deepEqual(analyzer.loginSubmission(nested), { password: 'user.password', identifier: 'user.emailAddress', values: [{ name: 'password', value: 'Secret-1234', password: true }, { name: 'emailAddress', value: 'a@b.example', password: false }] });
    const query = f.exchange({ url: '/auth?user=octo&pass=Secret-1234' });
    assert.equal(analyzer.loginSubmission(query)?.password, 'pass');
    assert.equal(analyzer.loginSubmission(query)?.identifier, 'user');
  });

  test('a body with two passwords (sign-up, change of password) or an empty password is no login submission', () => {
    const signup = f.exchange({ method: 'POST', url: '/signup', requestHeaders: { 'content-type': FORM }, requestBody: 'email=a%40b.example&password=Secret-1234&password_confirmation=Secret-1234' });
    assert.equal(analyzer.loginSubmission(signup), undefined);
    assert.equal(analyzer.isCredentialSubmission(signup), true);
    const empty = f.exchange({ method: 'POST', url: '/login', requestHeaders: { 'content-type': FORM }, requestBody: 'email=a%40b.example&password=' });
    assert.equal(analyzer.loginSubmission(empty), undefined);
  });
});

describe('login and logout roles from forms and observed traffic (L1)', () => {
  test('a sign-up form is not a login even when its submission signs the user in', () => {
    const f = new CaptureFactory();
    const html = CaptureFactory.page('Join', '<form method="post" action="/join"><input type="email" name="email"><input type="password" name="password" autocomplete="new-password"><button>Join</button></form>');
    f.document('/join', html);
    f.snapshot('/join', 'Join', html);
    f.exchange({ method: 'POST', url: '/join', resourceType: 'document', pageUrl: f.url('/join'), requestHeaders: { 'content-type': FORM }, requestBody: 'email=new%40user.example&password=Secret-1234', status: 302, responseHeaders: { location: '/', 'set-cookie': 'session=0123456789abcdef0123; HttpOnly; Path=/' } });
    const join = endpoint(build(f), 'POST', '/join');
    assert.equal(join.role, undefined);
    assert.equal(join.login, undefined);
  });

  test('only the default button of a login form targets the login endpoint', () => {
    const f = new CaptureFactory();
    const html = CaptureFactory.page('Login', '<form method="post" action="/session"><input name="user"><input type="password" name="password"><button>Sign in</button><button formaction="/forgot">Forgot password</button></form>');
    f.document('/login', html);
    f.snapshot('/login', 'Login', html);
    const model = build(f);
    assert.equal(endpoint(model, 'POST', '/session').role, 'login');
    assert.equal(endpoint(model, 'POST', '/forgot').role, undefined);
  });

  test('a login that was submitted but issued no credential stays known from the form', () => {
    const f = new CaptureFactory();
    const html = CaptureFactory.page('Login', '<form method="post" action="/login"><input name="username"><input type="password" name="password"><button>Sign in</button></form>');
    f.document('/login', html);
    f.snapshot('/login', 'Login', html);
    f.exchange({ method: 'POST', url: '/login', resourceType: 'document', pageUrl: f.url('/login'), requestHeaders: { 'content-type': FORM }, requestBody: 'username=someone&password=Wrong-1234', status: 302, responseHeaders: { location: '/login?error=1', 'set-cookie': 'session=fedcba9876543210fedc; HttpOnly; Path=/' } });
    const model = build(f);
    const login = endpoint(model, 'POST', '/login');
    assert.deepEqual(login.login, { evidence: 'form', identifier: 'username', password: 'password', issues: { cookies: [], tokens: [] } });
    assert.equal(model.cookies.find((cookie) => cookie.name === 'session')?.issuedBy, undefined);
  });

  test('a sign-out path is a logout only when it rotates or deletes a credential cookie or was requested with one', () => {
    const f = new CaptureFactory();
    const sid = 'sid=a1b2c3d4e5f6a7b8c9d0';
    f.json('POST', '/api/login', 200, { ok: true }, { requestHeaders: { 'content-type': JSON_TYPE }, requestBody: { json: { username: 'someone', password: 'Secret-1234' } }, responseHeaders: { 'set-cookie': `${sid}; HttpOnly; Path=/` } });
    f.json('POST', '/api/logout', 204, undefined, { requestHeaders: { cookie: sid }, responseHeaders: { 'set-cookie': 'sid=; Max-Age=0; Path=/' } });
    f.document('/help/logout', CaptureFactory.page('Help', '<p>How to log out</p>'));
    const model = build(f);
    const login = endpoint(model, 'POST', '/api/login');
    const logout = endpoint(model, 'POST', '/api/logout');
    assert.equal(login.role, 'login');
    assert.equal(logout.role, 'logout');
    assert.equal(logout.name, 'postLogout');
    assert.equal(endpoint(model, 'GET', '/help/logout').role, undefined);
    assert.equal(endpoint(model, 'GET', '/help/logout').name, 'getHelpLogoutPage');
    const cookie = model.cookies.find((info) => info.name === 'sid');
    assert.deepEqual(cookie?.issuedBy, [login.id]);
    assert.deepEqual(cookie?.revokedBy, [logout.id]);
  });

  test('a user name prefilled in a login form is redacted from the form descriptors and the schema (QL-9)', () => {
    const f = new CaptureFactory();
    const html = CaptureFactory.loginHtml('0123456789abcdef0123456789abcdef', 'remembered@user.example');
    f.document('/login', html);
    f.snapshot('/login', 'Login', html);
    const model = build(f);
    assert.ok(!JSON.stringify(model).includes('remembered@user.example'));
    const field = model.forms.flatMap((form) => form.fields).find((candidate) => candidate.name === 'email');
    assert.equal(field?.value, '<redacted>');
    assert.ok(JSON.stringify(build(f, false)).includes('remembered@user.example'));
  });
});
