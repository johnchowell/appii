import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { CredentialAnalyzer, ModelBuilder } from '../src/build/index.js';
import { CaptureSession, HarConverter } from '../src/capture/index.js';
import { HarExporter } from '../src/export/index.js';
import type { ApiModel, Capture, Header } from '../src/model/index.js';
import { Http, Json, Samples } from '../src/shared/index.js';

const CSRF = 'Wq81mPxk0Lw27RtyZq81';

function layout(main: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Quotes</title></head><body><div class="container"><a href="/">Home</a>${main}</div></body></html>`;
}

function startQuotes(): Promise<{ server: Server; origin: string; sessions: Map<string, boolean> }> {
  const sessions = new Map<string, boolean>();
  const fresh = (signedIn: boolean): string => {
    const id = randomBytes(12).toString('hex');
    sessions.set(id, signedIn);
    return `session=${id}; Path=/; HttpOnly`;
  };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const session = Http.parseCookieHeader(req.headers.cookie ?? '').find((cookie) => cookie.name === 'session')?.value ?? '';
      const signedIn = sessions.get(session) === true;
      const send = (status: number, body: string, headers: Record<string, string | string[]> = {}): void => {
        res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
        res.end(body);
      };
      if (url.pathname === '/login' && req.method === 'POST') {
        const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
        if (form.get('csrf_token') !== CSRF || form.get('password') === '') return send(400, layout('<p>bad</p>'));
        return send(302, '', { location: '/', 'set-cookie': fresh(true) });
      }
      if (url.pathname === '/login') {
        return send(200, layout(`<form action="/login" method="post"><input type="hidden" name="csrf_token" value="${CSRF}"><input name="username"><input type="password" name="password"><input type="submit" value="Login"></form>`), { 'set-cookie': fresh(false) });
      }
      if (url.pathname === '/logout') return send(302, '', { location: '/', 'set-cookie': fresh(false) });
      const nav = signedIn ? '<a href="/logout">Logout</a>' : '<a href="/login">Login</a>';
      if (url.pathname === '/') return send(200, layout(`${nav}<div class="quote">A</div>`), session === '' ? { 'set-cookie': fresh(false) } : {});
      const numbered = /^\/page\/([0-9]+)\/$/.exec(url.pathname);
      if (numbered) return send(200, layout(`${nav}<div class="quote">${numbered[1]}</div>`));
      if (url.pathname === '/search') return send(200, layout(`${nav}<form><input name="q"></form>`));
      send(404, layout('<p>missing</p>'));
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sessions })));
}

type AuthRow = [string, string[][] | undefined, boolean];

function auth(model: ApiModel): Map<string, AuthRow> {
  return new Map(model.endpoints.map((endpoint) => [`${endpoint.method} ${endpoint.path}`, [endpoint.auth.cookies.join(','), endpoint.auth.sets, endpoint.auth.anonymous === true]]));
}

function collapse(capture: Capture): Capture {
  const copy = Json.clone(capture);
  const hide = (headers: Header[]): void => {
    for (const header of headers) {
      const lower = header.name.toLowerCase();
      if (lower === 'cookie') header.value = Http.parseCookieHeader(header.value).map((cookie) => `${cookie.name}=${Samples.REDACTED}`).join('; ');
      if (lower === 'set-cookie') header.value = header.value.split('\n').map((line) => line.replace(/^([^=;]+)=[^;]*/, `$1=${Samples.REDACTED}`)).join('\n');
    }
  };
  for (const exchange of copy.exchanges) {
    hide(exchange.request.headers);
    if (exchange.response) hide(exchange.response.headers);
  }
  for (const cookie of copy.cookies) cookie.value = Samples.REDACTED;
  return copy;
}

describe('the evidence-based auth model survives a redacted HAR round trip (QTS-R3)', () => {
  let server: Server;
  let capture: Capture;
  let model: ApiModel;

  before(async () => {
    const started = await startQuotes();
    server = started.server;
    try {
      capture = await CaptureSession.create({
        url: `${started.origin}/login`,
        headless: true,
        idleMs: 300,
        script: async (page) => {
          await page.fill('input[name=username]', 'ann');
          await page.fill('input[name=password]', 'Pw-not-shown-77');
          await Promise.all([page.waitForURL(`${started.origin}/`), page.click('input[type=submit]')]);
          for (const path of ['/page/1/', '/page/2/', '/logout', '/search']) await page.goto(started.origin + path, { waitUntil: 'load' });
        },
      }).run();
      model = ModelBuilder.create({ now: new Date(0) }).build(capture);
    } catch (err) {
      server.close();
      throw err;
    }
  });

  after(() => {
    server.closeAllConnections();
    server.close();
  });

  test('the original model has the signed-in pages behind the session cookie, so the round trip checks something', () => {
    const rows = auth(model);
    assert.deepEqual(rows.get('GET /page/{page}/')?.[1], [['cookie:session']]);
    assert.deepEqual(rows.get('GET /logout')?.[1], [['cookie:session']]);
    assert.equal(rows.get('GET /search')?.[2], true);
  });

  test('a capture whose cookie values all became one placeholder keeps every credential set', () => {
    assert.deepEqual(auth(ModelBuilder.create({ now: new Date(0) }).build(collapse(capture))), auth(model));
  });

  test('appii exports a redacted HAR that builds the same auth model and holds no cookie value', () => {
    const har = HarExporter.create().export(model, { capture }).content;
    for (const cookie of capture.cookies) assert.ok(!har.includes(cookie.value), cookie.name);
    const imported = HarConverter.create().fromHar(har);
    assert.deepEqual(auth(ModelBuilder.create({ now: new Date(0) }).build(imported)), auth(model));
  });

  test('a cookie value counts in the generation that was current when the request was sent', () => {
    const collapsed = collapse(capture);
    const evidence = CredentialAnalyzer.create().analyze(collapsed);
    const sent = collapsed.exchanges.map((exchange) => [new URL(exchange.request.url).pathname, evidence.isCredential('session', Samples.REDACTED, exchange)]);
    assert.deepEqual(
      sent.filter(([path]) => path !== '/favicon.ico'),
      [
        ['/login', false],
        ['/login', false],
        ['/', true],
        ['/page/1/', true],
        ['/page/2/', true],
        ['/logout', true],
        ['/', false],
        ['/search', false],
      ],
    );
  });
});
