import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HtmlDocument, TokenDetector } from '../src/forms/index.js';
import { startFixtureSite } from './fixtures/site.js';

const detector = new TokenDetector();

test('isTokenField recognizes framework CSRF and state token field names', () => {
  const tokens = [
    'csrf_token', '_csrf', 'csrf', 'CSRFToken', 'csrfmiddlewaretoken', 'YII_CSRF_TOKEN', '_xsrf', 'xsrf-token', 'anticsrf',
    '_token', 'token', 'authenticity_token', '__RequestVerificationToken', 'form_build_id', 'form_token', 'form_key', 'formkey',
    '__VIEWSTATE', '__VIEWSTATEGENERATOR', '__VIEWSTATEENCRYPTED', '__EVENTVALIDATION', '__PREVIOUSPAGE', '__REQUESTDIGEST',
    'javax.faces.ViewState', 'struts.token', 'org.apache.struts.taglib.html.TOKEN', 'sesskey', '_sourcePage', '__fp',
    'nonce', '_wpnonce', 'woocommerce-login-nonce', 'anti_forgery_token', 'user[authenticity_token]', 'registration_form[_token]',
  ];
  for (const name of tokens) assert.ok(detector.isTokenField(name), name);
});

test('isTokenField ignores ordinary field names', () => {
  const plain = [
    '', 'email', 'password', 'username', 'q', 'action', 'access_token', 'token_type', 'tokens', 'my_token', 'remember', 'state',
    '__EVENTTARGET', '__EVENTARGUMENT', 'announcement', 'form_id', 'utf8', 'viewstate_mode', 'form[token_x]', 'javaxfacesviewstate',
  ];
  for (const name of plain) assert.ok(!detector.isTokenField(name), name);
});

test('FIELD_PATTERN is a stateless case-insensitive rule table', () => {
  assert.equal(TokenDetector.FIELD_PATTERN.flags, 'i');
  assert.equal(TokenDetector.META_PATTERN.flags, 'i');
  for (let i = 0; i < 3; i++) assert.ok(TokenDetector.FIELD_PATTERN.test('csrf_token'));
  assert.ok(TokenDetector.FIELD_NAMES.every((name) => name === name.toLowerCase()));
  assert.ok(TokenDetector.FIELD_NAMES.every((name) => detector.isTokenField(name)));
});

test('pageTokens returns CSRF meta tags by name with their content', () => {
  const html = `<!doctype html><html><head>
    <meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="description" content="x">
    <meta name="csrf-token" content="abc123"><meta name="csrf-param" content="authenticity_token">
    <meta name="_csrf" content="spring"><meta name="_csrf_header" content="X-CSRF-TOKEN"><meta name="xsrf-token" content="x1">
    <meta name="csrf_token" content="py"><meta name="CSRF-Token" content="upper"><meta name="request-verification-token" content="rv">
    <meta name="csrf-token" content="second"><meta name="csrf-empty"><meta property="csrf-token" content="prop">
  </head><body><meta name="x-csrf-token" content="in-body"><template><meta name="csrf-template" content="t"></template></body></html>`;
  assert.deepEqual(detector.pageTokens(html), {
    'csrf-token': 'abc123',
    'csrf-param': 'authenticity_token',
    _csrf: 'spring',
    _csrf_header: 'X-CSRF-TOKEN',
    'xsrf-token': 'x1',
    csrf_token: 'py',
    'CSRF-Token': 'upper',
    'request-verification-token': 'rv',
    'x-csrf-token': 'in-body',
  });
});

test('pageTokens handles pages without tokens and hostile names', () => {
  assert.deepEqual(detector.pageTokens(''), {});
  assert.deepEqual(detector.pageTokens('<meta name="description" content="x">'), {});
  const tokens = detector.pageTokens('<meta name="__proto__csrf" content="p"><meta name="constructor" content="c">');
  assert.deepEqual(Object.keys(tokens), ['__proto__csrf']);
  assert.equal(Object.getPrototypeOf(tokens), Object.prototype);
});

test('documentTokens works on an already parsed document', () => {
  const doc = HtmlDocument.parse('<meta name="csrf-token" content="z">', 'https://example.com/');
  assert.deepEqual(detector.documentTokens(doc), { 'csrf-token': 'z' });
});

test('fixture app page exposes no meta token and the login form token is a field token', async () => {
  const site = await startFixtureSite();
  try {
    const login = await (await fetch(site.origin + '/login')).text();
    assert.deepEqual(detector.pageTokens(login), {});
    assert.ok(detector.isTokenField('csrf_token'));
    const app = await (await fetch(site.origin + '/app')).text();
    assert.deepEqual(detector.pageTokens(app), {});
  } finally {
    await site.close();
  }
});
