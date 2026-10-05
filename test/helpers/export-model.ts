import type { Page } from 'playwright';
import { ModelBuilder, EndpointFactory } from '../../src/build/index.js';
import { CaptureSession } from '../../src/capture/index.js';
import type { ApiModel, Capture, Endpoint, EndpointKind } from '../../src/model/index.js';
import { FIXTURE_USER, startFixtureSite } from '../fixtures/site.js';
import type { FixtureSite } from '../fixtures/site.js';

export interface ExportFixture {
  site: FixtureSite;
  capture: Capture;
  model: ApiModel;
}

export interface EndpointSpec extends Partial<Omit<Endpoint, 'method' | 'path'>> {
  method: string;
  path: string;
  kind?: EndpointKind;
}

export class ExportModel {
  static readonly NOW = new Date('2026-06-01T12:00:00.000Z');
  static readonly ORIGIN = 'https://shop.example.com';

  static async fixture(): Promise<ExportFixture> {
    const site = await startFixtureSite();
    try {
      const session: CaptureSession = CaptureSession.create({ url: site.url, headless: true, idleMs: 400, script: ExportModel.script(site, () => session.recorder.settled()) });
      const capture = await session.run();
      const model = ModelBuilder.create({ now: ExportModel.NOW }).build(capture);
      return { site, capture, model };
    } catch (err) {
      await site.close();
      throw err;
    }
  }

  static script(site: FixtureSite, settled: () => Promise<void>): (page: Page) => Promise<void> {
    return async (page) => {
      await page.goto(site.origin + '/login');
      await page.evaluate("fetch('/api/me').then((r) => r.text())");
      await page.fill('#email', FIXTURE_USER.email);
      await page.fill('#password', FIXTURE_USER.password);
      await Promise.all([page.waitForURL('**/account'), page.click('#login button[type=submit]')]);
      await page.evaluate("fetch('/api/me').then((r) => r.json())");
      await page.goto(site.origin + '/app');
      await page.waitForFunction("document.getElementById('out') && /^done /.test(document.getElementById('out').textContent)");
      await settled();
      await page.evaluate("fetch('/api/items/3').then((r) => r.json())");
      await settled();
      await page.goto(site.origin + '/signup');
      await page.goto(site.origin + '/products');
    };
  }

  static endpoint(spec: EndpointSpec): Endpoint {
    const origin = spec.origin ?? ExportModel.ORIGIN;
    const base = EndpointFactory.blank({
      method: spec.method,
      origin,
      path: spec.path,
      kind: spec.kind ?? 'json',
      ...(spec.operationName !== undefined ? { operationName: spec.operationName } : {}),
    });
    const id = spec.id ?? `${spec.method.toLowerCase()}-${spec.path.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'root'}`;
    return EndpointFactory.normalize({ ...base, firstParty: true, count: 1, ...spec, origin, id, name: spec.name ?? id.replace(/-([a-z0-9])/g, (_m, c: string) => c.toUpperCase()) });
  }

  static model(endpoints: Endpoint[], extra: Partial<ApiModel> = {}): ApiModel {
    const origins = [...new Set(endpoints.map((endpoint) => endpoint.origin))].sort();
    return {
      version: 1,
      name: 'shop.example.com',
      generatedAt: ExportModel.NOW.toISOString(),
      source: { startUrl: ExportModel.ORIGIN + '/', exchanges: endpoints.reduce((sum, endpoint) => sum + endpoint.count, 0) },
      primaryOrigin: ExportModel.ORIGIN,
      origins,
      endpoints,
      cookies: [],
      forms: [],
      websockets: [],
      ...extra,
    };
  }
}
