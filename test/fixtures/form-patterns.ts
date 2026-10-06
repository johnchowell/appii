import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FormSite {
  origin: string;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, body: string) => void;

export const AUTHORS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  'Albert Einstein': Object.freeze(['change', 'deep-thoughts', 'thinking']),
  'Jane Austen': Object.freeze(['aliteracy', 'books', 'classic']),
});

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
}

function html(res: ServerResponse, body: string, status = 200, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function json(res: ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function start(handler: Handler): Promise<FormSite> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        handler(req, res, new URL(req.url ?? '/', 'http://localhost'), Buffer.concat(chunks).toString('utf8'));
      } catch {
        res.writeHead(500);
        res.end();
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  };
}

function filterForm(author: string, tag: string): string {
  const option = (value: string, chosen: string): string => `<option value="${value}"${value === chosen ? ' selected' : ''}>${value}</option>`;
  const authors = ['----------', ...Object.keys(AUTHORS)].map((value) => option(value, author)).join('');
  const tags = ['----------', ...(AUTHORS[author] ?? [])].map((value) => option(value, tag)).join('');
  return `<form action="/filter.aspx" method="post" name="filterform" id="filterform">
<select name="author" id="author" onchange="__doPostBack()">${authors}</select>
<select name="tag" id="tag">${tags}</select>
<input type="hidden" name="__VIEWSTATE" value="ZTdmOTAzN2VhZGNl">
<input type="submit" name="submit_button" value="Search">
</form><script>function __doPostBack() { document.forms.filterform.submit(); }</script>`;
}

export function startPostbackSite(): Promise<FormSite> {
  return start((req, res, url, body) => {
    if (url.pathname === '/search.aspx') return html(res, page('Search', filterForm('----------', '----------')));
    if (url.pathname === '/filter.aspx' && req.method === 'POST') {
      const data = new URLSearchParams(body);
      const author = data.get('author') ?? '----------';
      const results = data.has('submit_button') ? `<p class="quote">${author} ${data.get('tag')}</p>` : '';
      return html(res, page('Search', filterForm(author, data.get('tag') ?? '----------') + results));
    }
    return html(res, page('Missing', 'missing'), 404);
  });
}

function listing(title: string): string {
  const items = Array.from({ length: 20 }, (_, i) => `<li class="col-xs-6"><article class="product_pod"><h3><a href="/catalogue/book_${i}/index.html">Book ${i}</a></h3><form><button type="submit" class="btn btn-primary btn-block">Add to basket</button></form></article></li>`).join('');
  return page(
    title,
    `<div id="default"><form method="get" class="form-horizontal"><div style="display:none"></div><strong>1000</strong> results - showing <strong>1</strong> to <strong>20</strong>.</form><ol class="row">${items}</ol><ul class="pager"><li class="next"><a href="/catalogue/page-2.html">next</a></li></ul></div>`,
  );
}

export function startShopSite(): Promise<FormSite> {
  return start((_req, res, url) => {
    if (url.pathname === '/index.html' || url.pathname === '/catalogue/page-2.html') return html(res, listing('All products'));
    return html(res, page('404 Not Found', '<h1>404 Not Found</h1>'), 404);
  });
}

const PREFERENCES = ['theme', 'width', 'size']
  .map((group) => `<form class="skin-client-prefs"><input type="radio" name="skin-client-pref-${group}-group" value="1" checked><input type="radio" name="skin-client-pref-${group}-group" value="0"></form>`)
  .join('');

const SEARCH = '<form id="searchform" action="/w/index.php"><input type="search" name="search" id="searchInput"><input type="hidden" name="title" value="Special:Search"><button>Search</button></form>';

const BANNER = `<form id="frb-form" method="get" action="/wiki/Main_Page"><input type="radio" name="amount" value="2.75" checked><input type="radio" name="amount" value="10"><input type="text" name="otherAmount"><button name="frb-methods" value="card">Card</button><button name="frb-methods" value="paypal">PayPal</button></form>
<script>document.getElementById('frb-form').addEventListener('submit', (event) => event.preventDefault());</script>`;

export function startWikiFormsSite(): Promise<FormSite> {
  return start((_req, res, url) => {
    if (url.pathname === '/wiki/Main_Page') return html(res, page('Main Page', SEARCH + BANNER + PREFERENCES + '<a href="/wiki/Mech_engineer">engineer</a>'));
    if (url.pathname === '/wiki/Mech_engineer') {
      return html(res, page('Mechanical engineering', `${SEARCH}${PREFERENCES}<script>history.replaceState(null, '', '/wiki/Mech_engineering');</script>`));
    }
    const article = /^\/wiki\/([A-Za-z_]+)$/.exec(url.pathname);
    if (article) return html(res, page(article[1] ?? '', SEARCH + PREFERENCES));
    if (url.pathname === '/w/index.php') {
      const term = (url.searchParams.get('search') ?? '').replace(/ /g, '_');
      res.writeHead(302, { location: `/wiki/${term}`, 'cache-control': 'no-store' });
      res.end();
      return;
    }
    return html(res, page('Missing', 'missing'), 404);
  });
}

const VIEWS: Readonly<Record<string, string>> = Object.freeze({
  '/': '<div class="home"><p>Global feed</p></div>',
  '/login':
    '<h1>Sign in</h1><form><fieldset><input name="email" type="text" placeholder="Email"><input name="password" type="password" placeholder="Password" minlength="8"></fieldset><button type="submit" disabled>Sign in</button></form>',
  '/register':
    '<h1>Sign up</h1><form><input name="username" placeholder="Username"><input name="email" type="text" placeholder="Email"><input name="password" type="password" placeholder="Password"><button type="submit" disabled>Sign up</button></form>',
});

export function startRoutesSite(): Promise<FormSite> {
  const shell = page(
    'Conduit',
    `<nav><a href="/" data-route>Home</a> <a href="/login" data-route>Sign in</a> <a href="/register" data-route>Sign up</a></nav><main id="app"></main>
<script type="module">
const views = ${JSON.stringify(VIEWS)};
const app = document.getElementById('app');
function render() {
  app.innerHTML = views[location.pathname] || views['/'];
  const form = app.querySelector('form');
  if (!form) return;
  const button = form.querySelector('button');
  form.addEventListener('input', () => { button.disabled = [...form.querySelectorAll('input')].some((input) => input.value === ''); });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const user = Object.fromEntries(new FormData(form));
    const path = location.pathname === '/login' ? '/api/users/login' : '/api/users';
    fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user }) }).then((r) => r.json()).then(() => window.go('/'));
  });
}
window.go = (path) => { history.pushState({}, '', path); render(); };
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-route]');
  if (!link) return;
  event.preventDefault();
  window.go(link.getAttribute('href'));
});
render();
</script>`,
  );
  return start((req, res, url) => {
    if (url.pathname === '/api/users/login' && req.method === 'POST') return json(res, { user: { email: 'u@example.com', token: 'jwt' } });
    if (url.pathname === '/api/users' && req.method === 'POST') return json(res, { user: { username: 'u', token: 'jwt' } });
    if (url.pathname.startsWith('/api/')) return json(res, { errors: { body: ['not found'] } }, 404);
    return html(res, shell);
  });
}
