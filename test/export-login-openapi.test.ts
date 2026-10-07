import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenApiExporter, OpenApiYamlExporter } from '../src/export/index.js';
import type { ApiModel } from '../src/model/index.js';
import { LoginModels } from './helpers/login-models.js';

type Operation = {
  operationId: string;
  description: string;
  security?: Record<string, string[]>[];
  parameters?: { name: string; in: string; required: boolean }[];
  'x-appii-role'?: string;
  'x-appii-login'?: unknown;
  'x-appii-anonymous'?: string;
  'x-appii-endpoint'?: { seen?: string[] };
};
type Doc = { paths: Record<string, Record<string, Operation>>; components?: { securitySchemes?: Record<string, { description: string }> } };

const ORIGIN = 'https://quotes.example.test';

function openapi(model: ApiModel): Doc {
  return JSON.parse(new OpenApiExporter().export(model).content) as Doc;
}

function op(doc: Doc, path: string, method: string): Operation {
  const found = doc.paths[path]?.[method];
  assert.ok(found, `${method} ${path} in ${Object.keys(doc.paths).join(', ')}`);
  return found;
}

describe('OpenAPI documents the login and logout and the anonymous state (L3, QL-2, QL-3, QL-4, QL-7)', () => {
  test('the login operation needs no security, carries x-appii-role login and its fields, and says what it issues', () => {
    const doc = openapi(LoginModels.form(ORIGIN));
    const login = op(doc, '/login', 'post');
    assert.deepEqual(login.security, []);
    assert.equal(login['x-appii-role'], 'login');
    assert.deepEqual(login['x-appii-login'], { evidence: 'observed', identifier: 'username', password: 'password', issues: { cookies: ['session'], tokens: [] } });
    assert.equal(login['x-appii-anonymous'], 'allowed');
    assert.match(login.description, /Login: sends the user name in `username` and the password in `password`, and issues the cookie `session`\./);
  });

  test('the logout operation carries x-appii-role logout and says which cookie it revokes', () => {
    const doc = openapi(LoginModels.form(ORIGIN));
    const logout = op(doc, '/logout', 'get');
    assert.equal(logout['x-appii-role'], 'logout');
    assert.match(logout.description, /Logout: revokes the cookie `session`\./);
    assert.doesNotMatch(logout.operationId, /Page$/);
  });

  test('the credential cookie scheme names the login operation that issues it and the logout operation that revokes it', () => {
    const doc = openapi(LoginModels.form(ORIGIN));
    const scheme = doc.components?.securitySchemes?.sessionCookie;
    assert.ok(scheme, JSON.stringify(doc.components));
    const login = op(doc, '/login', 'post').operationId;
    const logout = op(doc, '/logout', 'get').operationId;
    assert.match(scheme.description, new RegExp(`The login operation ${login} \\(POST /login\\) issues it\\.`));
    assert.match(scheme.description, new RegExp(`The logout operation ${logout} \\(GET /logout\\) revokes it\\.`));
  });

  test('every operation a security scheme names is an operationId of the document with its METHOD and path, never a model id (QL3-3)', () => {
    for (const [model, names] of [[LoginModels.form(ORIGIN), true], [LoginModels.anonymous(ORIGIN), false], [LoginModels.bearer(ORIGIN), true]] as const) {
      const doc = openapi(model);
      const operations = new Map<string, string>();
      for (const [path, item] of Object.entries(doc.paths)) for (const [method, operation] of Object.entries(item)) operations.set(operation.operationId, `${method.toUpperCase()} ${path}`);
      const schemes = Object.values(doc.components?.securitySchemes ?? {});
      let named = 0;
      for (const scheme of schemes) {
        for (const match of scheme.description.matchAll(/([A-Za-z_][A-Za-z0-9_]*) \(([A-Z]+) ([^)\s]+)\)/g)) {
          assert.equal(operations.get(match[1] ?? ''), `${match[2]} ${match[3]}`, scheme.description);
          named++;
        }
        for (const endpoint of model.endpoints) assert.doesNotMatch(scheme.description, new RegExp(`(^|[ ,])${endpoint.id}([ ,.]|$)`), scheme.description);
      }
      assert.equal(named > 0, names);
    }
    const scheme = openapi(LoginModels.form(ORIGIN)).components?.securitySchemes?.sessionCookie;
    assert.match(scheme?.description ?? '', /^Session cookie session \(HttpOnly\), set by getLoginPage \(GET \/login\), postLogin \(POST \/login\), getLogout \(GET \/logout\)\. /);
  });

  test('an endpoint never requested without the credential offers {} and says that anonymous access was not tested; a refused one is strict', () => {
    const doc = openapi(LoginModels.form(ORIGIN));
    const page = op(doc, '/page/{page}/', 'get');
    assert.deepEqual(page.security, [{ sessionCookie: [] }, {}]);
    assert.equal(page['x-appii-anonymous'], 'untested');
    assert.match(page.description, /Anonymous access: not tested\./);
    assert.deepEqual(page['x-appii-endpoint']?.seen, ['authenticated']);
    const account = op(doc, '/account', 'get');
    assert.deepEqual(account.security, [{ sessionCookie: [] }]);
    assert.equal(account['x-appii-anonymous'], 'refused');
    assert.match(account.description, /Anonymous access: refused\./);
    assert.match(account.description, new RegExp(`Log in first with ${op(doc, '/login', 'post').operationId} \\(POST /login\\)\\.`));
    const home = op(doc, '/', 'get');
    assert.deepEqual(home.security, [{ sessionCookie: [] }, {}]);
    assert.match(home.description, /Anonymous access: allowed\./);
  });

  test('the bearer scheme names the login operation and the response field that holds the token', () => {
    const doc = openapi(LoginModels.bearer(ORIGIN));
    const login = op(doc, '/api/auth/login', 'post');
    assert.deepEqual(login.security, []);
    assert.equal(login['x-appii-role'], 'login');
    assert.match(login.description, /issues the bearer token in the response field `token`/);
    const scheme = doc.components?.securitySchemes?.bearerAuth;
    assert.match(scheme?.description ?? '', new RegExp(`The login operation ${login.operationId} \\(POST /api/auth/login\\) returns it in the response field token\\.`));
    assert.deepEqual(op(doc, '/api/me', 'get').security, [{ bearerAuth: [] }]);
    assert.deepEqual(op(doc, '/api/notes', 'get').security, [{ bearerAuth: [] }, {}]);
  });

  test('an anonymous capture documents the login form that was not submitted, without security', () => {
    const doc = openapi(LoginModels.anonymous(ORIGIN));
    const login = op(doc, '/login', 'post');
    assert.deepEqual(login.security, []);
    assert.equal(login['x-appii-role'], 'login');
    assert.equal(login['x-appii-anonymous'], 'untested');
    assert.match(login.description, /Login: sends the user name in `username` and the password in `password`; known from a form; not submitted yet\./);
  });

  test('a CSRF header of a login is a required header parameter, since the login has no security requirement', () => {
    const model = LoginModels.bearer(ORIGIN);
    const login = LoginModels.endpoint(model, 'POST', '/api/auth/login');
    login.auth.csrf = [{ location: 'header', name: 'X-CSRF-Token', source: 'meta', sourceName: 'csrf-token', sourceUrl: `${ORIGIN}/app` }];
    const doc = openapi(model);
    const operation = op(doc, '/api/auth/login', 'post');
    assert.deepEqual(operation.security, []);
    assert.ok(operation.parameters?.some((parameter) => parameter.in === 'header' && parameter.name === 'X-CSRF-Token' && parameter.required), JSON.stringify(operation.parameters));
  });

  test('the YAML document carries the same login role', () => {
    const yaml = new OpenApiYamlExporter().export(LoginModels.form(ORIGIN)).content;
    assert.match(yaml, /x-appii-role: login/);
    assert.match(yaml, /x-appii-role: logout/);
  });
});
