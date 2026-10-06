import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder, ModelValidator, Redactor, SecretCollector, SecretValues } from '../src/build/index.js';
import type { ApiModel, Capture } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const ORIGIN = 'https://tasks.example.test';
const EMAIL = 'appii-test@example.com';
const LOCAL = 'appii-test';
const ANON = 'anon5c1d2e3f4a5b6c7d8e9f0a1';
const AUTH = 'auth8e7d6c5b4a3f2e1d0c9b8a7';
const LOGIN = CaptureFactory.page('Sign in', '<form method="post" action="/session"><input type="email" name="email" autocomplete="email"><input type="password" name="pass" autocomplete="current-password"><button>Sign in</button></form>');

function capture(options: { echo: boolean; email?: string }): Capture {
  const email = options.email ?? EMAIL;
  const local = email.slice(0, email.indexOf('@'));
  const f = new CaptureFactory(ORIGIN);
  f.document('/login', LOGIN, { responseHeaders: { 'set-cookie': `sid=${ANON}; Path=/; HttpOnly` } });
  f.snapshot('/login', 'Sign in', LOGIN);
  f.json('GET', '/api/tags', 200, { tags: [`${local}-notes`, 'garden', local] }, { requestHeaders: { cookie: `sid=${ANON}` } });
  f.exchange({
    method: 'POST',
    url: '/session',
    resourceType: 'document',
    pageUrl: `${ORIGIN}/login`,
    requestHeaders: { cookie: `sid=${ANON}`, 'content-type': 'application/x-www-form-urlencoded' },
    requestBody: `email=${encodeURIComponent(email)}&pass=Sesame-2026`,
    status: 303,
    responseHeaders: { location: '/dashboard', 'set-cookie': `sid=${AUTH}; Path=/; HttpOnly` },
  });
  f.json('GET', '/api/me', 200, options.echo ? { email, name: local, greeting: `Hello ${local}` } : { email, plan: 'free' }, { requestHeaders: { cookie: `sid=${AUTH}` } });
  f.json('GET', '/api/projects', 200, [{ id: 7, name: `${local}-board` }], { requestHeaders: { cookie: `sid=${AUTH}` } });
  return f.capture({ startUrl: `${ORIGIN}/login` });
}

function build(value: Capture, redact = true): ApiModel {
  const model = ModelBuilder.create({ now: new Date(0), redact }).build(value);
  assert.deepEqual(new ModelValidator().validate(model), []);
  return model;
}

function example(model: ApiModel, path: string): unknown {
  return model.endpoints.find((endpoint) => endpoint.path === path)?.responses[0]?.body?.examples[0];
}

describe('account data derived from an e-mail login identifier (LL-9)', () => {
  test('the local part that the logged-in API returns as a whole value is personal data; the e-mail address is too', () => {
    const model = build(capture({ echo: true }));
    assert.deepEqual(example(model, '/api/me'), { email: '<redacted>', name: '<redacted>', greeting: `Hello ${LOCAL}` });
    assert.ok(!JSON.stringify(model).includes(EMAIL));
  });

  test('only whole values are scrubbed: words that merely contain the local part stay, so nothing else is over-scrubbed', () => {
    const model = build(capture({ echo: true }));
    assert.deepEqual(example(model, '/api/tags'), { tags: [`${LOCAL}-notes`, 'garden', '<redacted>'] });
    assert.deepEqual(example(model, '/api/projects'), [{ id: 7, name: `${LOCAL}-board` }]);
  });

  test('without evidence that the logged-in site returns it, the local part is left alone', () => {
    const model = build(capture({ echo: false }));
    assert.deepEqual(example(model, '/api/tags'), { tags: [`${LOCAL}-notes`, 'garden', LOCAL] });
    assert.deepEqual(example(model, '/api/me'), { email: '<redacted>', plan: 'free' });
  });

  test('a local part shorter than three characters is not derived; --no-redact keeps every value', () => {
    assert.equal(SecretCollector.localPart('ab@example.com'), undefined);
    assert.equal(SecretCollector.localPart('abc@example.com'), 'abc');
    assert.equal(SecretCollector.localPart('not-an-email'), undefined);
    const short = build(capture({ echo: true, email: 'ab@example.com' }));
    assert.deepEqual((example(short, '/api/me') as Record<string, unknown>).name, 'ab');
    const raw = build(capture({ echo: true }), false);
    assert.deepEqual((example(raw, '/api/me') as Record<string, unknown>).name, LOCAL);
  });

  test('whole-value matching covers a JSON string in raw text and an HTML text node, not a substring', () => {
    const values = new SecretValues([], new Map(), [LOCAL]);
    assert.equal(values.scrub(LOCAL), '<redacted>');
    assert.equal(values.scrub(`{"name":"${LOCAL}","slug":"${LOCAL}-1"}`), `{"name":"<redacted>","slug":"${LOCAL}-1"}`);
    assert.equal(values.scrub(`<span class="user"> ${LOCAL} </span><p>Hello ${LOCAL}</p>`), '<span class="user"> <redacted> </span><p>Hello appii-test</p>');
    assert.equal(values.scrub(`/u/${LOCAL}-tester`), `/u/${LOCAL}-tester`);
    assert.equal(values.has(LOCAL), true);
    assert.equal(values.contains(`"${LOCAL}"`), true);
    assert.equal(values.contains(`${LOCAL}s`), false);
    assert.equal(values.label(`"${LOCAL}"`), 'secret');
    const redactor = Redactor.create();
    redactor.useValues(values);
    assert.equal(redactor.url(`${ORIGIN}/u/${LOCAL}?q=${LOCAL}&n=${LOCAL}-tester`), `${ORIGIN}/u/%3Credacted%3E?q=%3Credacted%3E&n=${LOCAL}-tester`);
    assert.equal(redactor.url(`${ORIGIN}/u/${LOCAL}-notes`), `${ORIGIN}/u/${LOCAL}-notes`);
  });
});
