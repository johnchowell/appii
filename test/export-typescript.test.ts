import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { TsTypeWriter, TypeScriptExporter } from '../src/export/index.js';
import { FormExtractor, FormSchemaBuilder } from '../src/forms/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { Http, Text } from '../src/shared/index.js';
import { TsClientHarness } from './fixtures/export-ts-harness.js';
import { FIXTURE_USER, startFixtureSite } from './fixtures/site.js';
import type { FixtureSite } from './fixtures/site.js';
import { ExportModel } from './helpers/export-model.js';
import type { ExportFixture } from './helpers/export-model.js';

const TSC = resolve('node_modules/.bin/tsc');
const STRICT = [
  '--strict',
  '--target',
  'ES2022',
  '--lib',
  'ES2022,DOM',
  '--module',
  'ESNext',
  '--moduleResolution',
  'Bundler',
  '--noEmit',
  '--noUnusedLocals',
  '--noUncheckedIndexedAccess',
  '--exactOptionalPropertyTypes',
  '--noImplicitOverride',
  '--noImplicitReturns',
  '--skipLibCheck',
  '--types',
  '',
];

type Generated = Record<string, unknown> & {
  ValidationError: new (errors: unknown[]) => Error & { errors: FieldErrorShape[] };
  CookieJar: new () => CookieJarShape;
};

interface FieldErrorShape {
  field: string;
  code: string;
  message: string;
  label?: string;
}

interface CookieJarShape {
  set(line: string, url: string, now?: number): boolean;
  get(name: string, url?: string, now?: number): string | undefined;
  header(url: string, now?: number): string;
  list(now?: number): Record<string, unknown>[];
  clear(): void;
}

interface ClientShape {
  cookies: CookieJarShape;
  clearTokens(): void;
  [method: string]: unknown;
}

interface ResponseShape {
  status: number;
  ok: boolean;
  url: string;
  redirected: boolean;
  headers: Headers;
  data: any;
}

function tsc(cwd: string, files: string[]): Promise<{ code: number; output: string }> {
  return new Promise((done) => {
    execFile(TSC, [...STRICT, ...files], { cwd, timeout: 120_000 }, (err, stdout, stderr) => {
      done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: stdout + stderr });
    });
  });
}

async function load(dir: string, name: string, source: string): Promise<Generated> {
  const file = join(dir, name);
  await writeFile(file, source);
  return (await import(pathToFileURL(file).href)) as Generated;
}

function call(client: ClientShape, method: string, request?: unknown): Promise<ResponseShape> {
  const fn = client[method];
  assert.equal(typeof fn, 'function', method);
  return (fn as (request?: unknown) => Promise<ResponseShape>).call(client, request);
}

function validator(mod: Generated, name: string): (input?: unknown) => FieldErrorShape[] {
  const fn = mod[name];
  assert.equal(typeof fn, 'function', name);
  return fn as (input?: unknown) => FieldErrorShape[];
}

async function rejects(promise: Promise<unknown>, mod: Generated): Promise<FieldErrorShape[]> {
  try {
    await promise;
  } catch (err) {
    assert.ok(err instanceof mod.ValidationError, String(err));
    return err.errors;
  }
  assert.fail('expected a ValidationError');
}

describe('TypeScriptExporter: generated client against the fixture site', () => {
  let fixture: ExportFixture;
  let fresh: FixtureSite;
  let model: ApiModel;
  let dir: string;
  let source: string;
  let mod: Generated;
  let Client: new (options?: Record<string, unknown>) => ClientShape;
  const exporter = new TypeScriptExporter();

  before(async () => {
    fixture = await ExportModel.fixture();
    model = fixture.model;
    fresh = await startFixtureSite();
    dir = await mkdtemp(join(tmpdir(), 'appii-ts-'));
    source = exporter.export(model).content;
    mod = await load(dir, 'client.ts', source);
    Client = mod[TypeScriptExporter.clientName(model)] as typeof Client;
  });

  after(async () => {
    await fixture?.site.close();
    await fresh?.close();
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the export result is a self-contained ASCII TypeScript file', () => {
    const result = exporter.export(model);
    assert.equal(result.format, 'typescript');
    assert.equal(result.filename, `${Text.kebabCase(model.name)}-client.ts`);
    assert.ok(Text.isAscii(result.content));
    assert.doesNotMatch(result.content, /^import /m);
    assert.match(result.content, /\nexport class Api127001\d+Client extends BaseApiClient \{\n/);
    assert.equal(TypeScriptExporter.clientName({ ...model, name: 'shop.example.com' }), 'ShopExampleComClient');
    assert.equal(TypeScriptExporter.clientName({ ...model, name: '' }), 'ApiClient');
    for (const endpoint of model.endpoints) assert.match(result.content, new RegExp(`\\n  async ${endpoint.name}\\(request: `));
    assert.match(result.content, /\nexport function validatePostLogin\(input: Partial<PostLoginBody> = \{\}, options: ValidateOptions = \{\}\): FieldError\[\] \{\n/);
    assert.match(result.content, /\nexport function validatePostSignup\(/);
    assert.match(result.content, /\nexport function validateGetSearch\(input: Partial<GetSearchQuery> = \{\}, options: ValidateOptions = \{\}\)/);
  });

  test('the client compiles with tsc --strict and its response data is typed by status', async () => {
    const usage = [
      `import { ${TypeScriptExporter.clientName(model)} as Client, ValidationError, validatePostLogin } from './client.js';`,
      `import type { FieldError, ListItemsResponse200 } from './client.js';`,
      '',
      'export async function usage(): Promise<string[]> {',
      "  const client = new Client({ baseUrl: 'http://localhost:1', validate: true, headers: { 'x-test': '1' } });",
      '  const out: string[] = [];',
      '  const list = await client.listItems({ query: { page: 1, limit: 2 } });',
      '  if (list.status === 200) {',
      '    const data: ListItemsResponse200 = list.data;',
      '    out.push(data.items[0]?.name ?? "");',
      '  }',
      '  const item = await client.getItem({ params: { itemId: 1 } });',
      '  if (item.status === 200) out.push(item.data.name, item.data.createdAt);',
      '  const me = await client.getMe();',
      '  if (me.status === 200) out.push(me.data.email);',
      '  else if (me.status === 401) out.push(me.data.error);',
      '  const login = await client.postLogin({ body: { email: "a@b.c", password: "12345678" } });',
      '  out.push(String(login.status), login.url);',
      '  const errors: FieldError[] = validatePostLogin({ email: "x" });',
      '  out.push(String(errors.length), String(new ValidationError(errors).errors.length));',
      '  await client.postSignup({ body: { username: "abc", email: "a@b.c", country: "us", terms: "on", interests: ["a"], avatar: new Blob([]) } });',
      '  await client.graphqlGetItem({ body: { variables: { id: "1" } } });',
      '  await client.getSearch({ query: { q: "x" } });',
      '  out.push(client.cookies.header("http://localhost:1/"));',
      '  return out;',
      '}',
    ].join('\n');
    await writeFile(join(dir, 'usage.ts'), usage);
    const ok = await tsc(dir, ['client.ts', 'usage.ts']);
    assert.equal(ok.output, '');
    assert.equal(ok.code, 0);
    await writeFile(
      join(dir, 'bad.ts'),
      [
        `import { ${TypeScriptExporter.clientName(model)} as Client } from './client.js';`,
        'export async function bad(): Promise<void> {',
        '  const client = new Client();',
        "  await client.getItem({ params: { itemId: 'one' } });",
        '  const me = await client.getMe();',
        '  if (me.status === 200) me.data.missing.toString();',
        '  await client.postLogin({ body: { email: 1 } });',
        '}',
      ].join('\n'),
    );
    const bad = await tsc(dir, ['client.ts', 'bad.ts']);
    assert.notEqual(bad.code, 0);
    assert.match(bad.output, /bad\.ts\(4,/);
    assert.match(bad.output, /bad\.ts\(6,.*missing/);
    assert.match(bad.output, /bad\.ts\(7,/);
  });

  test('postLogin fetches the CSRF token from the login page, follows the redirect and keeps the session', async () => {
    const client = new Client({ baseUrl: fresh.origin });
    const anonymous = await call(client, 'getMe');
    assert.equal(anonymous.status, 401);
    assert.deepEqual(anonymous.data, { error: 'unauthorized' });
    const start = fresh.requests.length;
    const login = await call(client, 'postLogin', { body: { email: FIXTURE_USER.email, password: FIXTURE_USER.password } });
    assert.equal(login.status, 200);
    assert.equal(login.redirected, true);
    assert.equal(login.url, `${fresh.origin}/account`);
    assert.match(String(login.data), /Welcome user@example\.com/);
    const requests = fresh.requests.slice(start).map((r) => `${r.method} ${r.path}`);
    assert.deepEqual(requests, ['GET /login', 'POST /login', 'GET /account']);
    const post = fresh.requests[start + 1];
    const form = new URLSearchParams(post?.body);
    const session = [...fresh.sessions.values()].find((s) => s.user === FIXTURE_USER.email);
    assert.deepEqual([...form.keys()], ['csrf_token', 'email', 'password', 'action']);
    assert.equal(form.get('csrf_token'), session?.csrf);
    assert.equal(form.get('action'), 'login');
    assert.equal(post?.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.equal(post?.headers.referer, `${fresh.origin}/login`);
    assert.equal(post?.headers.origin, fresh.origin);
    assert.ok(client.cookies.get('auth', `${fresh.origin}/`));
    const me = await call(client, 'getMe');
    assert.equal(me.status, 200);
    assert.deepEqual(me.data, { email: FIXTURE_USER.email });
  });

  test('invalid form input throws ValidationError before any request is sent', async () => {
    const client = new Client({ baseUrl: fresh.origin });
    const before = fresh.requests.length;
    const errors = await rejects(call(client, 'postLogin', { body: { email: 'not-an-email', password: 'short' } }), mod);
    assert.deepEqual(errors, [
      { field: 'email', code: 'typeMismatch', message: "Please include an '@' in the email address. 'not-an-email' is missing an '@'.", label: 'Email' },
      { field: 'password', code: 'tooShort', message: 'Please lengthen this text to 8 characters or more (you are currently using 5 characters).', label: 'Password' },
    ]);
    const missing = await rejects(call(client, 'postLogin', { body: {} }), mod);
    assert.deepEqual(missing.map((e) => [e.field, e.message]), [
      ['email', 'Please fill out this field.'],
      ['password', 'Please fill out this field.'],
    ]);
    const search = await rejects(call(client, 'getSearch', { query: { q: '' } }), mod);
    assert.deepEqual(search.map((e) => e.code), ['valueMissing']);
    assert.equal(fresh.requests.length, before);
    const unchecked = new Client({ baseUrl: fresh.origin, validate: false });
    const response = await call(unchecked, 'postLogin', { body: { email: 'x', password: 'y' } });
    assert.equal(response.status, 422);
    assert.deepEqual(fresh.requests.slice(before).map((r) => `${r.method} ${r.path}`), ['GET /login', 'POST /login']);
  });

  test('typed JSON endpoints: getItem, listItems, GraphQL defaults and the GET search form', async () => {
    const client = new Client({ baseUrl: fresh.origin });
    const item = await call(client, 'getItem', { params: { itemId: 2 } });
    assert.equal(item.status, 200);
    assert.equal(item.data.name, 'Gadget');
    assert.equal((await call(client, 'getItem', { params: { itemId: 999 } })).status, 404);
    await assert.rejects(call(client, 'getItem', { params: {} }), /Missing path parameter "itemId"/);
    const list = await call(client, 'listItems', { query: { page: 2, limit: 1 } });
    assert.deepEqual(list.data.items.map((i: { name: string }) => i.name), ['Gadget']);
    assert.equal(fresh.requests.at(-1)?.path, '/api/items?page=2&limit=1');
    const graphql = await call(client, 'graphqlGetItem', { body: { variables: { id: '3' } } });
    assert.deepEqual(graphql.data, { data: { item: { id: '3', name: 'Doohickey' } } });
    assert.equal(JSON.parse(fresh.requests.at(-1)?.body ?? '{}').operationName, 'GetItem');
    const search = await call(client, 'getSearch', { query: { q: 'wid get' } });
    assert.equal(search.status, 200);
    assert.equal(fresh.requests.at(-1)?.path, '/search?q=wid+get');
    assert.equal(typeof search.data, 'string');
  });

  test('createItem copies the CSRF cookie into the header, seeding the cookie from the page that sets it', async () => {
    const client = new Client({ baseUrl: fresh.origin });
    const start = fresh.requests.length;
    const created = await call(client, 'createItem', { body: { name: 'Gizmo', price: 7 } });
    assert.equal(created.status, 201);
    assert.equal(created.data.name, 'Gizmo');
    assert.ok(fresh.items.some((item) => item.name === 'Gizmo'));
    const requests = fresh.requests.slice(start);
    assert.deepEqual(requests.map((r) => `${r.method} ${r.path}`), ['GET /app', 'POST /api/items']);
    assert.equal(requests[1]?.headers['x-csrf-token'], client.cookies.get('csrf', `${fresh.origin}/`));
    assert.equal(requests[1]?.headers['content-type'], 'application/json');
    const invalid = await call(client, 'createItem', { body: { price: -1 } });
    assert.equal(invalid.status, 400);
    assert.deepEqual(Object.keys(invalid.data.errors), ['name', 'price']);
  });

  test('multipart signup: website-equivalent entries, defaults, files and the formnovalidate draft submitter', async () => {
    const client = new Client({ baseUrl: fresh.origin });
    const avatar = new File([new Uint8Array([1, 2, 3])], 'me.png', { type: 'image/png' });
    const ok = await call(client, 'postSignup', { body: { username: 'new_user', email: 'new@example.com', country: 'ca', terms: 'on', avatar } });
    assert.equal(ok.status, 201, JSON.stringify(ok.data));
    assert.deepEqual(ok.data.received, {
      username: 'new_user',
      email: 'new@example.com',
      age: '',
      website: '',
      birthday: '',
      country: 'ca',
      plan: 'free',
      interests: ['a', 'c'],
      bio: 'Hello\r\nworld',
      terms: 'on',
      avatar: { filename: 'me.png', type: 'image/png', size: 3 },
      readonly_field: 'ro',
      intent: 'create',
    });
    assert.equal(fresh.requests.at(-1)?.path, '/signup');
    assert.match(String(fresh.requests.at(-1)?.headers['content-type']), /^multipart\/form-data; boundary=/);
    const empty = await call(client, 'postSignup', { body: { username: 'other_user', email: 'o@example.com', country: 'us', terms: 'on' } });
    assert.deepEqual(empty.data.received.avatar, { filename: '', type: 'application/octet-stream', size: 0 });
    assert.match(fresh.requests.at(-1)?.body ?? '', /Content-Disposition: form-data; name="avatar"; filename=""\r\nContent-Type: application\/octet-stream\r\n\r\n\r\n/);
    const draft = await call(client, 'postSignup', { body: { intent: 'draft', username: 'X' } });
    assert.equal(draft.status, 201);
    assert.equal(fresh.requests.at(-1)?.path, '/signup?draft=1');
    assert.equal(draft.data.received.intent, 'draft');
  });

  test('signup validation matches the browser messages', async () => {
    const client = new Client({ baseUrl: fresh.origin });
    const before = fresh.requests.length;
    const errors = await rejects(
      call(client, 'postSignup', {
        body: { username: 'AB', email: 'a@', age: 5, website: 'nope', birthday: '1800-01-01', bio: 'x'.repeat(201), interests: ['a', 'z'] },
      }),
      mod,
    );
    assert.deepEqual(
      errors.map((e) => [e.field, e.code, e.message]),
      [
        ['username', 'patternMismatch', 'Please match the requested format.'],
        ['email', 'typeMismatch', "Please enter a part following '@'. 'a@' is incomplete."],
        ['age', 'rangeUnderflow', 'Value must be greater than or equal to 13.'],
        ['website', 'typeMismatch', 'Please enter a URL.'],
        ['birthday', 'rangeUnderflow', 'Value must be 01/01/1900 or later.'],
        ['country', 'valueMissing', 'Please select an item in the list.'],
        ['interests', 'typeMismatch', "'z' is not one of the options: a, b, c."],
        ['bio', 'tooLong', 'Please shorten this text to 200 characters or less (you are currently using 201 characters).'],
        ['terms', 'valueMissing', 'Please check this box if you want to proceed.'],
      ],
    );
    assert.equal(fresh.requests.length, before);
    const validate = validator(mod, 'validatePostSignup');
    assert.deepEqual(validate({ username: 'good_name', email: 'g@example.com', country: 'us', terms: 'on' }), []);
    assert.deepEqual(validate({ username: 'good_name', email: 'g@example.com', country: 'us', terms: 'on', age: 13.5 }).map((e) => e.message), [
      'Please enter a valid value. The two nearest valid values are 13 and 14.',
    ]);
    assert.deepEqual(validate({ intent: 'draft' }), []);
    assert.deepEqual(validator(mod, 'validatePostLogin')({ email: 'user@example.com', password: 'correct-horse' }), []);
  });

  test('a new session loads the token page again before the next form submission', async () => {
    const client = new Client({ baseUrl: fresh.origin });
    const wrong = await call(client, 'postLogin', { body: { email: FIXTURE_USER.email, password: 'wrong-password' } });
    assert.equal(wrong.status, 422);
    client.cookies.clear();
    const start = fresh.requests.length;
    const login = await call(client, 'postLogin', { body: { email: FIXTURE_USER.email, password: FIXTURE_USER.password } });
    assert.equal(login.status, 200);
    assert.deepEqual(fresh.requests.slice(start).map((r) => `${r.method} ${r.path}`), ['GET /login', 'POST /login', 'GET /account']);
  });

  test('the generated client compiles with lib DOM and also with only the Node.js types', async () => {
    for (const dom of [true, false]) {
      const result = await new Promise<{ code: number; output: string }>((done) => {
        const args = [...TsClientHarness.STRICT, ...(dom ? TsClientHarness.WITH_DOM : TsClientHarness.WITHOUT_DOM), 'client.ts'];
        execFile(TSC, args, { cwd: dir, timeout: 120_000 }, (err, stdout, stderr) => {
          done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: stdout + stderr });
        });
      });
      assert.equal(result.output, '', dom ? 'lib DOM' : 'Node.js types');
      assert.equal(result.code, 0);
    }
  });

  test('redirect manual returns the 303 and the cookie store still records Set-Cookie', async () => {
    const client = new Client({ baseUrl: fresh.origin, redirect: 'manual' });
    const login = await call(client, 'postLogin', { body: { email: FIXTURE_USER.email, password: FIXTURE_USER.password } });
    assert.equal(login.status, 303);
    assert.equal(login.headers.get('location'), '/account');
    assert.equal(login.data, undefined);
    assert.ok(client.cookies.get('auth', `${fresh.origin}/api/me`));
    const me = await call(client, 'getMe');
    assert.equal(me.status, 200);
  });

  test('options: initial cookies, custom fetch and default headers', async () => {
    const seen: { url: string; headers: Headers; method: string }[] = [];
    const fake = async (input: string, init: RequestInit): Promise<Response> => {
      seen.push({ url: input, headers: new Headers(init.headers), method: String(init.method) });
      return new Response(JSON.stringify({ email: 'x@y.z' }), { status: 200, headers: { 'content-type': 'application/json', 'set-cookie': 'n=1; Path=/' } });
    };
    const client = new Client({ baseUrl: 'https://api.example.test/base/', cookies: 'a=1; b=2', fetch: fake, headers: { 'X-Custom': 'yes' } });
    const me = await call(client, 'getMe', { headers: { 'x-extra': '2' } });
    assert.deepEqual(me.data, { email: 'x@y.z' });
    assert.equal(seen[0]?.url, 'https://api.example.test/base/api/me');
    assert.equal(seen[0]?.headers.get('cookie'), 'a=1; b=2');
    assert.equal(seen[0]?.headers.get('x-custom'), 'yes');
    assert.equal(seen[0]?.headers.get('x-extra'), '2');
    await call(client, 'getMe');
    assert.equal(seen[1]?.headers.get('cookie'), 'a=1; b=2; n=1');
  });
});

describe('Generated runtime units', () => {
  let dir: string;
  let mod: Generated;
  let Client: new (options?: Record<string, unknown>) => ClientShape;

  function formEndpoint(html: string, extra: Partial<Endpoint> = {}): Endpoint {
    const page = 'https://shop.example.com/form';
    const [form] = FormExtractor.create().extract(html, page);
    assert.ok(form);
    const built = FormSchemaBuilder.create().build(form);
    const get = built.method === 'GET';
    return ExportModel.endpoint({
      method: built.method,
      path: new URL(built.action).pathname,
      kind: 'form',
      id: `${built.method.toLowerCase()}-form`,
      name: 'submitForm',
      ...(get
        ? {
            queryParams: Object.entries(built.schema.properties as Record<string, Record<string, unknown>>).map(([name, schema]) => ({
              name,
              in: 'query' as const,
              required: ((built.schema.required as string[] | undefined) ?? []).includes(name),
              schema,
              examples: [],
            })),
          }
        : { requestBody: { mimeType: built.mimeType, kind: built.mimeType === 'multipart/form-data' ? 'multipart' : 'form', schema: built.schema, examples: [] } }),
      form: { pageUrl: page, selector: form.selector, action: form.action, method: form.method, enctype: form.enctype, charset: form.charset, fields: form.fields, submitters: form.submitters, tokenFields: form.tokenFields },
      ...extra,
    });
  }

  const HTML = `<form id="f" method="post" action="/submit">
    <input type="email" name="email">
    <input type="email" name="emails" multiple>
    <input type="number" name="qty" min="0" max="1" step="0.25">
    <input type="number" name="big" min="1" max="2" step="5">
    <input type="number" name="dec" step="0.1">
    <input type="date" name="day" step="7" min="2026-01-01">
    <input type="time" name="at" min="09:00" max="17:00">
    <input type="time" name="slot" step="900">
    <input type="datetime-local" name="when" min="2026-01-01T00:00">
    <input type="month" name="month" min="2026-01">
    <input type="week" name="week" min="2026-W05">
    <input type="url" name="site">
    <input type="text" name="code" pattern="[a-z]+" title="letters">
    <input type="text" name="unicode" pattern="\\p{L}+">
    <textarea name="note" maxlength="3"></textarea>
    <input type="radio" name="size" value="s" required><input type="radio" name="size" value="m">
    <input type="checkbox" name="tags" value="a"><input type="checkbox" name="tags" value="b" required>
    <input type="file" name="doc" required>
    <input type="hidden" name="h" value="1">
    <button name="go" value="1">Go</button>
  </form>`;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-ts-units-'));
    const endpoint = formEndpoint(HTML);
    const model = ExportModel.model([endpoint]);
    mod = await load(dir, 'units.ts', new TypeScriptExporter().export(model).content);
    Client = mod.ShopExampleComClient as typeof Client;
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('the generated client for every input type compiles with tsc --strict', async () => {
    const compiled = await tsc(dir, ['units.ts']);
    assert.equal(compiled.output, '');
    assert.equal(compiled.code, 0);
  });

  test('validation messages for email, number steps, dates, times, patterns and groups', () => {
    const validate = validator(mod, 'validateSubmitForm');
    const base = { size: 's', tags: ['b'], doc: new File(['x'], 'x.txt') };
    assert.deepEqual(validate(base), []);
    const cases: [Record<string, unknown>, string, string][] = [
      [{ email: 'abc' }, 'email', "Please include an '@' in the email address. 'abc' is missing an '@'."],
      [{ email: '@x.com' }, 'email', "Please enter a part followed by '@'. '@x.com' is incomplete."],
      [{ email: 'a,b@x.com' }, 'email', "A part followed by '@' should not contain the symbol ','."],
      [{ email: 'a@x,y.com' }, 'email', "A part following '@' should not contain the symbol ','."],
      [{ email: 'a@.x.com' }, 'email', "'.' is used at a wrong position in '.x.com'."],
      [{ email: 'a@@x.com' }, 'email', "A part following '@' should not contain the symbol '@'."],
      [{ email: 'a@-x.com' }, 'email', 'Please enter an email address.'],
      [{ emails: 'a@x.com,' }, 'emails', 'Please enter a non-empty email address.'],
      [{ emails: 'a@x.com,bad' }, 'emails', "Please include an '@' in the email address. 'bad' is missing an '@'."],
      [{ qty: 0.3 }, 'qty', 'Please enter a valid value. The two nearest valid values are 0.25 and 0.5.'],
      [{ qty: 0.9 }, 'qty', 'Please enter a valid value. The two nearest valid values are 0.75 and 1.'],
      [{ qty: 2 }, 'qty', 'Value must be less than or equal to 1.'],
      [{ qty: 'abc' }, 'qty', 'Please enter a number.'],
      [{ big: 1.5 }, 'big', 'Please enter a valid value. The nearest valid value is 1.'],
      [{ dec: 0.35 }, 'dec', 'Please enter a valid value. The two nearest valid values are 0.3 and 0.4.'],
      [{ day: '2026-01-03' }, 'day', 'Please enter a valid value. The two nearest valid values are 01/01/2026 and 01/08/2026.'],
      [{ day: '2026-02-30' }, 'day', 'Please enter a valid value. The field is incomplete or has an invalid date.'],
      [{ at: '08:00' }, 'at', 'Value must be 9:00 AM or later.'],
      [{ at: '18:30' }, 'at', 'Value must be 5:00 PM or earlier.'],
      [{ slot: '10:10' }, 'slot', 'Please enter a valid value. The two nearest valid values are 10:00 AM and 10:15 AM.'],
      [{ when: '2025-01-01T10:00' }, 'when', 'Value must be 01/01/2026, 12:00 AM or later.'],
      [{ month: '2025-05' }, 'month', 'Value must be 2026-01 or later.'],
      [{ week: '2026-W01' }, 'week', 'Value must be Week 05, 2026 or later.'],
      [{ site: 'nope' }, 'site', 'Please enter a URL.'],
      [{ code: 'ABC' }, 'code', 'Please match the requested format.'],
      [{ unicode: '123' }, 'unicode', 'Please match the requested format.'],
      [{ note: 'abcd' }, 'note', 'Please shorten this text to 3 characters or less (you are currently using 4 characters).'],
      [{ size: undefined }, 'size', 'Please select one of these options.'],
      [{ size: 'xl' }, 'size', "'xl' is not one of the options: s, m."],
      [{ tags: ['a'] }, 'tags', 'Please check this box if you want to proceed.'],
      [{ doc: undefined }, 'doc', 'Please select a file.'],
    ];
    for (const [input, field, message] of cases) {
      const errors = validate({ ...base, ...input });
      assert.deepEqual(errors.map((e) => [e.field, e.message]), [[field, message]], JSON.stringify(input));
    }
    assert.deepEqual(validate({ ...base, emails: ' a@x.com , b@y.org ', unicode: '\u00e9t\u00e9', note: 'a\r\nb', code: 'abc', qty: '0.75', dec: 0.3 }), []);
  });

  test('form entries are encoded like a browser submission', async () => {
    const seen: { body: unknown; headers: Headers; url: string }[] = [];
    const client = new Client({
      baseUrl: 'https://shop.example.com',
      validate: false,
      fetch: async (input: string, init: RequestInit) => {
        seen.push({ body: init.body, headers: new Headers(init.headers), url: input });
        return new Response(null, { status: 204 });
      },
    });
    const response = await call(client, 'submitForm', { body: { email: 'a@b.c', note: 'one\ntwo', tags: ['a', 'b'], extra: 'z' } });
    assert.equal(response.status, 204);
    assert.equal(response.data, undefined);
    const sent = seen[0];
    assert.equal(sent?.headers.get('content-type'), 'application/x-www-form-urlencoded');
    assert.equal(sent?.headers.get('referer'), 'https://shop.example.com/form');
    assert.equal(sent?.headers.get('origin'), 'https://shop.example.com');
    assert.equal(
      sent?.body,
      'email=a%40b.c&emails=&qty=&big=&dec=&day=&at=&slot=&when=&month=&week=&site=&code=&unicode=&note=one%0D%0Atwo&tags=a&tags=b&doc=&h=1&go=1&extra=z',
    );
  });
});

describe('CookieJar of the generated client', () => {
  let Jar: new (registrableDomain?: (host: string) => string | undefined) => CookieJarShape;
  let dir: string;
  const NOW = Date.parse('2026-06-01T00:00:00Z');

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'appii-ts-jar-'));
    const mod = await load(dir, 'jar.ts', new TypeScriptExporter().export(ExportModel.model([])).content);
    Jar = mod.CookieJar as typeof Jar;
  });

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  test('a client generated from an empty model compiles with tsc --strict', async () => {
    const compiled = await tsc(dir, ['jar.ts']);
    assert.equal(compiled.output, '');
    assert.equal(compiled.code, 0);
  });

  test('domain, path, secure, expiry and ordering rules', () => {
    const jar = new Jar(Http.registrableDomain);
    const url = 'https://www.example.com/app/page';
    assert.equal(jar.set('sid=1; Path=/', url, NOW), true);
    assert.equal(jar.set('pref=a', url, NOW), true);
    assert.equal(jar.set('wide=1; Domain=.example.com; Path=/', url, NOW), true);
    assert.equal(jar.set('deep=1; Path=/app/page/x', url, NOW), true);
    assert.equal(jar.set('other=1; Domain=other.com', url, NOW), false);
    assert.equal(jar.set('tld=1; Domain=com', url, NOW), false);
    assert.equal(jar.set('sec=1; Secure; Path=/', url, NOW), true);
    assert.equal(jar.set('short=1; Max-Age=60; Expires=Wed, 01 Jan 2031 00:00:00 GMT', url, NOW), true);
    assert.equal(jar.set('old=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', url, NOW), true);
    assert.equal(jar.header('https://www.example.com/app/page/x/y', NOW), 'deep=1; pref=a; short=1; sid=1; wide=1; sec=1');
    assert.equal(jar.header('http://api.example.com/', NOW), 'wide=1');
    assert.equal(jar.header('https://www.example.com/', NOW), 'sid=1; wide=1; sec=1');
    assert.equal(jar.header('https://www.example.com/app', NOW + 61_000), 'pref=a; sid=1; wide=1; sec=1');
    assert.equal(jar.header('https://www.example.com/application', NOW), 'sid=1; wide=1; sec=1');
    assert.equal(jar.set('sid=; Max-Age=0; Path=/', url, NOW), true);
    assert.equal(jar.get('sid', url, NOW), undefined);
    assert.equal(jar.get('pref', undefined, NOW), 'a');
  });

  test('secure origins, prefixes, SameSite=None and leave-secure-cookies-alone', () => {
    const jar = new Jar();
    assert.equal(jar.set('a=1; Secure', 'http://example.com/', NOW), false);
    assert.equal(jar.set('a=1; Secure', 'http://localhost:3000/', NOW), true);
    assert.equal(jar.set('b=1; Secure', 'http://127.0.0.1/', NOW), true);
    assert.equal(jar.set('c=1; SameSite=None', 'https://example.com/', NOW), false);
    assert.equal(jar.set('__Secure-x=1', 'https://example.com/', NOW), false);
    assert.equal(jar.set('__Secure-x=1; Secure', 'https://example.com/', NOW), true);
    assert.equal(jar.set('__Host-y=1; Secure; Path=/; Domain=example.com', 'https://example.com/', NOW), false);
    assert.equal(jar.set('__Host-y=1; Secure; Path=/', 'https://example.com/', NOW), true);
    assert.equal(jar.set('s=1; Secure; Path=/', 'https://example.com/', NOW), true);
    assert.equal(jar.set('s=2; Path=/', 'http://example.com/', NOW), false);
    assert.equal(jar.set('ip=1; Domain=10.0.0.1', 'http://10.0.0.1/', NOW), true);
    assert.equal(jar.header('http://10.0.0.1/', NOW), 'ip=1');
    assert.equal(jar.set('bad\u0001=1', 'https://example.com/', NOW), false);
    assert.equal(jar.set('=', 'https://example.com/', NOW), false);
  });

  test('cookie dates follow the RFC 6265 algorithm', () => {
    const jar = new Jar();
    const at = (expires: string): number | undefined => {
      jar.clear();
      jar.set(`d=1; Expires=${expires}`, 'https://example.com/', NOW);
      return jar.list(NOW)[0]?.expires as number | undefined;
    };
    assert.equal(at('Wed, 21 Oct 2026 07:28:00 GMT'), Date.parse('2026-10-21T07:28:00Z'));
    assert.equal(at('Wednesday, 21-Oct-26 07:28:00 GMT'), Date.parse('2026-10-21T07:28:00Z'));
    assert.equal(at('21 Oct 2026 7:8:0'), Date.parse('2026-10-21T07:08:00Z'));
    assert.equal(at('Feb 30 2027 00:00:00'), undefined);
    assert.equal(at('Wed, 21 Oct 2031 07:28:00 GMT'), NOW + 34560000 * 1000);
  });
});

describe('TsTypeWriter', () => {
  const writer = new TsTypeWriter();

  test('objects with optional and required members, nested arrays and safe keys', () => {
    const schema = {
      type: 'object',
      properties: {
        id: { type: 'integer' },
        'first-name': { type: 'string' },
        tags: { type: 'array', items: { type: 'string' } },
        meta: { type: 'object', properties: { a: { type: 'boolean' } }, required: ['a'] },
      },
      required: ['id'],
    };
    assert.equal(
      writer.declaration('Item', schema),
      'export interface Item {\n  id: number;\n  "first-name"?: string;\n  tags?: string[];\n  meta?: {\n    a: boolean;\n  };\n}',
    );
  });

  test('enums, consts, unions, nullable, tuples, intersections and fallbacks', () => {
    assert.equal(writer.type({ enum: ['a', 1, true, null] }), '"a" | 1 | true | null');
    assert.equal(writer.type({ const: 'x\u00e9' }), '"x\\u00e9"');
    assert.equal(writer.type({ type: ['string', 'null'] }), 'string | null');
    assert.equal(writer.type({ type: 'string', nullable: true }), 'string | null');
    assert.equal(writer.type({ type: 'array', items: { type: ['string', 'number'] } }), '(string | number)[]');
    assert.equal(writer.type({ anyOf: [{ type: 'string' }, { type: 'integer' }] }), 'string | number');
    assert.equal(writer.type({ oneOf: [{ type: 'string' }, {}] }), 'unknown');
    assert.equal(writer.type({ allOf: [{ type: 'object', properties: { a: { type: 'string' } } }, { type: 'object', properties: { b: { type: 'number' } } }] }), '{\n  a?: string;\n} & {\n  b?: number;\n}');
    assert.equal(writer.type({ type: 'array', prefixItems: [{ type: 'string' }, { type: 'number' }], items: false }), '[string, number]');
    assert.equal(writer.type({ type: 'string', format: 'binary' }), 'Blob');
    assert.equal(writer.type({ type: 'object' }), 'Record<string, unknown>');
    assert.equal(writer.type({ type: 'object', additionalProperties: { type: 'integer' } }), 'Record<string, number>');
    assert.equal(writer.type({ type: 'object', properties: { a: { type: 'string' } }, additionalProperties: true }), '{\n  a?: string;\n  [key: string]: unknown;\n}');
    assert.equal(writer.type(undefined), 'unknown');
    assert.equal(writer.type({}), 'unknown');
    assert.equal(writer.type({ enum: [] }), 'never');
    assert.equal(writer.declaration('Name', { type: 'string' }), 'export type Name = string;');
    assert.equal(new TsTypeWriter({ maxDepth: 1 }).type({ type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'string' } } } } } } }), '{\n  a?: {\n    b?: unknown;\n  };\n}');
  });
});
