import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CurlExporter } from '../src/export/index.js';
import { LoginModels } from './helpers/login-models.js';
import { LoginShell } from './helpers/login-shell.js';

class NoTokenSite {
  readonly requests: string[] = [];
  origin = '';
  #server: Server | undefined;

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        this.requests.push(`${req.method ?? 'GET'} ${req.url ?? '/'}`);
        if (req.method === 'GET' && req.url === '/login') {
          res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session=anon; Path=/; HttpOnly' });
          res.end('<form method=post action=/login><input name=username><input type=password name=password></form>');
          return;
        }
        res.writeHead(403, { 'content-type': 'text/plain' });
        res.end('forbidden');
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }
}

describe('curl script warnings name the URL that the script requested, APPII_BASE_URL included (P6)', () => {
  const captured = 'https://captured.example';
  const site = new NoTokenSite();
  let dir = '';

  before(async () => {
    await site.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-curl-base-'));
  });

  after(async () => {
    await site.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test('the warning for a CSRF token missing from its page names the page under APPII_BASE_URL, not the captured origin', async () => {
    const file = join(dir, 'page.sh');
    await writeFile(file, new CurlExporter().export(LoginModels.form(captured)).content);
    site.requests.length = 0;
    const run = await LoginShell.run([file, 'postLogin', 'username=x', 'password=y', '-o', '/dev/null'], dir, { APPII_BASE_URL: site.origin, APPII_COOKIE_JAR: join(dir, 'jar.txt') });
    assert.deepEqual(site.requests, ['GET /login', 'POST /login']);
    assert.match(run.stderr, new RegExp(`postLogin: warning: GET ${site.origin.replace(/[.]/g, '\\.')}/login gave no value for the CSRF token csrf_token \\(the hidden field csrf_token\\)\\. Set APPII_CSRF_TOKEN to send it\\.`));
    assert.ok(!run.stderr.includes(captured), run.stderr);
  });

  test('without APPII_BASE_URL the same warning names the captured origin that the script used', async () => {
    const file = join(dir, 'local.sh');
    await writeFile(file, new CurlExporter().export(LoginModels.form(site.origin)).content);
    site.requests.length = 0;
    const run = await LoginShell.run([file, 'postLogin', 'username=x', 'password=y', '-o', '/dev/null'], dir, { APPII_COOKIE_JAR: join(dir, 'jar2.txt') });
    assert.deepEqual(site.requests, ['GET /login', 'POST /login']);
    assert.match(run.stderr, new RegExp(`GET ${site.origin.replace(/[.]/g, '\\.')}/login gave no value`));
  });

  test('the warning for a token that comes from another response names that response under APPII_BASE_URL', async () => {
    const model = LoginModels.form(captured);
    const login = LoginModels.endpoint(model, 'POST', '/login');
    login.auth.csrf = login.auth.csrf.map((token) => ({ ...token, source: 'response' as const, sourceName: 'csrf', sourceUrl: `${captured}/api/session`, sourceMethod: 'POST' }));
    assert.ok(login.auth.csrf.length > 0);
    const file = join(dir, 'response.sh');
    await writeFile(file, new CurlExporter().export(model).content);
    site.requests.length = 0;
    const run = await LoginShell.run([file, 'postLogin', 'username=x', 'password=y', '-o', '/dev/null'], dir, { APPII_BASE_URL: `${site.origin}/base`, APPII_COOKIE_JAR: join(dir, 'jar3.txt') });
    assert.match(run.stderr, new RegExp(`It comes from the response of POST ${site.origin.replace(/[.]/g, '\\.')}/base/api/session; set APPII_CSRF_TOKEN to send it\\.`));
    assert.ok(!run.stderr.includes(captured), run.stderr);
  });
});
