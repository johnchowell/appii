import { ModelBuilder } from '../../src/build/index.js';
import type { ApiModel } from '../../src/model/index.js';
import { CaptureFactory } from './capture-factory.js';

export class PresentModels {
  static readonly NOW = new Date('2026-01-01T00:00:00.000Z');
  static readonly ORIGIN = 'https://app.example.org';
  static readonly THIRD_PARTY = 'https://collect.tracker.net';
  static readonly TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.c2lnbmF0dXJl';
  static readonly ESCAPE = '\x1b[31mred\x1b[0m';
  static readonly USERS = ['3f2b8c1e-4a5d-4e6f-8a9b-0c1d2e3f4a5b', '7a6b5c4d-3e2f-4a1b-9c8d-7e6f5a4b3c2d', '0f1e2d3c-4b5a-4968-8776-655443322110'];

  static fixture(): ApiModel {
    return ModelBuilder.create({ now: PresentModels.NOW }).build(CaptureFactory.fixture().capture);
  }

  static mixed(): ApiModel {
    const f = new CaptureFactory(PresentModels.ORIGIN);
    const page = f.url('/dashboard');
    const bearer = { authorization: `Bearer ${PresentModels.TOKEN}`, accept: 'application/json' };
    f.document('/dashboard', CaptureFactory.page('Dashboard', '<h1>Dashboard</h1>'), {
      responseHeaders: {
        'set-cookie': ['__Host-session=s3cr3tvalue0123456789; Path=/; Secure; HttpOnly; SameSite=Strict', 'lang=fr; Path=/; Max-Age=86400'],
      },
    });
    for (const id of PresentModels.USERS) {
      f.json('GET', `/api/v1/users/${id}`, 200, { id, name: 'Zo\u00eb \u00c5ngstr\u00f6m', roles: ['admin'], profile: { address: { city: 'Malm\u00f6', geo: { lat: 55.6, lng: 13 } } } }, {
        pageUrl: page,
        requestHeaders: bearer,
      });
    }
    f.json('GET', '/api/v1/orders?status=open&sort=desc', 200, [{ id: 1, total: 9.5, lines: [{ sku: 'A-1', qty: 2 }] }], {
      pageUrl: page,
      requestHeaders: { 'x-api-key': 'k-1234567890abcdef', 'x-trace': PresentModels.ESCAPE, accept: 'application/json' },
    });
    f.json('GET', '/api/v1/orders?status=closed', 500, { error: 'boom' }, {
      pageUrl: page,
      requestHeaders: { 'x-api-key': 'k-1234567890abcdef', 'x-trace': PresentModels.ESCAPE, accept: 'application/json' },
    });
    f.json('POST', '/api/v1/orders', 201, { id: 2, status: 'open' }, {
      pageUrl: page,
      requestHeaders: { ...bearer, 'content-type': 'application/json' },
      requestBody: {
        json: {
          customer: { name: 'Ana', address: { street: 'Main', city: 'X', geo: { lat: 1.5, lng: 2.5, precision: { meters: 3, source: { kind: 'gps', device: { id: 'd1' } } } } } },
          lines: [{ sku: 'A-1', qty: 2, options: [{ key: 'color', value: 'red' }] }],
          note: 'leave at door',
          gift: false,
        },
      },
    });
    f.exchange({
      method: 'DELETE',
      url: `/api/v1/users/${PresentModels.USERS[0]}`,
      pageUrl: page,
      requestHeaders: bearer,
      status: 204,
    });
    f.json('GET', '/api/v1/organizations/42/projects/77/environments/production-eu-west-1/deployments/latest/artifacts', 200, { items: [] }, {
      pageUrl: page,
      requestHeaders: bearer,
    });
    f.json('POST', `${PresentModels.THIRD_PARTY}/v2/collect?tid=UA-1`, 204, undefined, {
      pageUrl: page,
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: { json: { event: 'view', page: '/dashboard' } },
    });
    f.websocket('wss://app.example.org/live', [
      { direction: 'sent', at: '2026-01-01T00:00:05.000Z', opcode: 'text', data: '{"type":"subscribe","channel":"orders"}' },
      { direction: 'received', at: '2026-01-01T00:00:06.000Z', opcode: 'text', data: '{"type":"order","id":3}' },
    ], page);
    f.cookie('__Host-session', 's3cr3tvalue0123456789', { secure: true, httpOnly: true, sameSite: 'Strict' });
    f.cookie('lang', 'fr', { sameSite: null, expires: (CaptureFactory.EPOCH + 86_400_000) / 1000 });
    f.cookie('_ga', 'GA1.2.3456789.1234567890', { domain: '.example.org', hostOnly: false, sameSite: 'None', secure: true, expires: (CaptureFactory.EPOCH + 63_072_000_000) / 1000 });
    return ModelBuilder.create({ now: PresentModels.NOW, allOrigins: true }).build(f.capture({ startUrl: page }));
  }

  static empty(): ApiModel {
    return ModelBuilder.create({ now: PresentModels.NOW, name: 'empty' }).build(new CaptureFactory(PresentModels.ORIGIN).capture());
  }
}
