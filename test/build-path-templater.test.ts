import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PathTemplater } from '../src/build/index.js';
import type { PathTemplate } from '../src/build/index.js';
import { EndpointIndex } from '../src/shared/index.js';

const templater = new PathTemplater();

function templates(paths: string[]): Record<string, string> {
  const map = templater.template(paths);
  return Object.fromEntries(paths.map((path) => [path, map.get(path)?.template ?? '']));
}

function only(paths: string[], path: string): PathTemplate {
  const found = templater.template(paths).get(path);
  assert.ok(found, path);
  return found;
}

describe('PathTemplater.classify', () => {
  test('recognizes id-like segment kinds from the rule table', () => {
    const cases: [string, string][] = [
      ['123', 'integer'],
      ['0', 'integer'],
      ['123e4567-e89b-12d3-a456-426614174000', 'uuid'],
      ['2026-01-31', 'date'],
      ['507f1f77bcf86cd799439011', 'hex'],
      ['DEADBEEF00112233', 'hex'],
      ['aZ3_kd93KdlslE0q', 'token'],
      ['dQw4w9WgXcQ', 'token'],
      ['items', 'literal'],
      ['v1', 'literal'],
      ['api', 'literal'],
      ['graphql', 'literal'],
      ['2fa', 'literal'],
      ['user123', 'literal'],
      ['my-post-2024-recap-for-everyone', 'literal'],
      ['deadbeefdeadbeef', 'literal'],
      ['DeadBeef00112233', 'literal'],
      ['2026-13-01', 'literal'],
      ['app.js', 'literal'],
      ['', 'literal'],
    ];
    for (const [segment, kind] of cases) assert.equal(templater.classify(segment), kind, segment);
  });

  test('opaque tokens need length and letter/digit alternation', () => {
    assert.equal(PathTemplater.isOpaqueToken('order2024summary'), false);
    assert.equal(PathTemplater.isOpaqueToken('a1b2c3d4e5f6g7h8'), true);
    assert.equal(PathTemplater.isOpaqueToken('abc123'), false);
    assert.equal(PathTemplater.isOpaqueToken('with.dot.a1b2c3d4e5'), false);
  });
});

describe('PathTemplater.template', () => {
  test('does not over-generalize distinct pages and keeps collections apart from items', () => {
    assert.deepEqual(templates(['/login', '/logout', '/signup', '/account', '/']), {
      '/login': '/login',
      '/logout': '/logout',
      '/signup': '/signup',
      '/account': '/account',
      '/': '/',
    });
    assert.deepEqual(templates(['/api/items', '/api/items/1', '/api/items/2', '/api/items/999']), {
      '/api/items': '/api/items',
      '/api/items/1': '/api/items/{itemId}',
      '/api/items/2': '/api/items/{itemId}',
      '/api/items/999': '/api/items/{itemId}',
    });
  });

  test('versions, api and graphql stay literal even when they vary', () => {
    assert.deepEqual(templates(['/v1/items', '/v2/items', '/v3/items', '/api/graphql', '/api/rest', '/api/rpc']), {
      '/v1/items': '/v1/items',
      '/v2/items': '/v2/items',
      '/v3/items': '/v3/items',
      '/api/graphql': '/api/graphql',
      '/api/rest': '/api/rest',
      '/api/rpc': '/api/rpc',
    });
  });

  test('a single literal stays literal but a single id becomes a parameter', () => {
    assert.deepEqual(templates(['/users/alice']), { '/users/alice': '/users/alice' });
    assert.deepEqual(templates(['/users/123']), { '/users/123': '/users/{userId}' });
    assert.deepEqual(templates(['/users/alice', '/users/bob']), { '/users/alice': '/users/alice', '/users/bob': '/users/bob' });
  });

  test('three or more distinct literals under a plural parent become a parameter', () => {
    const map = templates(['/users/alice', '/users/bob', '/users/carol', '/users/alice/posts', '/users/bob/posts', '/users/dave/posts']);
    assert.equal(map['/users/alice'], '/users/{user}');
    assert.equal(map['/users/carol'], '/users/{user}');
    assert.equal(map['/users/alice/posts'], '/users/{user}/posts');
    const params = only(['/users/alice', '/users/bob', '/users/carol'], '/users/bob').params;
    assert.deepEqual(params, [{ name: 'user', position: 1, kind: 'literal', examples: ['alice', 'bob', 'carol'] }]);
  });

  test('literals under non-plural or reserved parents and sub-resources stay literal', () => {
    assert.deepEqual(Object.values(templates(['/admin/users', '/admin/groups', '/admin/roles'])), ['/admin/users', '/admin/groups', '/admin/roles']);
    assert.deepEqual(Object.values(templates(['/api/login', '/api/logout', '/api/me'])), ['/api/login', '/api/logout', '/api/me']);
    assert.deepEqual(Object.values(templates(['/account/profile', '/account/billing', '/account/security'])), [
      '/account/profile',
      '/account/billing',
      '/account/security',
    ]);
    assert.deepEqual(Object.values(templates(['/items/1/reviews', '/items/2/photos', '/items/3/specs'])), [
      '/items/{itemId}/reviews',
      '/items/{itemId}/photos',
      '/items/{itemId}/specs',
    ]);
    assert.deepEqual(Object.values(templates(['/assets/a.js', '/assets/b.js', '/assets/c.js'])), ['/assets/a.js', '/assets/b.js', '/assets/c.js']);
  });

  test('generalization requires all other segments to match', () => {
    const map = templates(['/shops/a/items', '/shops/b/items', '/shops/c/orders']);
    assert.deepEqual(Object.values(map), ['/shops/a/items', '/shops/b/items', '/shops/c/orders']);
  });

  test('names come from the preceding literal and are unique per template', () => {
    assert.equal(only(['/users/1/posts/2'], '/users/1/posts/2').template, '/users/{userId}/posts/{postId}');
    assert.equal(only(['/users/1/2'], '/users/1/2').template, '/users/{userId}/{userId2}');
    assert.equal(only(['/42'], '/42').template, '/{id}');
    assert.equal(only(['/api/v1/42'], '/api/v1/42').template, '/api/v1/{id}');
    assert.equal(only(['/order-items/7'], '/order-items/7').template, '/order-items/{orderItemId}');
    assert.equal(only(['/reports/2026-01-31'], '/reports/2026-01-31').template, '/reports/{reportDate}');
    assert.equal(only(['/categories/123e4567-e89b-12d3-a456-426614174000'], '/categories/123e4567-e89b-12d3-a456-426614174000').template, '/categories/{categoryId}');
  });

  test('params carry kinds and distinct decoded examples; mixed kinds merge', () => {
    const template = only(['/files/1', '/files/2', '/files/1'], '/files/1');
    assert.deepEqual(template.params, [{ name: 'fileId', position: 1, kind: 'integer', examples: ['1', '2'] }]);
    const mixed = only(['/users/123', '/users/alice', '/users/bob', '/users/carol'], '/users/123');
    assert.equal(mixed.template, '/users/{user}');
    assert.equal(mixed.params[0]?.kind, 'literal');
    const ids = only(['/x/123', '/x/507f1f77bcf86cd799439011'], '/x/123');
    assert.equal(ids.params[0]?.kind, 'token');
    const encoded = only(['/tags/caf%C3%A9', '/tags/b', '/tags/c'], '/tags/b');
    assert.deepEqual(encoded.params[0]?.examples, ['caf\u00e9', 'b', 'c']);
  });

  test('trailing slashes and non-slash paths are handled', () => {
    assert.deepEqual(templates(['/api/items/', '/api/items']), { '/api/items/': '/api/items/', '/api/items': '/api/items' });
    assert.deepEqual(templates(['*']), { '*': '*' });
  });

  test('the output is deterministic for the same input', () => {
    const paths = ['/b/1', '/a/2', '/users/x', '/users/y', '/users/z'];
    assert.deepEqual([...templater.template(paths)], [...templater.template(paths)]);
  });
});

describe('EndpointIndex.matchPath', () => {
  test('matches whole-segment and partial-segment params and decodes values', () => {
    assert.deepEqual(EndpointIndex.matchPath('/api/items/{itemId}', '/api/items/42'), { itemId: '42' });
    assert.deepEqual(EndpointIndex.matchPath('/users/{user}/posts', '/users/caf%C3%A9/posts'), { user: 'caf\u00e9' });
    assert.deepEqual(EndpointIndex.matchPath('/files/{name}.{ext}', '/files/report.final.pdf'), { name: 'report', ext: 'final.pdf' });
    assert.deepEqual(EndpointIndex.matchPath('/login', '/login'), {});
    assert.deepEqual(EndpointIndex.matchPath('/a/{x}', '/a/%E0%A4%A'), { x: '%E0%A4%A' });
  });

  test('rejects different lengths, literals, empty params and malformed templates', () => {
    assert.equal(EndpointIndex.matchPath('/api/items/{itemId}', '/api/items'), undefined);
    assert.equal(EndpointIndex.matchPath('/api/items/{itemId}', '/api/items/'), undefined);
    assert.equal(EndpointIndex.matchPath('/api/items/{itemId}', '/api/other/1'), undefined);
    assert.equal(EndpointIndex.matchPath('/login', '/logout'), undefined);
    assert.deepEqual(EndpointIndex.matchPath('/a/{', '/a/{'), {});
    assert.equal(EndpointIndex.matchPath('/a/{', '/a/b'), undefined);
    assert.equal(EndpointIndex.matchPath('/a.b/{x}', '/aXb/1'), undefined);
  });

  test('does not backtrack catastrophically on hostile segments', () => {
    const started = Date.now();
    const segment = 'a'.repeat(5000) + '{';
    assert.equal(EndpointIndex.matchPath(`/${segment}`, '/x'), undefined);
    assert.equal(EndpointIndex.matchPath('/{a}{b}{c}{d}{e}{f}', '/' + 'x'.repeat(3000) + '/'), undefined);
    assert.deepEqual(EndpointIndex.matchPath('/{a}{b}', '/{a}{b}'), {});
    assert.ok(Date.now() - started < 500);
  });

  test('uses only own properties for names', () => {
    const values = EndpointIndex.matchPath('/{__proto__}', '/x');
    assert.ok(values && Object.hasOwn(values, '__proto__'));
    assert.equal(Object.getPrototypeOf(values), Object.prototype);
  });
});
