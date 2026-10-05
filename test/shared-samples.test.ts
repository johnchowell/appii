import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Curl, Samples } from '../src/shared/index.js';
import type { Endpoint } from '../src/model/index.js';

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
  });
  const s = Samples.requestSample(e, { baseUrl: 'https://api.example.com/' });
  assert.equal(s.url, 'https://api.example.com/api/items/42?page=1&q=a%20b');
  assert.deepEqual(s.headers, [
    { name: 'x-csrf-token', value: '{{x_csrf_token}}' },
    { name: 'Content-Type', value: 'application/json' },
  ]);
  assert.deepEqual(s.body?.value, { name: 'Thing', password: '{{password}}' });
  const literal = Curl.curlCommand(s);
  assert.match(literal, /^curl -sS -X POST 'https:\/\/api\.example\.com\/api\/items\/42\?page=1&q=a%20b' \\\n  -H 'x-csrf-token: \{\{x_csrf_token\}\}'/);
  const shell = Curl.curlCommand(s, { variables: 'shell', cookie: '"$COOKIE"', multiline: false });
  assert.ok(shell.includes(`-H "x-csrf-token: \${X_CSRF_TOKEN}"`));
  assert.ok(shell.includes(`--data-raw "{\\"name\\":\\"Thing\\",\\"password\\":\\"\${PASSWORD}\\"}"`));
  assert.deepEqual(Curl.placeholderNames(s), ['PASSWORD', 'X_CSRF_TOKEN']);
  const out = execFileSync('bash', ['-c', `curl() { printf '%s\\n' "$@"; }; X_CSRF_TOKEN=t1 PASSWORD='p "q' COOKIE='sid=1'; ${shell}`]).toString();
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
  assert.deepEqual(s.body?.value, { email: 'user@example.com', remember: 'yes', csrf_token: '{{csrf_token}}' });
  const cmd = Curl.curlCommand(s, { multiline: false });
  assert.ok(cmd.includes(`--data-urlencode 'email=user@example.com' --data-urlencode 'remember=yes' --data-urlencode 'csrf_token={{csrf_token}}'`));
  const mp = endpoint({
    method: 'POST',
    path: '/signup',
    kind: 'form',
    requestBody: { mimeType: 'multipart/form-data', kind: 'multipart', examples: [{ username: 'bob', avatar: { filename: 'a.png', contentType: 'image/png', size: 3 } }] },
  });
  const m = Curl.curlCommand(Samples.requestSample(mp), { multiline: false });
  assert.ok(m.includes(`-F 'username=bob' -F 'avatar=@a.png'`));
  assert.ok(!m.includes('Content-Type'));
});
