import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder, ModelValidator } from '../src/build/index.js';
import { EndpointDetailPresenter, SummaryPresenter } from '../src/present/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

function capture(): ReturnType<CaptureFactory['capture']> {
  const f = new CaptureFactory();
  f.document('/', CaptureFactory.page('Home', '<img src="/logo.png">'));
  f.exchange({ url: '/logo.png', resourceType: 'image', status: 200, responseHeaders: { 'content-type': 'image/png' }, responseBody: 'png' });
  f.exchange({ url: 'https://cdn.example.net/lib.js', resourceType: 'script', status: 200, responseHeaders: { 'content-type': 'text/javascript' }, responseBody: '1' });
  f.exchange({ method: 'OPTIONS', url: '/api/items', requestHeaders: { 'access-control-request-method': 'POST' }, status: 204 });
  f.json('POST', '/api/items', 201, { id: 1 }, { requestHeaders: { 'content-type': 'application/json' }, requestBody: { json: { name: 'a' } } });
  f.json('POST', '/api/items', 201, { id: 2 }, { requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' }, requestBody: 'name=b' });
  f.exchange({ url: '/api/stream', status: 200, responseHeaders: { 'content-type': 'application/json' }, responseBody: '{"n":1}\n{"n":2}\n' });
  f.exchange({ url: '/api/stream', status: 200, servedBy: 'cache', cacheKind: 'memory', responseHeaders: { 'content-type': 'application/json' }, responseBody: '{"n":1}\n{"n":2}\n' });
  f.exchange({ method: 'GET', url: '/old', resourceType: 'document', status: 301, responseHeaders: { location: '/' } });
  return f.capture();
}

describe('list --show and the build summary show every body, JSON lines, redirects and skipped requests (HTTPBIN-2, HTTPBIN-10, HTTPBIN-5, QTS-6)', () => {
  const model = ModelBuilder.create({ now: new Date(0) }).build(capture());
  const ref = (method: string, path: string): string => model.endpoints.find((endpoint) => endpoint.method === method && endpoint.path === path)?.id ?? `${method} ${path}`;

  test('every request body of an endpoint is listed with its media type', () => {
    const out = new EndpointDetailPresenter({ width: 120 }).render({ model, ref: ref('POST', '/api/items') });
    assert.match(out, /Request body 1 of 2\n-+\nType: application\/json \(json\)/);
    assert.match(out, /Request body 2 of 2\n-+\nType: application\/x-www-form-urlencoded \(form\)/);
  });

  test('a JSON lines response says so, and a redirect says where it leads', () => {
    const stream = new EndpointDetailPresenter({ width: 120 }).render({ model, ref: ref('GET', '/api/stream') });
    assert.match(stream, /200 {2}1 hit {2}application\/json \(json, JSON lines: one value per line\)/);
    const old = new EndpointDetailPresenter({ width: 120 }).render({ model, ref: ref('GET', '/old') });
    assert.match(old, /Redirects to: https:\/\/shop\.example\.com\//);
  });

  test('the summary says which requests were skipped and why', () => {
    assert.deepEqual(model.source.skipped, [
      { reason: 'other-origin', count: 1, examples: ['https://cdn.example.net'] },
      { reason: 'static', count: 1, examples: ['GET /logo.png'] },
      { reason: 'preflight', count: 1, examples: ['OPTIONS /api/items'] },
      { reason: 'cache', count: 1, examples: ['GET /api/stream'] },
    ]);
    assert.deepEqual(new ModelValidator().validate(model), []);
    const summary = new SummaryPresenter({ width: 200 }).render(model);
    assert.match(summary, /Requests: +9 captured, 5 matched to endpoints/);
    assert.match(summary, /Skipped: +1 request to another origin \(https:\/\/cdn\.example\.net\); 1 static asset \(GET \/logo\.png\); 1 CORS preflight \(OPTIONS \/api\/items\); 1 answer from the browser cache \(GET \/api\/stream\)/);
  });
});
