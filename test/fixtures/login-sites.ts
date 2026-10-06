import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface LoginRequestLog {
  method: string;
  path: string;
  cookie: string;
  authorization: string;
  contentType: string;
  body: string;
}

export interface LoginSite {
  origin: string;
  requests: LoginRequestLog[];
  close(): Promise<void>;
}

export interface TokenSiteOptions {
  bearer?: boolean;
}

export const LOGIN_USER = { username: 'appii-user', password: 'Sesame-Pass-2026' };

export const BAD_PASSWORD = 'Wrong-Pass-2026';

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void | Promise<void>;

class LoginServer {
  static escape(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  static cookies(req: IncomingMessage): Record<string, string> {
    const out: Record<string, string> = {};
    for (const part of (req.headers.cookie ?? '').split(';')) {
      const eq = part.indexOf('=');
      if (eq > 0) out[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    }
    return out;
  }

  static page(title: string, body: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${LoginServer.escape(title)}</title></head><body>${body}</body></html>`;
  }

  static send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8'): void {
    res.statusCode = status;
    res.setHeader('content-type', type);
    res.end(body);
  }

  static json(res: ServerResponse, status: number, value: unknown): void {
    LoginServer.send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
  }

  static redirect(res: ServerResponse, location: string, status = 302): void {
    res.statusCode = status;
    res.setHeader('location', location);
    res.end();
  }

  static async start(handler: Handler): Promise<LoginSite> {
    const requests: LoginRequestLog[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks).toString('utf8');
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      requests.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        cookie: req.headers.cookie ?? '',
        authorization: req.headers.authorization ?? '',
        contentType: req.headers['content-type'] ?? '',
        body,
      });
      try {
        await handler(req, res, url, body);
      } catch (err) {
        LoginServer.json(res, 500, { error: String(err) });
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
      origin: `http://127.0.0.1:${port}`,
      requests,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }
}

export async function startFormLoginSite(): Promise<LoginSite> {
  const sessions = new Map<string, { csrf: string; user?: string }>();
  const issue = (res: ServerResponse, state: { csrf: string; user?: string }): string => {
    const id = randomBytes(18).toString('base64url');
    sessions.set(id, state);
    res.setHeader('set-cookie', `session=${id}; HttpOnly; Path=/`);
    return id;
  };
  const current = (req: IncomingMessage, res: ServerResponse): { csrf: string; user?: string } => {
    const id = LoginServer.cookies(req).session;
    const found = id === undefined ? undefined : sessions.get(id);
    if (found) return found;
    const fresh = { csrf: randomBytes(20).toString('hex') };
    issue(res, fresh);
    return fresh;
  };
  const nav = (user: string | undefined): string => (user ? `<a href="/account">Account</a> <a href="/logout">Logout</a>` : '<a href="/login">Login</a>');
  const form = (csrf: string, error = ''): string =>
    LoginServer.page(
      'Login',
      `${error ? `<p class="error">${LoginServer.escape(error)}</p>` : ''}<form action="/login" method="post" accept-charset="utf-8">
  <input type="hidden" name="csrf_token" value="${csrf}">
  <label for="username">Username</label> <input type="text" id="username" name="username">
  <label for="password">Password</label> <input type="password" id="password" name="password">
  <input type="submit" value="Login">
</form>`,
    );
  return LoginServer.start((req, res, url, body) => {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (method === 'GET' && path === '/') {
      const state = current(req, res);
      return LoginServer.send(res, 200, LoginServer.page('Quotes', `<h1>Quotes</h1>${nav(state.user)} <a href="/page/2/">Next</a>`));
    }
    if (method === 'GET' && /^\/page\/\d+\/$/.test(path)) {
      const state = current(req, res);
      return LoginServer.send(res, 200, LoginServer.page('Quotes', `<h1>Page</h1>${nav(state.user)}`));
    }
    if (method === 'GET' && path === '/login') return LoginServer.send(res, 200, form(current(req, res).csrf));
    if (method === 'POST' && path === '/login') {
      const state = current(req, res);
      const fields = new URLSearchParams(body);
      if (fields.get('csrf_token') !== state.csrf) return LoginServer.send(res, 400, form(state.csrf, 'CSRF token missing or wrong'));
      const username = fields.get('username') ?? '';
      const password = fields.get('password') ?? '';
      if (username === '' || password === '' || password === BAD_PASSWORD) return LoginServer.send(res, 401, form(state.csrf, 'Wrong user name or password'));
      issue(res, { csrf: state.csrf, user: username });
      return LoginServer.redirect(res, '/');
    }
    if (method === 'GET' && path === '/account') {
      const state = current(req, res);
      if (!state.user) return LoginServer.redirect(res, '/login');
      return LoginServer.send(res, 200, LoginServer.page('Account', `<h1>Account of ${LoginServer.escape(state.user)}</h1>${nav(state.user)}`));
    }
    if (method === 'GET' && path === '/logout') {
      const state = current(req, res);
      issue(res, { csrf: state.csrf });
      return LoginServer.redirect(res, '/');
    }
    return LoginServer.send(res, 404, LoginServer.page('Not found', '<p>Not found</p>'));
  });
}

export async function startSpaLoginSite(): Promise<LoginSite> {
  const sessions = new Map<string, string>();
  const csrf = new Map<string, string>();
  const user = (req: IncomingMessage): string | undefined => {
    const id = LoginServer.cookies(req).sid;
    return id === undefined ? undefined : sessions.get(id);
  };
  const shell = LoginServer.page(
    'SPA',
    `<div id="app">Loading...</div><script>
(async () => {
  await new Promise((resolve) => setTimeout(resolve, 600));
  const session = await fetch('/api/me');
  if (session.ok) { document.getElementById('app').textContent = 'Welcome back ' + (await session.json()).username; return; }
  const { token } = await (await fetch('/api/csrf')).json();
  const host = document.createElement('div');
  host.id = 'login-host';
  document.getElementById('app').replaceChildren(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = '<form id="login"><input type="hidden" name="csrf" value="' + token + '"><input name="username" autocomplete="username"><input type="password" name="password" autocomplete="current-password"><button disabled>Sign in</button></form>';
  const form = root.getElementById('login');
  const button = form.querySelector('button');
  form.addEventListener('input', () => { button.disabled = !(form.elements.username.value && form.elements.password.value); });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const res = await fetch('/api/login', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': data.csrf }, body: JSON.stringify({ username: data.username, password: data.password }) });
    if (!res.ok) { form.elements.password.value = ''; return; }
    const me = await (await fetch('/api/me')).json();
    history.pushState({}, '', '/dashboard');
    const items = await (await fetch('/api/items')).json();
    document.getElementById('app').textContent = 'Welcome ' + me.username + ' (' + items.items.length + ' items)';
  });
})();
</script>`,
  );
  return LoginServer.start((req, res, url, body) => {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (method === 'GET' && (path === '/' || path === '/dashboard')) return LoginServer.send(res, 200, shell);
    if (method === 'GET' && path === '/api/csrf') {
      let id = LoginServer.cookies(req).pre;
      if (id === undefined || !csrf.has(id)) {
        id = randomBytes(12).toString('hex');
        csrf.set(id, randomBytes(16).toString('hex'));
        res.setHeader('set-cookie', `pre=${id}; HttpOnly; Path=/; SameSite=Lax`);
      }
      return LoginServer.json(res, 200, { token: csrf.get(id) });
    }
    if (method === 'POST' && path === '/api/login') {
      const pre = LoginServer.cookies(req).pre;
      if (pre === undefined || req.headers['x-csrf-token'] !== csrf.get(pre)) return LoginServer.json(res, 403, { error: 'csrf' });
      const data = JSON.parse(body || '{}') as { username?: string; password?: string };
      if (data.username !== LOGIN_USER.username || data.password !== LOGIN_USER.password) return LoginServer.json(res, 401, { error: 'bad credentials' });
      const id = randomBytes(18).toString('hex');
      sessions.set(id, data.username);
      res.setHeader('set-cookie', `sid=${id}; HttpOnly; Path=/; SameSite=Lax`);
      return LoginServer.json(res, 200, { ok: true });
    }
    if (method === 'GET' && path === '/api/me') {
      const name = user(req);
      return name ? LoginServer.json(res, 200, { username: name }) : LoginServer.json(res, 401, { error: 'unauthorized' });
    }
    if (method === 'GET' && path === '/api/items') {
      return user(req) ? LoginServer.json(res, 200, { items: [{ id: 1, name: 'Widget' }] }) : LoginServer.json(res, 401, { error: 'unauthorized' });
    }
    return LoginServer.json(res, 404, { error: 'not found' });
  });
}

export async function startTokenLoginSite(options: TokenSiteOptions = {}): Promise<LoginSite> {
  const tokens = new Map<string, string>();
  const bearer = options.bearer === true;
  const user = (req: IncomingMessage): string | undefined => {
    const header = req.headers.authorization ?? '';
    const token = bearer ? (header.startsWith('Bearer ') ? header.slice(7) : undefined) : LoginServer.cookies(req).token;
    return token === undefined ? undefined : tokens.get(token);
  };
  const page = LoginServer.page(
    'Sign in',
    `<main id="out"></main><form id="signin"><label>User <input name="username" autocomplete="username"></label><label>Password <input name="password" type="password"></label><button type="submit">Sign in</button></form><script>
const form = document.getElementById('signin');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value }) });
  const data = await res.json();
  const headers = ${bearer ? "data.token ? { authorization: 'Bearer ' + data.token } : {}" : '{}'};
  const profile = await fetch('/api/profile', { headers });
  document.getElementById('out').textContent = res.status + ' ' + profile.status;
  if (res.ok) form.remove();
});
</script>`,
  );
  return LoginServer.start((req, res, url, body) => {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (method === 'GET' && path === '/signin') return LoginServer.send(res, 200, page);
    if (method === 'POST' && path === '/api/auth/login') {
      const data = JSON.parse(body || '{}') as { username?: string; password?: string };
      if (data.username !== LOGIN_USER.username || data.password !== LOGIN_USER.password) return LoginServer.json(res, 401, { error: 'bad credentials' });
      const token = randomBytes(24).toString('base64url');
      tokens.set(token, data.username);
      if (bearer) return LoginServer.json(res, 200, { token, user: { name: data.username } });
      res.setHeader('set-cookie', `token=${token}; HttpOnly; Path=/; SameSite=Lax`);
      return LoginServer.json(res, 200, { user: { name: data.username } });
    }
    if (method === 'GET' && path === '/api/profile') {
      const name = user(req);
      return name ? LoginServer.json(res, 200, { name }) : LoginServer.json(res, 401, { error: 'unauthorized' });
    }
    return LoginServer.json(res, 404, { error: 'not found' });
  });
}

export async function startFormVariantsSite(): Promise<LoginSite> {
  const pages: Record<string, string> = {
    '/owner': `<form id="real" action="/submit" method="post"></form>
<form id="search" action="/search"><input name="q"><button>Search</button></form>
<label>User <input name="user" form="real"></label>
<label>Pass <input type="password" name="pass" form="real"></label>
<select name="tenant" form="real"><option value="a">Alpha</option><option value="b">Beta</option></select>
<label><input type="checkbox" name="remember" value="yes" form="real"> Remember</label>
<label><input type="radio" name="realm" value="staff" form="real"> Staff</label><label><input type="radio" name="realm" value="guest" form="real" checked> Guest</label>
<button type="button" form="real" name="help">Help</button>
<button form="real" name="go" value="first">First</button>
<button form="real" name="go" value="second">Second</button>`,
    '/enter': `<form action="/submit" method="post"><input type="hidden" name="user" value="preset"><input type="password" name="pass"><input type="checkbox" name="trust" value="1"></form>`,
    '/enter-blocked': `<form action="/submit" method="post"><input name="user"><input type="password" name="pass"></form>`,
    '/hidden-default': `<form action="/submit" method="post"><input name="user"><input type="password" name="pass"><input type="submit" hidden name="kind" value="hidden-default"></form>`,
    '/twice': `<div style="display:none"><form action="/submit?copy=hidden" method="post"><input name="user"><input type="password" name="pass"><button>Go</button></form></div>
<form action="/submit?copy=shown" method="post"><input name="user"><input type="password" name="pass"><button>Go</button></form>`,
    '/late': `<div id="slot"></div><script>setTimeout(() => { document.getElementById('slot').innerHTML = '<form action="/submit" method="post"><input name="user"><input type="password" name="pass"><button>Go</button></form>'; }, 1500);</script>`,
    '/get': `<form action="/submit" method="get"><input name="user"><input type="password" name="pass"><button>Go</button></form>`,
    '/nothing': `<form action="/search"><input name="q"><button>Search</button></form><input name="loose">`,
    '/invisible': `<form action="/submit" method="post" style="display:none"><input name="user"><input type="password" name="pass"><button>Go</button></form>`,
  };
  return LoginServer.start((req, res, url, body) => {
    const html = pages[url.pathname];
    if (html !== undefined) return LoginServer.send(res, 200, LoginServer.page('Variants', html));
    if (url.pathname === '/submit') {
      const entries = (req.method === 'POST' ? [...new URLSearchParams(body)] : [...url.searchParams]).map(([name, value]) => `<li data-name="${LoginServer.escape(name)}">${LoginServer.escape(value)}</li>`);
      return LoginServer.send(res, 200, LoginServer.page('Done', `<ul id="received">${entries.join('')}</ul>`));
    }
    return LoginServer.send(res, 404, LoginServer.page('Not found', ''));
  });
}

export async function startLateLoginPageSite(): Promise<LoginSite> {
  const csrf = new Map<string, string>();
  const shell = LoginServer.page(
    'Sign in',
    `<div id="app">Loading...</div><script>
fetch('/api/config').then((res) => res.json()).then((config) => {
  setTimeout(() => {
    document.getElementById('app').innerHTML = '<form method="post" action="/session"><input type="hidden" name="_csrf" value="' + config.csrf + '"><input type="email" name="email" autocomplete="email"><input type="password" name="pass" autocomplete="current-password"><button>Sign in</button></form>';
  }, 400);
});
</script>`,
  );
  return LoginServer.start(async (req, res, url) => {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (method === 'GET' && path === '/login') return LoginServer.send(res, 200, shell);
    if (method === 'GET' && path === '/about') return LoginServer.send(res, 200, LoginServer.page('About', '<p>About us</p>'));
    if (method === 'GET' && path === '/api/config') {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const id = randomBytes(12).toString('hex');
      csrf.set(id, randomBytes(16).toString('hex'));
      res.setHeader('set-cookie', `sid=${id}; HttpOnly; Path=/; SameSite=Lax`);
      return LoginServer.json(res, 200, { csrf: csrf.get(id) });
    }
    return LoginServer.json(res, 404, { error: 'not found' });
  });
}

export interface NavigatingTokenSiteOptions {
  bearer?: boolean;
  xhr?: boolean;
}

export async function startNavigatingTokenSite(options: NavigatingTokenSiteOptions = {}): Promise<LoginSite> {
  const tokens = new Map<string, string>();
  const bearer = options.bearer === true;
  const send = options.xhr === true
    ? `new Promise((resolve) => { const xhr = new XMLHttpRequest(); xhr.open('POST', '/api/auth/login'); xhr.setRequestHeader('content-type', 'application/json'); xhr.onload = () => resolve({ ok: xhr.status === 200, data: JSON.parse(xhr.responseText) }); xhr.send(body); })`
    : `fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body }).then(async (res) => ({ ok: res.ok, data: await res.json() }))`;
  const signin = LoginServer.page(
    'Sign in',
    `<form id="signin"><label>User <input name="username" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button type="submit">Sign in</button></form><script>
const form = document.getElementById('signin');
form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = JSON.stringify({ username: form.elements.username.value, password: form.elements.password.value });
  const result = await ${send};
  if (!result.ok) return;
  if (result.data.accessToken) sessionStorage.setItem('accessToken', result.data.accessToken);
  location.href = '/home';
});
</script>`,
  );
  const home = LoginServer.page(
    'Home',
    `<h1 id="hello">...</h1><script>
const token = sessionStorage.getItem('accessToken');
fetch('/api/profile', { headers: token ? { authorization: 'Bearer ' + token } : {} }).then((res) => res.json()).then((data) => { document.getElementById('hello').textContent = data.name ?? 'anonymous'; });
</script>`,
  );
  const user = (req: IncomingMessage): string | undefined => {
    const header = req.headers.authorization ?? '';
    const token = bearer ? (header.startsWith('Bearer ') ? header.slice(7) : undefined) : LoginServer.cookies(req).auth_token;
    return token === undefined ? undefined : tokens.get(token);
  };
  return LoginServer.start((req, res, url, body) => {
    const method = req.method ?? 'GET';
    const path = url.pathname;
    if (method === 'GET' && path === '/signin') return LoginServer.send(res, 200, signin);
    if (method === 'GET' && path === '/home') return LoginServer.send(res, 200, home);
    if (method === 'POST' && path === '/api/auth/login') {
      const data = JSON.parse(body || '{}') as { username?: string; password?: string };
      if (data.username !== LOGIN_USER.username || data.password !== LOGIN_USER.password) return LoginServer.json(res, 401, { error: 'bad credentials' });
      const token = randomBytes(24).toString('hex');
      tokens.set(token, data.username);
      if (bearer) return LoginServer.json(res, 200, { accessToken: token, tokenType: 'Bearer', user: { name: data.username } });
      res.setHeader('set-cookie', `auth_token=${token}; HttpOnly; Path=/; SameSite=Lax`);
      return LoginServer.json(res, 200, { ok: true, user: { name: data.username } });
    }
    if (method === 'GET' && path === '/api/profile') {
      const name = user(req);
      return name ? LoginServer.json(res, 200, { name, plan: 'free' }) : LoginServer.json(res, 401, { error: 'unauthorized' });
    }
    return LoginServer.json(res, 404, { error: 'not found' });
  });
}
