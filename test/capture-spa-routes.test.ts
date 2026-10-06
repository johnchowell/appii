import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { chromium } from 'playwright';
import type { Browser, BrowserContext, Page } from 'playwright';
import { CaptureSession, PageSnapshotter } from '../src/capture/index.js';
import { ModelBuilder } from '../src/build/index.js';
import type { PageSnapshot } from '../src/model/index.js';
import { PageServers } from './fixtures/capture-pages.js';
import type { PageServer } from './fixtures/capture-pages.js';

const VIEWS: Record<string, string> = {
  '/': '<div class="home"><p>Global feed</p></div>',
  '/login':
    '<h1>Sign in</h1><form><fieldset><input name="email" type="email" placeholder="Email" required><input name="password" type="password" placeholder="Password" required></fieldset><button type="submit">Sign in</button></form>',
  '/register':
    '<h1>Sign up</h1><form><input name="username" placeholder="Username" required><input name="email" type="email" required><input name="password" type="password" required><button type="submit">Sign up</button></form>',
  '/settings': '<h1>Settings</h1><form><input name="image" type="url"><textarea name="bio"></textarea><button>Update</button></form>',
  '/editor': '<h1>Editor</h1>',
};

const spa = (extra: string): string =>
  PageServers.html(
    'Conduit',
    `<nav><a href="/" data-route>Home</a> <a href="/login" data-route>Sign in</a> <a href="/register" data-route>Sign up</a></nav><main id="app"></main>${extra}
<script type="module">
const views = ${JSON.stringify(VIEWS)};
const app = document.getElementById('app');
function render() {
  Promise.resolve().then(() => {
    if (location.pathname === '/editor') {
      history.replaceState({}, '', '/register');
      return render();
    }
    app.innerHTML = views[location.pathname] || views['/'];
    if (location.pathname === '/') fetch('/api/articles');
  });
}
window.go = (path) => { history.pushState({}, '', path); render(); };
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-route]');
  if (!link) return;
  event.preventDefault();
  window.go(link.getAttribute('href'));
});
addEventListener('popstate', render);
render();
</script>`,
  );

const HASH_APP = PageServers.html(
  'Hash app',
  `<nav><a href="#/">Home</a> <a href="#/login">Sign in</a></nav><main id="app"></main>
<script>
const views = ${JSON.stringify(VIEWS)};
const app = document.getElementById('app');
function render() { app.innerHTML = views[location.hash.slice(1) || '/'] || views['/']; }
addEventListener('hashchange', render);
render();
</script>`,
);

const WIDGETS = PageServers.html(
  'Widgets',
  `<main id="app"><ul id="list"></ul><div id="slot"></div></main>
<script>
const list = document.getElementById('list');
const slot = document.getElementById('slot');
window.addItems = (count) => {
  for (let i = 0; i < count; i++) {
    const li = document.createElement('li');
    li.innerHTML = '<form action="/basket/add" method="post"><input type="hidden" name="product" value="' + (list.children.length + 1) + '"><button>Add to basket</button></form>';
    list.append(li);
  }
};
window.burst = (count) => new Promise((resolve) => {
  let made = 0;
  const step = () => {
    const form = document.createElement('form');
    form.action = '/burst/' + made;
    form.innerHTML = '<input name="field' + made + '">';
    slot.append(form);
    made++;
    if (made < count) setTimeout(step, 10); else resolve();
  };
  step();
});
window.rerender = () => { slot.innerHTML = slot.innerHTML; };
window.showComments = () => { slot.innerHTML = '<form id="comment"><textarea name="body" required></textarea><button>Post</button></form>'; };
window.clearSlot = () => { slot.innerHTML = ''; };
window.addItems(3);
</script>`,
);

let server: PageServer;
let browser: Browser;

const stream = async (_req: IncomingMessage, res: ServerResponse): Promise<void> => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.write('<!doctype html><html><head><meta charset="utf-8"><title>Slow</title></head><body><form id="slow" action="/slow-post" method="post"><input name="first">');
  await new Promise((resolve) => setTimeout(resolve, 900));
  res.end('<input name="second"></form><p>done</p></body></html>');
};

before(async () => {
  const routes: Record<string, (req: IncomingMessage, res: ServerResponse) => void | Promise<void>> = {};
  for (const path of Object.keys(VIEWS)) routes[path] = (_req, res) => PageServers.send(res, 200, 'text/html; charset=utf-8', spa(''));
  routes['/login?slow=1'] = (_req, res) => PageServers.send(res, 200, 'text/html; charset=utf-8', spa('<img src="/slow.png" alt="">'));
  routes['/tail'] = (_req, res) =>
    PageServers.send(res, 200, 'text/html; charset=utf-8', PageServers.html('Tail', `<p>${'news '.repeat(2000)}</p><img src="/slow.png" alt=""><form action="/subscribe"><input name="email"><button>Subscribe</button></form>`));
  routes['/slow.png'] = (_req, res) => {
    setTimeout(() => PageServers.send(res, 404, 'text/plain', 'none'), 1500);
  };
  routes['/api/articles'] = (_req, res) => PageServers.send(res, 200, 'application/json', '{"articles":[]}');
  routes['/hash'] = (_req, res) => PageServers.send(res, 200, 'text/html; charset=utf-8', HASH_APP);
  routes['/widgets'] = (_req, res) => PageServers.send(res, 200, 'text/html; charset=utf-8', WIDGETS);
  routes['/slow'] = stream;
  server = await PageServers.start(routes);
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function until(check: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return check();
}

const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function withForm(snapshots: readonly PageSnapshot[], url: string, field: string): PageSnapshot[] {
  const owned = new RegExp(`<(?:input|textarea|select)[^>]* name="${field}"[^>]* data-appii-form-owner="\\d+"`);
  return snapshots.filter((s) => s.url === url && owned.test(s.html));
}

async function session(options: ConstructorParameters<typeof PageSnapshotter>[0], run: (page: Page, snapshotter: PageSnapshotter) => Promise<void>): Promise<PageSnapshotter> {
  const context: BrowserContext = await browser.newContext();
  const snapshotter = new PageSnapshotter(options);
  try {
    await snapshotter.attach(context);
    const page = await context.newPage();
    await snapshotter.prepare(page);
    await run(page, snapshotter);
    await snapshotter.settled();
    snapshotter.detach();
  } finally {
    await context.close();
  }
  return snapshotter;
}

describe('PageSnapshotter on client-side routes', () => {
  test('records the forms of pushState routes that the session leaves again, and the model keeps them', async () => {
    const capture = await CaptureSession.create({
      url: server.url('/'),
      headless: true,
      idleMs: 300,
      script: async (page) => {
        await page.waitForSelector('main .home');
        await pause(600);
        await page.click('nav a[href="/login"]');
        await page.waitForSelector('form input[name=password]');
        await pause(800);
        await page.click('nav a[href="/register"]');
        await page.waitForSelector('form input[name=username]');
        await pause(800);
        await page.click('nav a[href="/"]');
        await page.waitForSelector('main .home');
        await pause(400);
      },
    }).run();
    assert.equal(withForm(capture.pages, server.url('/login'), 'password').length, 1, JSON.stringify(capture.pages.map((p) => p.url)));
    assert.equal(withForm(capture.pages, server.url('/register'), 'username').length, 1);
    const forms = ModelBuilder.create().build(capture).forms;
    const fieldsOf = (url: string): string[][] => forms.filter((f) => f.pageUrl === url).map((f) => f.fields.map((field) => field.name));
    assert.deepEqual(fieldsOf(server.url('/login')), [['email', 'password']]);
    assert.deepEqual(fieldsOf(server.url('/register')), [['username', 'email', 'password']]);
  });

  test('records routes reached by replaceState redirects, popstate traversals and hash changes', async () => {
    const snapshotter = await session({ debounceMs: 100 }, async (page, snapshotter) => {
      await page.goto(server.url('/'));
      await page.waitForSelector('main .home');
      await pause(300);
      await page.evaluate(() => (window as unknown as { go(path: string): void }).go('/editor'));
      await page.waitForSelector('form input[name=username]');
      assert.equal(page.url(), server.url('/register'));
      assert.ok(await until(() => withForm(snapshotter.snapshots, server.url('/register'), 'username').length > 0), 'replaceState redirect');
      await page.evaluate(() => {
        history.pushState({}, '', '/settings');
        history.pushState({}, '', '/');
      });
      await page.goBack();
      await page.waitForSelector('form textarea[name=bio]');
      assert.ok(await until(() => withForm(snapshotter.snapshots, server.url('/settings'), 'bio').length > 0), 'popstate traversal');
      await page.goto(server.url('/hash'));
      await pause(300);
      await page.click('a[href="#/login"]');
      await page.waitForSelector('form input[name=password]');
      assert.ok(await until(() => withForm(snapshotter.snapshots, server.url('/hash#/login'), 'password').length > 0), 'hash route');
      await page.click('a[href="#/"]');
    });
    assert.equal(withForm(snapshotter.snapshots, server.url('/settings'), 'bio').length, 1);
  });

  test('records a form that appears later on the same URL, once per debounce window', async () => {
    const snapshotter = await session({ debounceMs: 150 }, async (page, snapshotter) => {
      await page.goto(server.url('/widgets'));
      await pause(400);
      await snapshotter.settled();
      const loaded = snapshotter.snapshots.length;
      await page.evaluate(() => (window as unknown as { showComments(): void }).showComments());
      assert.ok(await until(() => withForm(snapshotter.snapshots, server.url('/widgets'), 'body').length > 0), 'form shown after load');
      await page.evaluate(() => (window as unknown as { clearSlot(): void }).clearSlot());
      assert.equal(snapshotter.snapshots.length, loaded + 1);
      await page.evaluate(() => (window as unknown as { burst(count: number): Promise<void> }).burst(6));
      assert.ok(await until(() => snapshotter.snapshots.length > loaded + 1), 'burst snapshot');
      await pause(400);
      assert.equal(snapshotter.snapshots.length, loaded + 2, 'one snapshot for a burst of forms inside one debounce window');
      const burst = snapshotter.snapshots.at(-1)!;
      assert.equal(withForm([burst], server.url('/widgets'), 'field5').length, 1, 'the snapshot waits for the burst to end');
    });
    assert.equal(withForm(snapshotter.snapshots, server.url('/widgets'), 'body').length, 1);
  });

  test('takes no new snapshot when forms of an already recorded shape are re-rendered or appended', async () => {
    await session({ debounceMs: 80 }, async (page, snapshotter) => {
      await page.goto(server.url('/widgets'));
      await page.evaluate(() => (window as unknown as { burst(count: number): Promise<void> }).burst(2));
      await pause(400);
      await snapshotter.settled();
      const before = snapshotter.snapshots.length;
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => (window as unknown as { addItems(count: number): void }).addItems(20));
        await page.evaluate(() => (window as unknown as { rerender(): void }).rerender());
        await pause(150);
      }
      await pause(250);
      assert.equal(snapshotter.snapshots.length, before);
    });
  });

  test('takes no new snapshot for fragment navigations that change nothing in the document', async () => {
    for (const world of [undefined, async () => undefined]) {
      await session({ debounceMs: 80, ...(world ? { world } : {}) }, async (page, snapshotter) => {
        await page.goto(server.url('/widgets'));
        await pause(300);
        await snapshotter.settled();
        const before = snapshotter.snapshots.length;
        for (const fragment of ['#list', '#slot', '#list']) {
          await page.evaluate((hash) => {
            location.hash = hash;
          }, fragment);
          await pause(150);
        }
        await page.goBack();
        await pause(250);
        await snapshotter.settled();
        assert.equal(snapshotter.snapshots.length, before, world ? 'without hooks' : 'with hooks');
      });
    }
  });

  test('records routes that the user visits before the page finishes loading', async () => {
    await session({ debounceMs: 50 }, async (page, snapshotter) => {
      await page.goto(server.url('/login?slow=1'), { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('form input[name=password]');
      assert.ok(await until(() => withForm(snapshotter.snapshots, server.url('/login?slow=1'), 'password').length > 0), 'the first route');
      await page.evaluate(() => (window as unknown as { go(path: string): void }).go('/register'));
      await page.waitForSelector('form input[name=username]');
      assert.ok(await until(() => withForm(snapshotter.snapshots, server.url('/register'), 'username').length > 0), 'the second route');
      assert.equal(await page.evaluate(() => document.readyState), 'interactive');
      await page.evaluate(() => (window as unknown as { go(path: string): void }).go('/'));
    });
  });

  test('takes no extra snapshot before the load event for forms that the parser inserted', async () => {
    let loadedAt = 0;
    const snapshotter = await session({ debounceMs: 50 }, async (page) => {
      await page.goto(server.url('/tail'), { waitUntil: 'load' });
      loadedAt = await page.evaluate(() => performance.timing.loadEventStart);
      await pause(200);
    });
    const tail = snapshotter.snapshots.filter((s) => s.url === server.url('/tail'));
    assert.ok(tail.length > 0);
    assert.deepEqual(
      tail.filter((s) => Date.parse(s.capturedAt) < loadedAt - 5).map((s) => s.capturedAt),
      [],
    );
  });

  test('never snapshots a half-parsed form while the document is still loading', async () => {
    for (const world of [undefined, async () => undefined]) {
      const snapshotter = await session({ debounceMs: 50, ...(world ? { world } : {}) }, async (page) => {
        await page.goto(server.url('/slow'), { waitUntil: 'load' });
        await pause(300);
      });
      const slow = snapshotter.snapshots.filter((s) => s.url === server.url('/slow'));
      assert.ok(slow.length > 0, world ? 'without hooks' : 'with hooks');
      assert.ok(
        slow.every((s) => s.html.includes('name="second"')),
        slow.map((s) => s.html.length).join(','),
      );
    }
  });

  test('records pushState routes through the browser navigation events when the page world is unavailable', async () => {
    const snapshotter = await session({ debounceMs: 100, world: async () => undefined }, async (page, snapshotter) => {
      await page.goto(server.url('/'));
      await page.waitForSelector('main .home');
      await pause(300);
      await page.click('nav a[href="/login"]');
      await page.waitForSelector('form input[name=password]');
      assert.ok(await until(() => withForm(snapshotter.snapshots, server.url('/login'), 'password').length > 0));
      await page.click('nav a[href="/"]');
    });
    assert.equal(withForm(snapshotter.snapshots, server.url('/login'), 'password').length, 1);
  });
});
