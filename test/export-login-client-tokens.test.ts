import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { ApiModel } from '../src/model/index.js';
import { TsClientHarness } from './fixtures/export-ts-harness.js';
import type { Module, SentRequest } from './fixtures/export-ts-harness.js';
import { LoginModels } from './helpers/login-models.js';

const ORIGIN = 'https://quotes.example.test';

class PageTokens {
  static page(withToken: boolean): string {
    const token = withToken ? '<input type="hidden" name="csrf_token" value="page-token-1">' : '';
    return `<!doctype html><html><body><form action="/login" method="post">${token}<input name="username"><input type="password" name="password"></form></body></html>`;
  }

  static handler(withToken: boolean): (request: SentRequest) => Response {
    return (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/login') return new Response(PageTokens.page(withToken), { headers: { 'content-type': 'text/html; charset=utf-8' } });
      if (request.method === 'POST' && path === '/login') {
        const sent = new URLSearchParams(String(request.body)).get('csrf_token');
        return sent === 'page-token-1' ? new Response(null, { status: 302, headers: { location: '/' } }) : new Response('Bad CSRF token', { status: 403 });
      }
      return new Response('<p>Quotes</p>', { headers: { 'content-type': 'text/html' } });
    };
  }

  static line(request: SentRequest): string {
    return `${request.method} ${new URL(request.url).pathname}`;
  }
}

describe('the TypeScript client names a CSRF token that its source page did not hold (LL-10)', () => {
  let harness: TsClientHarness;
  let model: ApiModel;
  let mod: Module;
  let login = '';

  before(async () => {
    harness = await TsClientHarness.open('appii-login-page-token-');
    model = LoginModels.form(ORIGIN);
    login = LoginModels.endpoint(model, 'POST', '/login').name;
    mod = (await harness.load(model, 'page-token-client.ts')).mod;
  });

  after(async () => {
    await harness?.close();
  });

  test('the login page has no csrf_token: the 4xx answer raises MissingTokenError naming the token, the hidden field and the page', async () => {
    const recorder = TsClientHarness.recorder(PageTokens.handler(false));
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    const MissingTokenError = mod.MissingTokenError as new (...args: never[]) => Error;
    await assert.rejects(TsClientHarness.call(client, login, { body: { username: 'reader', password: 'pw' } }), (err: unknown) => {
      assert.ok(err instanceof MissingTokenError, String(err));
      assert.equal(
        err.message,
        `The server rejected the request with status 403. The client did not send the token csrf_token. It loaded ${ORIGIN}/login and found no hidden field csrf_token. Give csrf_token in the request to send it.`,
      );
      const missing = (err as Error & { missing: unknown[] }).missing;
      assert.deepEqual(missing, [{ token: 'csrf_token', source: `${ORIGIN}/login`, expected: 'hidden field csrf_token' }]);
      return true;
    });
    assert.deepEqual(recorder.sent.map(PageTokens.line), ['GET /login', 'POST /login']);
    assert.ok(!new URLSearchParams(String(recorder.sent[1]?.body)).get('csrf_token'), 'the login went without a token value');
  });

  test('the login page holds the token: the login is sent with it and no error is raised', async () => {
    const recorder = TsClientHarness.recorder(PageTokens.handler(true));
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    const response = await TsClientHarness.call(client, login, { body: { username: 'reader', password: 'pw' } });
    assert.notEqual(response.status, 403);
    assert.equal(new URLSearchParams(String(recorder.sent[1]?.body)).get('csrf_token'), 'page-token-1');
  });

  test('a success answer does not raise even when the page had no token', async () => {
    const recorder = TsClientHarness.recorder((request) => (request.method === 'GET' ? PageTokens.handler(false)(request) : new Response(null, { status: 302, headers: { location: '/' } })));
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    const response = await TsClientHarness.call(client, login, { body: { username: 'reader', password: 'pw' } });
    assert.ok(response.status < 400, String(response.status));
  });

  test('a token read from a JSON response that does not hold it is named with that response', async () => {
    const own = LoginModels.form(ORIGIN);
    const posted = LoginModels.endpoint(own, 'POST', '/login');
    posted.auth.csrf = [{ location: 'header', name: 'X-CSRF-Token', source: 'response', sourceName: 'csrfToken', sourceUrl: `${ORIGIN}/api/csrf` }];
    const loaded = (await harness.load(own, 'response-token-client.ts')).mod;
    const recorder = TsClientHarness.recorder((request) => {
      if (request.method === 'GET') return new Response(JSON.stringify({ other: 'x' }), { headers: { 'content-type': 'application/json' } });
      return new Response('Bad CSRF token', { status: 403 });
    });
    const client = TsClientHarness.client(loaded, own, { fetch: recorder.fetch });
    await assert.rejects(TsClientHarness.call(client, posted.name, { body: { username: 'reader', password: 'pw' } }), (err: Error & { missing?: unknown[] }) => {
      assert.equal(err.name, 'MissingTokenError');
      assert.match(err.message, new RegExp(`The client did not send the token X-CSRF-Token\\. It loaded ${ORIGIN.replace(/[.]/g, '\\.')}/api/csrf and found no csrfToken in the response\\.`));
      assert.deepEqual(err.missing, [{ token: 'X-CSRF-Token', source: `${ORIGIN}/api/csrf`, expected: 'csrfToken in the response' }]);
      return true;
    });
    assert.deepEqual(recorder.sent.map(PageTokens.line), ['GET /api/csrf', 'POST /login']);
  });
});

