import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { ApiModel, Endpoint, JsonSchema } from '../src/model/index.js';
import { EndpointFilter, EndpointFormatter, SchemaTree, ShellFolder } from '../src/present/index.js';
import { Ansi, EndpointIndex, isAppiiError } from '../src/shared/index.js';
import { PresentModels } from './helpers/present-models.js';

const badInput = (err: unknown) => isAppiiError(err) && err.code === 'BAD_INPUT';
const FIXTURE: ApiModel = PresentModels.fixture();
const MIXED: ApiModel = PresentModels.mixed();
const byId = (model: ApiModel, id: string): Endpoint => {
  const found = model.endpoints.find((endpoint) => endpoint.id === id);
  assert.ok(found, id);
  return found;
};

describe('SchemaTree', () => {
  const tree = new SchemaTree();

  test('flattens nested objects and arrays of objects with dotted and [] paths', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: {
        items: { type: 'array', items: { type: 'object', properties: { id: { type: 'integer' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['id'] } },
        meta: { type: 'object', properties: { total: { type: 'integer', minimum: 0 } } },
      },
      required: ['items'],
    };
    assert.deepEqual(tree.rows(schema), [
      { path: 'items', type: 'array<object>', required: true, constraints: '' },
      { path: 'items[].id', type: 'integer', required: true, constraints: '' },
      { path: 'items[].tags', type: 'array<string>', required: false, constraints: '' },
      { path: 'meta', type: 'object', required: false, constraints: '' },
      { path: 'meta.total', type: 'integer', required: false, constraints: 'range 0..' },
    ]);
  });

  test('root arrays and scalars get a (root) row; undefined gives no rows', () => {
    const rows = tree.rows({ type: 'array', items: { type: 'object', properties: { a: { type: 'string' } } } });
    assert.deepEqual(rows.map((row) => row.path), ['(root)', '[].a']);
    assert.equal(rows[0]?.type, 'array<object>');
    assert.deepEqual(tree.rows({ type: 'string', format: 'email' }), [{ path: '(root)', type: 'string(email)', required: true, constraints: 'format email' }]);
    assert.deepEqual(tree.rows({}), [{ path: '(root)', type: 'any', required: true, constraints: '' }]);
    assert.deepEqual(tree.rows(undefined), []);
    assert.deepEqual(tree.rows({ type: 'array', items: { type: 'array', items: { type: 'object', properties: { x: { type: 'number' } } } } }).map((row) => row.path), ['(root)', '[][].x']);
  });

  test('shows constrained scalar items, maps, defaults, refs and HTML constraints', () => {
    const rows = tree.rows({
      type: 'object',
      properties: {
        interests: { type: 'array', items: { type: 'string', enum: ['a', 'b'] }, default: ['a'] },
        plain: { type: 'array', items: { type: 'string' } },
        byId: { type: 'object', additionalProperties: { type: 'object', properties: { n: { type: 'integer' } } } },
        age: { type: 'integer', 'x-html-type': 'number', 'x-html-min': '13', 'x-html-max': '120', 'x-html-step': '1' },
        linked: { $ref: '#/components/schemas/Thing' },
        terms: { type: 'string', const: 'on', default: 'on' },
      },
    });
    const get = (path: string) => rows.find((row) => row.path === path);
    assert.deepEqual(get('interests[]'), { path: 'interests[]', type: 'enum(2)', required: false, constraints: 'one of a|b' });
    assert.equal(get('interests')?.constraints, 'default ["a"]');
    assert.equal(get('plain[]'), undefined);
    assert.equal(get('byId.*')?.type, 'object');
    assert.equal(get('byId.*.n')?.type, 'integer');
    assert.equal(get('age')?.constraints, 'html number, range 13..120, step 1');
    assert.equal(get('linked')?.constraints, 'ref #/components/schemas/Thing');
    assert.equal(get('terms')?.constraints, 'always on');
  });

  test('quotes keys that would make paths ambiguous', () => {
    const rows = tree.rows({ type: 'object', properties: { 'a.b': { type: 'string' }, 'user[name]': { type: 'string' }, '': { type: 'string' }, 'with space': { type: 'object', properties: { x: { type: 'string' } } } } });
    assert.deepEqual(rows.map((row) => row.path), ['["a.b"]', 'user[name]', '[""]', '["with space"]', '["with space"].x']);
    assert.equal(SchemaTree.join('', 'a'), 'a');
    assert.equal(SchemaTree.join('x', 'a*'), 'x["a*"]');
  });

  test('merges object variants without duplicating paths and keeps the parent required set', () => {
    const rows = tree.rows({
      type: 'object',
      required: ['id'],
      anyOf: [
        { type: 'object', properties: { id: { type: 'string' }, a: { type: 'integer' } }, required: ['a'] },
        { type: 'object', properties: { id: { type: 'integer' }, b: { type: 'boolean' } } },
      ],
    });
    assert.deepEqual(
      rows.map((row) => [row.path, row.type, row.required]),
      [
        ['id', 'string', true],
        ['a', 'integer', false],
        ['b', 'boolean', false],
      ],
    );
  });

  test('stops at maxDepth and annotates the truncated node', () => {
    const deep: JsonSchema = { type: 'object', properties: { a: { type: 'object', properties: { b: { type: 'object', properties: { c: { type: 'string' }, d: { type: 'string' } } } } } } };
    assert.deepEqual(new SchemaTree({ maxDepth: 2 }).rows(deep), [
      { path: 'a', type: 'object', required: false, constraints: '' },
      { path: 'a.b', type: 'object', required: false, constraints: '+2 nested' },
    ]);
    assert.equal(new SchemaTree({ maxDepth: 1 }).rows({ type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } } } } } })[0]?.constraints, '+1 nested');
    assert.equal(new SchemaTree({ maxDepth: 2 }).rows({ type: 'object', properties: { list: { type: 'array', items: { type: 'object', properties: { x: { type: 'string' } } } } } })[1]?.path, 'list[].x');
    assert.throws(() => new SchemaTree({ maxDepth: 0 }), badInput);
    assert.throws(() => new SchemaTree({ maxDepth: 1.5 }), badInput);
  });

  test('survives cyclic in-memory schemas', () => {
    const node: JsonSchema = { type: 'object', properties: {} };
    (node.properties as Record<string, JsonSchema>).self = node;
    const variant: JsonSchema = { type: 'object', properties: { a: { type: 'string' } } };
    variant.anyOf = [variant];
    assert.ok(tree.rows(node).length <= SchemaTree.DEFAULT_MAX_DEPTH + 1);
    assert.deepEqual(tree.rows(variant).map((row) => row.path), ['a']);
  });

  test('branches describe each conditional submission of the real signup form', () => {
    const branches = tree.branches(byId(FIXTURE, 'post-signup').requestBody?.schema);
    assert.deepEqual(
      branches.map((branch) => [branch.condition, branch.label, branch.requires, branch.excluded, branch.noValidate]),
      [
        ['intent=create', 'Create', ['username', 'email', 'country', 'terms'], [], false],
        ['intent=draft', 'Save draft', [], [], true],
      ],
    );
    const create = branches[0]?.rows ?? [];
    assert.deepEqual(create.map((row) => [row.path, row.type, row.required]), [
      ['username', 'string', true],
      ['email', 'string', true],
      ['age', 'integer|empty', false],
      ['country', 'enum(2)', true],
    ]);
    assert.deepEqual(branches[1]?.rows.map((row) => [row.path, row.constraints]), [['country', 'one of ""|us|ca, default ""']]);
    assert.deepEqual(tree.branches({ type: 'object', properties: { a: { type: 'string' } } }), []);
    assert.deepEqual(tree.branches(undefined), []);
  });

  test('exclusive submitter names are grouped as alternatives', () => {
    const schema: JsonSchema = {
      type: 'object',
      properties: { title: { type: 'string' }, _save: { const: 'Save' }, _more: { const: 'More' }, _go: { const: 'Go' } },
      required: ['title'],
      if: { required: ['_save'], properties: { _save: { const: 'Save' } } },
      then: { required: ['title', '_save'], properties: { _more: false, _go: false } },
      else: {
        if: { required: ['_more'], properties: { _more: { const: 'More' } } },
        then: { required: ['title', '_more'], properties: { _save: false, _go: false } },
      },
    };
    assert.deepEqual(SchemaTree.alternatives(schema), [['_save', '_more', '_go']]);
    assert.deepEqual(SchemaTree.fieldNames(schema), ['title', '_save|_more|_go']);
    assert.deepEqual(tree.branches(schema).map((branch) => branch.excluded), [['_more', '_go'], ['_save', '_go']]);
    assert.deepEqual(SchemaTree.fieldNames(byId(FIXTURE, 'post-signup').requestBody?.schema).slice(0, 3), ['username', 'email', 'age']);
  });

  test('renders the real multipart signup form schema with its HTML rules', () => {
    const rows = tree.rows(byId(FIXTURE, 'post-signup').requestBody?.schema);
    const get = (path: string) => rows.find((row) => row.path === path);
    assert.equal(get('username')?.required, false);
    assert.deepEqual(get('username')?.requiredWhen, ['intent=create']);
    assert.equal(get('intent')?.required, true);
    assert.equal(get('intent')?.requiredWhen, undefined);
    assert.match(get('username')?.constraints ?? '', /pattern \[a-z0-9_\]\{3,16\}/);
    assert.match(get('age')?.constraints ?? '', /range 13\.\.120, step 1/);
    assert.equal(get('age')?.requiredWhen, undefined);
    assert.equal(get('country')?.type, 'enum(3)');
    assert.match(get('country')?.constraints ?? '', /one of us\|ca\|""/);
    assert.equal(get('interests[]')?.constraints, 'one of a|b|c');
    assert.match(get('bio')?.constraints ?? '', /length 0\.\.200/);
    assert.equal(get('avatar')?.type, 'string(binary)');
  });
});

describe('EndpointFilter', () => {
  const numbers = (model: ApiModel, filter: EndpointFilter) => filter.apply(model).map((endpoint) => EndpointIndex.of(model).numberOf(endpoint));

  test('an empty filter is inactive and keeps every endpoint in model order', () => {
    const filter = new EndpointFilter();
    assert.equal(filter.active, false);
    assert.deepEqual(numbers(FIXTURE, filter), FIXTURE.endpoints.map((_, i) => i + 1));
    assert.deepEqual(filter.describe(), []);
    assert.equal(new EndpointFilter({ text: '  ', method: ' , ', kind: [] }).active, false);
  });

  test('method accepts comma or space separated lists, case-insensitively', () => {
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ method: 'post' })), [4, 7, 9, 12]);
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ method: 'delete, post' })), [4, 7, 9, 12]);
    assert.deepEqual(numbers(MIXED, new EndpointFilter({ method: 'DELETE GET' })).length, 5);
  });

  test('text terms match only the documented fields: method, path, name, id or GraphQL operation', () => {
    assert.equal(EndpointFilter.textFields(), 'method, path, name, id or GraphQL operation');
    assert.deepEqual(EndpointFilter.TEXT_FIELDS.map(([label]) => label), ['method', 'path', 'name', 'id', 'GraphQL operation']);
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ text: 'document' })), []);
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ text: 'https' })), []);
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ text: 'shop.example.com' })), []);
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ text: 'post-signup' })), [12]);
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ text: 'postlogin' })), [9]);
    const graphql = byId(FIXTURE, 'post-graphql-getitem');
    assert.equal(new EndpointFilter({ text: 'GetItem graphql' }).matches(graphql), true);
    assert.equal(new EndpointFilter({ text: 'GetItem' }).matches({ ...graphql, name: 'x', id: 'y' }), true);
  });

  test('text terms must all match id, name, key, path or operation', () => {
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ text: 'items' })), [3, 4, 5]);
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ text: 'ITEMS post' })), [4]);
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ text: 'getitem' })), [5, 7]);
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ text: '{itemid}' })), [5]);
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ text: 'nothing-matches-this' })), []);
  });

  test('origin matches a full origin, a host, a host with port, ignoring case and trailing slashes', () => {
    const third = byId(MIXED, 'post-v2-collect');
    assert.equal(new EndpointFilter({ origin: 'https://COLLECT.tracker.net/' }).matches(third), true);
    assert.equal(new EndpointFilter({ origin: 'collect.tracker.net' }).matches(third), true);
    assert.equal(new EndpointFilter({ origin: 'http://collect.tracker.net' }).matches(third), false);
    assert.equal(new EndpointFilter({ origin: 'tracker.net' }).matches(third), false);
    assert.equal(new EndpointFilter({ origin: 'app.example.org' }).apply(MIXED).length, 6);
    const local = { ...third, origin: 'http://localhost:3000' };
    assert.equal(new EndpointFilter({ origin: 'localhost:3000' }).matches(local), true);
    assert.equal(new EndpointFilter({ origin: 'localhost' }).matches(local), true);
    assert.equal(new EndpointFilter({ origin: 'localhost:4000' }).matches(local), false);
    assert.equal(new EndpointFilter({ origin: 'http://localhost:3000/path' }).matches(local), true);
    assert.deepEqual(EndpointFilter.originMatcher(' Example.COM/ '), { hostname: 'example.com' });
    assert.deepEqual(EndpointFilter.originMatcher('B\u00fccher.example'), { hostname: 'xn--bcher-kva.example' });
    assert.deepEqual(EndpointFilter.originMatcher('[::1]:8080'), { hostname: '[::1]', port: 8080 });
    assert.deepEqual(EndpointFilter.originMatcher('example.com:443'), { hostname: 'example.com', port: 443 });
    assert.deepEqual(EndpointFilter.originMatcher('example.com:80'), { hostname: 'example.com', port: 80 });
    assert.deepEqual(EndpointFilter.originMatcher('example.com/some/path'), { hostname: 'example.com/some/path' });
    assert.deepEqual(EndpointFilter.originMatcher('HTTPS://B\u00fccher.example:443/x'), { origin: 'https://xn--bcher-kva.example' });
    assert.deepEqual(EndpointFilter.originMatcher('ftp://files.example/'), { origin: 'ftp://files.example' });
    const idn = { ...third, origin: 'https://xn--bcher-kva.example' };
    assert.equal(new EndpointFilter({ origin: 'b\u00fccher.example' }).matches(idn), true);
    const ipv6 = { ...third, origin: 'http://[::1]:8080' };
    assert.equal(new EndpointFilter({ origin: '[::1]:8080' }).matches(ipv6), true);
    assert.equal(new EndpointFilter({ origin: '[::1]' }).matches(ipv6), true);
    assert.equal(EndpointFilter.originMatcher(''), undefined);
  });

  test('a host with a port matches the effective port of the origin, also the default port of its scheme', () => {
    const third = byId(MIXED, 'post-v2-collect');
    const at = (origin: string) => ({ ...third, origin });
    const matches = (filter: string, origin: string) => new EndpointFilter({ origin: filter }).matches(at(origin));
    assert.equal(matches('example.com:443', 'https://example.com'), true);
    assert.equal(matches('example.com:443', 'http://example.com'), false);
    assert.equal(matches('example.com:443', 'http://example.com:443'), true);
    assert.equal(matches('example.com:80', 'http://example.com'), true);
    assert.equal(matches('example.com:80', 'https://example.com'), false);
    assert.equal(matches('example.com', 'https://example.com'), true);
    assert.equal(matches('example.com', 'http://example.com:8080'), true);
    assert.equal(matches('example.com:8080', 'https://example.com'), false);
    assert.equal(matches('EXAMPLE.com:0443/', 'https://example.com'), true);
    assert.equal(matches('[::1]:443', 'https://[::1]'), true);
    assert.deepEqual(new EndpointFilter({ origin: 'example.com:443' }).describe(), ['origin example.com:443']);
  });

  test('cookies() keeps the cookies that the matching endpoints set or use, and names only those endpoints', () => {
    assert.equal(new EndpointFilter().cookies(FIXTURE), FIXTURE.cookies);
    const filter = new EndpointFilter({ text: 'post-login' });
    const login = filter.cookies(FIXTURE);
    assert.ok(login.length > 0 && login.length < FIXTURE.cookies.length);
    assert.ok(login.every((cookie) => cookie.setBy.includes('post-login') || cookie.usedBy.includes('post-login')));
    assert.ok(login.every((cookie) => [...cookie.setBy, ...cookie.usedBy].every((id) => id === 'post-login')));
    assert.deepEqual(login, EndpointIndex.subset(FIXTURE, filter.apply(FIXTURE)).cookies);
    assert.deepEqual(new EndpointFilter({ origin: 'nowhere.test' }).cookies(FIXTURE), []);
  });

  test('cookies() includes the cookies that a browser would send to a form that was never submitted (count 0)', () => {
    const signup = FIXTURE.endpoints.find((endpoint) => endpoint.id === 'post-signup');
    assert.equal(signup?.count, 0);
    const cookies = new EndpointFilter({ text: 'post-signup' }).cookies(FIXTURE);
    assert.deepEqual(cookies.map((cookie) => [cookie.name, cookie.usedBy]), [...(signup?.auth.cookies ?? [])].sort().map((name) => [name, ['post-signup']]));
    const unlinked = { ...FIXTURE, cookies: FIXTURE.cookies.map((cookie) => ({ ...cookie, setBy: [], usedBy: [] })) };
    assert.deepEqual(new EndpointFilter({ text: 'post-signup' }).cookies(unlinked).map((cookie) => cookie.name), [...(signup?.auth.cookies ?? [])].sort());
  });

  test('cookies() does not take a cookie of the same name that only other endpoints use', () => {
    const other = { ...FIXTURE.cookies.find((cookie) => cookie.name === 'sid')!, domain: 'other.example.net', setBy: [], usedBy: ['get-root'] };
    const model = { ...FIXTURE, cookies: [...FIXTURE.cookies, other] };
    const cookies = new EndpointFilter({ text: 'post-login' }).cookies(model);
    assert.deepEqual(cookies.filter((cookie) => cookie.name === 'sid').map((cookie) => cookie.domain), ['shop.example.com']);
  });

  test('kind and firstPartyOnly restrict the selection', () => {
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ kind: ['form'] })), [9, 10, 12]);
    assert.deepEqual(numbers(FIXTURE, new EndpointFilter({ kind: ['graphql', 'json'] })), [3, 4, 5, 7]);
    assert.deepEqual(numbers(MIXED, new EndpointFilter({ firstPartyOnly: true })), [1, 2, 3, 4, 5, 6]);
    const filter = new EndpointFilter({ method: 'get', kind: ['json'], origin: 'x.test', text: 'a b', firstPartyOnly: true });
    assert.equal(filter.active, true);
    assert.deepEqual(filter.describe(), ['method GET', 'kind json', 'origin x.test', 'text "a b"', 'first-party only']);
  });
});

describe('ShellFolder', () => {
  const run = (script: string, env: Record<string, string> = {}) =>
    execFileSync('sh', ['-c', script.replace(/^curl\b/, "printf '<%s>\\n'")], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } }).toString();
  const env = { TOKEN: 'a b$c', SID: 'xyz' };
  const commands = [
    `curl -sS -X POST 'https://shop.example.com/api/items?page=1&limit=2&very_long_parameter_name=some_long_value' \\\n  -H "x-csrf-token: \${TOKEN}" \\\n  -b "sid=\${SID}; theme=\${THEME}" \\\n  --data-raw '{"name":"Thing","description":"it'\\''s a \\"quoted\\" value with \\\\ backslashes"}'`,
    `curl -sS 'https://example.com/upload' \\\n  -F 'bio=Hello\nworld, this line keeps going well past the width of a narrow terminal' \\\n  -F 'empty=' -F '' -F "" \\\n  -F 'avatar=@file.bin'`,
    `curl "\${TOKEN}"x'y'"\$SID"\\ z 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'`,
    `curl --data-raw "a long double quoted value that contains \\"escapes\\" and \\$dollars and \\\`ticks\\\` repeated to be long enough"`,
  ];

  test('folds commands so every line fits and the shell sees exactly the same arguments', () => {
    const folder = new ShellFolder();
    for (const command of commands) {
      const expected = run(command, env);
      for (const width of [12, 16, 20, 24, 30, 40, 60, 80, 100, 160]) {
        const folded = folder.fold(command, width);
        assert.ok(
          folded.every((line) => line.length <= width),
          `width ${width}: ${folded.find((line) => line.length > width)}`,
        );
        assert.equal(run(folded.join('\n'), env), expected, `width ${width}\n${folded.join('\n')}`);
      }
    }
  });

  test('keeps short groups intact and preserves their indentation', () => {
    const command = "curl -sS 'https://a.test/' \\\n  -H 'x: 1' \\\n  -H 'y: 2'";
    assert.deepEqual(new ShellFolder().fold(command, 80), ["curl -sS 'https://a.test/' \\", "  -H 'x: 1' \\", "  -H 'y: 2'"]);
    const wrapped = new ShellFolder({ indent: 4 }).fold("curl -sS -X POST --compressed --location 'https://a.test/'", 30);
    assert.match(wrapped[1] ?? '', /^ {4}\S/);
  });

  test('splits inside quotes by closing, continuing and reopening at column 0', () => {
    const folded = new ShellFolder().fold(`curl '${'x'.repeat(50)}'`, 20);
    assert.ok(folded.length > 2);
    assert.match(folded[0]!, /'\\$/);
    assert.match(folded[1]!, /^'/);
  });

  test('parse understands quoting and continuations; unparseable input falls back to its lines', () => {
    const groups = ShellFolder.parse(`a 'b c' "d \${E}" f\\ g \\\n  h`);
    assert.ok(groups);
    assert.equal(groups.length, 2);
    assert.equal(groups[0]?.continued, true);
    assert.equal(groups[1]?.indent, 2);
    assert.deepEqual(groups[0]?.words.map((word) => ShellFolder.render(word)), ['a', "'b c'", '"d ${E}"', 'f\\ g']);
    assert.equal(ShellFolder.parse("curl 'unterminated"), undefined);
    assert.equal(ShellFolder.parse('curl "$(date)"'), undefined);
    assert.deepEqual(ShellFolder.parse("curl $'a\\nb\\'c'")?.[0]?.words[1], [{ text: "$'a\\nb\\'c'", quote: '' }]);
    assert.equal(ShellFolder.parse("curl $'unterminated"), undefined);
    assert.equal(ShellFolder.parse(`curl "$'x'"`), undefined);
    assert.equal(ShellFolder.parse('curl x # a comment'), undefined);
    assert.ok(ShellFolder.parse('curl x#y'));
    assert.deepEqual(ShellFolder.parse('curl "${A:-${B}}"')?.[0]?.words[1], [{ text: '${A:-${B}}', quote: '"' }]);
    assert.equal(ShellFolder.parse('curl "${A:-${B}"'), undefined);
    assert.deepEqual(new ShellFolder().fold("curl 'unterminated\nsecond", 10), ["curl 'unterminated", 'second']);
    assert.deepEqual(new ShellFolder().fold('', 10), ['']);
  });

  test('very narrow widths leave groups unfolded and invalid options are rejected', () => {
    assert.deepEqual(new ShellFolder().fold("curl 'abc' \\\n  -H 'x'", 5), ["curl 'abc' \\", "  -H 'x'"]);
    assert.throws(() => new ShellFolder({ indent: -1 }), badInput);
    assert.throws(() => new ShellFolder().fold('curl', 0), badInput);
  });
});

describe('EndpointFormatter', () => {
  const plain = new EndpointFormatter();
  const color = new EndpointFormatter(Ansi.color);

  test('paths highlight {params} and append GraphQL operations', () => {
    assert.equal(plain.path(byId(FIXTURE, 'get-api-items-itemid')), '/api/items/{itemId}');
    assert.equal(color.path(byId(FIXTURE, 'get-api-items-itemid')), `/api/items/${Ansi.color.cyan('{itemId}')}`);
    assert.equal(plain.path(byId(FIXTURE, 'post-graphql-getitem')), '/graphql#GetItem');
    assert.equal(plain.url(byId(FIXTURE, 'get-root')), 'https://shop.example.com/');
    assert.equal(color.method(byId(FIXTURE, 'post-api-items')), Ansi.color.yellow('POST'));
  });

  test('query names mark required params and body summaries list up to three fields', () => {
    assert.equal(plain.query(byId(FIXTURE, 'get-api-items')), 'page*, limit*');
    assert.equal(plain.query(byId(FIXTURE, 'post-signup')), 'draft');
    assert.equal(plain.body(byId(FIXTURE, 'post-api-items')), 'json: name, price');
    assert.equal(plain.body(byId(FIXTURE, 'post-login')), 'form: csrf_token, email, password +2');
    assert.equal(plain.body(byId(FIXTURE, 'post-signup')), 'multipart: username, email, age +10');
    assert.equal(plain.body(byId(FIXTURE, 'post-graphql-getitem')), 'graphql: $id');
    assert.equal(plain.body(byId(FIXTURE, 'get-root')), '');
    const arrayBody = { ...byId(FIXTURE, 'post-api-items'), requestBody: { kind: 'json' as const, mimeType: 'application/json', schema: { type: 'array', items: { type: 'integer' } }, examples: [] } };
    assert.equal(plain.body(arrayBody), 'json: array<integer>');
    const unknown = { ...arrayBody, requestBody: { kind: 'binary' as const, mimeType: 'application/octet-stream', examples: [] } };
    assert.equal(plain.body(unknown), 'binary');
  });

  test('statuses are distinct and sorted; auth labels follow a fixed order', () => {
    assert.deepEqual(EndpointIndex.statuses(byId(FIXTURE, 'post-api-items')), [201, 400]);
    assert.equal(plain.statuses(byId(FIXTURE, 'get-api-items-itemid')), '200 404');
    assert.equal(color.statuses(byId(FIXTURE, 'get-api-items-itemid')), `${Ansi.color.green('200')} ${Ansi.color.yellow('404')}`);
    assert.equal(plain.auth(byId(FIXTURE, 'post-api-items')), 'cookie,csrf');
    assert.equal(plain.auth(byId(FIXTURE, 'get-root')), '');
    assert.equal(plain.auth(byId(MIXED, 'post-api-v1-orders')), 'bearer');
    assert.equal(plain.auth(byId(MIXED, 'get-api-v1-orders')), 'header');
    const all = { ...byId(MIXED, 'post-api-v1-orders'), auth: { cookies: ['sid'], headers: ['authorization', 'x-api-key'], bearer: true, csrf: [{ location: 'header' as const, name: 'x-csrf', source: 'cookie' as const }] } };
    assert.deepEqual(EndpointFormatter.authLabels(all), ['cookie', 'bearer', 'header', 'csrf']);
    const basic = { ...all, auth: { cookies: [], headers: ['authorization'], bearer: false, csrf: [] } };
    assert.deepEqual(EndpointFormatter.authLabels(basic), ['header']);
  });

  test('model text is cleaned to ASCII without control characters', () => {
    const odd = { ...byId(FIXTURE, 'get-root'), path: '/caf\u00e9/\x1b[2J', method: 'GET' };
    assert.equal(plain.path(odd), '/caf\\u00e9/\\x1b[2J');
  });
});
