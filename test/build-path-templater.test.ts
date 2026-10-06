import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PathTemplater, ResponseStructure } from '../src/build/index.js';
import type { PathEvidence, PathObservation, PathTemplate } from '../src/build/index.js';
import { EndpointIndex } from '../src/shared/index.js';

const templater = new PathTemplater();
const structures = new ResponseStructure();

function templates(paths: string[], evidence: ReadonlyMap<string, PathEvidence> = new Map()): Record<string, string> {
  const map = templater.template(paths, evidence);
  return Object.fromEntries(paths.map((path) => [path, map.get(path)?.template ?? '']));
}

function observation(body: unknown, extra: Partial<PathObservation> = {}): PathObservation {
  const html = typeof body === 'string';
  const structure = html ? structures.html(body, 'https://example.com/') : structures.json(body);
  return { method: 'GET', status: 200, mime: html ? 'text/html' : 'application/json', ...(structure ? { structure } : {}), query: [], ...extra };
}

function seen(entries: Record<string, PathObservation | PathObservation[]>, extra: Record<string, Partial<PathEvidence>> = {}): Map<string, PathEvidence> {
  return new Map(
    Object.entries(entries).map(([path, found]) => [path, { forms: new Set<string>(), names: new Set<string>(), observations: Array.isArray(found) ? found : [found], ...extra[path] }]),
  );
}

function same(paths: string[], body: unknown): Map<string, PathEvidence> {
  return seen(Object.fromEntries(paths.map((path) => [path, observation(body)])));
}

function layout(main: string, title = 'x'): string {
  return `<!doctype html><html><head><title>${title}</title></head><body class="page-${title}"><div class="container"><header class="nav"><a href="/">Home</a></header><div class="row"><div class="col-8">${main}</div></div><footer class="foot">f</footer></div></body></html>`;
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
    assert.deepEqual(templates(['/users/alice'], same(['/users/alice'], { user: { name: 'Alice' } })), { '/users/alice': '/users/alice' });
  });

  test('literals whose responses share one structure become a parameter, whatever the parent word', () => {
    const paths = ['/users/alice', '/users/bob', '/users/carol', '/users/alice/posts', '/users/bob/posts', '/users/dave/posts'];
    const evidence = new Map([...same(paths.slice(0, 3), { user: { name: 'A', bio: 'b' } }), ...same(paths.slice(3), { posts: [{ id: 1, title: 't' }] })]);
    const map = templates(paths, evidence);
    assert.equal(map['/users/alice'], '/users/{user}');
    assert.equal(map['/users/carol'], '/users/{user}');
    assert.equal(map['/users/alice/posts'], '/users/{user}/posts');
    const params = templater.template(paths.slice(0, 3), evidence).get('/users/bob')?.params;
    assert.deepEqual(params, [{ name: 'user', position: 1, kind: 'literal', examples: ['alice', 'bob', 'carol'] }]);
    assert.deepEqual(Object.values(templates(paths.slice(0, 3))), paths.slice(0, 3));
  });

  test('literals under reserved parents, distinct pages and sub-resources stay literal', () => {
    assert.deepEqual(Object.values(templates(['/admin/users', '/admin/groups', '/admin/roles'], same(['/admin/users', '/admin/groups', '/admin/roles'], { items: [{ id: 1 }] }))), [
      '/admin/users',
      '/admin/groups',
      '/admin/roles',
    ]);
    assert.deepEqual(Object.values(templates(['/api/login', '/api/logout', '/api/me'])), ['/api/login', '/api/logout', '/api/me']);
    const account = seen({
      '/account/profile': observation(layout('<form class="profile"><input name="name"></form>')),
      '/account/billing': observation(layout('<table class="invoices"><tr><td>1</td></tr></table>')),
      '/account/security': observation(layout('<ul class="sessions"><li>a</li></ul>')),
    });
    assert.deepEqual(Object.values(templates(['/account/profile', '/account/billing', '/account/security'], account)), [
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
    const mixed = templates(['/users/123', '/users/featured', '/users/trending', '/users/blocked']);
    assert.deepEqual(mixed, { '/users/123': '/users/{userId}', '/users/featured': '/users/featured', '/users/trending': '/users/trending', '/users/blocked': '/users/blocked' });
    const ids = only(['/x/123', '/x/507f1f77bcf86cd799439011'], '/x/123');
    assert.equal(ids.params[0]?.kind, 'token');
    const tags = ['/tags/caf%C3%A9', '/tags/b', '/tags/c'];
    const encoded = templater.template(tags, same(tags, { tag: { name: 'x' } })).get('/tags/b');
    assert.deepEqual(encoded?.params[0]?.examples, ['caf\u00e9', 'b', 'c']);
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

describe('PathTemplater evidence: structure, value shape and identifiers', () => {
  const quote = (tag: string): string => layout(`<h3>Viewing tag: ${tag}</h3><div class="quote"><span class="text">q</span><a class="tag" href="/tag/${tag}/">${tag}</a></div><nav><ul class="pager"><li class="next"><a href="#">Next</a></li></ul></nav>`, tag);

  test('singular collection parents open when the pages share one HTML skeleton (QTS-1)', () => {
    const tags = ['/tag/love/', '/tag/inspirational/', '/tag/life/'];
    const authors = ['/author/Jane-Austen/', '/author/J-K-Rowling/'];
    const evidence = seen({
      ...Object.fromEntries(tags.map((path) => [path, observation(quote(path.split('/')[2] ?? ''))])),
      ...Object.fromEntries(authors.map((path) => [path, observation(layout(`<div class="author-details"><h3 class="author-title">${path}</h3><span class="born">b</span></div>`))])),
      '/tag/inspirational/page/1/': observation(quote('inspirational')),
      '/login': observation(layout('<form action="/login"><input name="username"></form>')),
    });
    const paths = [...tags, ...authors, '/tag/inspirational/page/1/', '/login'];
    const map = templates(paths, evidence);
    for (const path of tags) assert.equal(map[path], '/tag/{tag}/');
    for (const path of authors) assert.equal(map[path], '/author/{author}/');
    assert.equal(map['/tag/inspirational/page/1/'], '/tag/{tag}/page/{page}/');
    assert.equal(map['/login'], '/login');
    assert.deepEqual(templater.template(paths, evidence).get('/tag/love/')?.params, [{ name: 'tag', position: 1, kind: 'literal', examples: ['love', 'inspirational', 'life'] }]);
  });

  test('the skeleton ignores text, repeated items, body classes and digits in class names', () => {
    const a = structures.html(layout('<div class="quote q-1"><p>One</p></div><div class="quote q-2"><p>Two</p></div>', 'Ada_Lovelace'), 'https://e.com/');
    const b = structures.html(layout('<div class="quote q-9"><p>Other text entirely</p></div>', 'Charles_Babbage').replace('class="page-', 'class="mw-editable page-'), 'https://e.com/');
    const c = structures.html(layout('<form><input name="q"></form>'), 'https://e.com/');
    assert.ok(a && b && c);
    assert.equal(ResponseStructure.alike(a, b), true);
    assert.equal(ResponseStructure.alike(a, c), false);
    const article = structures.json({ article: { slug: 'a', title: 'T', author: { username: 'u', image: null } } });
    const sparse = structures.json({ article: { slug: 'b', title: 'U', author: { username: 'v' } } });
    const feed = structures.json({ articles: [{ slug: 'a' }], articlesCount: 1 });
    assert.ok(article && sparse && feed);
    assert.equal(ResponseStructure.alike(article, sparse), true);
    assert.equal(ResponseStructure.alike(article, feed), false);
    assert.equal(structures.json({}), undefined);
  });

  test('a sibling that answers with another structure, query or status stays literal (SPA-2)', () => {
    const slugs = ['how-to-learn-javascript-efficiently', 'react-hooks-best-practices', 'building-scalable-apis-with-node-js'];
    const paths = [...slugs.map((slug) => `/api/articles/${slug}`), '/api/articles/feed'];
    const references = { references: new Set([2]) };
    const listed = seen(
      {
        ...Object.fromEntries(slugs.map((slug) => [`/api/articles/${slug}`, observation({ article: { slug, title: 'T', body: 'b' } })])),
        '/api/articles/feed': observation({ errors: { token: ['is missing'] } }, { status: 401, query: ['limit', 'offset'] }),
      },
      Object.fromEntries(slugs.map((slug) => [`/api/articles/${slug}`, references])),
    );
    const anonymous = templates(paths, listed);
    assert.deepEqual(Object.values(anonymous), ['/api/articles/{article}', '/api/articles/{article}', '/api/articles/{article}', '/api/articles/feed']);
    const signedIn = seen({
      ...Object.fromEntries(slugs.map((slug) => [`/api/articles/${slug}`, observation({ article: { slug, title: 'T', body: 'b' } })])),
      '/api/articles/feed': observation({ articles: [{ slug: 'x', title: 'T' }], articlesCount: 1 }, { query: ['limit', 'offset'] }),
    });
    assert.equal(templates(paths, signedIn)['/api/articles/feed'], '/api/articles/feed');
    const quiet = seen({
      ...Object.fromEntries(slugs.map((slug) => [`/api/articles/${slug}`, observation({ article: { slug, title: 'T', body: 'b' } })])),
      '/api/articles/feed': observation({ errors: { token: ['is missing'] } }, { status: 401 }),
    }, Object.fromEntries(slugs.map((slug) => [`/api/articles/${slug}`, references])));
    assert.equal(templates(paths, quiet)['/api/articles/feed'], '/api/articles/feed');
  });

  test('values the API itself listed or echoes open with one sample and take the field name (SPA-1)', () => {
    const echo = (key: string) => ({ echoes: new Map([[2, [{ key, identifier: true, depth: 2, exact: true }]]]) });
    const evidence = seen(
      {
        '/api/profiles/mikewilson': observation({ profile: { username: 'mikewilson', bio: null } }),
        '/api/articles/react-hooks-best-practices': observation({ article: { slug: 'react-hooks-best-practices' } }),
        '/api/articles/react-hooks-best-practices/comments': observation({ comments: [] }),
        '/api/articles/other-article/comments': observation({ comments: [{ id: 1, body: 'x' }] }),
        '/api/articles/feed': observation({ articles: [], articlesCount: 0 }, { query: ['limit'] }),
      },
      {
        '/api/profiles/mikewilson': { ...echo('username'), references: new Set([2]) },
        '/api/articles/react-hooks-best-practices': echo('slug'),
      },
    );
    const map = templates(Object.keys(Object.fromEntries(evidence)), evidence);
    assert.equal(map['/api/profiles/mikewilson'], '/api/profiles/{username}');
    assert.equal(map['/api/articles/react-hooks-best-practices'], '/api/articles/{slug}');
    assert.equal(map['/api/articles/react-hooks-best-practices/comments'], '/api/articles/{slug}/comments');
    assert.equal(map['/api/articles/feed'], '/api/articles/feed');
    const action = seen({ '/api/profiles/me': observation({ profile: { username: 'me' } }) }, { '/api/profiles/me': echo('username') });
    assert.equal(templates(['/api/profiles/me'], action)['/api/profiles/me'], '/api/profiles/me');
  });

  test('slugs that carry a numeric id open from two samples, a lone one stays literal (BOOKS-1)', () => {
    const books = ['the-exiled_247', 'tipping-the-velvet_999', 'the-requiem-red_995', 'a-light-in-the-attic_1000', 'how-to-train-your-dragon-38'];
    const paths = [...books.map((book) => `/catalogue/${book}/index.html`), '/catalogue/no-such-book_99999/index.html'];
    const evidence = seen({
      ...Object.fromEntries(paths.slice(0, -1).map((path) => [path, observation(layout('<article class="product_page"><h1>Book</h1></article>'))])),
      '/catalogue/no-such-book_99999/index.html': observation('<html><body><h1>404 Not Found</h1></body></html>', { status: 404 }),
    });
    for (const map of [templates(paths), templates(paths, evidence)]) for (const path of paths) assert.equal(map[path], '/catalogue/{catalogue}/index.html', path);
    assert.deepEqual(Object.values(templates(['/checkout/step-2'])), ['/checkout/step-2']);
    const categories = ['travel_2', 'mystery_3', 'new-adult_20', 'self-help_41', 'login_7'].map((slug) => `/catalogue/category/books/${slug}/index.html`);
    const map = templates(categories);
    assert.deepEqual(categories.map((path) => map[path]), [...categories.slice(0, 4).map(() => '/catalogue/category/books/{book}/index.html'), categories[4]]);
    assert.equal(templater.classify('a-light-in-the-attic_1000'), 'slug');
    assert.equal(templater.classify('page-2.html'), 'literal');
  });

  test('numbered file names become an in-segment parameter and the pattern spreads (BOOKS-2)', () => {
    const paths = ['/catalogue/page-2.html', '/catalogue/page-3.html', '/catalogue/category/books/mystery_3/index.html', '/catalogue/category/books/poetry_23/index.html', '/catalogue/category/books/mystery_3/page-2.html'];
    const map = templates(paths);
    assert.equal(map['/catalogue/page-2.html'], '/catalogue/page-{page}.html');
    assert.equal(map['/catalogue/category/books/mystery_3/page-2.html'], '/catalogue/category/books/{book}/page-{page}.html');
    assert.deepEqual(templater.template(paths).get('/catalogue/page-3.html')?.params, [{ name: 'page', position: 1, kind: 'integer', examples: ['2', '3'] }]);
    assert.deepEqual(EndpointIndex.matchPath('/catalogue/page-{page}.html', '/catalogue/page-50.html'), { page: '50' });
    assert.deepEqual(Object.values(templates(['/docs/chapter1.html', '/a.html', '/b.html', '/c.html'])), ['/docs/chapter1.html', '/a.html', '/b.html', '/c.html']);
  });

  test('REST resources under singular parents open on equal JSON shapes; an aborted call joins (WIKI-1)', () => {
    const titles = ['Charles_Babbage', 'Computer', 'Mathematician', 'Writer'];
    const summary = (title: string) => ({ type: 'standard', title: title.replace(/_/g, ' '), titles: { canonical: title, normalized: title.replace(/_/g, ' ') }, extract: 'x', lang: 'en' });
    const evidence = seen(
      {
        ...Object.fromEntries(titles.map((title) => [`/api/rest_v1/page/summary/${title}`, observation(summary(title))])),
        '/api/rest_v1/page/summary/Mechanical_engineer': { method: 'GET', mime: '', query: [] },
      },
      Object.fromEntries(titles.map((title) => [`/api/rest_v1/page/summary/${title}`, { echoes: new Map([[4, [{ key: 'title', identifier: false, depth: 1, exact: false }]]]) }])),
    );
    const map = templates([...evidence.keys()], evidence);
    for (const path of evidence.keys()) assert.equal(map[path], '/api/rest_v1/page/summary/{title}', path);
  });

  test('integers under singular nouns and units are named after the noun', () => {
    assert.equal(only(['/status/418'], '/status/418').template, '/status/{status}');
    assert.equal(only(['/bytes/16'], '/bytes/16').template, '/bytes/{bytes}');
    assert.equal(only(['/page/2/'], '/page/2/').template, '/page/{page}/');
    assert.equal(only(['/items/2'], '/items/2').template, '/items/{itemId}');
  });

  test('evidence-based templating is deterministic', () => {
    const paths = ['/tag/b/', '/tag/a/', '/tag/c/', '/x/1'];
    const evidence = same(paths, '<html><body><div class="q">x</div></body></html>');
    assert.deepEqual([...templater.template(paths, evidence)], [...templater.template(paths, evidence)]);
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

describe('PathTemplater evidence: what a status or a shared shape proves (NEW-SPA-1, WIKI-N1)', () => {
  const slugs = ['how-to-learn-javascript-efficiently', 'react-hooks-best-practices', 'building-scalable-apis-with-node-js'];
  const article = (slug: string): PathObservation => observation({ article: { slug, title: 'T', body: 'b' } });
  const listed = { references: new Set([2]) };

  test('an unlisted value that the server answers with 404 or 410 joins the parameter as an unknown id', () => {
    const stale = '/api/articles/an-old-link-that-was-removed';
    for (const status of [404, 410]) {
      const evidence = seen(
        { ...Object.fromEntries(slugs.map((slug) => [`/api/articles/${slug}`, article(slug)])), [stale]: observation({ errors: { article: ['not found'] } }, { status }) },
        Object.fromEntries(slugs.map((slug) => [`/api/articles/${slug}`, listed])),
      );
      const map = templates([...evidence.keys()], evidence);
      for (const path of evidence.keys()) assert.equal(map[path], '/api/articles/{article}', `${status} ${path}`);
    }
    const one = seen({ [`/api/articles/${slugs[0]}`]: article(slugs[0] ?? ''), [stale]: observation({ errors: { article: ['not found'] } }, { status: 404 }) }, { [`/api/articles/${slugs[0]}`]: listed });
    assert.deepEqual(Object.values(templates([...one.keys()], one)), ['/api/articles/{article}', '/api/articles/{article}']);
  });

  test('a sibling that refuses the same anonymous client stays literal, one the client lacked credentials for joins', () => {
    const feed = '/api/articles/feed';
    const anonymous = seen(
      { [`/api/articles/${slugs[0]}`]: article(slugs[0] ?? ''), [feed]: observation({ errors: { token: ['is missing'] } }, { status: 401 }) },
      { [`/api/articles/${slugs[0]}`]: listed },
    );
    assert.equal(templates([...anonymous.keys()], anonymous)[feed], feed);
    const signedIn = (slug: string): PathObservation => observation({ article: { slug, title: 'T', body: 'b' } }, { credentials: ['authorization'] });
    const draft = '/api/articles/my-draft-article';
    const lacked = seen(
      {
        ...Object.fromEntries(slugs.map((slug) => [`/api/articles/${slug}`, signedIn(slug)])),
        [draft]: observation({ errors: { token: ['is missing'] } }, { status: 401 }),
      },
      Object.fromEntries(slugs.map((slug) => [`/api/articles/${slug}`, listed])),
    );
    assert.equal(templates([...lacked.keys()], lacked)[draft], '/api/articles/{article}');
  });

  test('sibling operations with one JSON shape under a singular parent stay apart without identifier evidence', () => {
    const results = { pages: [{ id: 1, key: 'Hedy_Lamarr', title: 'Hedy Lamarr', excerpt: 'x', description: 'd' }] };
    const search = seen({ '/w/rest.php/v1/search/title': observation(results, { query: ['q', 'limit'] }), '/w/rest.php/v1/search/page': observation(results, { query: ['q', 'limit'] }) });
    assert.deepEqual(Object.values(templates([...search.keys()], search)), ['/w/rest.php/v1/search/title', '/w/rest.php/v1/search/page']);
    const feeds = seen({ '/api/feed/top': observation({ items: [{ id: 1 }] }), '/api/feed/hot': observation({ items: [{ id: 2 }] }) });
    assert.deepEqual(Object.values(templates([...feeds.keys()], feeds)), ['/api/feed/top', '/api/feed/hot']);
    const three = seen({ '/api/feed/top': observation({ items: [{ id: 1 }] }), '/api/feed/hot': observation({ items: [{ id: 2 }] }), '/api/feed/rising': observation({ items: [{ id: 3 }] }) });
    assert.deepEqual(Object.values(templates([...three.keys()], three)), ['/api/feed/{feed}', '/api/feed/{feed}', '/api/feed/{feed}']);
    const users = seen({ '/api/users/alice/profile': observation({ bio: 'a', followers: 1 }), '/api/users/bob/profile': observation({ bio: 'b', followers: 2 }) });
    assert.deepEqual(Object.values(templates([...users.keys()], users)), ['/api/users/{user}/profile', '/api/users/{user}/profile']);
  });

  test('two summaries that echo their title still share one endpoint (WIKI-1)', () => {
    const summary = (title: string) => ({ type: 'standard', title: title.replace(/_/g, ' '), extract: 'x', lang: 'en' });
    const titles = ['Logic', 'Grace_Hopper'];
    const evidence = seen(
      Object.fromEntries(titles.map((title) => [`/api/rest_v1/page/summary/${title}`, observation(summary(title))])),
      Object.fromEntries(titles.map((title) => [`/api/rest_v1/page/summary/${title}`, { echoes: new Map([[4, [{ key: 'title', identifier: false, depth: 1, exact: false }]]]) }])),
    );
    for (const path of evidence.keys()) assert.equal(templates([...evidence.keys()], evidence)[path], '/api/rest_v1/page/summary/{title}', path);
  });
});
