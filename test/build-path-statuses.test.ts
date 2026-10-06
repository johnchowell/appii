import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Page } from 'playwright';
import { ModelBuilder } from '../src/build/index.js';
import { CaptureSession } from '../src/capture/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import type { ApiModel, Endpoint } from '../src/model/index.js';

const SLUGS = ['how-to-learn-javascript-efficiently', 'react-hooks-best-practices', 'building-scalable-apis-with-node-js'];
const STALE = 'an-old-link-that-was-removed';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL) => void;

function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'access-control-allow-credentials': 'true' });
  res.end(JSON.stringify(value));
}

function page(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>App</title></head><body><app-root></app-root><script>
window.api = (path) => fetch(path, { headers: { accept: 'application/json' } }).then((r) => r.json());
</script></body></html>`);
}

function article(slug: string): Record<string, unknown> {
  return { slug, title: slug.replace(/-/g, ' '), body: 'text', tagList: ['x'], author: { username: 'johndoe', bio: null, image: null, following: false } };
}

const conduit: Handler = (req, res, url) => {
  const path = url.pathname;
  if (path === '/') return page(res);
  if (path === '/api/articles') return json(res, { articles: SLUGS.map((slug) => article(slug)), articlesCount: SLUGS.length });
  if (path === '/api/articles/feed') {
    if (!req.headers.authorization) return json(res, { errors: { token: ['is missing'] } }, 401);
    return json(res, { articles: [], articlesCount: 0 });
  }
  const one = /^\/api\/articles\/([a-z0-9-]+)$/.exec(path);
  if (one && SLUGS.includes(one[1] ?? '')) return json(res, { article: article(one[1] ?? '') });
  if (one) return json(res, { errors: { article: ['not found'] } }, 404);
  return json(res, { errors: { body: ['not found'] } }, 404);
};

const reference: Handler = (_req, res, url) => {
  const path = url.pathname;
  if (path === '/') return page(res);
  const results = { pages: [{ id: 1, key: 'Hedy_Lamarr', title: 'Hedy Lamarr', excerpt: 'Hedy', description: 'actress', thumbnail: null }] };
  if (path === '/w/rest.php/v1/search/title' || path === '/w/rest.php/v1/search/page') return json(res, results);
  const summary = /^\/api\/rest_v1\/page\/summary\/([A-Za-z_]+)$/.exec(path);
  if (summary) return json(res, { type: 'standard', title: (summary[1] ?? '').replace(/_/g, ' '), extract: 'x', lang: 'en' });
  const feed = /^\/api\/feed\/([a-z]+)$/.exec(path);
  if (feed) return json(res, { items: [{ id: 1, score: 3 }] });
  return json(res, { errorKey: 'rest-no-match' }, 404);
};

function start(handler: Handler): Promise<{ server: Server; origin: string }> {
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => handler(req, res, new URL(req.url ?? '/', 'http://localhost')));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}` })));
}

async function capture(handler: Handler, calls: string): Promise<ApiModel> {
  const { server, origin } = await start(handler);
  try {
    const script = async (target: Page): Promise<void> => {
      await target.evaluate(`(async () => { ${calls} })()`);
    };
    const captured = await CaptureSession.create({ url: `${origin}/`, headless: true, idleMs: 300, script }).run();
    return ModelBuilder.create({ now: new Date(0) }).build(captured);
  } finally {
    server.closeAllConnections();
    server.close();
  }
}

function endpoint(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

function statuses(found: Endpoint): number[] {
  return found.responses.map((response) => response.status);
}

describe('a value the server answers with 404 is an unknown id of the same parameter (NEW-SPA-1)', () => {
  let stale: ApiModel;
  let single: ApiModel;

  before(async () => {
    stale = await capture(
      conduit,
      `await window.api('/api/articles?limit=10&offset=0');
       for (const slug of ${JSON.stringify(SLUGS)}) await window.api('/api/articles/' + slug);
       await window.api('/api/articles/${STALE}');
       await window.api('/api/articles/feed?limit=10&offset=0');`,
    );
    single = await capture(
      conduit,
      `await window.api('/api/articles');
       await window.api('/api/articles/${SLUGS[0]}');
       await window.api('/api/articles/${STALE}');
       await window.api('/api/articles/feed');`,
    );
  });

  test('a stale link joins /api/articles/{slug} as its 404 response, whatever the number of listed articles opened', () => {
    for (const [model, count] of [[stale, SLUGS.length + 1], [single, 2]] as const) {
      const found = endpoint(model, 'GET', '/api/articles/{slug}');
      assert.deepEqual(statuses(found), [200, 404]);
      assert.equal(found.count, count);
      assert.ok(!model.endpoints.some((candidate) => candidate.path.includes('an-old-link')), model.endpoints.map((e) => e.path).join(', '));
      const doc = JSON.parse(ExporterRegistry.default().export(model, 'openapi').content) as { paths: Record<string, Record<string, { responses: Record<string, unknown> }>> };
      assert.deepEqual(Object.keys(doc.paths['/api/articles/{slug}']?.get?.responses ?? {}), ['200', '404']);
    }
  });

  test('the feed that refuses the same anonymous client stays literal, with or without a query', () => {
    assert.deepEqual(statuses(endpoint(stale, 'GET', '/api/articles/feed')), [401]);
    assert.deepEqual(statuses(endpoint(single, 'GET', '/api/articles/feed')), [401]);
    assert.ok(!endpoint(single, 'GET', '/api/articles/{slug}').pathParams[0]?.examples.includes('feed'));
  });
});

describe('two operations with one JSON shape under a singular parent stay apart without identifier evidence (WIKI-N1)', () => {
  let model: ApiModel;

  before(async () => {
    model = await capture(
      reference,
      `await window.api('/w/rest.php/v1/search/title?q=Hedy&limit=3');
       await window.api('/w/rest.php/v1/search/page?q=Hedy&limit=3');
       await window.api('/api/feed/top');
       await window.api('/api/feed/hot');
       await window.api('/api/rest_v1/page/summary/Logic');
       await window.api('/api/rest_v1/page/summary/Grace_Hopper');`,
    );
  });

  test('search/title and search/page are two endpoints, so no client accepts an operation the server does not have', () => {
    endpoint(model, 'GET', '/w/rest.php/v1/search/title');
    endpoint(model, 'GET', '/w/rest.php/v1/search/page');
    endpoint(model, 'GET', '/api/feed/top');
    endpoint(model, 'GET', '/api/feed/hot');
    assert.ok(!model.endpoints.some((candidate) => /\{search\}|\{feed\}/.test(candidate.path)), model.endpoints.map((e) => e.path).join(', '));
  });

  test('page summaries that echo their title still share one endpoint (WIKI-1)', () => {
    const summary = endpoint(model, 'GET', '/api/rest_v1/page/summary/{title}');
    assert.deepEqual([...(summary.pathParams[0]?.examples ?? [])].sort(), ['Grace_Hopper', 'Logic']);
  });
});
