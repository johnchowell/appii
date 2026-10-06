import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ModelBuilder } from '../src/build/index.js';
import { CaptureSession, HarConverter } from '../src/capture/index.js';
import type { Har } from '../src/capture/index.js';
import { HarExporter } from '../src/export/index.js';
import type { ApiModel, Capture } from '../src/model/index.js';
import { Http, Samples } from '../src/shared/index.js';

const CSRF = 'Zt72kPqm0Lw27RtyQx93';

function page(main: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Quotes</title></head><body><a href="/">Home</a>${main}</body></html>`;
}

class QuotesSite {
  readonly values: string[] = [];
  origin = '';
  #server: Server | undefined;
  readonly #signedIn = new Map<string, boolean>();

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://localhost');
        const session = Http.parseCookieHeader(req.headers.cookie ?? '').find((cookie) => cookie.name === 'session')?.value ?? '';
        const nav = this.#signedIn.get(session) === true ? '<a href="/logout">Logout</a>' : '<a href="/login">Login</a>';
        const send = (status: number, body: string, headers: Record<string, string> = {}): void => {
          res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
          res.end(body);
        };
        if (url.pathname === '/login' && req.method === 'POST') {
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          if (form.get('csrf_token') !== CSRF || !form.get('password')) return send(400, page('<p>bad</p>'));
          return send(302, '', { location: '/', 'set-cookie': this.#fresh(true) });
        }
        if (url.pathname === '/login') {
          return send(200, page(`<form action="/login" method="post"><input type="hidden" name="csrf_token" value="${CSRF}"><input name="username"><input type="password" name="password"><input type="submit" value="Login"></form>`), { 'set-cookie': this.#fresh(false) });
        }
        if (url.pathname === '/logout') return send(302, '', { location: '/', 'set-cookie': this.#fresh(false) });
        if (url.pathname === '/') return send(200, page(`${nav}<div class="quote">A</div>`));
        const numbered = /^\/page\/([0-9]+)\/$/.exec(url.pathname);
        if (numbered) return send(200, page(`${nav}<div class="quote">${numbered[1]}</div>`));
        if (url.pathname === '/search') return send(200, page(`${nav}<form><input name="q"></form>`));
        send(404, page('<p>missing</p>'));
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  #fresh(signedIn: boolean): string {
    const value = randomBytes(12).toString('hex');
    this.values.push(value);
    this.#signedIn.set(value, signedIn);
    return `session=${value}; Path=/; HttpOnly`;
  }
}

function sets(model: ApiModel): Map<string, unknown> {
  return new Map(model.endpoints.map((endpoint) => [`${endpoint.method} ${endpoint.path}`, [endpoint.auth.sets ?? [], endpoint.auth.anonymous === true]]));
}

function sessionSent(har: Har, path: string): string[] {
  return har.log.entries.filter((entry) => new URL(entry.request.url).pathname === path).map((entry) => entry.request.cookies.find((cookie) => cookie.name === 'session')?.value ?? '');
}

function sessionSet(har: Har, method: string, path: string): string[] {
  return har.log.entries
    .filter((entry) => entry.request.method === method && new URL(entry.request.url).pathname === path)
    .flatMap((entry) => entry.response.cookies.filter((cookie) => cookie.name === 'session').map((cookie) => cookie.value));
}

describe('a redacted HAR keeps which cookie value each request carried (QTS-R3)', () => {
  const site = new QuotesSite();
  let capture: Capture;
  let model: ApiModel;
  let har: Har;
  let text = '';

  before(async () => {
    await site.start();
    capture = await CaptureSession.create({
      url: `${site.origin}/login`,
      headless: true,
      idleMs: 300,
      script: async (tab) => {
        await tab.fill('input[name=username]', 'ann');
        await tab.fill('input[name=password]', 'Pw-not-shown-77');
        await Promise.all([tab.waitForURL(`${site.origin}/`), tab.click('input[type=submit]')]);
        for (const path of ['/page/1/', '/page/2/', '/logout', '/search']) await tab.goto(site.origin + path, { waitUntil: 'load' });
      },
    }).run();
    model = ModelBuilder.create({ now: new Date(0) }).build(capture);
    text = HarExporter.create().export(model, { capture }).content;
    har = JSON.parse(text) as Har;
  });

  after(async () => {
    await site.stop();
  });

  test('no cookie value leaves the capture, and each value has its own placeholder in every place', () => {
    assert.ok(site.values.length >= 3, site.values.join(', '));
    for (const value of site.values) assert.ok(!text.includes(value), value);
    const [anonymous] = sessionSet(har, 'GET', '/login');
    const [signedIn] = sessionSet(har, 'POST', '/login');
    const [signedOut] = sessionSet(har, 'GET', '/logout');
    for (const alias of [anonymous, signedIn, signedOut]) assert.ok(alias !== undefined && Samples.isRedacted(alias) && alias !== Samples.REDACTED, String(alias));
    assert.equal(new Set([anonymous, signedIn, signedOut]).size, 3);
    assert.deepEqual(sessionSent(har, '/page/1/'), [signedIn]);
    assert.deepEqual(sessionSent(har, '/page/2/'), [signedIn]);
    assert.deepEqual(sessionSent(har, '/logout'), [signedIn]);
    assert.deepEqual(sessionSent(har, '/search'), [signedOut]);
    const post = har.log.entries.find((entry) => entry.request.method === 'POST');
    assert.equal(Http.getHeader(post?.request.headers ?? [], 'cookie'), `session=${anonymous}`);
    const line = Http.getHeaderAll(post?.response.headers ?? [], 'set-cookie').join('\n');
    assert.equal(line, `session=${signedIn}; Path=/; HttpOnly`);
  });

  test('capture --from-har and build give the same auth model as the capture', () => {
    const rebuilt = ModelBuilder.create({ now: new Date(0) }).build(HarConverter.create().fromHar(text));
    assert.deepEqual(sets(rebuilt), sets(model));
    assert.deepEqual(sets(model).get('GET /page/{page}/'), [[['cookie:session']], false]);
  });

  test('--no-redact keeps the values and an export starts its numbering again', () => {
    const raw = JSON.parse(HarExporter.create().export(model, { capture, redact: false }).content) as Har;
    assert.deepEqual(sessionSent(raw, '/page/1/'), sessionSet(raw, 'POST', '/login'));
    assert.ok(site.values.includes(sessionSent(raw, '/page/1/')[0] ?? ''));
    assert.equal(HarExporter.create().export(model, { capture }).content, text);
  });
});
