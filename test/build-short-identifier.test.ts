import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { ModelBuilder, ModelValidator, SecretValues } from '../src/build/index.js';
import { CaptureSession } from '../src/capture/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import type { ApiModel, Capture } from '../src/model/index.js';

const USER = 'nora';
const PASSWORD = 'Notes-Pass-2026';
const NOTE = { id: 1, title: 'Ask nora about the garden plan', body: 'Shared with nora and the team' };

const LOGIN_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Notes</title></head><body><h1>Notes</h1><p id="msg"></p>
<form id="login-form"><input name="username" autocomplete="username" required><input type="password" name="password" autocomplete="current-password" required><button type="submit">Log in</button></form>
<script>
document.getElementById('login-form').addEventListener('submit', function (e) {
  e.preventDefault();
  var f = e.target;
  fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: f.username.value, password: f.password.value }) })
    .then(function (r) { if (r.ok) location.href = '/notes'; else document.getElementById('msg').textContent = 'wrong'; });
});
</script></body></html>`;

const NOTES_PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Notes</title></head><body><h1 id="title">Notes</h1><p>Owner: <span id="owner"></span></p><ul id="list"></ul>
<script>
fetch('/api/notes').then(function (r) { return r.status === 401 ? null : r.json(); }).then(function (d) {
  if (!d) { location.href = '/login'; return; }
  document.getElementById('owner').textContent = d.owner;
  document.getElementById('list').innerHTML = d.notes.map(function (n) { return '<li>' + n.title + '</li>'; }).join('');
});
</script></body></html>`;

interface Site {
  server: Server;
  origin: string;
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const pair of (req.headers.cookie ?? '').split(/; */)) {
    const eq = pair.indexOf('=');
    if (eq > 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1);
  }
  return undefined;
}

function startNotes(): Promise<Site> {
  const tokens = new Set<string>();
  const send = (res: ServerResponse, status: number, type: string, body: string, headers: Record<string, string> = {}): void => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => send(res, status, 'application/json', JSON.stringify(value), headers);
  const handle = (req: IncomingMessage, res: ServerResponse, url: URL, body: string): void => {
    const p = url.pathname;
    const token = readCookie(req, 'token');
    const user = token !== undefined && tokens.has(token) ? USER : undefined;
    if (req.method === 'GET' && p === '/login') return send(res, 200, 'text/html; charset=utf-8', LOGIN_PAGE);
    if (req.method === 'GET' && p === '/notes') return send(res, 200, 'text/html; charset=utf-8', NOTES_PAGE);
    if (req.method === 'POST' && p === '/api/auth/login') {
      const sent = JSON.parse(body) as { username?: string; password?: string };
      if (sent.username !== USER || sent.password !== PASSWORD) return json(res, 401, { error: 'wrong user name or password' });
      const fresh = randomBytes(24).toString('hex');
      tokens.add(fresh);
      return json(res, 200, { user: { name: USER } }, { 'set-cookie': `token=${fresh}; Path=/; HttpOnly; SameSite=Strict` });
    }
    if (p.startsWith('/api/') && user === undefined) return json(res, 401, { error: 'login required' });
    if (req.method === 'GET' && p === '/api/notes') return json(res, 200, { owner: user, notes: [NOTE] });
    if (req.method === 'GET' && p === '/api/notes/1') return json(res, 200, { owner: user, ...NOTE });
    return json(res, 404, { error: 'not found' });
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handle(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'), Buffer.concat(chunks).toString('utf8')));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

function build(capture: Capture, redact = true): ApiModel {
  const model = ModelBuilder.create({ now: new Date(0), redact }).build(capture);
  assert.deepEqual(new ModelValidator().validate(model), []);
  return model;
}

function wholeEchoes(text: string): string[] {
  return text.match(new RegExp(`"${USER}"|>\\s*${USER}\\s*<|\\\\"${USER}\\\\"`, 'g')) ?? [];
}

describe('a login identifier shorter than six characters that the logged-in site echoes (LV3-2)', () => {
  let site: Site | undefined;
  let capture: Capture | undefined;

  before(async () => {
    site = await startNotes();
    capture = await CaptureSession.create({
      url: `${site.origin}/login`,
      visits: [`${site.origin}/notes`, `${site.origin}/api/notes/1`],
      login: [
        { name: 'username', value: USER },
        { name: 'password', value: PASSWORD },
      ],
      headless: true,
      idleMs: 400,
      recorder: { readTimeoutMs: 5000 },
    }).run();
  });

  after(() => {
    site?.server.closeAllConnections();
    site?.server.close();
  });

  test('the capture holds the echoes, so the build has something to scrub', () => {
    assert.ok(wholeEchoes(JSON.stringify(capture)).length >= 3, 'login response, notes list and the note echo the user name');
  });

  test('api.json and every export replace the whole value, and the word inside longer text stays', () => {
    const model = build(capture!);
    const text = JSON.stringify(model);
    assert.deepEqual(wholeEchoes(text), []);
    assert.ok(text.includes(NOTE.title), 'a note title that only contains the name is not over-scrubbed');
    assert.ok(text.includes(NOTE.body));
    const registry = ExporterRegistry.default();
    for (const format of ['openapi', 'openapi-yaml', 'postman', 'html', 'markdown', 'typescript', 'curl']) {
      const content = registry.export(model, format).content;
      assert.deepEqual(wholeEchoes(content), [], format);
    }
    const har = registry.export(model, 'har', { capture: capture! }).content;
    assert.deepEqual(wholeEchoes(har), [], 'har');
    assert.ok(har.includes(NOTE.title), 'har keeps the longer text');
  });

  test('--no-redact keeps the observed value', () => {
    const model = build(capture!, false);
    assert.ok(wholeEchoes(JSON.stringify(model)).length > 0);
  });
});

describe('whole values without any substring secret are still scrubbed from examples (LV3-2)', () => {
  test('scrubDeep uses the whole values even when no longer secret was collected', () => {
    const values = new SecretValues([], new Map(), [USER]);
    assert.deepEqual(values.scrubDeep({ owner: USER, title: NOTE.title }), { owner: '<redacted>', title: NOTE.title });
  });
});
