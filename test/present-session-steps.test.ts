import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import type { ApiModel, Capture, Endpoint } from '../src/model/index.js';
import { EndpointDetailPresenter } from '../src/present/index.js';
import { Ansi } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const ORIGIN = 'https://quotes.example';
const ANON = 'anon.7e6d5c4b3a291807f6e5d4c3b2a19080';
const CSRF = 'Mn42Bv53Cx64Za75Lk86Jh97Gf08Ds19';
const API_CSRF = 'Rt5Yu6Io7Pa8Sd9Fg0Hj1Kl2Zx3Cv4Bn';

function loginPage(): string {
  return CaptureFactory.page('Login', `<form action="/login" method="post"><input type="hidden" name="csrf_token" value="${CSRF}"><input type="text" name="username"><input type="password" name="password"><input type="submit" value="Login"></form>`);
}

function capture(): Capture {
  const f = new CaptureFactory(ORIGIN);
  f.document('/', CaptureFactory.page('Quotes', '<a href="/login">Login</a>'));
  f.document('/login', loginPage(), { responseHeaders: { 'set-cookie': `session=${ANON}; HttpOnly; Path=/` } });
  f.snapshot('/login', 'Login', loginPage());
  f.json('GET', '/api/token', 200, { csrfToken: API_CSRF }, { requestHeaders: { cookie: `session=${ANON}` } });
  f.json('POST', '/api/notes', 201, { id: 1 }, { requestHeaders: { cookie: `session=${ANON}`, 'content-type': 'application/json', 'x-csrf-token': API_CSRF }, requestBody: { json: { text: 'hi' } } });
  f.cookie('session', ANON, { httpOnly: true, sameSite: null });
  return f.capture();
}

function model(): ApiModel {
  return ModelBuilder.create({ now: new Date(0) }).build(capture());
}

function endpoint(value: ApiModel, method: string, path: string): Endpoint {
  const found = value.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path}`);
  return found;
}

function show(value: ApiModel, ref: string, width = 120): string[] {
  return Ansi.strip(new EndpointDetailPresenter({ width, file: 'api.json' }).render({ model: value, ref })).split('\n');
}

function section(lines: readonly string[], title: string): string[] {
  const start = lines.indexOf(title);
  if (start < 0) return [];
  const end = lines.findIndex((line, i) => i > start + 1 && /^-+$/.test(lines[i + 1] ?? '') && line !== '');
  return lines.slice(start, end < 0 ? undefined : end);
}

function cells(line: string): string[] {
  return line.split('|').slice(1, -1).map((cell) => cell.trim());
}

describe('list --show explains how to get a session-bound CSRF token and how to log in with curl (P3)', () => {
  test('the CSRF table shows the cookie each token is bound to', () => {
    const value = model();
    const login = endpoint(value, 'POST', '/login');
    const auth = section(show(value, login.id), 'Auth');
    const rows = auth.filter((line) => line.startsWith('|')).map(cells);
    assert.deepEqual(rows[0], ['LOCATION', 'NAME', 'SOURCE', 'SOURCE NAME', 'SOURCE URL', 'BOUND TO']);
    assert.deepEqual(rows[1], ['body', 'csrf_token', 'hidden-field', 'csrf_token', `${ORIGIN}/login`, 'cookie session']);
  });

  test('a login whose token comes from a page points to the curl export, which fetches the token and keeps the cookie jar', () => {
    const value = model();
    const login = endpoint(value, 'POST', '/login');
    const steps = section(show(value, login.id), 'Session steps');
    const text = steps.join(' ').replace(/\s+/g, ' ');
    assert.match(text, new RegExp(`The token csrf_token changes with the session: request GET ${ORIGIN}/login, read the hidden field csrf_token, and send it with the cookie session from the same session\\.`));
    assert.match(text, /The example above leaves these steps to you; the curl export does them with a cookie jar:/);
    assert.ok(steps.includes('  appii export api.json --format curl -o endpoints.sh'), steps.join('\n'));
    assert.ok(steps.includes('  bash endpoints.sh postLogin username=VALUE password=VALUE'), steps.join('\n'));
    assert.match(text, /keeps the cookies the login sets in its jar/);
    assert.ok(!text.includes(CSRF) && !text.includes(ANON));
  });

  test('a CSRF token read from a JSON response names that request and field; it is not a login, so no credentials are asked for', () => {
    const value = model();
    const notes = endpoint(value, 'POST', '/api/notes');
    assert.deepEqual(notes.auth.csrf.map((token) => [token.source, token.sourceName, token.sourceMethod]), [['response', 'csrfToken', 'GET']]);
    const steps = section(show(value, notes.id), 'Session steps');
    const text = steps.join(' ').replace(/\s+/g, ' ');
    assert.match(text, new RegExp(`The token x-csrf-token changes with the session: request GET ${ORIGIN}/api/token, read csrfToken from its response, and send it with the cookie session from the same session\\.`));
    assert.ok(steps.includes(`  bash endpoints.sh ${notes.name}`), steps.join('\n'));
    assert.doesNotMatch(text, /login sets/);
  });

  test('an endpoint without a fetched token and without the login role has no session steps', () => {
    const value = model();
    assert.deepEqual(section(show(value, endpoint(value, 'GET', '/').id), 'Session steps'), []);
    assert.deepEqual(section(show(value, endpoint(value, 'GET', '/api/token').id), 'Session steps'), []);
  });

  test('the curl function named in the steps is the one the curl export writes, also for a reserved shell name', () => {
    const value = model();
    const notes = endpoint(value, 'POST', '/api/notes');
    notes.name = 'list';
    const steps = section(show(value, notes.id), 'Session steps');
    assert.ok(steps.includes('  bash endpoints.sh listEndpoint'), steps.join('\n'));
    assert.ok(!steps.includes('  bash endpoints.sh list'), steps.join('\n'));
  });

  test('the steps fit narrow terminals', () => {
    const value = model();
    for (const line of show(value, endpoint(value, 'POST', '/login').id, 60)) assert.ok(line.length <= 60, line);
  });
});
