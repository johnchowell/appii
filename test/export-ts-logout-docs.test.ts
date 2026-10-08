import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { TypeScriptExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { LoginModels } from './helpers/login-models.js';

class LogoutDocs {
  static readonly ORIGIN = 'https://notes.example.test';

  static doc(model: ApiModel, method: string): string {
    const source = new TypeScriptExporter().export(model).content;
    const at = source.indexOf(`  async ${method}(`);
    assert.ok(at > 0, source);
    const start = source.lastIndexOf('/**', at);
    return source.slice(start, at);
  }

  static bearer(): ApiModel {
    const model = LoginModels.bearer(LogoutDocs.ORIGIN);
    const me = LoginModels.endpoint(model, 'GET', '/api/me');
    model.endpoints.push({ ...structuredClone(me), id: 'post-api-logout', name: 'postLogout', key: 'POST /api/logout', method: 'POST', path: '/api/logout', role: 'logout' });
    return model;
  }
}

describe('the TypeScript logout docs say only what the capture shows the logout revokes (QL4-4)', () => {
  test('a cookie session: the logout docs name the revoked cookie and the cookie jar, and say nothing about a bearer token', () => {
    const doc = LogoutDocs.doc(LoginModels.form(LogoutDocs.ORIGIN), 'getLogout');
    assert.match(doc, /\* Logout: revokes the cookie session\. The cookie jar of the client takes the new cookies\.\n/);
    assert.doesNotMatch(doc, /bearer/i);
  });

  test('a bearer login (pattern c): the logout docs say that the client forgets the token, and nothing about a cookie it revokes', () => {
    const doc = LogoutDocs.doc(LogoutDocs.bearer(), 'postLogout');
    assert.match(doc, /\* Logout: ends the session\. The client forgets the bearer token that a login returned\.\n/);
    assert.doesNotMatch(doc, /cookie jar/);
  });

  test('a logout with no revoked cookie and no bearer login says only that it ends the session', () => {
    const model = LoginModels.form(LogoutDocs.ORIGIN);
    for (const cookie of model.cookies) cookie.revokedBy = [];
    const doc = LogoutDocs.doc(model, 'getLogout');
    assert.match(doc, /\* Logout: ends the session\.\n/);
    assert.doesNotMatch(doc, /bearer|cookie jar/i);
  });
});
