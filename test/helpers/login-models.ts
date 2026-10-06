import { ModelBuilder } from '../../src/build/index.js';
import type { AnonymousAccess, ApiModel, Endpoint, EndpointLogin, SeenState } from '../../src/model/index.js';
import { CaptureFactory } from './capture-factory.js';

export interface EndpointMark {
  method: string;
  path: string;
  role?: 'login' | 'logout';
  login?: EndpointLogin;
  anonymous?: AnonymousAccess;
  seen?: SeenState[];
}

export class LoginModels {
  static readonly CSRF = 'Tq9mZr2xVb7nLk4sWd8fHj3c';
  static readonly ANON_SESSION = 'anon.eyJjc3JmIjoiVHE5In0.sig1';
  static readonly AUTH_SESSION = 'auth.eyJjc3JmIjoiVHE5IiwidXNlciI6InJlYWRlciJ9.sig2';
  static readonly REVOKED_SESSION = 'anon.eyJjc3JmIjoiWnA0In0.sig3';
  static readonly USER = 'reader-one';
  static readonly PASSWORD = 'Sesame-Pass-2026';
  static readonly TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJyZWFkZXIifQ.c2lnbmF0dXJl';

  static loginPage(csrf: string): string {
    return CaptureFactory.page(
      'Login',
      `<form action="/login" method="post" accept-charset="utf-8"><input type="hidden" name="csrf_token" value="${csrf}"><label for="username">Username</label><input type="text" id="username" name="username"><label for="password">Password</label><input type="password" id="password" name="password"><input type="submit" value="Login"></form>`,
    );
  }

  static endpoint(model: ApiModel, method: string, path: string): Endpoint {
    const found = model.endpoints.find((candidate) => candidate.method === method && candidate.path === path);
    if (!found) throw new Error(`${method} ${path} is not in ${model.endpoints.map((each) => `${each.method} ${each.path}`).join(', ')}`);
    return found;
  }

  static mark(model: ApiModel, marks: readonly EndpointMark[], cookies: Record<string, { issuedBy?: [string, string][]; revokedBy?: [string, string][] }> = {}): ApiModel {
    for (const mark of marks) {
      const endpoint = LoginModels.endpoint(model, mark.method, mark.path);
      delete endpoint.role;
      delete endpoint.login;
      if (mark.role !== undefined) endpoint.role = mark.role;
      if (mark.login !== undefined) endpoint.login = structuredClone(mark.login);
      if (mark.anonymous !== undefined) endpoint.auth.anonymous = mark.anonymous;
      if (mark.seen !== undefined) endpoint.auth.seen = [...mark.seen];
    }
    for (const endpoint of model.endpoints) {
      if (marks.some((mark) => mark.method === endpoint.method && mark.path === endpoint.path)) continue;
      delete endpoint.role;
      delete endpoint.login;
    }
    for (const cookie of model.cookies) {
      delete cookie.issuedBy;
      delete cookie.revokedBy;
      const wanted = cookies[cookie.name];
      if (!wanted) continue;
      if (wanted.issuedBy) cookie.issuedBy = wanted.issuedBy.map(([method, path]) => LoginModels.endpoint(model, method, path).id);
      if (wanted.revokedBy) cookie.revokedBy = wanted.revokedBy.map(([method, path]) => LoginModels.endpoint(model, method, path).id);
    }
    return model;
  }

  static formLogin(): EndpointLogin {
    return { evidence: 'observed', identifier: 'username', password: 'password', issues: { cookies: ['session'], tokens: [] } };
  }

  static formCapture(origin: string): CaptureFactory {
    const f = new CaptureFactory(origin);
    const html = LoginModels.loginPage(LoginModels.CSRF);
    f.document('/account', '', { status: 302, responseHeaders: { location: '/login' } });
    f.document('/login', html, { responseHeaders: { 'set-cookie': `session=${LoginModels.ANON_SESSION}; HttpOnly; Path=/` } });
    f.snapshot('/login', 'Login', html);
    f.document('/', CaptureFactory.page('Quotes', '<a href="/login">Login</a>'), { requestHeaders: { cookie: `session=${LoginModels.ANON_SESSION}` } });
    return f;
  }

  static anonymous(origin: string): ApiModel {
    const model = ModelBuilder.create({ now: new Date(0) }).build(LoginModels.formCapture(origin).capture());
    return LoginModels.mark(model, [
      { method: 'POST', path: '/login', role: 'login', login: { ...LoginModels.formLogin(), evidence: 'form', issues: { cookies: [], tokens: [] } }, anonymous: 'untested' },
      { method: 'GET', path: '/login', anonymous: 'allowed', seen: ['anonymous'] },
      { method: 'GET', path: '/', anonymous: 'allowed', seen: ['anonymous'] },
    ]);
  }

  static form(origin: string): ApiModel {
    const f = LoginModels.formCapture(origin);
    const auth = `session=${LoginModels.AUTH_SESSION}`;
    f.exchange({
      method: 'POST',
      url: '/login',
      resourceType: 'document',
      pageUrl: f.url('/login'),
      requestHeaders: { cookie: `session=${LoginModels.ANON_SESSION}`, 'content-type': 'application/x-www-form-urlencoded', origin },
      requestBody: `csrf_token=${LoginModels.CSRF}&username=${LoginModels.USER}&password=${LoginModels.PASSWORD}`,
      status: 302,
      responseHeaders: { location: '/', 'set-cookie': `${auth}; HttpOnly; Path=/` },
    });
    f.document('/', CaptureFactory.page('Quotes', '<a href="/logout">Logout</a>'), { requestHeaders: { cookie: auth } });
    f.document('/page/2/', CaptureFactory.page('Quotes 2', '<a href="/logout">Logout</a>'), { requestHeaders: { cookie: auth } });
    f.document('/account', CaptureFactory.page('Account', '<h1>reader</h1>'), { requestHeaders: { cookie: auth } });
    f.document('/logout', '', { status: 302, requestHeaders: { cookie: auth }, responseHeaders: { location: '/', 'set-cookie': `session=${LoginModels.REVOKED_SESSION}; HttpOnly; Path=/` } });
    f.cookie('session', LoginModels.REVOKED_SESSION, { httpOnly: true, sameSite: null });
    const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
    return LoginModels.mark(
      model,
      [
        { method: 'POST', path: '/login', role: 'login', login: LoginModels.formLogin(), anonymous: 'allowed', seen: ['anonymous'] },
        { method: 'GET', path: '/login', anonymous: 'allowed', seen: ['anonymous'] },
        { method: 'GET', path: '/', anonymous: 'allowed', seen: ['anonymous', 'authenticated'] },
        { method: 'GET', path: '/page/{page}/', anonymous: 'untested', seen: ['authenticated'] },
        { method: 'GET', path: '/account', anonymous: 'refused', seen: ['anonymous', 'authenticated'] },
        { method: 'GET', path: '/logout', role: 'logout', anonymous: 'untested', seen: ['authenticated'] },
      ],
      { session: { issuedBy: [['POST', '/login']], revokedBy: [['GET', '/logout']] } },
    );
  }

  static bearer(origin: string): ApiModel {
    const f = new CaptureFactory(origin);
    const app = f.url('/app');
    f.document('/app', CaptureFactory.page('App', '<div id="root"></div>'));
    f.json('GET', '/api/me', 401, { error: 'unauthorized' }, { pageUrl: app });
    f.json('POST', '/api/auth/login', 200, { token: LoginModels.TOKEN, user: { name: LoginModels.USER } }, {
      pageUrl: app,
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: { json: { username: LoginModels.USER, password: LoginModels.PASSWORD } },
    });
    f.json('GET', '/api/me', 200, { name: LoginModels.USER }, { pageUrl: app, requestHeaders: { authorization: `Bearer ${LoginModels.TOKEN}` } });
    f.json('GET', '/api/notes', 200, [{ id: 1, text: 'first' }], { pageUrl: app, requestHeaders: { authorization: `Bearer ${LoginModels.TOKEN}` } });
    const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture());
    return LoginModels.mark(model, [
      { method: 'POST', path: '/api/auth/login', role: 'login', login: { evidence: 'observed', identifier: 'username', password: 'password', issues: { cookies: [], tokens: ['token'] } }, anonymous: 'allowed', seen: ['anonymous'] },
      { method: 'GET', path: '/api/me', anonymous: 'refused', seen: ['anonymous', 'authenticated'] },
      { method: 'GET', path: '/api/notes', anonymous: 'untested', seen: ['authenticated'] },
      { method: 'GET', path: '/app', anonymous: 'allowed', seen: ['anonymous'] },
    ]);
  }
}
