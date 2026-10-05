import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder, PathTemplater, Redactor } from '../src/build/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { Samples } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const R = Samples.REDACTED;
const ENC = encodeURIComponent(R);
const redactor = Redactor.create();
const JWT = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXZhbHVl';

function build(f: CaptureFactory, startUrl?: string): ApiModel {
  return ModelBuilder.create({ now: new Date(0) }).build(f.capture(startUrl === undefined ? {} : { startUrl }));
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

function leaks(model: ApiModel, secrets: readonly string[]): string[] {
  const text = JSON.stringify(model);
  return secrets.filter((secret) => text.includes(secret));
}

describe('Redactor name rules', () => {
  test('password, PIN, token and key names are secret in every spelling', () => {
    const secret = [
      'password', 'password1', 'password2', 'new_password1', 'newpassword', 'confirmPassword', 'passwordConfirmation', 'pass1', 'pass2',
      'pw', 'pwd', 'passwd', 'passphrase', 'passcode', 'pin', 'otp', 'client_secret', 'appSecret', 'api_key', 'apiKey', 'x-api-key',
      'access_token', 'refreshToken', 'id_token', 'logintoken', 'securitytoken', 'csrfmiddlewaretoken', '_wpnonce', 'sesskey',
      'authenticity_token', 'card_number', 'cvc', 'ssn', 'session_id', 'sessionid', 'private_key', 'subscription-key',
      'rp_key', 'resetKey', 'activation_key', 'verification_code', 'sms_code', 'two_factor_code', 'backupCode',
    ];
    for (const name of secret) assert.ok(redactor.isSecretField(name), name);
  });

  test('ordinary names stay visible', () => {
    const plain = ['', 'username', 'email', 'q', 'title', 'passenger', 'author', 'compass', 'secretary', 'keyboard', 'pinned', 'page', 'sort', 'state', 'code', 'key', 'sort_key', 'country_code', 'zip_code', 'public_key'];
    for (const name of plain) assert.ok(!redactor.isSecretField(name), name);
  });

  test('query parameters add the credential names that APIs use in URLs', () => {
    const url = (text: string): URL => new URL(text);
    assert.ok(redactor.isSecretQueryParam('key', url('https://maps.example/geocode/json?address=x&key=k')));
    assert.ok(redactor.isSecretQueryParam('appid', url('https://api.example/weather?q=Berlin&appid=a')));
    assert.ok(redactor.isSecretQueryParam('access_key', url('https://api.example/check?access_key=a')));
    assert.ok(redactor.isSecretQueryParam('sig', url('https://blob.example/f.txt?sv=2022-11-02&sig=s')));
    assert.ok(redactor.isSecretQueryParam('X-Amz-Signature', url('https://s3.example/o?X-Amz-Signature=s')));
    assert.ok(redactor.isSecretQueryParam('code', url('https://app.example/oauth/callback?code=c')));
    assert.ok(redactor.isSecretQueryParam('code', url('https://app.example/done?code=c&state=xyz')));
    assert.ok(!redactor.isSecretQueryParam('code', url('https://shop.example/countries?code=US')));
    for (const name of ['q', 'address', 'sv', 'state', 'sp']) assert.ok(!redactor.isSecretQueryParam(name, url('https://x.example/callback')), name);
  });

  test('CSRF header names are secret headers, including the WordPress nonce header', () => {
    for (const name of ['x-wp-nonce', 'X-CSRF-Token', 'x-xsrf-token', 'RequestVerificationToken']) {
      assert.ok(redactor.isSecretHeader(name), name);
      assert.equal(redactor.header(name, 'abc123'), R, name);
    }
    assert.equal(redactor.header('x-request-id', 'abc123'), 'abc123');
  });
});

describe('Redactor URL rules', () => {
  test('query values of secret names and secret values are replaced, other parts are kept', () => {
    assert.equal(
      redactor.url('https://maps.example/geocode/json?address=x&key=AIzaSyA-secret'),
      `https://maps.example/geocode/json?address=x&key=${ENC}`,
    );
    assert.equal(redactor.url('https://blob.example/f.txt?sv=2022-11-02&sp=r&sig=Zm9v%3D'), `https://blob.example/f.txt?sv=2022-11-02&sp=r&sig=${ENC}`);
    assert.equal(redactor.url('https://app.example/oauth/callback?code=4%2F0AX4&state=xyz'), `https://app.example/oauth/callback?code=${ENC}&state=xyz`);
    assert.equal(redactor.url('https://shop.example/countries?code=US'), 'https://shop.example/countries?code=US');
  });

  test('fragments with name=value pairs follow the query rules', () => {
    assert.equal(
      redactor.url('https://app.example.com/callback?session_id=S1#access_token=FRAG777&token_type=bearer&expires_in=3600'),
      `https://app.example.com/callback?session_id=${ENC}#access_token=${ENC}&token_type=${ENC}&expires_in=3600`,
    );
    assert.equal(redactor.url('https://app.example/#/reset?id_token=abc&next=%2Fhome'), `https://app.example/#/reset?id_token=${ENC}&next=%2Fhome`);
    assert.equal(redactor.url('https://app.example/page#section-2'), 'https://app.example/page#section-2');
    assert.equal(redactor.url(`https://app.example/#/magic/${JWT}`), `https://app.example/#/magic/${ENC}`);
  });

  test('path segments that hold a JWT are replaced', () => {
    assert.equal(redactor.url(`https://app.example/auth/magic/${JWT}?next=1`), `https://app.example/auth/magic/${ENC}?next=1`);
    assert.equal(redactor.url('https://app.example/api/items/42'), 'https://app.example/api/items/42');
  });

  test('JSON documents inside query values are redacted key by key', () => {
    const variables = JSON.stringify({ token: 'GETVARTOKEN_111', password: 'GETVARPW_222', id: '7' });
    const out = redactor.url(`https://app.example/graphql?operationName=VerifyEmail&variables=${encodeURIComponent(variables)}`);
    const parsed = JSON.parse(new URL(out).searchParams.get('variables') ?? 'null');
    assert.deepEqual(parsed, { token: R, password: R, id: '7' });
  });

  test('redaction is idempotent and can be switched off', () => {
    const once = redactor.url(`https://u:p@app.example/a/${JWT}?api_key=1#access_token=2`);
    assert.equal(redactor.url(once), once);
    const off = new Redactor(false);
    assert.equal(off.url(`https://app.example/a/${JWT}?api_key=1`), `https://app.example/a/${JWT}?api_key=1`);
  });
});

describe('Redactor value rules', () => {
  test('text/plain form bodies redact secret lines and keep the line endings', () => {
    assert.equal(redactor.plainText('user=bob\r\npassword=PlainSecret\r\nnote=a=b\r\n'), `user=bob\r\npassword=${R}\r\nnote=a=b\r\n`);
    assert.equal(redactor.plainText('x=1\nsecretish=2', new Set(['x'])), `x=${R}\nsecretish=2`);
    assert.equal(redactor.plainText(`free text\nbearer=${JWT}`), `free text\nbearer=${R}`);
  });

  test('WebSocket frames: JSON, socket.io and engine.io packets, record separators and STOMP headers', () => {
    assert.equal(redactor.frame('{"type":"auth","token":"PLAIN_3"}'), `{"type":"auth","token":"${R}"}`);
    assert.equal(redactor.frame('40{"token":"SIOAUTHSECRET_1"}'), `40{"token":"${R}"}`);
    assert.equal(redactor.frame('42["login",{"password":"SIOPW_2"}]'), `42["login",{"password":"${R}"}]`);
    assert.equal(redactor.frame('431["ack",{"secret":"S"}]'), `431["ack",{"secret":"${R}"}]`);
    assert.equal(redactor.frame('42/chat,["msg",{"pin":"1234"}]'), `42/chat,["msg",{"pin":"${R}"}]`);
    assert.equal(redactor.frame('451-["upload",{"apiKey":"K"}]'), `451-["upload",{"apiKey":"${R}"}]`);
    assert.equal(redactor.frame('{"protocol":"json"}\u001e{"type":1,"arguments":[{"token":"T"}]}\u001e'), `{"protocol":"json"}\u001e{"type":1,"arguments":[{"token":"${R}"}]}\u001e`);
    assert.equal(redactor.frame('CONNECT\nlogin:guest\npasscode:hunter2\n\n\u0000'), `CONNECT\nlogin:guest\npasscode:${R}\n\n\u0000`);
    assert.equal(redactor.frame('2'), '2');
    assert.equal(redactor.frame('hello'), 'hello');
  });

  test('JWTs in path segments are templated as parameters', () => {
    const templates = new PathTemplater().template([`/auth/magic/${JWT}`]);
    assert.equal(templates.get(`/auth/magic/${JWT}`)?.template, '/auth/magic/{magicId}');
  });
});

describe('Redactor policy in a built model', () => {
  test('password and token fields stay out of request examples and exports (FB-2)', () => {
    const f = new CaptureFactory('https://django.example');
    f.snapshot(
      '/accounts/signup/',
      'Signup',
      `<form method="post" action="/accounts/signup/"><input type="hidden" name="csrfmiddlewaretoken" value="CSRFMWTOKENVALUE123">
       <input name="username"><input type="password" name="password1"><input type="password" name="password2"><input type="password" name="x"><button>Sign up</button></form>`,
    );
    f.exchange({
      method: 'POST',
      url: '/accounts/signup/',
      resourceType: 'document',
      status: 302,
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: 'csrfmiddlewaretoken=CSRFMWTOKENVALUE123&username=bob&password1=SecretPw1%21&password2=SecretPw1%21&x=XFIELDPW',
    });
    f.exchange({
      method: 'POST',
      url: '/wp-login.php?action=resetpass',
      resourceType: 'document',
      status: 302,
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: 'pass1=WpPassSecret&pass2=WpPassSecret&_wpnonce=WPNONCEVAL99&rp_key=RPKEYSECRET42',
    });
    f.exchange({ method: 'POST', url: '/login', resourceType: 'document', status: 302, requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'acct=bob&pw=HNPWSECRET' });
    const model = build(f);
    assert.deepEqual(leaks(model, ['SecretPw1!', 'CSRFMWTOKENVALUE123', 'WpPassSecret', 'WPNONCEVAL99', 'RPKEYSECRET42', 'HNPWSECRET', 'XFIELDPW']), []);
    const signup = endpoint(model, 'POST', '/accounts/signup/');
    assert.deepEqual(signup.requestBody?.examples[0], { csrfmiddlewaretoken: R, username: 'bob', password1: R, password2: R, x: R });
  });

  test('credential query parameters are redacted in examples and samples (FB-3, FB-7)', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/geo?address=x&key=AIzaSyA-secretKEY2', 200, {});
    const vars = encodeURIComponent(JSON.stringify({ token: 'GETVARTOKEN_111', first: 10 }));
    f.json('GET', `/graphql?operationName=VerifyEmail&query=${encodeURIComponent('query VerifyEmail($token: String!) { verify(token: $token) }')}&variables=${vars}`, 200, {});
    const model = build(f);
    assert.deepEqual(leaks(model, ['AIzaSyA-secretKEY2', 'GETVARTOKEN_111']), []);
    const geo = endpoint(model, 'GET', '/api/geo');
    assert.deepEqual(geo.queryParams.map((param) => [param.name, param.examples]), [['address', ['x']], ['key', [R]]]);
  });

  test('start URL, CSRF source URLs, form pages and socket URLs are redacted (FB-4, FB-5)', () => {
    const f = new CaptureFactory();
    const token = 'tok-0123456789abcdef';
    f.json('GET', '/api/session?api_key=APIKEYSECRET_AAA&access_token=ACCESSTOKEN_BBB', 200, { csrfToken: token });
    f.json('POST', '/api/save', 200, {}, { requestHeaders: { 'x-csrf-token': token } });
    f.snapshot(
      '/dashboard?session_id=SESSIONIDSECRET_CCC#access_token=FRAGTOKEN777&token_type=bearer',
      'Dashboard',
      `<html><head><meta name="csrf-token" content="meta-0123456789"></head><body><form method="post"><input name="q"></form></body></html>`,
    );
    f.json('POST', '/api/orders', 200, {}, { requestHeaders: { 'x-csrf-token': 'meta-0123456789' } });
    f.websocket('wss://shop.example.com/ws?token=WSTOKEN_EEE', [{ direction: 'sent', at: '2026-01-01T00:00:00.000Z', opcode: 'text', data: '40{"token":"SIOAUTHSECRET_1"}' }]);
    const model = build(f, 'https://shop.example.com/?access_token=STARTSECRET_DDD');
    assert.deepEqual(leaks(model, ['APIKEYSECRET_AAA', 'ACCESSTOKEN_BBB', 'SESSIONIDSECRET_CCC', 'STARTSECRET_DDD', 'FRAGTOKEN777', 'WSTOKEN_EEE', 'SIOAUTHSECRET_1']), []);
    assert.equal(model.source.startUrl, `https://shop.example.com/?access_token=${ENC}`);
    const save = endpoint(model, 'POST', '/api/save');
    assert.equal(save.auth.csrf[0]?.sourceUrl, `https://shop.example.com/api/session?api_key=${ENC}&access_token=${ENC}`);
    assert.equal(model.websockets[0]?.examples[0], `40{"token":"${R}"}`);
  });

  test('a JWT in the path never reaches the endpoint key, path or samples (FB-6)', () => {
    const f = new CaptureFactory();
    f.document(`/auth/magic/${JWT}`, CaptureFactory.page('Magic', '<p>ok</p>'));
    f.json('GET', `/api/verify/${JWT}`, 200, {});
    const model = build(f);
    assert.deepEqual(leaks(model, [JWT, JWT.split('.')[1] ?? JWT]), []);
    endpoint(model, 'GET', '/auth/magic/{magicId}');
    endpoint(model, 'GET', '/api/verify/{verifyId}');
  });

  test('text/plain form submissions redact password fields (FB-9)', () => {
    const f = new CaptureFactory();
    f.snapshot('/note', 'Note', '<form method="post" action="/note" enctype="text/plain"><input name="user"><input type="password" name="code"><input type="password" name="password"></form>');
    f.exchange({ method: 'POST', url: '/note', resourceType: 'document', status: 200, requestHeaders: { 'content-type': 'text/plain' }, requestBody: 'user=bob\r\ncode=CODEVALUE_8\r\npassword=PLAINSECRET_9\r\n' });
    const model = build(f);
    assert.deepEqual(leaks(model, ['PLAINSECRET_9', 'CODEVALUE_8']), []);
    assert.equal(endpoint(model, 'POST', '/note').requestBody?.examples[0], `user=bob\r\ncode=${R}\r\npassword=${R}\r\n`);
  });

  test('the X-WP-Nonce header is a CSRF token and its value is not published (FB-13)', () => {
    const f = new CaptureFactory();
    f.json('POST', '/wp-json/wp/v2/posts/1', 200, {}, { requestHeaders: { 'content-type': 'application/json', 'x-wp-nonce': '8f3a1c9e2b' }, requestBody: { json: { title: 'x' } } });
    const model = build(f);
    const post = endpoint(model, 'POST', '/wp-json/wp/v2/posts/{postId}');
    assert.deepEqual(post.auth.csrf, [{ location: 'header', name: 'x-wp-nonce', source: 'unknown' }]);
    assert.deepEqual(leaks(model, ['8f3a1c9e2b']), []);
  });
});
