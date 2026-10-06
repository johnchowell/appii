import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { FormExtractor, LoginFormDetector } from '../src/forms/index.js';

const PAGE = 'https://site.example/login';
const extractor = FormExtractor.create();

function form(body: string) {
  const [found] = extractor.extract(`<!doctype html><html><body>${body}</body></html>`, PAGE);
  assert.ok(found, body);
  return found;
}

describe('LoginFormDetector (WHATWG autofill field names, QL-2)', () => {
  test('a form with one current password is a login form; its identifier is the one text control before the password', () => {
    const quotes = form('<form action="/login" method="post"><input type="hidden" name="csrf_token" value="t"><input type="text" id="username" name="username"><input type="password" name="password"><input type="submit" value="Login"></form>');
    assert.deepEqual(LoginFormDetector.detect(quotes), { password: 'password', identifier: 'username', personal: ['username', 'password'] });
    assert.equal(LoginFormDetector.isLogin(quotes), true);
  });

  test('autocomplete username or email names the identifier first, then type email', () => {
    const tokens = form('<form method="post"><input name="company"><input name="handle" autocomplete="section-blue work username webauthn"><input type="password" name="pw" autocomplete="current-password"></form>');
    assert.deepEqual(LoginFormDetector.detect(tokens), { password: 'pw', identifier: 'handle', personal: ['handle', 'company', 'pw'] });
    const email = form('<form method="post"><input name="team"><input type="email" name="mail"><input type="password" name="secret"></form>');
    assert.equal(LoginFormDetector.detect(email)?.identifier, 'mail');
    const after = form('<form method="post"><input type="password" name="pass"><input name="otp" autocomplete="one-time-code"></form>');
    assert.deepEqual(LoginFormDetector.detect(after), { password: 'pass', personal: ['otp', 'pass'] });
  });

  test('two text controls before the password leave the identifier unknown', () => {
    const two = form('<form method="post"><input name="first"><input name="last"><input type="password" name="password"></form>');
    assert.deepEqual(LoginFormDetector.detect(two), { password: 'password', personal: ['first', 'last', 'password'] });
  });

  test('sign-up and change-password forms are not login forms', () => {
    assert.equal(LoginFormDetector.detect(form('<form method="post"><input name="email" type="email"><input type="password" name="password" autocomplete="new-password"></form>')), undefined);
    assert.equal(LoginFormDetector.detect(form('<form method="post"><input name="email" type="email"><input type="password" name="password" autocomplete="NEW-PASSWORD webauthn"></form>')), undefined);
    assert.equal(LoginFormDetector.detect(form('<form method="post"><input name="user"><input type="password" name="password"><input type="password" name="confirm"></form>')), undefined);
    assert.equal(LoginFormDetector.detect(form('<form method="post"><input type="password" name="current"><input type="password" name="next" autocomplete="new-password"></form>')), undefined);
    assert.equal(LoginFormDetector.detect(form('<form method="get" action="/search"><input name="q"></form>')), undefined);
    assert.equal(LoginFormDetector.hasPassword(form('<form method="post"><input type="password" name="a"><input type="password" name="b"></form>')), true);
  });

  test('an unnamed password control cannot be submitted by the form and does not make a login form', () => {
    assert.equal(LoginFormDetector.detect(form('<form method="post"><input name="user"><input type="password"></form>')), undefined);
  });

  test('the autofill field name is the last token once a trailing webauthn token is removed', () => {
    assert.equal(LoginFormDetector.autofillField(' Shipping  EMAIL '), 'email');
    assert.equal(LoginFormDetector.autofillField('current-password webauthn'), 'current-password');
    assert.equal(LoginFormDetector.autofillField('\tusername\n'), 'username');
    assert.equal(LoginFormDetector.autofillField(''), undefined);
    assert.equal(LoginFormDetector.autofillField(undefined), undefined);
  });
});
