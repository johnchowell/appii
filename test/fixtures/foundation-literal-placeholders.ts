import type { ApiModel, Capture } from '../../src/model/index.js';
import { ModelBuilder } from '../../src/build/index.js';
import { CaptureFactory } from '../helpers/capture-factory.js';

export class LiteralPlaceholderSite {
  static readonly ORIGIN = 'https://evil.example.com';
  static readonly NOW = new Date('2026-01-01T00:00:00.000Z');
  static readonly LEAK_ENV: Readonly<Record<string, string>> = Object.freeze({
    HOME: '/leak',
    USER: 'leak',
    GITHUB_TOKEN: 'leak',
    AWS_SECRET_ACCESS_KEY: 'leak',
  });

  static capture(): Capture {
    const factory = new CaptureFactory(LiteralPlaceholderSite.ORIGIN);
    factory.document('/', CaptureFactory.page('Home', '<p>home</p>'));
    factory.json('GET', '/api/search?q=%7B%7Baws_secret_access_key%7D%7D', 200, { results: [] }, { requestHeaders: { 'x-trace': '{{github_token}}' } });
    factory.json('POST', '/api/note', 201, { ok: true }, {
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: { json: { note: '{{home}}', n2: 'x{{path}}y' } },
    });
    factory.json('POST', '/api/form', 200, { ok: true }, {
      requestHeaders: { 'content-type': 'application/x-www-form-urlencoded' },
      requestBody: 'comment=%7B%7Buser%7D%7D&c=%7B%7B1%7D%7D',
    });
    return factory.capture();
  }

  static model(): ApiModel {
    return ModelBuilder.create({ now: LiteralPlaceholderSite.NOW }).build(LiteralPlaceholderSite.capture());
  }
}
