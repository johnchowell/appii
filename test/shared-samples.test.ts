import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Curl, SampleText, Samples, Text } from '../src/shared/index.js';
import type { Endpoint, FormField } from '../src/model/index.js';

function endpoint(over: Partial<Endpoint>): Endpoint {
  return {
    id: 'x',
    name: 'x',
    key: 'GET http://h/x',
    method: 'GET',
    origin: 'http://127.0.0.1:9',
    path: '/x',
    kind: 'json',
    firstParty: true,
    pathParams: [],
    queryParams: [],
    headerParams: [],
    responses: [],
    auth: { cookies: [], headers: [], bearer: false, csrf: [] },
    resourceTypes: ['fetch'],
    samples: [],
    count: 1,
    ...over,
  };
}

test('requestSample fills path, query, csrf header and json body', () => {
  const e = endpoint({
    method: 'POST',
    path: '/api/items/{itemId}',
    pathParams: [{ name: 'itemId', in: 'path', required: true, schema: { type: 'integer' }, examples: ['42'] }],
    queryParams: [
      { name: 'page', in: 'query', required: true, schema: { type: 'integer' }, examples: [] },
      { name: 'q', in: 'query', required: false, schema: { type: 'string' }, examples: ['a b'] },
    ],
    auth: { cookies: ['csrf'], headers: [], bearer: false, csrf: [{ location: 'header', name: 'x-csrf-token', source: 'cookie', sourceName: 'csrf' }] },
    requestBody: { mimeType: 'application/json', kind: 'json', examples: [{ name: 'Thing', password: '<redacted>' }] },
    samples: [{ exchangeId: 'e1', url: 'http://127.0.0.1:9/api/items/42?page=1&q=a+b', status: 201, startedAt: '2024-01-01T00:00:00.000Z' }],
  });
  const s = Samples.requestSample(e, { baseUrl: 'https://api.example.com/' });
  assert.equal(String(s.url), 'https://api.example.com/api/items/42?page=1&q=a%20b');
  assert.deepEqual(
    s.headers.map((header) => ({ name: header.name, value: String(header.value) })),
    [
      { name: 'x-csrf-token', value: '{{csrf}}' },
      { name: 'Content-Type', value: 'application/json' },
    ],
  );
  assert.deepEqual(Samples.plainValue(s.body?.value), { name: 'Thing', password: '{{password}}' });
  const literal = Curl.curlCommand(s);
  assert.match(literal, /^curl -sS -X POST 'https:\/\/api\.example\.com\/api\/items\/42\?page=1&q=a%20b' \\\n  -H 'x-csrf-token: \{\{csrf\}\}'/);
  const shell = Curl.curlCommand(s, { variables: 'shell', cookie: SampleText.placeholder('cookie'), multiline: false });
  assert.ok(shell.includes(`-H "x-csrf-token: \${APPII_CSRF}"`), shell);
  assert.ok(shell.includes(`--data-raw '{"name":"Thing","password":"'"\${APPII_PASSWORD}"'"}'`), shell);
  assert.ok(shell.includes(`-b "\${APPII_COOKIE}"`), shell);
  assert.deepEqual(Curl.placeholderNames(s), ['APPII_CSRF', 'APPII_PASSWORD']);
  assert.equal(String(s.cookie), 'csrf={{csrf}}');
  const out = execFileSync('bash', ['-c', `curl() { printf '%s\\n' "$@"; }; APPII_CSRF=t1 APPII_PASSWORD='p "q' APPII_COOKIE='sid=1'; ${shell}`]).toString();
  assert.ok(out.includes('x-csrf-token: t1'));
  assert.ok(out.includes('{"name":"Thing","password":"p "q"}'));
  assert.ok(out.includes('sid=1'));
});

test('form and multipart samples become curl field flags', () => {
  const form = endpoint({
    method: 'POST',
    path: '/login',
    kind: 'form',
    requestBody: {
      mimeType: 'application/x-www-form-urlencoded',
      kind: 'form',
      schema: { type: 'object', properties: { email: { type: 'string', format: 'email' }, remember: { const: 'yes' } } },
      examples: [],
    },
    auth: { cookies: [], headers: [], bearer: false, csrf: [{ location: 'body', name: 'csrf_token', source: 'hidden-field', sourceName: 'csrf_token' }] },
  });
  const s = Samples.requestSample(form);
  assert.deepEqual(Samples.plainValue(s.body?.value), { email: 'user@example.com', remember: 'yes', csrf_token: '{{csrf_token}}' });
  const cmd = Curl.curlCommand(s, { multiline: false });
  assert.ok(cmd.includes(`--data-raw 'email=user%40example.com' --data-raw 'remember=yes' --data-urlencode 'csrf_token={{csrf_token}}'`), cmd);
  const mp = endpoint({
    method: 'POST',
    path: '/signup',
    kind: 'form',
    requestBody: { mimeType: 'multipart/form-data', kind: 'multipart', examples: [{ username: 'bob', avatar: { filename: 'a.png', contentType: 'image/png', size: 3 } }] },
  });
  const m = Curl.curlCommand(Samples.requestSample(mp), { multiline: false });
  assert.ok(m.includes(`--form-string 'username=bob' -F 'avatar=@a.png'`), m);
  assert.ok(!m.includes('Content-Type'));
});

const SHIM = `curl() { printf '%s\\n' "$@"; }; `;

function runShell(command: string, env: Record<string, string> = {}): string[] {
  const out = execFileSync('bash', ['-c', SHIM + command], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } }).toString();
  return out.split('\n').slice(0, -1);
}

test('captured text that looks like a placeholder stays literal in every rendering', () => {
  const e = endpoint({
    method: 'POST',
    origin: 'https://evil.example.com',
    path: '/api/search',
    queryParams: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' }, examples: ['{{aws_secret_access_key}}'] }],
    headerParams: [{ name: 'x-trace', in: 'header', required: true, schema: { type: 'string' }, examples: ['{{github_token}}'] }],
    requestBody: { mimeType: 'application/json', kind: 'json', examples: [{ note: '{{home}}', n2: 'x{{path}}y', '{{user}}': 1 }] },
  });
  const s = Samples.requestSample(e);
  assert.deepEqual(Curl.placeholderNames(s), []);
  const shell = Curl.curlCommand(s, { variables: 'shell' });
  assert.ok(shell.includes('q=%7B%7Baws_secret_access_key%7D%7D'), shell);
  assert.ok(shell.includes(`'x-trace: {{github_token}}'`), shell);
  assert.ok(!shell.includes('${'), shell);
  const leak = { HOME: '/leak', USER: 'leak', GITHUB_TOKEN: 'leak', AWS_SECRET_ACCESS_KEY: 'leak' };
  const args = runShell(shell, leak);
  assert.ok(!args.some((arg) => arg.includes('leak')), args.join('\n'));
  assert.ok(args.includes('https://evil.example.com/api/search?q=%7B%7Baws_secret_access_key%7D%7D'));
  assert.ok(args.includes('x-trace: {{github_token}}'));
  assert.ok(args.includes('{"note":"{{home}}","n2":"x{{path}}y","{{user}}":1}'));
  const form = endpoint({
    method: 'POST',
    path: '/form',
    kind: 'form',
    requestBody: { mimeType: 'application/x-www-form-urlencoded', kind: 'form', examples: [{ c: '{{1}}', d: 'a${HOME}b' }] },
  });
  const fs = Samples.requestSample(form);
  assert.deepEqual(Curl.placeholderNames(fs), []);
  const formArgs = runShell(Curl.curlCommand(fs, { variables: 'shell' }), leak);
  assert.ok(formArgs.includes('c=%7B%7B1%7D%7D'), formArgs.join('\n'));
  assert.ok(formArgs.includes('d=a%24%7BHOME%7Db'), formArgs.join('\n'));
});

test('curl commands are ASCII and send the exact UTF-8 and control characters of each value', () => {
  const e = endpoint({
    method: 'POST',
    path: '/city',
    kind: 'form',
    headerParams: [{ name: 'x-note', in: 'header', required: true, schema: { type: 'string' }, examples: ['caf\u00e9!'] }],
    requestBody: { mimeType: 'application/x-www-form-urlencoded', kind: 'form', examples: [{ ville: 'Montr\u00e9al', tab: 'a\tb', cr: 'x\ry', bang: 'hi!there' }] },
  });
  const s = Samples.requestSample(e);
  for (const variables of ['literal', 'shell'] as const) {
    const cmd = Curl.curlCommand(s, { variables });
    assert.ok(Text.isAscii(cmd), cmd);
    assert.ok(!/[\x00-\x09\x0b-\x1f\x7f]/.test(cmd), cmd);
    const args = runShell(cmd);
    assert.ok(args.includes('ville=Montr%C3%A9al'), args.join('\n'));
    assert.ok(args.includes('tab=a%09b'), args.join('\n'));
    assert.ok(args.includes('cr=x%0Dy'), args.join('\n'));
    assert.ok(args.includes('bang=hi%21there'), args.join('\n'));
    assert.ok(args.includes('x-note: caf\u00e9!'), args.join('\n'));
  }
});

test('bearer and cookie-sourced CSRF placeholders are linked in the shared sample', () => {
  const e = endpoint({
    method: 'POST',
    path: '/api/me',
    headerParams: [
      { name: 'Authorization', in: 'header', required: true, schema: { type: 'string' }, examples: ['Bearer <redacted>'] },
      { name: 'X-CSRF-Token', in: 'header', required: true, schema: { type: 'string' }, examples: ['<redacted>'] },
    ],
    auth: { cookies: ['csrftoken'], headers: ['Authorization'], bearer: true, csrf: [{ location: 'header', name: 'X-CSRF-Token', source: 'cookie', sourceName: 'csrftoken' }] },
  });
  const s = Samples.requestSample(e);
  const literal = Curl.curlCommand(s, { multiline: false });
  assert.ok(literal.includes(`-H 'Authorization: Bearer {{access_token}}'`), literal);
  assert.ok(literal.includes(`-H 'X-CSRF-Token: {{csrftoken}}'`), literal);
  assert.deepEqual(Curl.placeholderNames(s), ['APPII_ACCESS_TOKEN', 'APPII_CSRFTOKEN']);
  const missing = Samples.requestSample(endpoint({ auth: { cookies: [], headers: [], bearer: true, csrf: [] } }));
  assert.ok(Curl.curlCommand(missing).includes(`'Authorization: Bearer {{access_token}}'`));
});

test('form endpoints send the URL, method and entry of one submitter', () => {
  const field = (name: string, value: string, extra: Partial<FormField> = {}): FormField => ({
    name,
    order: 0,
    kind: 'button',
    type: 'submit',
    value,
    hasValueAttribute: true,
    checked: false,
    disabled: false,
    readOnly: false,
    required: false,
    multiple: false,
    ...extra,
  });
  const origin = 'http://127.0.0.1:9';
  const signup = (submitters: FormField[]): Endpoint =>
    endpoint({
      method: 'POST',
      origin,
      path: '/signup',
      kind: 'form',
      queryParams: [{ name: 'draft', in: 'query', required: false, schema: { type: 'string' }, examples: ['1'] }],
      requestBody: { mimeType: 'multipart/form-data', kind: 'multipart', examples: [{ username: 'bob', intent: 'draft' }] },
      form: {
        pageUrl: `${origin}/signup`,
        selector: 'form#signup',
        action: `${origin}/signup`,
        method: 'POST',
        enctype: 'multipart/form-data',
        charset: 'UTF-8',
        fields: [],
        submitters,
        tokenFields: [],
      },
    });
  const create = field('intent', 'create');
  const draft = field('intent', 'draft', { formAction: `${origin}/signup?draft=1`, formNoValidate: true });
  const both = Samples.requestSample(signup([create, draft]));
  assert.equal(String(both.url), `${origin}/signup`);
  const bothArgs = runShell(Curl.curlCommand(both));
  assert.ok(bothArgs.includes('intent=create'), bothArgs.join('\n'));
  assert.ok(!bothArgs.includes('intent=draft'), bothArgs.join('\n'));
  const only = Samples.requestSample(signup([{ ...draft, disabled: false }]));
  assert.equal(String(only.url), `${origin}/signup?draft=1`);
  assert.ok(runShell(Curl.curlCommand(only)).includes('intent=draft'));
  const disabledFirst = Samples.requestSample(signup([{ ...create, disabled: true }, draft]));
  assert.equal(String(disabledFirst.url), `${origin}/signup?draft=1`);
});

test('generated and captured bodies keep own keys such as __proto__', () => {
  const schemaOnly = endpoint({
    method: 'POST',
    requestBody: { mimeType: 'application/json', kind: 'json', schema: { type: 'object', properties: { ['__proto__']: { type: 'string', const: 'p' }, a: { type: 'integer' } } }, examples: [] },
  });
  const generated = Samples.plainValue(Samples.requestSample(schemaOnly).body?.value) as Record<string, unknown>;
  assert.deepEqual(Object.keys(generated), ['__proto__', 'a']);
  assert.equal(Object.getPrototypeOf(generated), Object.prototype);
  const captured = endpoint({ method: 'POST', requestBody: { mimeType: 'application/json', kind: 'json', examples: [JSON.parse('{"__proto__":{"x":1},"b":"c"}')] } });
  const args = runShell(Curl.curlCommand(Samples.requestSample(captured)));
  assert.ok(args.includes('{"__proto__":{"x":1},"b":"c"}'), args.join('\n'));
});
