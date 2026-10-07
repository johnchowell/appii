import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarkdownExporter } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { EndpointDetailPresenter } from '../src/present/index.js';
import { LoginModels } from './helpers/login-models.js';
import { LoginShell } from './helpers/login-shell.js';
import { LoginSite } from './helpers/login-site.js';

class JsonExample {
  static readonly HEADING = 'Example request (curl)';
  static readonly PASSWORD = 'say "hi" \\ ok\nline two\ttab \u00e9 \u007f end';
  static readonly USER = 'nora "the" \\admin';

  static show(model: ApiModel, endpoint: Endpoint, width: number): string {
    const lines = new EndpointDetailPresenter({ width }).render({ model, ref: endpoint.id }).split('\n');
    const start = lines.indexOf(JsonExample.HEADING);
    assert.ok(start >= 0, `missing ${JsonExample.HEADING}`);
    const body = lines.slice(start + 2);
    const end = body.indexOf('');
    return (end < 0 ? body : body.slice(0, end)).join('\n');
  }

  static markdown(model: ApiModel, endpoint: Endpoint): string {
    const content = new MarkdownExporter().export(model).content;
    const at = content.indexOf(`\n\`\`\`bash\n`, content.indexOf(`${endpoint.name}: ${endpoint.method} ${endpoint.path}`));
    assert.ok(at >= 0, 'missing Markdown example');
    const start = at + '\n```bash\n'.length;
    return content.slice(start, content.indexOf('\n```', start));
  }
}

describe('the one-command JSON login example escapes its values for JSON and stops on unset values (LV3-5)', () => {
  const site = new LoginSite();
  let dir = '';
  let model: ApiModel;
  let login: Endpoint;

  before(async () => {
    await site.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-json-example-'));
    model = LoginModels.bearer(site.origin);
    login = LoginModels.endpoint(model, 'POST', '/api/auth/login');
  });

  after(async () => {
    await site.stop();
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (command: string, env: Record<string, string>) => {
    const file = join(dir, 'example.sh');
    await writeFile(file, `${command}\n`);
    site.reset();
    return LoginShell.run([file], dir, env);
  };

  test('list --show and the Markdown example send a password with a quote, a backslash, a newline, a tab and non-ASCII text as the same JSON string', async () => {
    const examples = [JsonExample.show(model, login, 200), JsonExample.show(model, login, 60), JsonExample.show(model, login, 40), JsonExample.markdown(model, login)];
    for (const [i, command] of examples.entries()) {
      const result = await run(command, { APPII_USERNAME: JsonExample.USER, APPII_PASSWORD: JsonExample.PASSWORD, LANG: 'C.UTF-8' });
      assert.equal(result.code, 0, `${i}: ${result.stderr}\n${command}`);
      const sent = site.requests.filter((request) => request.path === '/api/auth/login');
      assert.equal(sent.length, 1, `${i}: ${command}`);
      assert.deepEqual(JSON.parse(sent[0]?.body ?? ''), { username: JsonExample.USER, password: JsonExample.PASSWORD }, `${i}: ${command}`);
      assert.equal((JSON.parse(result.stdout) as { user: { name: string } }).user.name, JsonExample.USER, `${i}`);
    }
    for (const [i, width] of [[1, 60], [2, 40]] as const) {
      const lines = (examples[i] ?? '').split('\n');
      assert.ok(lines.length > 4, examples[i]);
      assert.ok(lines.every((line) => line.length <= width), examples[i]);
    }
  });

  test('an unset user name or password stops the command before any request and names the variable', async () => {
    for (const command of [JsonExample.show(model, login, 200), JsonExample.show(model, login, 40), JsonExample.markdown(model, login)]) {
      const missing = await run(command, { APPII_USERNAME: 'nora' });
      assert.notEqual(missing.code, 0, command);
      assert.match(missing.stderr, /APPII_PASSWORD/);
      assert.equal(missing.stdout, '');
      assert.equal(site.requests.length, 0, command);
      const empty = await run(command, { APPII_USERNAME: '', APPII_PASSWORD: 'p' });
      assert.notEqual(empty.code, 0, command);
      assert.match(empty.stderr, /APPII_USERNAME/);
      assert.equal(site.requests.length, 0, command);
    }
  });
});
