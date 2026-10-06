import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EndpointFactory, EndpointNamer } from '../src/build/index.js';
import type { Endpoint, EndpointKind } from '../src/model/index.js';
import { Text } from '../src/shared/index.js';

const ORIGIN = 'https://shop.example.com';
const namer = new EndpointNamer();

function endpoint(method: string, path: string, kind: EndpointKind = 'json', operationName?: string, origin = ORIGIN): Endpoint {
  return EndpointFactory.blank({ method, origin, path, kind, ...(operationName ? { operationName } : {}) });
}

function named(list: Endpoint[]): [string, string][] {
  namer.name(list);
  return list.map((e) => [e.id, e.name]);
}

describe('EndpointNamer', () => {
  test('REST conventions for collections and items', () => {
    assert.deepEqual(
      named([
        endpoint('GET', '/api/items'),
        endpoint('POST', '/api/items'),
        endpoint('GET', '/api/items/{itemId}'),
        endpoint('PUT', '/api/items/{itemId}'),
        endpoint('PATCH', '/v2/categories/{categoryId}'),
        endpoint('DELETE', '/api/items/{itemId}/'),
        endpoint('GET', '/api/order-items'),
      ]),
      [
        ['get-api-items', 'listItems'],
        ['post-api-items', 'createItem'],
        ['get-api-items-itemid', 'getItem'],
        ['put-api-items-itemid', 'updateItem'],
        ['patch-v2-categories-categoryid', 'updateCategory'],
        ['delete-api-items-itemid', 'deleteItem'],
        ['get-api-order-items', 'listOrderItems'],
      ],
    );
  });

  test('documents, forms, graphql and fallbacks', () => {
    assert.deepEqual(
      named([
        endpoint('GET', '/login', 'document'),
        endpoint('POST', '/login', 'form'),
        endpoint('GET', '/', 'document'),
        endpoint('GET', '/products/{productId}', 'document'),
        endpoint('GET', '/search', 'form'),
        endpoint('POST', '/signup', 'form'),
        endpoint('POST', '/graphql', 'graphql', 'GetItem'),
        endpoint('POST', '/graphql', 'graphql'),
        endpoint('POST', '/api/token'),
        endpoint('GET', '/api/me'),
        endpoint('POST', '/', 'other'),
        endpoint('PUT', '/api/items'),
        endpoint('POST', '/api/items/{itemId}'),
      ]),
      [
        ['get-login', 'getLoginPage'],
        ['post-login', 'postLogin'],
        ['get-root', 'getHomePage'],
        ['get-products-productid', 'getProductPageByProductId'],
        ['get-search', 'getSearch'],
        ['post-signup', 'postSignup'],
        ['post-graphql-getitem', 'getItem'],
        ['post-graphql', 'postGraphql'],
        ['post-api-token', 'postToken'],
        ['get-api-me', 'getMe'],
        ['post-root', 'postRoot'],
        ['put-api-items', 'putItems'],
        ['post-api-items-itemid', 'postItems'],
      ],
    );
  });

  test('REST names win collisions with GraphQL operations; graphql names are qualified by path', () => {
    assert.deepEqual(named([endpoint('POST', '/graphql', 'graphql', 'GetItem'), endpoint('GET', '/api/items/{itemId}')]), [
      ['post-graphql-getitem', 'graphqlGetItem'],
      ['get-api-items-itemid', 'getItem'],
    ]);
  });

  test('other collisions use path-qualified names, then numeric suffixes', () => {
    assert.deepEqual(
      named([
        endpoint('GET', '/api/items'),
        endpoint('GET', '/admin/items'),
        endpoint('GET', '/api/items', 'json', undefined, 'https://cdn.example.com'),
        endpoint('GET', '/admin/items/{itemId}'),
        endpoint('GET', '/api/items/{itemId}'),
      ]),
      [
        ['get-api-items', 'listItems'],
        ['get-admin-items', 'listAdminItems'],
        ['get-api-items-2', 'listApiItems'],
        ['get-admin-items-itemid', 'getItem'],
        ['get-api-items-itemid', 'getApiItem'],
      ],
    );
  });

  test('ids and names are unique, deterministic and valid identifiers', () => {
    const list = () => [
      endpoint('GET', '/a'),
      endpoint('GET', '/a'),
      endpoint('GET', '/a'),
      endpoint('GET', '/123/x', 'other'),
      endpoint('GET', '/class', 'other'),
      endpoint('POST', '/graphql', 'graphql', 'delete'),
    ];
    const first = named(list());
    assert.deepEqual(first, named(list()));
    assert.equal(new Set(first.map(([id]) => id)).size, first.length);
    assert.equal(new Set(first.map(([, name]) => name)).size, first.length);
    assert.deepEqual(first.map(([id]) => id), ['get-a', 'get-a-2', 'get-a-3', 'get-123-x', 'get-class', 'post-graphql-delete']);
    for (const [, name] of first) assert.match(name, /^[A-Za-z_$][A-Za-z0-9_$]*$/);
    assert.equal(first[3]?.[1], 'get123X');
    assert.equal(first[5]?.[1], 'graphqlDelete');
    assert.deepEqual(named([endpoint('POST', '/', 'graphql', 'delete')]), [['post-root-delete', 'deleteEndpoint']]);
    for (const [, name] of first) assert.ok(!Text.RESERVED_WORDS.includes(name), name);
  });

  test('segment parsing and plural detection', () => {
    assert.deepEqual(EndpointNamer.segments('/api/items/{itemId}/'), [
      { text: 'api', param: false },
      { text: 'items', param: false },
      { text: 'itemId', param: true },
    ]);
    assert.deepEqual(EndpointNamer.segments('/caf%C3%A9'), [{ text: 'caf\u00e9', param: false }]);
    assert.equal(EndpointNamer.isPlural('items'), true);
    assert.equal(EndpointNamer.isPlural('categories'), true);
    assert.equal(EndpointNamer.isPlural('status'), false);
    assert.equal(EndpointNamer.isPlural('login'), false);
    assert.equal(namer.slug(endpoint('GET', '/caf%C3%A9')), 'get-caf');
  });

  test('multi-word slugs under a plural parent are items, compound collections stay lists (SPA-5)', () => {
    assert.deepEqual(
      named([
        endpoint('GET', '/api/articles/react-hooks-best-practices'),
        endpoint('GET', '/api/articles/building-scalable-apis-with-node-js'),
        endpoint('GET', '/api/articles/how-to-learn-javascript-efficiently'),
        endpoint('GET', '/api/order-items'),
        endpoint('GET', '/api/line_items'),
        endpoint('GET', '/api/users/blocked-users'),
      ]).map(([, name]) => name),
      ['getArticleReactHooksBestPractices', 'getArticleBuildingScalableApisWithNodeJs', 'getArticleHowToLearnJavascriptEfficiently', 'listOrderItems', 'listLineItems', 'listBlockedUsers'],
    );
    assert.equal(Text.singularizePhrase('node-js'), 'node-js');
    assert.equal(Text.singularizePhrase('order-items'), 'order-item');
    assert.equal(Text.singularizePhrase('react-hooks-best-practices'), 'react-hooks-best-practice');
    assert.equal(EndpointNamer.isPlural('building-scalable-apis-with-node-js'), false);
  });

  test('page and file names stay short, readable and unique', () => {
    const list = () => [
      endpoint('GET', '/page/{page}/', 'document'),
      endpoint('GET', '/tag/{tag}/', 'document'),
      endpoint('GET', '/tag/{tag}/page/{page}/', 'document'),
      endpoint('GET', '/catalogue/page-{page}.html', 'other'),
      endpoint('GET', '/catalogue/{catalogue}/index.html', 'document'),
      endpoint('GET', '/index.html', 'other'),
      endpoint('GET', '/bytes/{bytes}', 'other'),
      endpoint('GET', '/users/{user}', 'json'),
    ];
    const first = named(list());
    assert.deepEqual(first, named(list()));
    assert.deepEqual(
      first.map(([, name]) => name),
      ['getPageByPage', 'getTagPageByTag', 'getTagPageByTagAndPage', 'getCataloguePage', 'getCataloguePageByCatalogue', 'getIndex', 'getBytes', 'getUser'],
    );
    assert.equal(new Set(first.map(([id]) => id)).size, first.length);
    assert.deepEqual(EndpointNamer.segments('/catalogue/page-{page}.html'), [
      { text: 'catalogue', param: false },
      { text: 'page-', param: false, embedded: ['page'] },
    ]);
    assert.deepEqual(EndpointNamer.params('/catalogue/category/books/{book}/page-{page}.html'), ['book', 'page']);
  });

  test('a page name depends on its own path, not on which sibling pages were captured (BOOKS-R4)', () => {
    const shared = ['/catalogue/{catalogue}/index.html', '/catalogue/category/books/{book}/index.html', '/tag/{tag}/'];
    const extra = ['/catalogue/page-{page}.html', '/catalogue/category/books/{book}/page-{page}.html', '/tag/{tag}/page/{page}/', '/'];
    const names = (paths: readonly string[]): Map<string, string> => {
      const list = paths.map((path) => endpoint('GET', path, 'document'));
      namer.name(list);
      return new Map(list.map((e) => [e.path, e.name]));
    };
    const alone = names(shared);
    const all = names([...shared, ...extra]);
    const reversed = names([...extra, ...shared].reverse());
    for (const path of shared) {
      assert.equal(all.get(path), alone.get(path), path);
      assert.equal(reversed.get(path), alone.get(path), path);
    }
    assert.deepEqual([...all.values()], [
      'getCataloguePageByCatalogue',
      'getCatalogueCategoryBookPageByBook',
      'getTagPageByTag',
      'getCataloguePageByPage',
      'getCatalogueCategoryBookPageByBookAndPage',
      'getTagPageByTagAndPage',
      'getHomePage',
    ]);
    const values = [...all.values()];
    assert.equal(new Set(values).size, values.length);
    for (const name of values) assert.doesNotMatch(name, /[0-9]$/);
    for (const name of values) assert.ok(!values.includes(name.replace(/Book/g, 'Books')) || !name.includes('Book'), name);
  });
});

