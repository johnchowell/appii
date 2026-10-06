import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CurlExporter } from '../src/export/index.js';
import type { CsrfToken, Endpoint } from '../src/model/index.js';
import { Curl, SampleText, Samples, ShellScript } from '../src/shared/index.js';
import type { PlaceholderPart } from '../src/shared/index.js';
import { ExportModel } from './helpers/export-model.js';

class GuardFixture {
  static readonly ORIGIN = 'https://shop.example.com';

  static login(token: Partial<CsrfToken> = {}, name = 'postLogin'): Endpoint {
    return ExportModel.endpoint({
      method: 'POST',
      path: '/login',
      kind: 'form',
      name,
      role: 'login',
      login: { evidence: 'observed', identifier: 'username', password: 'password', issues: { cookies: ['session'], tokens: [] } },
      requestBody: { mimeType: 'application/x-www-form-urlencoded', kind: 'form', examples: [{ csrf_token: '<redacted>', username: '<redacted>', password: '<redacted>' }] },
      auth: {
        cookies: ['session', 'theme'],
        headers: [],
        anonymous: 'allowed',
        bearer: false,
        csrf: [{ location: 'body', name: 'csrf_token', source: 'hidden-field', sourceName: 'csrf_token', sourceUrl: `${GuardFixture.ORIGIN}/login`, sessionCookies: ['session'], ...token }],
      },
    });
  }

  static parts(text: SampleText | undefined): PlaceholderPart[] {
    return (text?.parts ?? []).filter((part): part is PlaceholderPart => part.kind === 'placeholder');
  }

  static bash(script: string, env: Record<string, string>, cwd?: string): { status: number | null; stdout: string; stderr: string } {
    const run = spawnSync('bash', ['-c', `curl() { printf '%s\\n' "$@"; }\n${script}`], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LANG: 'C', ...env }, encoding: 'utf8', ...(cwd === undefined ? {} : { cwd }) });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  }
}

describe('the one-command example needs the CSRF token and the cookies it is bound to (P3b)', () => {
  test('requestSample marks the token and its session cookie with where they come from, and leaves credentials and other cookies alone', () => {
    const sample = Samples.requestSample(GuardFixture.login());
    const body = sample.body?.value as Samples.SampleRecord;
    const token = GuardFixture.parts(body.csrf_token as SampleText)[0];
    assert.equal(token?.missing, 'the hidden field csrf_token of GET https://shop.example.com/login; bash endpoints.sh postLogin fetches it');
    assert.equal(token?.required, undefined);
    const user = GuardFixture.parts(body.username as SampleText)[0];
    assert.equal(user?.required, Samples.IDENTIFIER_LABEL);
    assert.equal(user?.missing, undefined);
    const cookies = new Map(GuardFixture.parts(sample.cookie).map((part) => [part.name, part]));
    assert.equal(cookies.get('session')?.missing, 'the session cookie of GET https://shop.example.com/login that csrf_token is bound to; bash endpoints.sh postLogin keeps it');
    assert.equal(cookies.get('theme')?.missing, undefined);
  });

  test('the shell example stops on an unset token or cookie; with explain the first use of each variable says where the value comes from', () => {
    const sample = Samples.requestSample(GuardFixture.login());
    const short = Curl.curlCommand(sample, { variables: 'shell' });
    assert.match(short, /-b "session=\$\{APPII_SESSION:\?\}; theme=\$\{APPII_THEME\}"/);
    assert.match(short, /--data-urlencode "csrf_token=\$\{APPII_CSRF_TOKEN:\?\}"/);
    assert.match(short, /--data-urlencode "username=\$\{APPII_USERNAME:\?\}"/);
    const explained = Curl.curlCommand(sample, { variables: 'shell', explain: true });
    assert.match(explained, /-b "session=\$\{APPII_SESSION:\?the session cookie of GET https:\/\/shop\.example\.com\/login that csrf_token is bound to; bash endpoints\.sh postLogin keeps it\}; theme=\$\{APPII_THEME\}"/);
    assert.match(explained, /--data-urlencode "username=\$\{APPII_USERNAME:\?\}"/);
    const unset = GuardFixture.bash(explained, { APPII_USERNAME: 'u', APPII_PASSWORD: 'p', APPII_SESSION: 's' });
    assert.notEqual(unset.status, 0);
    assert.equal(unset.stdout, '');
    assert.match(unset.stderr, /APPII_CSRF_TOKEN: the hidden field csrf_token of GET https:\/\/shop\.example\.com\/login; bash endpoints\.sh postLogin fetches it/);
    const set = GuardFixture.bash(explained, { APPII_USERNAME: 'u', APPII_PASSWORD: 'p', APPII_SESSION: 's', APPII_CSRF_TOKEN: 't' });
    assert.equal(set.status, 0, set.stderr);
    assert.ok(set.stdout.split('\n').includes('csrf_token=t'));
    assert.ok(set.stdout.split('\n').includes('session=s; theme='));
  });

  test('a double-submit token repeats its cookie: the first use carries the message and the cookie stops too', () => {
    const items = ExportModel.endpoint({
      method: 'POST',
      path: '/api/items',
      requestBody: { mimeType: 'application/json', kind: 'json', examples: [{ name: 'x' }] },
      auth: { cookies: ['csrf'], headers: [], anonymous: 'untested', bearer: false, csrf: [{ location: 'header', name: 'x-csrf-token', source: 'cookie', sourceName: 'csrf' }] },
    });
    const command = Curl.curlCommand(Samples.requestSample(items), { variables: 'shell', explain: true });
    assert.match(command, /-H "x-csrf-token: \$\{APPII_CSRF:\?the cookie csrf; bash endpoints\.sh postApiItems reads it from its cookie jar\}"/);
    assert.match(command, /-b "csrf=\$\{APPII_CSRF:\?\}"/);
  });

  test('a token from the response of another request names that request and does not promise that the script fetches it', () => {
    const sample = Samples.requestSample(GuardFixture.login({ source: 'response', sourceName: 'csrf', sourceUrl: `${GuardFixture.ORIGIN}/api/session`, sourceMethod: 'POST' }));
    const body = sample.body?.value as Samples.SampleRecord;
    assert.equal(GuardFixture.parts(body.csrf_token as SampleText)[0]?.missing, 'csrf in the response of POST https://shop.example.com/api/session');
    const unknown = Samples.requestSample(GuardFixture.login({ source: 'unknown', sourceName: undefined, sourceUrl: undefined, sessionCookies: undefined }));
    assert.equal(GuardFixture.parts((unknown.body?.value as Samples.SampleRecord).csrf_token as SampleText)[0]?.missing, 'the CSRF token csrf_token; its source was not captured');
  });

  test('the page in the message follows the base URL of the example', () => {
    const sample = Samples.requestSample(GuardFixture.login(), { baseUrl: 'http://localhost:8080/' });
    const command = Curl.curlCommand(sample, { variables: 'shell', explain: true });
    assert.match(command, /APPII_CSRF_TOKEN:\?the hidden field csrf_token of GET http:\/\/localhost:8080\/login; /);
    assert.doesNotMatch(command, /shop\.example\.com/);
  });

  test('site text in the message cannot run commands or end the expansion: unsafe characters are percent-encoded', () => {
    const hostile = `${GuardFixture.ORIGIN}/login?a=$(touch pwned)&b='!\`id\`}"\\x`;
    const sample = Samples.requestSample(GuardFixture.login({ sourceUrl: hostile, sourceName: 'tok$(touch pwned2)' }));
    const command = Curl.curlCommand(sample, { variables: 'shell', explain: true });
    const dir = mkdtempSync(join(tmpdir(), 'appii-guard-'));
    try {
      const run = GuardFixture.bash(command, { APPII_USERNAME: 'u', APPII_PASSWORD: 'p', APPII_SESSION: 's' }, dir);
      assert.notEqual(run.status, 0);
      assert.equal(run.stdout, '');
      assert.ok(!existsSync(join(dir, 'pwned')) && !existsSync(join(dir, 'pwned2')));
      assert.match(run.stderr, /APPII_CSRF_TOKEN: the hidden field tok%24\(touch pwned2\) of GET https:\/\/shop\.example\.com\/login\?a=%24\(touch pwned\)&b=%27%21%60id%60%7D%22%5Cx; bash endpoints\.sh postLogin fetches it/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('the message names the function that the curl export defines, also for a name that is a shell word', () => {
    const endpoint = GuardFixture.login({}, 'logout');
    assert.equal(ShellScript.functionName('logout'), 'logoutEndpoint');
    const sample = Samples.requestSample(endpoint);
    assert.match(String(GuardFixture.parts((sample.body?.value as Samples.SampleRecord).csrf_token as SampleText)[0]?.missing), /bash endpoints\.sh logoutEndpoint fetches it$/);
    const script = new CurlExporter().export(ExportModel.model([endpoint])).content;
    assert.match(script, /^logoutEndpoint\(\) \{$/m);
  });

  test('the curl export ignores the messages: a body token taken from a cookie of another name keeps a plain default and reads the jar', () => {
    const form = ExportModel.endpoint({
      method: 'POST',
      path: '/api/items',
      kind: 'form',
      requestBody: { mimeType: 'application/x-www-form-urlencoded', kind: 'form', examples: [{ name: 'x', token: '<redacted>' }] },
      auth: { cookies: ['csrf'], headers: [], anonymous: 'untested', bearer: false, csrf: [{ location: 'body', name: 'token', source: 'cookie', sourceName: 'csrf' }] },
    });
    const script = new CurlExporter().export(ExportModel.model([form])).content;
    assert.match(script, /appii_value="\$\{APPII_CSRF\}"/);
    assert.doesNotMatch(script, /:\?/);
  });
});
