import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelBuilder } from '../src/build/index.js';
import { CurlExporter, PostmanExporter } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { TsClientHarness } from './fixtures/export-ts-harness.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const NAME = '_spa_session';
const SHELL = CaptureFactory.page('Tasks', '<div id="app">Loading...</div><script src="/app.js"></script>');
const FORM = (token: string): string =>
  CaptureFactory.page(
    'Tasks',
    `<div id="app"><h1>Sign in</h1><form method="post" action="/session"><input type="hidden" name="_csrf" value="${token}"><input type="email" name="email" autocomplete="email"><input type="password" name="pass" autocomplete="current-password"><button type="submit">Sign in</button></form></div>`,
  );

interface Session {
  csrf: string;
  user?: string;
}

class SpaSite {
  readonly sessions = new Map<string, Session>();
  readonly requests: string[] = [];
  origin = '';
  #server: Server | undefined;

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => this.#handle(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  #handle(req: IncomingMessage, res: ServerResponse, body: string): void {
    const url = new URL(req.url ?? '/', this.origin);
    this.requests.push(`${req.method} ${url.pathname}`);
    const id = /(?:^|;\s*)_spa_session=([^;]+)/.exec(req.headers.cookie ?? '')?.[1];
    const session = id === undefined ? undefined : this.sessions.get(id);
    const open = (user?: string): string => {
      const fresh = randomBytes(12).toString('hex');
      this.sessions.set(fresh, user === undefined ? { csrf: randomBytes(16).toString('hex') } : { csrf: randomBytes(16).toString('hex'), user });
      return fresh;
    };
    if (req.method === 'GET' && (url.pathname === '/login' || url.pathname === '/dashboard')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(SHELL);
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/csrf') {
      const current = session ? id! : open();
      res.writeHead(200, { 'content-type': 'application/json', ...(session ? {} : { 'set-cookie': `${NAME}=${current}; Path=/; HttpOnly` }) });
      res.end(JSON.stringify({ csrfToken: this.sessions.get(current)!.csrf }));
      return;
    }
    if (req.method === 'POST' && url.pathname === '/session') {
      const form = new URLSearchParams(body);
      if (!session || form.get('_csrf') !== session.csrf) {
        res.writeHead(403, { 'content-type': 'text/html' });
        res.end('<h1>Invalid CSRF token</h1>');
        return;
      }
      this.sessions.delete(id!);
      res.writeHead(303, { location: '/dashboard', 'set-cookie': `${NAME}=${open(form.get('email') ?? '')}; Path=/; HttpOnly` });
      res.end();
      return;
    }
    if (req.method === 'GET' && url.pathname === '/api/me') {
      res.writeHead(session?.user === undefined ? 401 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(session?.user === undefined ? { error: 'unauthorized' } : { email: session.user }));
      return;
    }
    res.writeHead(404);
    res.end();
  }
}

function capture(origin: string, loggedIn: boolean): ApiModel {
  const token = 'Zq7Kp2Lm9Xw4Rt6Yb1Nc8Vd3Ee5Ff6Gg';
  const anon = 'a1b2c3d4e5f6a7b8c9d0e1f2';
  const auth = 'f2e1d0c9b8a7f6e5d4c3b2a1';
  const f = new CaptureFactory(origin);
  f.document('/login', SHELL);
  f.json('GET', '/api/csrf', 200, { csrfToken: token }, { pageUrl: `${origin}/login`, responseHeaders: { 'set-cookie': `${NAME}=${anon}; Path=/; HttpOnly` } });
  f.json('GET', '/api/me', 401, { error: 'unauthorized' }, { pageUrl: `${origin}/login`, requestHeaders: { cookie: `${NAME}=${anon}` } });
  f.snapshot('/login', 'Tasks', FORM(token));
  if (loggedIn) {
    f.exchange({
      method: 'POST',
      url: '/session',
      resourceType: 'document',
      pageUrl: `${origin}/login`,
      requestHeaders: { cookie: `${NAME}=${anon}`, 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: `_csrf=${token}&email=ann%40example.test&pass=Sesame-2026`,
      status: 303,
      responseHeaders: { location: '/dashboard', 'set-cookie': `${NAME}=${auth}; Path=/; HttpOnly` },
    });
    f.document('/dashboard', SHELL, { requestHeaders: { cookie: `${NAME}=${auth}` } });
    f.json('GET', '/api/me', 200, { email: 'ann@example.test' }, { pageUrl: `${origin}/dashboard`, requestHeaders: { cookie: `${NAME}=${auth}` } });
  }
  return ModelBuilder.create({ now: new Date(0) }).build(f.capture({ startUrl: `${origin}/login` }));
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path}`);
  return found;
}

function bash(args: string[], cwd: string, env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile('bash', args, { cwd, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C', ...env }, timeout: 30_000, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}

describe('a login form rendered by a script with a CSRF token from a JSON response: the exports log in (LL-3)', () => {
  const site = new SpaSite();
  let dir = '';
  let harness: TsClientHarness;

  before(async () => {
    await site.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-csrf-login-'));
    harness = await TsClientHarness.open('appii-csrf-login-ts-');
  });

  after(async () => {
    await site.stop();
    await rm(dir, { recursive: true, force: true });
    await harness?.close();
  });

  for (const loggedIn of [false, true]) {
    const label = loggedIn ? 'the updated model' : 'the anonymous model';

    test(`${label}: the token source is GET /api/csrf csrfToken`, () => {
      const model = capture(site.origin, loggedIn);
      assert.deepEqual(endpoint(model, 'POST', '/session').auth.csrf, [
        { location: 'body', name: '_csrf', source: 'response', sourceName: 'csrfToken', sourceUrl: `${site.origin}/api/csrf`, sourceMethod: 'GET', sessionCookies: [NAME] },
      ]);
    });

    test(`${label}: the curl script logs in and the next function is logged in`, async () => {
      const model = capture(site.origin, loggedIn);
      const file = join(dir, `endpoints-${loggedIn}.sh`);
      await writeFile(file, new CurlExporter().export(model).content);
      const jar = join(dir, `jar-${loggedIn}.txt`);
      site.requests.length = 0;
      const login = await bash([file, 'postSession', 'email=curl@example.test', 'pass=pw', '-o', '/dev/null', '-w', '%{http_code}'], dir, { APPII_COOKIE_JAR: jar });
      assert.equal(login.code, 0, login.stderr);
      assert.equal(login.stdout.trim(), '303', login.stderr);
      assert.deepEqual(site.requests.slice(0, 2), ['GET /api/csrf', 'POST /session']);
      const me = await bash([file, endpoint(model, 'GET', '/api/me').name], dir, { APPII_COOKIE_JAR: jar });
      assert.equal(me.code, 0, me.stderr);
      assert.match(me.stdout, /curl@example\.test/);
    });

    test(`${label}: the TypeScript client logs in and the next call is logged in`, async () => {
      const model = capture(site.origin, loggedIn);
      const { mod } = await harness.load(model, `client-${loggedIn}.ts`);
      const client = TsClientHarness.client(mod, model);
      site.requests.length = 0;
      const login = await TsClientHarness.call(client, endpoint(model, 'POST', '/session').name, { body: { email: 'ts@example.test', pass: 'pw' } });
      assert.ok(login.status < 400, String(login.status));
      assert.deepEqual(site.requests.slice(0, 2), ['GET /api/csrf', 'POST /session']);
      const me = await TsClientHarness.call(client, endpoint(model, 'GET', '/api/me').name);
      assert.equal(me.status, 200);
      assert.deepEqual(me.data, { email: 'ts@example.test' });
    });

    test(`${label}: the Postman collection reads the token from GET /api/csrf`, () => {
      const model = capture(site.origin, loggedIn);
      const collection = JSON.parse(new PostmanExporter().export(model).content) as { item: unknown[] };
      const requests: { name: string; request: { method: string; url: { raw: string } }; event?: { listen: string; script: { exec: string[] } }[] }[] = [];
      const walk = (items: unknown[]): void => {
        for (const item of items as Record<string, unknown>[]) {
          if (Array.isArray(item.item)) walk(item.item);
          else requests.push(item as (typeof requests)[number]);
        }
      };
      walk(collection.item);
      const source = requests.find((item) => item.event?.some((event) => event.listen === 'test' && event.script.exec.join('\n').includes('pm.collectionVariables.set')));
      assert.ok(source, 'a request stores the token');
      assert.equal(source.request.method, 'GET');
      assert.match(source.request.url.raw, /\/api\/csrf$/);
      assert.match(source.event?.find((event) => event.listen === 'test')?.script.exec.join('\n') ?? '', /csrfToken/);
    });
  }
});
