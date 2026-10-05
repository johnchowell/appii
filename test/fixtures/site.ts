import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';

export interface FixtureRequestLog {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface FixtureSite {
  url: string;
  origin: string;
  requests: FixtureRequestLog[];
  sessions: Map<string, { csrf: string; user?: string }>;
  items: Item[];
  close(): Promise<void>;
}

interface Item {
  id: number;
  name: string;
  price: number;
  tags: string[];
  createdAt: string;
}

export const FIXTURE_USER = { email: 'user@example.com', password: 'correct-horse' };

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title></head><body>${body}</body></html>`;
}

export async function startFixtureSite(): Promise<FixtureSite> {
  const sessions = new Map<string, { csrf: string; user?: string }>();
  const authTokens = new Map<string, string>();
  const requests: FixtureRequestLog[] = [];
  const items: Item[] = [
    { id: 1, name: 'Widget', price: 9.99, tags: ['tools'], createdAt: '2026-01-02T03:04:05.000Z' },
    { id: 2, name: 'Gadget', price: 24.5, tags: ['tools', 'electronics'], createdAt: '2026-02-03T04:05:06.000Z' },
    { id: 3, name: 'Doohickey', price: 3, tags: [], createdAt: '2026-03-04T05:06:07.000Z' },
  ];
  let nextId = 4;

  function session(req: IncomingMessage, res: ServerResponse) {
    const cookies = parseCookies(req);
    let sid = cookies.sid;
    if (!sid || !sessions.has(sid)) {
      sid = randomBytes(12).toString('hex');
      sessions.set(sid, { csrf: randomBytes(16).toString('hex') });
      appendCookie(res, `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`);
    }
    return { sid, state: sessions.get(sid)!, cookies };
  }

  function appendCookie(res: ServerResponse, value: string) {
    const prev = res.getHeader('set-cookie');
    const list = Array.isArray(prev) ? prev : prev ? [String(prev)] : [];
    res.setHeader('set-cookie', [...list, value]);
  }

  function currentUser(req: IncomingMessage): string | undefined {
    const auth = parseCookies(req).auth;
    if (auth && authTokens.has(auth)) return authTokens.get(auth);
    const h = req.headers.authorization;
    if (h?.startsWith('Bearer ')) return authTokens.get(h.slice(7));
    return undefined;
  }

  function send(res: ServerResponse, status: number, body: string, type = 'text/html; charset=utf-8') {
    res.statusCode = status;
    res.setHeader('content-type', type);
    res.end(body);
  }

  function json(res: ServerResponse, status: number, value: unknown) {
    send(res, status, JSON.stringify(value), 'application/json; charset=utf-8');
  }

  function loginPage(csrf: string, values: { email?: string } = {}, errors: Record<string, string> = {}, status = 200) {
    const err = (f: string) =>
      errors[f] ? `<div class="error" id="${f}-error" data-field="${f}">${esc(errors[f]!)}</div>` : '';
    return {
      status,
      html: page(
        'Login',
        `<h1>Sign in</h1>
${errors._form ? `<div class="alert alert-danger" role="alert">${esc(errors._form)}</div>` : ''}
<form id="login" action="/login" method="post">
  <input type="hidden" name="csrf_token" value="${esc(csrf)}">
  <label for="email">Email</label>
  <input id="email" type="email" name="email" required autocomplete="username" value="${esc(values.email ?? '')}"${errors.email ? ' aria-invalid="true" aria-describedby="email-error"' : ''}>
  ${err('email')}
  <label for="password">Password</label>
  <input id="password" type="password" name="password" required minlength="8">
  ${err('password')}
  <label><input type="checkbox" name="remember" value="yes"> Remember me</label>
  <button type="submit" name="action" value="login">Sign in</button>
</form>
<form action="/search" method="get" class="search">
  <input type="search" name="q" required placeholder="Search">
  <button>Go</button>
</form>`,
      ),
    };
  }

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const bodyBuf = await readBody(req);
    requests.push({ method: req.method ?? 'GET', path: url.pathname + url.search, headers: req.headers, body: bodyBuf.toString('utf8') });
    const method = req.method ?? 'GET';
    const p = url.pathname;

    try {
      if (method === 'GET' && p === '/') {
        session(req, res);
        appendCookie(res, 'theme=dark; Path=/; Max-Age=3600');
        return send(
          res,
          200,
          page('Home', `<h1>Fixture</h1><a href="/login">Login</a> <a href="/app">App</a> <a href="/products">Products</a> <a href="/signup">Signup</a>`),
        );
      }

      if (method === 'GET' && p === '/login') {
        const { state } = session(req, res);
        const r = loginPage(state.csrf);
        return send(res, r.status, r.html);
      }

      if (method === 'POST' && p === '/login') {
        const { state } = session(req, res);
        const form = new URLSearchParams(bodyBuf.toString('utf8'));
        const origin = req.headers.origin;
        const host = `http://${req.headers.host}`;
        if (origin && origin !== host) return send(res, 403, page('Forbidden', '<p>Cross-origin request blocked</p>'));
        if (form.get('csrf_token') !== state.csrf) {
          const r = loginPage(state.csrf, { email: form.get('email') ?? '' }, { _form: 'Invalid or missing CSRF token' }, 403);
          return send(res, r.status, r.html);
        }
        const errors: Record<string, string> = {};
        const email = form.get('email') ?? '';
        const password = form.get('password') ?? '';
        if (!email) errors.email = 'Email is required';
        else if (!/^[^@\s]+@[^@\s]+$/.test(email)) errors.email = 'Email is not valid';
        if (!password) errors.password = 'Password is required';
        else if (password.length < 8) errors.password = 'Password must be at least 8 characters';
        if (!Object.keys(errors).length && (email !== FIXTURE_USER.email || password !== FIXTURE_USER.password)) {
          errors._form = 'Incorrect email or password';
        }
        if (Object.keys(errors).length) {
          const r = loginPage(state.csrf, { email }, errors, 422);
          return send(res, r.status, r.html);
        }
        const token = randomBytes(16).toString('hex');
        authTokens.set(token, email);
        state.user = email;
        const remember = form.get('remember') === 'yes';
        appendCookie(res, `auth=${token}; Path=/; HttpOnly; SameSite=Lax${remember ? '; Max-Age=86400' : ''}`);
        res.statusCode = 303;
        res.setHeader('location', '/account');
        return res.end();
      }

      if (method === 'GET' && p === '/account') {
        const user = currentUser(req);
        if (!user) {
          res.statusCode = 302;
          res.setHeader('location', '/login?next=%2Faccount');
          return res.end();
        }
        return send(res, 200, page('Account', `<h1 class="welcome">Welcome ${esc(user)}</h1><a href="/logout">Logout</a>`));
      }

      if (method === 'GET' && p === '/logout') {
        appendCookie(res, 'auth=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT');
        res.statusCode = 302;
        res.setHeader('location', '/');
        return res.end();
      }

      if (method === 'GET' && p === '/search') {
        const q = url.searchParams.get('q') ?? '';
        const hits = items.filter((i) => i.name.toLowerCase().includes(q.toLowerCase()));
        return send(
          res,
          200,
          page('Search', `<h1>Results for ${esc(q)}</h1><ul class="results">${hits.map((h) => `<li data-id="${h.id}">${esc(h.name)}</li>`).join('')}</ul>`),
        );
      }

      if (method === 'GET' && p === '/products') {
        return send(
          res,
          200,
          page(
            'Products',
            `<h1>Products</h1><ul id="products">${items
              .map(
                (i) =>
                  `<li class="product" data-id="${i.id}"><a class="name" href="/products/${i.id}">${esc(i.name)}</a> <span class="price">$${i.price.toFixed(2)}</span>${i.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</li>`,
              )
              .join('')}</ul><a class="next" href="/products?page=2">Next</a>`,
          ),
        );
      }

      if (method === 'GET' && p === '/signup') {
        session(req, res);
        return send(
          res,
          200,
          page(
            'Signup',
            `<form id="signup" action="/signup" method="post" enctype="multipart/form-data">
  <input type="text" name="username" required pattern="[a-z0-9_]{3,16}" title="3-16 lowercase letters, digits or underscore">
  <input type="email" name="email" required>
  <input type="number" name="age" min="13" max="120" step="1">
  <input type="url" name="website">
  <input type="date" name="birthday" min="1900-01-01" max="2026-12-31">
  <select name="country" required><option value="">Choose...</option><option value="us">United States</option><option value="ca">Canada</option><option value="xx" disabled>Nowhere</option></select>
  <label><input type="radio" name="plan" value="free" checked> Free</label>
  <label><input type="radio" name="plan" value="pro"> Pro</label>
  <select name="interests" multiple><option value="a" selected>A</option><option value="b">B</option><option value="c" selected>C</option></select>
  <textarea name="bio" maxlength="200">Hello
world</textarea>
  <input type="checkbox" name="terms" required>
  <input type="file" name="avatar" accept="image/*">
  <fieldset disabled><input name="locked" value="nope"></fieldset>
  <input type="text" name="disabled_field" value="x" disabled>
  <input type="text" name="readonly_field" value="ro" readonly>
  <button type="submit" name="intent" value="create">Create</button>
  <button type="submit" name="intent" value="draft" formnovalidate formaction="/signup?draft=1">Save draft</button>
</form>`,
          ),
        );
      }

      if (method === 'POST' && p === '/signup') {
        const ct = req.headers['content-type'] ?? '';
        if (!ct.startsWith('multipart/form-data')) return json(res, 415, { error: 'multipart/form-data required' });
        const fd = await new Request('http://x/', { method: 'POST', headers: { 'content-type': ct }, body: new Uint8Array(bodyBuf) }).formData();
        const errors: Record<string, string[]> = {};
        const username = String(fd.get('username') ?? '');
        if (url.searchParams.get('draft') !== '1') {
          if (!/^[a-z0-9_]{3,16}$/.test(username)) errors.username = ['must be 3-16 lowercase letters, digits or underscore'];
          if (username === 'taken') errors.username = ['has already been taken'];
          if (!fd.get('terms')) errors.terms = ['must be accepted'];
        }
        const fields: Record<string, unknown> = {};
        for (const [k, v] of fd.entries()) {
          const val = typeof v === 'string' ? v : { filename: v.name, type: v.type, size: v.size };
          if (k in fields) {
            const prev = fields[k];
            fields[k] = Array.isArray(prev) ? [...prev, val] : [prev, val];
          } else fields[k] = val;
        }
        if (Object.keys(errors).length) return json(res, 422, { errors, received: fields });
        return json(res, 201, { ok: true, received: fields });
      }

      if (method === 'GET' && p === '/app') {
        const { state } = session(req, res);
        appendCookie(res, `csrf=${state.csrf}; Path=/; SameSite=Strict`);
        return send(
          res,
          200,
          page(
            'App',
            `<h1>App</h1><div id="out"></div><script>
(async () => {
  const csrf = document.cookie.split('; ').find(c => c.startsWith('csrf='))?.slice(5);
  localStorage.setItem('lastVisit', 'today');
  sessionStorage.setItem('tab', 'one');
  const list = await (await fetch('/api/items?page=1&limit=2')).json();
  await fetch('/api/items/1');
  await fetch('/api/items/2');
  await fetch('/api/items/999');
  await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ name: 'Thing', price: 5 }) });
  await fetch('/api/items', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': csrf }, body: JSON.stringify({ price: -1 }) });
  await fetch('/graphql', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ operationName: 'GetItem', query: 'query GetItem($id: ID!) { item(id: $id) { id name } }', variables: { id: '1' } }) });
  const xhr = new XMLHttpRequest();
  xhr.open('GET', '/api/items?page=2&limit=2');
  xhr.onload = () => { document.getElementById('out').textContent = 'done ' + list.items.length; };
  xhr.send();
})();
</script>`,
          ),
        );
      }

      if (p === '/api/items' && method === 'GET') {
        const pageNo = Math.max(1, Number(url.searchParams.get('page') ?? 1));
        const limit = Math.max(1, Number(url.searchParams.get('limit') ?? 10));
        const slice = items.slice((pageNo - 1) * limit, pageNo * limit);
        return json(res, 200, { items: slice, page: pageNo, total: items.length });
      }

      if (p === '/api/items' && method === 'POST') {
        const { state, cookies } = session(req, res);
        const token = req.headers['x-csrf-token'];
        if (!token || (token !== state.csrf && token !== cookies.csrf)) return json(res, 403, { error: 'csrf token mismatch' });
        let body: { name?: unknown; price?: unknown };
        try {
          body = JSON.parse(bodyBuf.toString('utf8'));
        } catch {
          return json(res, 400, { error: 'invalid json' });
        }
        const errors: Record<string, string[]> = {};
        if (typeof body.name !== 'string' || !body.name) errors.name = ['is required'];
        if (typeof body.price !== 'number' || body.price < 0) errors.price = ['must be a non-negative number'];
        if (Object.keys(errors).length) return json(res, 400, { errors });
        const item: Item = { id: nextId++, name: body.name as string, price: body.price as number, tags: [], createdAt: new Date().toISOString() };
        items.push(item);
        return json(res, 201, item);
      }

      const m = /^\/api\/items\/(\d+)$/.exec(p);
      if (m && method === 'GET') {
        const item = items.find((i) => i.id === Number(m[1]));
        return item ? json(res, 200, item) : json(res, 404, { error: 'not found' });
      }
      if (m && method === 'DELETE') {
        const user = currentUser(req);
        if (!user) return json(res, 401, { error: 'unauthorized' });
        const idx = items.findIndex((i) => i.id === Number(m[1]));
        if (idx < 0) return json(res, 404, { error: 'not found' });
        items.splice(idx, 1);
        res.statusCode = 204;
        return res.end();
      }

      if (method === 'GET' && p === '/api/me') {
        const user = currentUser(req);
        return user ? json(res, 200, { email: user }) : json(res, 401, { error: 'unauthorized' });
      }

      if (method === 'POST' && p === '/api/token') {
        const body = JSON.parse(bodyBuf.toString('utf8') || '{}') as { email?: string; password?: string };
        if (body.email !== FIXTURE_USER.email || body.password !== FIXTURE_USER.password) return json(res, 401, { error: 'bad credentials' });
        const token = randomBytes(16).toString('hex');
        authTokens.set(token, body.email);
        return json(res, 200, { access_token: token, token_type: 'Bearer' });
      }

      if (method === 'POST' && p === '/graphql') {
        const body = JSON.parse(bodyBuf.toString('utf8') || '{}') as { operationName?: string; variables?: { id?: string } };
        if (body.operationName === 'GetItem') {
          const item = items.find((i) => String(i.id) === body.variables?.id);
          return json(res, 200, { data: { item: item ? { id: String(item.id), name: item.name } : null } });
        }
        return json(res, 200, { errors: [{ message: 'Unknown operation', path: ['query'] }] });
      }

      if (method === 'GET' && p === '/set-cookies') {
        appendCookie(res, 'plain=1');
        appendCookie(res, 'scoped=2; Path=/api');
        appendCookie(res, 'secureonly=3; Secure; Path=/');
        appendCookie(res, 'lax=4; SameSite=Lax; Path=/');
        appendCookie(res, 'none=5; SameSite=None; Secure; Path=/');
        appendCookie(res, 'expiring=6; Max-Age=60; Path=/');
        appendCookie(res, 'theme=; Path=/; Max-Age=0');
        appendCookie(res, 'quoted="a b"; Path=/');
        return send(res, 200, page('Cookies', '<p>cookies set</p>'));
      }

      if (method === 'GET' && p === '/redirect') {
        const n = Number(url.searchParams.get('n') ?? 1);
        const code = Number(url.searchParams.get('code') ?? 302);
        res.statusCode = code;
        res.setHeader('location', n > 1 ? `/redirect?n=${n - 1}&code=${code}` : (url.searchParams.get('to') ?? '/echo'));
        appendCookie(res, `hop${n}=1; Path=/`);
        return res.end();
      }

      if (p === '/echo') {
        return json(res, 200, {
          method,
          path: p + url.search,
          headers: req.headers,
          body: bodyBuf.toString('utf8'),
          cookies: parseCookies(req),
        });
      }

      if (method === 'GET' && p === '/slow') {
        await new Promise((r) => setTimeout(r, Number(url.searchParams.get('ms') ?? 2000)));
        return send(res, 200, 'slow', 'text/plain');
      }

      return send(res, 404, page('Not found', '<p>Not found</p>'));
    } catch (err) {
      return json(res, 500, { error: String(err) });
    }
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: origin + '/',
    origin,
    requests,
    sessions,
    items,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
