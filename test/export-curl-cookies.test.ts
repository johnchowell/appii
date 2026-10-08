import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownExporter } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { EndpointDetailPresenter } from '../src/present/index.js';
import { ExportModel } from './helpers/export-model.js';
import { LoginShell } from './helpers/login-shell.js';

class CookieEcho {
  readonly seen: IncomingHttpHeaders[] = [];
  #server: Server | undefined;
  origin = '';

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      this.seen.push(req.headers);
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server?.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => (this.#server ? this.#server.close(() => resolve()) : resolve()));
  }

  last(): IncomingHttpHeaders | undefined {
    return this.seen.at(-1);
  }
}

class CookieModels {
  static plain(origin: string): Endpoint {
    return ExportModel.endpoint({ method: 'GET', path: '/api/me', origin, auth: { cookies: ['session', 'theme'], headers: [], anonymous: 'untested', bearer: false, csrf: [] } });
  }

  static three(origin: string): Endpoint {
    return ExportModel.endpoint({ method: 'GET', path: '/api/three', origin, auth: { cookies: ['a', 'b', 'c'], headers: [], anonymous: 'untested', bearer: false, csrf: [] } });
  }

  static bound(origin: string): Endpoint {
    return ExportModel.endpoint({
      method: 'GET',
      path: '/api/bound',
      origin,
      headerParams: [{ name: 'x-csrf-token', in: 'header', required: true, schema: { type: 'string' }, examples: ['<redacted>'] }],
      auth: {
        cookies: ['lang', 'session', 'theme'],
        headers: [],
        anonymous: 'untested',
        bearer: false,
        csrf: [{ location: 'header', name: 'x-csrf-token', source: 'hidden-field', sourceName: 'csrf_token', sourceUrl: `${origin}/form`, sessionCookies: ['session'] }],
      },
    });
  }

  static model(origin: string): ApiModel {
    return ExportModel.model([CookieModels.plain(origin), CookieModels.three(origin), CookieModels.bound(origin)]);
  }

  static show(model: ApiModel, ref: string): string {
    const out = new EndpointDetailPresenter({ width: 400 }).render({ model, ref });
    const start = out.indexOf('\n', out.indexOf('\n', out.indexOf('Example request (curl)')) + 1) + 1;
    return out.slice(start, out.indexOf('\n\n', start));
  }

  static markdown(model: ApiModel, path: string): string {
    const content = new MarkdownExporter().export(model).content;
    const section = content.slice(content.indexOf(`: GET ${path}\n`));
    const block = /```bash\n([\s\S]*?)\n```/.exec(section)?.[1];
    assert.ok(block, content);
    return block;
  }
}

describe('an unguarded cookie whose variable is not set is left out of the Cookie header (QL4-5)', () => {
  const echo = new CookieEcho();
  let dir = '';
  let model: ApiModel;

  before(async () => {
    await echo.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-cookies-'));
    model = CookieModels.model(echo.origin);
  });

  after(async () => {
    await echo.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const send = async (command: string, env: Record<string, string>): Promise<string | undefined> => {
    const before = echo.seen.length;
    const run = await LoginShell.run(['-c', `${command} -o /dev/null`], dir, env);
    assert.equal(run.code, 0, `${command}\n${run.stderr}`);
    assert.equal(echo.seen.length, before + 1);
    return echo.last()?.cookie;
  };

  test('list --show and the Markdown example send no Cookie header when no cookie variable is set, and the exact pairs that are set', async () => {
    const id = CookieModels.plain(echo.origin).id;
    const show = CookieModels.show(model, id);
    const markdown = CookieModels.markdown(model, '/api/me');
    assert.equal(show, markdown);
    assert.ok(show.includes(`-H @<(printf '%s\\n' "Cookie: \${APPII_SESSION:+session=$APPII_SESSION}\${APPII_THEME:+\${APPII_SESSION:+; }theme=$APPII_THEME}")`), show);
    for (const command of [show, markdown]) {
      assert.equal(await send(command, {}), undefined);
      assert.equal(await send(command, { APPII_SESSION: 's 1' }), 'session=s 1');
      assert.equal(await send(command, { APPII_THEME: 'dark' }), 'theme=dark');
      assert.equal(await send(command, { APPII_SESSION: 's1', APPII_THEME: 'dark' }), 'session=s1; theme=dark');
      assert.equal(await send(command, { APPII_SESSION: '', APPII_THEME: 'dark' }), 'theme=dark');
    }
  });

  test('three optional cookies: every subset that is set is sent with one separator between pairs', async () => {
    const command = CookieModels.show(model, CookieModels.three(echo.origin).id);
    assert.equal(command, CookieModels.markdown(model, '/api/three'));
    const values: Record<string, string> = { APPII_A: '1', APPII_B: '2', APPII_C: '3' };
    for (let mask = 0; mask < 8; mask++) {
      const names = ['a', 'b', 'c'].filter((_name, i) => (mask & (1 << i)) !== 0);
      const env = Object.fromEntries(names.map((name) => [`APPII_${name.toUpperCase()}`, values[`APPII_${name.toUpperCase()}`] ?? '']));
      const expected = names.map((name) => `${name}=${env[`APPII_${name.toUpperCase()}`]}`).join('; ');
      assert.equal(await send(command, env), expected === '' ? undefined : expected, `set: ${names.join(',') || 'none'}`);
    }
  });

  test('a cookie the CSRF token is bound to still stops the command, and the optional cookies around it are left out when unset', async () => {
    const command = CookieModels.show(model, CookieModels.bound(echo.origin).id);
    assert.match(command, /^: [^\n]*"\$\{APPII_SESSION:\?/);
    assert.ok(command.includes('"Cookie: ${APPII_LANG:+lang=$APPII_LANG; }session=${APPII_SESSION}${APPII_THEME:+; theme=$APPII_THEME}"'), command);
    const before = echo.seen.length;
    const stopped = await LoginShell.run(['-c', `${command} -o /dev/null`], dir, { APPII_X_CSRF_TOKEN: 't' });
    assert.notEqual(stopped.code, 0);
    assert.match(stopped.stderr, /APPII_SESSION/);
    assert.equal(echo.seen.length, before);
    const base = { APPII_X_CSRF_TOKEN: 't', APPII_SESSION: 's' };
    assert.equal(await send(command, base), 'session=s');
    assert.equal(await send(command, { ...base, APPII_LANG: 'en' }), 'lang=en; session=s');
    assert.equal(await send(command, { ...base, APPII_THEME: 'dark' }), 'session=s; theme=dark');
    assert.equal(await send(command, { ...base, APPII_LANG: 'en', APPII_THEME: 'dark' }), 'lang=en; session=s; theme=dark');
    assert.equal(echo.last()?.['x-csrf-token'], 't');
  });
});
