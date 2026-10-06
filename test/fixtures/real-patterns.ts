import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface PatternSite {
  origin: string;
  close(): Promise<void>;
}

type Handler = (req: IncomingMessage, res: ServerResponse, url: URL, body: Buffer) => void;

const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function html(res: ServerResponse, body: string, status = 200): void {
  send(res, status, 'text/html; charset=utf-8', body);
}

function json(res: ServerResponse, value: unknown, status = 200, headers: Record<string, string> = {}): void {
  send(res, status, 'application/json', JSON.stringify(value), headers);
}

async function start(handler: Handler): Promise<PatternSite> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      try {
        handler(req, res, url, Buffer.concat(chunks));
      } catch {
        send(res, 500, 'text/plain', 'error');
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

function quotesLayout(main: string, side = ''): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Quotes</title></head><body><div class="container"><div class="row header-box"><div class="col-md-8"><h1><a href="/">Quotes</a></h1></div><div class="col-md-4"><p><a href="/login">Login</a></p></div></div><div class="row"><div class="col-md-8">${main}</div><div class="col-md-4 tags-box">${side}</div></div></div><footer class="footer"><div class="container"><p class="text-muted">Quotes by GoodReads</p></div></footer></body></html>`;
}

function quote(text: string, author: string, tags: readonly string[]): string {
  return `<div class="quote"><span class="text">${text}</span><span>by <small class="author">${author}</small> <a href="/author/${author.replace(/[ .]+/g, '-')}/">(about)</a></span><div class="tags">${tags.map((tag) => `<a class="tag" href="/tag/${tag}/">${tag}</a>`).join(' ')}</div></div>`;
}

export function startQuotesSite(): Promise<PatternSite> {
  const tags = ['love', 'inspirational', 'life', 'humor'];
  const topTags = `<h2>Top Ten tags</h2>${tags.map((tag) => `<span class="tag-item"><a class="tag" href="/tag/${tag}/">${tag}</a></span>`).join('')}`;
  return start((_req, res, url) => {
    const path = url.pathname;
    if (path === '/') return html(res, quotesLayout(quote('A', 'Jane Austen', ['love']) + quote('B', 'J K Rowling', ['life']), topTags));
    if (path === '/login') return html(res, quotesLayout('<form action="/login" method="post"><input name="csrf_token" type="hidden" value="t"><label>Username</label><input name="username"><input type="submit" value="Login"></form>'));
    const tag = /^\/tag\/([a-z-]+)\/(?:page\/([0-9]+)\/)?$/.exec(path);
    if (tag) {
      const items = Array.from({ length: tag[1] === 'love' ? 3 : 1 }, (_, i) => quote(`${tag[1]} ${i}`, 'Jane Austen', [tag[1] ?? '']));
      return html(res, quotesLayout(`<h3>Viewing tag: <a href="/tag/${tag[1]}/page/1/">${tag[1]}</a></h3>${items.join('')}<nav><ul class="pager"><li class="next"><a href="/tag/${tag[1]}/page/2/">Next</a></li></ul></nav>`, topTags));
    }
    const author = /^\/author\/([A-Za-z-]+)\/$/.exec(path);
    if (author) {
      return html(res, quotesLayout(`<div class="author-details"><h3 class="author-title">${author[1]}</h3><p><strong>Born:</strong> <span class="author-born-date">1775</span></p><div class="author-description">About ${author[1]}</div></div>`));
    }
    return html(res, quotesLayout('<p>Not found</p>'), 404);
  });
}

function booksLayout(main: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Books</title></head><body id="default" class="default"><header class="header container-fluid"><div class="page_inner"><div class="row"><div class="col-sm-8 h1"><a href="/index.html">Books to Scrape</a></div></div></div></header><div class="container-fluid page"><div class="page_inner"><ul class="breadcrumb"><li><a href="/index.html">Home</a></li></ul><div class="row">${main}</div></div></div><footer class="footer container-fluid"></footer></body></html>`;
}

export const BOOKS = Object.freeze(['a-light-in-the-attic_1000', 'tipping-the-velvet_999', 'how-to-train-your-dragon-38', 'the-requiem-red_995']);
export const CATEGORIES = Object.freeze(['travel_2', 'mystery_3', 'new-adult_20']);

export function startBooksSite(): Promise<PatternSite> {
  const listing = (title: string): string =>
    booksLayout(
      `<aside class="sidebar col-sm-4 col-md-3"><ul class="nav nav-list">${CATEGORIES.map((category) => `<li><a href="/catalogue/category/books/${category}/index.html">${category}</a></li>`).join('')}</ul></aside><div class="col-sm-8 col-md-9"><div class="page-header action"><h1>${title}</h1></div><section><ol class="row">${BOOKS.map((book) => `<li class="col-xs-6"><article class="product_pod"><h3><a href="/catalogue/${book}/index.html">${book}</a></h3><p class="price_color">10</p></article></li>`).join('')}</ol><ul class="pager"><li class="next"><a href="/catalogue/page-2.html">next</a></li></ul></section></div>`,
    );
  return start((_req, res, url) => {
    const path = url.pathname;
    if (path === '/' || path === '/index.html') return html(res, listing('All products'));
    if (/^\/catalogue\/page-[0-9]+\.html$/.test(path)) return html(res, listing('All products'));
    const category = /^\/catalogue\/category\/books\/([a-z0-9_-]+)\/(?:index|page-[0-9]+)\.html$/.exec(path);
    if (category && CATEGORIES.includes(category[1] ?? '')) return html(res, listing(category[1] ?? ''));
    const book = /^\/catalogue\/([a-z0-9_-]+)\/index\.html$/.exec(path);
    if (book && BOOKS.includes(book[1] ?? '')) {
      return html(res, booksLayout(`<article class="product_page"><div class="row"><div class="col-sm-6"><img src="data:," alt="cover"></div><div class="col-sm-6 product_main"><h1>${book[1]}</h1><p class="price_color">10</p></div></div><table class="table table-striped"><tr><th>UPC</th><td>x</td></tr></table></article>`));
    }
    return html(res, '<html><head><title>404 Not Found</title></head><body><center><h1>404 Not Found</h1></center><hr><center>nginx</center></body></html>', 404);
  });
}

export const TITLES = Object.freeze(['Charles_Babbage', 'Computer', 'Mathematician']);

function wikiPage(title: string, editable: boolean): string {
  const links = [...TITLES, 'Ada_Lovelace'].map((other) => `<a href="/wiki/${other}" class="preview">${other.replace(/_/g, ' ')}</a>`).join(', ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title} - Wiki</title></head><body class="skin-vector ns-0 page-${title} rootpage-${title}${editable ? ' mw-editable' : ''}"><div class="mw-page-container"><div class="mw-page-container-inner"><div class="vector-column-start"><nav class="vector-main-menu">menu</nav></div><div class="mw-content-container"><main id="content" class="mw-body"><header class="mw-body-header"><h1 id="firstHeading" class="firstHeading">${title}</h1></header><div id="bodyContent" class="vector-body"><div id="mw-content-text" class="mw-body-content"><div class="mw-parser-output"><p>${title} links to ${links}.</p>${editable ? '<table class="infobox"><tr><td>x</td></tr></table>' : ''}</div></div></div></main></div></div></div><script>
for (const a of document.querySelectorAll('a.preview')) if (a.getAttribute('href') !== location.pathname) fetch('/api/rest_v1/page/summary/' + a.getAttribute('href').slice(6)).then((r) => r.json());
fetch('/w/rest.php/v1/search/title?q=' + encodeURIComponent(document.title.slice(0, 3)) + '&limit=2').then((r) => r.json());
</script></body></html>`;
}

export function startWikiSite(): Promise<PatternSite> {
  return start((_req, res, url) => {
    const path = url.pathname;
    if (path === '/wiki/Main_Page') {
      return html(res, `<!doctype html><html><head><title>Main Page</title></head><body class="page-Main_Page"><div id="mp-upper"><div id="mp-left" class="MainPageBG"><h2>Featured</h2><a href="/wiki/Ada_Lovelace">Ada</a></div></div><div id="mp-lower"><div class="mp-box">news</div></div></body></html>`);
    }
    const wiki = /^\/wiki\/([A-Za-z_]+)$/.exec(path);
    if (wiki) return html(res, wikiPage(wiki[1] ?? '', wiki[1] !== 'Ada_Lovelace'));
    const summary = /^\/api\/rest_v1\/page\/summary\/([A-Za-z_]+)$/.exec(path);
    if (summary) {
      const title = summary[1] ?? '';
      const thumbnail = title === 'Computer' ? { thumbnail: { source: 'https://upload.example/c.png', width: 320, height: 200 } } : {};
      return json(res, { type: 'standard', title: title.replace(/_/g, ' '), displaytitle: title.replace(/_/g, ' '), titles: { canonical: title, normalized: title.replace(/_/g, ' ') }, pageid: title.length, lang: 'en', extract: `${title} is a topic.`, ...thumbnail });
    }
    if (path === '/w/rest.php/v1/search/title') {
      const q = url.searchParams.get('q') ?? '';
      return json(res, { pages: [0, 1].map((i) => ({ id: i, key: `${q}_${i}`, title: `${q} ${i}`, excerpt: q, matched_title: null, anchor: null, description: 'd', thumbnail: { mimetype: 'image/png', width: 60, height: 40, duration: null, url: '//u/x.png' } })) });
    }
    return html(res, '<html><body>missing</body></html>', 404);
  });
}

export const ARTICLES = Object.freeze([
  { slug: 'how-to-learn-javascript-efficiently', title: 'How to learn JavaScript efficiently', author: 'johndoe' },
  { slug: 'react-hooks-best-practices', title: 'React Hooks best practices', author: 'janesmith' },
  { slug: 'building-scalable-apis-with-node-js', title: 'Building scalable APIs with Node.js', author: 'mikewilson' },
]);

function article(slug: string): Record<string, unknown> | undefined {
  const found = ARTICLES.find((candidate) => candidate.slug === slug);
  if (!found) return undefined;
  return { slug: found.slug, title: found.title, description: 'd', body: 'b', tagList: ['x'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', favorited: false, favoritesCount: 1, author: { username: found.author, bio: null, image: 'https://img.example/u.png', following: false } };
}

export function startConduitSite(): Promise<PatternSite> {
  return start((req, res, url) => {
    const path = url.pathname;
    if (path === '/' || path.startsWith('/article/') || path.startsWith('/profile/')) {
      return html(res, `<!doctype html><html><head><meta charset="utf-8"><title>Conduit</title></head><body><app-root></app-root><script>
window.api = (path) => fetch('/api' + path, { headers: { accept: 'application/json' } }).then((r) => r.json());
</script></body></html>`);
    }
    if (path === '/api/articles') return json(res, { articles: ARTICLES.map((item) => article(item.slug)), articlesCount: ARTICLES.length });
    if (path === '/api/articles/feed') {
      if (!req.headers.authorization) return json(res, { errors: { token: ['is missing'] } }, 401);
      return json(res, { articles: [], articlesCount: 0 });
    }
    if (path === '/api/tags') return json(res, { tags: ['x', 'y'] });
    const comments = /^\/api\/articles\/([a-z0-9-]+)\/comments$/.exec(path);
    if (comments && article(comments[1] ?? '')) return json(res, { comments: [{ id: 1, body: 'nice', createdAt: '2026-01-01T00:00:00.000Z', author: { username: 'johndoe', bio: null, image: null, following: false } }] });
    const one = /^\/api\/articles\/([a-z0-9-]+)$/.exec(path);
    const found = one ? article(one[1] ?? '') : undefined;
    if (found) return json(res, { article: found });
    const profile = /^\/api\/profiles\/([a-z0-9]+)$/.exec(path);
    if (profile) return json(res, { profile: { username: profile[1], bio: null, image: 'https://img.example/u.png', following: false } });
    return json(res, { errors: { body: ['not found'] } }, 404);
  });
}

export function startEchoSite(): Promise<PatternSite> {
  return start((req, res, url, body) => {
    const path = url.pathname;
    if (path === '/') {
      return html(res, `<!doctype html><html><head><meta charset="utf-8"><title>Echo</title></head><body><form id="order" method="post" action="/post"><input name="custname" value="Ann"><select name="size"><option value="small" selected>S</option></select><button type="submit">Order</button></form></body></html>`);
    }
    if (path === '/post' && req.method === 'POST') return json(res, { method: 'POST', contentType: req.headers['content-type'] ?? '', length: body.length });
    if (path === '/image/png') return send(res, 200, 'image/png', PNG);
    if (path === '/logo.png') return send(res, 200, 'image/png', PNG);
    const range = /^\/range\/([0-9]+)$/.exec(path);
    if (range) {
      const data = Buffer.alloc(Number(range[1]), 97);
      const match = /^bytes=([0-9]+)-([0-9]+)$/.exec(String(req.headers.range ?? ''));
      if (!match) return send(res, 200, 'application/octet-stream', data, { 'accept-ranges': 'bytes' });
      const start = Number(match[1]);
      const end = Math.min(Number(match[2]), data.length - 1);
      return send(res, 206, 'application/octet-stream', data.subarray(start, end + 1), { 'content-range': `bytes ${start}-${end}/${data.length}` });
    }
    const etag = /^\/etag\/([a-z]+)$/.exec(path);
    if (etag) {
      if (req.headers['if-none-match'] === `"${etag[1]}"`) {
        res.writeHead(304, { etag: `"${etag[1]}"` });
        return res.end();
      }
      return json(res, { etag: etag[1] }, 200, { etag: `"${etag[1]}"` });
    }
    const stream = /^\/stream\/([0-9]+)$/.exec(path);
    if (stream) {
      const lines = Array.from({ length: Number(stream[1]) }, (_, id) => JSON.stringify({ id, url: `${url.origin}${path}`, args: {} })).join('\n') + '\n';
      return send(res, 200, 'application/json', lines);
    }
    const bytes = /^\/bytes\/([0-9]+)$/.exec(path);
    if (bytes) return send(res, 200, 'application/octet-stream', Buffer.alloc(Number(bytes[1]), 1));
    const status = /^\/status\/([0-9]+)$/.exec(path);
    if (status) return send(res, Number(status[1]), 'text/plain', '');
    return send(res, 404, 'text/plain', 'missing');
  });
}
