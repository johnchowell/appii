import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import { HarExporter } from '../src/export/index.js';
import type { Capture } from '../src/model/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

class IdentifierCase {
  static readonly ORIGIN = 'http://127.0.0.1:47422';
  static readonly BOUNDARY = '----harIdentifierBoundary';
  static readonly SECRET = 'ledger-pass-Q7';
  static readonly SESSION = 'sid=8f3c2a91d4e07b65c1a9f2e4d8b03c7e';

  static capture(identifier: string): Capture {
    const f = new CaptureFactory(IdentifierCase.ORIGIN);
    const html = CaptureFactory.page(
      'Ledger',
      '<form action="/api/session" method="post" enctype="multipart/form-data"><input type="text" name="login" autocomplete="username"><input type="password" name="secret"><input type="hidden" name="workspace" value="acme"><button>Sign in</button></form>',
    );
    f.document('/', html);
    f.snapshot('/', 'Ledger', html);
    const part = (name: string, value: string): string => `--${IdentifierCase.BOUNDARY}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`;
    const profile = { login: identifier, name: 'Ledger User', workspace: 'acme' };
    f.json('POST', '/api/session', 200, { user: profile }, {
      pageUrl: f.url('/'),
      requestHeaders: { 'content-type': `multipart/form-data; boundary=${IdentifierCase.BOUNDARY}` },
      requestBody: `${part('login', identifier)}${part('secret', IdentifierCase.SECRET)}${part('workspace', 'acme')}--${IdentifierCase.BOUNDARY}--\r\n`,
      responseHeaders: { 'set-cookie': `${IdentifierCase.SESSION}; Path=/; HttpOnly; SameSite=Lax` },
    });
    f.json('GET', '/api/me', 200, profile, { pageUrl: f.url('/'), requestHeaders: { cookie: IdentifierCase.SESSION } });
    f.json('GET', '/api/me', 200, profile, { pageUrl: f.url('/'), requestHeaders: { cookie: IdentifierCase.SESSION } });
    return f.capture();
  }
}

describe('the HAR export hides the login identifier in the responses the way the build does (LV4-1)', () => {
  for (const identifier of ['mara.k', 'mira']) {
    test(`identifier ${identifier}: neither the model nor the HAR export holds it, and the HAR keeps the other response fields`, () => {
      const capture = IdentifierCase.capture(identifier);
      const model = ModelBuilder.create({ now: new Date(0) }).build(capture);
      assert.ok(!JSON.stringify(model).includes(identifier), 'the build hides it');
      const har = HarExporter.create().export(model, { capture }).content;
      assert.ok(!har.includes(identifier), har);
      assert.ok(!har.includes(IdentifierCase.SECRET));
      assert.match(har, /\\"login\\":\\"<redacted>\\",\\"name\\":\\"Ledger User\\"/);
      const plain = HarExporter.create().export(model, { capture, redact: false }).content;
      assert.ok(plain.includes(identifier), 'with --no-redact the value stays, as in the build');
    });
  }
});
