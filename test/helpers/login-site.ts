import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';

export interface SiteRequest {
  method: string;
  path: string;
  cookie: string;
  authorization: string;
  body: string;
}

interface Session {
  csrf: string;
  user?: string;
}

export class LoginSite {
  readonly requests: SiteRequest[] = [];
  readonly sessions = new Map<string, Session>();
  readonly tokens = new Map<string, string>();
  origin = '';
  #server: Server | undefined;

  async start(): Promise<void> {
    this.#server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => this.#handle(req, res, Buffer.concat(chunks).toString('utf8')));
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.origin = `http://127.0.0.1:${(this.#server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.#server?.closeAllConnections();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
  }

  user(sid: string | undefined): string | undefined {
    return sid === undefined ? undefined : this.sessions.get(sid)?.user;
  }

  static cookie(header: string, name: string): string | undefined {
    for (const pair of header.split(/; */)) {
      const eq = pair.indexOf('=');
      if (eq > 0 && pair.slice(0, eq) === name) return pair.slice(eq + 1);
    }
    return undefined;
  }

  #session(user?: string): string {
    const sid = randomBytes(12).toString('hex');
    this.sessions.set(sid, user === undefined ? { csrf: randomBytes(16).toString('hex') } : { csrf: randomBytes(16).toString('hex'), user });
    return sid;
  }

  #handle(req: IncomingMessage, res: ServerResponse, body: string): void {
    const url = new URL(req.url ?? '/', this.origin);
    const cookie = req.headers.cookie ?? '';
    const authorization = req.headers.authorization ?? '';
    this.requests.push({ method: req.method ?? 'GET', path: url.pathname, cookie, authorization, body });
    const sid = LoginSite.cookie(cookie, 'session');
    const session = sid === undefined ? undefined : this.sessions.get(sid);
    const html = (status: number, content: string, headers: Record<string, string> = {}): void => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Quotes</title></head><body>${content}</body></html>`);
    };
    const json = (status: number, value: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    const redirect = (location: string, headers: Record<string, string> = {}): void => {
      res.writeHead(302, { location, ...headers });
      res.end();
    };
    const nav = session?.user === undefined ? '<a href="/login">Login</a>' : '<a href="/logout">Logout</a>';
    if (req.method === 'GET' && url.pathname === '/login') {
      const current = session === undefined ? this.#session() : sid;
      const csrf = this.sessions.get(current ?? '')?.csrf ?? '';
      html(200, `<form action="/login" method="post"><input type="hidden" name="csrf_token" value="${csrf}"><input type="text" id="username" name="username"><input type="password" id="password" name="password"><input type="submit" value="Login"></form>`, {
        'set-cookie': `session=${current ?? ''}; HttpOnly; Path=/`,
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/login') {
      const form = new URLSearchParams(body);
      if (session === undefined || form.get('csrf_token') !== session.csrf) return html(400, '<p>Bad CSRF token</p>');
      const user = form.get('username') ?? '';
      if (user === '' || (form.get('password') ?? '') === '') return html(200, '<p>Missing credentials</p>');
      if (sid !== undefined) this.sessions.delete(sid);
      return redirect('/', { 'set-cookie': `session=${this.#session(user)}; HttpOnly; Path=/` });
    }
    if (req.method === 'GET' && url.pathname === '/logout') {
      if (sid !== undefined) this.sessions.delete(sid);
      return redirect('/', { 'set-cookie': `session=${this.#session()}; HttpOnly; Path=/` });
    }
    if (req.method === 'GET' && url.pathname === '/account') {
      if (session?.user === undefined) return redirect('/login');
      return html(200, `<h1>Account of ${session.user}</h1>${nav}`);
    }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname.startsWith('/page/'))) return html(200, `<h1>Quotes</h1>${nav}`);
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      let parsed: { username?: string; password?: string } = {};
      try {
        parsed = JSON.parse(body) as { username?: string; password?: string };
      } catch {
        return json(400, { error: 'bad json' });
      }
      if (!parsed.username || !parsed.password) return json(401, { error: 'bad credentials' });
      const token = randomBytes(18).toString('base64url');
      this.tokens.set(token, parsed.username);
      return json(200, { token, user: { name: parsed.username } });
    }
    if (req.method === 'GET' && (url.pathname === '/api/me' || url.pathname === '/api/notes')) {
      const bearer = /^Bearer (\S+)$/.exec(authorization)?.[1];
      const user = bearer === undefined ? undefined : this.tokens.get(bearer);
      if (user === undefined) return json(401, { error: 'unauthorized' });
      return json(200, url.pathname === '/api/me' ? { name: user } : [{ id: 1, text: `note of ${user}` }]);
    }
    if (req.method === 'GET' && url.pathname === '/app') return html(200, '<div id="root"></div>');
    html(404, '<p>Not found</p>');
  }
}
