import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import { OpenApiExporter } from '../src/export/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { ExportModel } from './helpers/export-model.js';

type Operation = { security?: Record<string, string[]>[]; 'x-appii-endpoint'?: { count: number } };
type Doc = { paths: Record<string, Record<string, Operation>> };

function operations(doc: Doc): [string, Operation][] {
  return Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item).map(([method, op]): [string, Operation] => [`${method.toUpperCase()} ${path}`, op]));
}

describe('OpenAPI security requirements', () => {
  test('every operation declares security; public ones declare an empty list', () => {
    const doc = JSON.parse(new OpenApiExporter().export(ModelBuilder.create().build(CaptureFactory.fixture().capture)).content) as Doc;
    for (const [where, op] of operations(doc)) assert.ok(Array.isArray(op.security), `${where} has no security`);
    assert.deepEqual(doc.paths['/']?.get?.security, []);
  });

  test('cookies of a model without credential sets are sent together, and endpoints that were never observed can also be called without credentials', () => {
    const cookies = ExportModel.endpoint({ method: 'GET', path: '/api/items', auth: { cookies: ['auth', 'sid'], headers: [], anonymous: 'refused', bearer: false, csrf: [] } });
    const predicted = ExportModel.endpoint({ method: 'GET', path: '/search', count: 0, auth: { cookies: ['sid'], headers: [], anonymous: 'untested', bearer: false, csrf: [] } });
    const open = ExportModel.endpoint({ method: 'GET', path: '/', count: 0 });
    const model = ExportModel.model([cookies, predicted, open], {
      cookies: ['auth', 'sid'].map((name) => ({
        name,
        domain: 'shop.example.com',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax' as const,
        session: true,
        expires: null,
        role: name === 'auth' ? ('auth' as const) : ('session' as const),
        setBy: [],
        usedBy: [],
        valueExample: 'x',
      })),
    });
    const doc = JSON.parse(new OpenApiExporter().export(model).content) as Doc;
    assert.deepEqual(doc.paths['/api/items']?.get?.security, [{ authCookie: [], sidCookie: [] }]);
    assert.deepEqual(doc.paths['/search']?.get?.security, [{ sidCookie: [] }, {}]);
    assert.deepEqual(doc.paths['/']?.get?.security, []);
  });

  test('only a refused endpoint gets the predicted-credential line; a form-only endpoint with predicted cookies stays untested', () => {
    const auth = { cookies: ['sid'], headers: [], bearer: false, csrf: [], sets: [['cookie:sid']], predicted: true };
    const refused = ExportModel.endpoint({ method: 'GET', path: '/account', auth: { ...auth, anonymous: 'refused', seen: ['anonymous'] } });
    const formOnly = ExportModel.endpoint({ method: 'POST', path: '/search', count: 0, auth: { ...auth, anonymous: 'untested' } });
    const doc = JSON.parse(new OpenApiExporter().export(ExportModel.model([refused, formOnly])).content) as { paths: Record<string, Record<string, { description?: string; security?: unknown[]; 'x-appii-predicted'?: boolean }>> };
    const account = doc.paths['/account']?.get;
    const search = doc.paths['/search']?.post;
    assert.equal(account?.['x-appii-predicted'], true);
    assert.match(account?.description ?? '', /Credential: probably cookie sid \(issued by the login; not observed on this endpoint\)\./);
    assert.equal(search?.['x-appii-predicted'], true);
    assert.doesNotMatch(search?.description ?? '', /Credential:|probably/);
    assert.deepEqual(search?.security?.at(-1), {});
  });

  test('an endpoint that also answered a request without credentials, or was never requested without them, accepts no credentials as an alternative; a refused one does not', () => {
    const f = new CaptureFactory();
    f.document('/', CaptureFactory.page('Home', ''));
    f.exchange({
      method: 'POST',
      url: '/login',
      resourceType: 'document',
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: 'email=a%40example.com&password=correct-horse',
      status: 303,
      responseHeaders: { location: '/', 'set-cookie': ['sid=a1b2c3d4e5f6a7b8; Path=/; HttpOnly', 'auth=feedfacecafebeef; Path=/; HttpOnly'] },
    });
    f.json('GET', '/api/feed', 200, { items: [] });
    f.json('GET', '/api/feed', 200, { items: [] }, { requestHeaders: { cookie: 'sid=a1b2c3d4e5f6a7b8; auth=feedfacecafebeef' } });
    f.json('GET', '/api/private', 401, { error: 'unauthorized' });
    f.json('GET', '/api/private', 200, {}, { requestHeaders: { cookie: 'sid=a1b2c3d4e5f6a7b8; auth=feedfacecafebeef' } });
    f.json('GET', '/api/untested', 200, {}, { requestHeaders: { cookie: 'sid=a1b2c3d4e5f6a7b8; auth=feedfacecafebeef' } });
    f.cookie('sid', 'a1b2c3d4e5f6a7b8', { httpOnly: true });
    f.cookie('auth', 'feedfacecafebeef', { httpOnly: true });
    const doc = JSON.parse(new OpenApiExporter().export(ModelBuilder.create().build(f.capture())).content) as Doc;
    assert.deepEqual(doc.paths['/api/feed']?.get?.security, [{ authCookie: [], sidCookie: [] }, {}]);
    assert.deepEqual(doc.paths['/api/private']?.get?.security, [{ authCookie: [], sidCookie: [] }]);
    assert.deepEqual(doc.paths['/api/untested']?.get?.security, [{ authCookie: [], sidCookie: [] }, {}], 'anonymous access was not tested, so no credential is also offered');
    assert.deepEqual(doc.paths['/']?.get?.security, []);
  });
});
