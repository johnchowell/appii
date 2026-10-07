import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder, ModelValidator } from '../src/build/index.js';
import type { ApiModel, CsrfToken } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const TOKEN = 'Qm9hcmQtVG9rZW4tMDEyMzQ1Njc4OWFi';

function build(f: CaptureFactory): ApiModel {
  const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
  assert.deepEqual(new ModelValidator().validate(model), []);
  return model;
}

function token(model: ApiModel, method: string, path: string): CsrfToken | undefined {
  return model.endpoints.find((endpoint) => endpoint.method === method && endpoint.path === path)?.auth.csrf.find((each) => each.name === 'csrf');
}

function post(f: CaptureFactory, cookie: string): void {
  f.json('POST', '/api/notes', 201, { id: 1 }, { requestHeaders: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, requestBody: `csrf=${TOKEN}&title=Plan` });
}

describe('a CSRF token is bound to the cookies of the session it came from, whatever their names (LV3-4)', () => {
  test('cookies that the JSON source response set are bound; tracking and preference cookies are not', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/csrf', 200, { csrfToken: TOKEN }, { responseHeaders: { 'set-cookie': ['brd=Zx81-board-0001; Path=/; HttpOnly', 'theme=dark; Path=/', '_ga=GA1.1.123456789.1700000000; Path=/'] } });
    post(f, 'brd=Zx81-board-0001; theme=dark; _ga=GA1.1.123456789.1700000000');
    const found = token(build(f), 'POST', '/api/notes');
    assert.equal(found?.source, 'response');
    assert.deepEqual(found?.sessionCookies, ['brd']);
  });

  test('a cookie that the source request carried and the server kept is bound when the same value comes with the token', () => {
    const f = new CaptureFactory();
    f.document('/', CaptureFactory.page('Board', '<h1>Board</h1>'), { responseHeaders: { 'set-cookie': 'brd=Zx81-board-0001; Path=/; HttpOnly' } });
    f.json('GET', '/api/csrf', 200, { csrfToken: TOKEN }, { requestHeaders: { cookie: 'brd=Zx81-board-0001; theme=dark' } });
    post(f, 'brd=Zx81-board-0001; theme=dark');
    assert.deepEqual(token(build(f), 'POST', '/api/notes')?.sessionCookies, ['brd']);
  });

  test('a cookie whose value changed between the token source and its use is not bound', () => {
    const f = new CaptureFactory();
    f.json('GET', '/api/csrf', 200, { csrfToken: TOKEN }, { requestHeaders: { cookie: 'lb=node-1' }, responseHeaders: { 'set-cookie': 'brd=Zx81-board-0001; Path=/; HttpOnly' } });
    f.json('GET', '/api/ping', 200, { ok: true }, { requestHeaders: { cookie: 'brd=Zx81-board-0001; lb=node-1' }, responseHeaders: { 'set-cookie': 'lb=node-3; Path=/' } });
    post(f, 'brd=Zx81-board-0001; lb=node-3');
    assert.deepEqual(token(build(f), 'POST', '/api/notes')?.sessionCookies, ['brd']);
  });
});
