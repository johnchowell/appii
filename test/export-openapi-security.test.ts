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
    const cookies = ExportModel.endpoint({ method: 'GET', path: '/api/items', auth: { cookies: ['auth', 'sid'], headers: [], anonymous: 'untested', bearer: false, csrf: [] } });
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

  test('an endpoint that also answered a request without credentials accepts no credentials as an alternative', () => {
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
    f.json('GET', '/api/private', 200, {}, { requestHeaders: { cookie: 'sid=a1b2c3d4e5f6a7b8; auth=feedfacecafebeef' } });
    f.cookie('sid', 'a1b2c3d4e5f6a7b8', { httpOnly: true });
    f.cookie('auth', 'feedfacecafebeef', { httpOnly: true });
    const doc = JSON.parse(new OpenApiExporter().export(ModelBuilder.create().build(f.capture())).content) as Doc;
    assert.deepEqual(doc.paths['/api/feed']?.get?.security, [{ authCookie: [], sidCookie: [] }, {}]);
    assert.deepEqual(doc.paths['/api/private']?.get?.security, [{ authCookie: [], sidCookie: [] }]);
    assert.deepEqual(doc.paths['/']?.get?.security, []);
  });
});
