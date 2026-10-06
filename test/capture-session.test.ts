import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser, BrowserContext } from 'playwright';
import { BrowserLauncher, CaptureSession, CookieParser, LiveDom, NetworkIdleMonitor, PageSnapshotter, TrafficRecorder } from '../src/capture/index.js';
import type { LaunchedBrowser } from '../src/capture/index.js';
import { AppiiError, Http } from '../src/shared/index.js';
import type { Capture, Exchange } from '../src/model/index.js';
import { FIXTURE_USER, startFixtureSite } from './fixtures/site.js';
import type { FixtureSite } from './fixtures/site.js';
import { startWebSocketSite } from './fixtures/capture-ws-server.js';
import type { WebSocketSite } from './fixtures/capture-ws-server.js';

let site: FixtureSite;
let sockets: WebSocketSite;

before(async () => {
  site = await startFixtureSite();
  sockets = await startWebSocketSite();
});

after(async () => {
  await site?.close();
  await sockets?.close();
});

const pathOf = (e: Exchange): string => {
  const url = new URL(e.request.url);
  return url.pathname + url.search;
};

function only(capture: Capture, method: string, path: string): Exchange {
  const found = capture.exchanges.filter((e) => e.request.method === method && pathOf(e) === path);
  assert.equal(found.length, 1, `expected one ${method} ${path}, got ${found.length}`);
  return found[0]!;
}

function withoutLiveAttributes(html: string): string {
  return html.replace(/ data-appii-[a-z-]+="[^"]*"/g, '');
}

function isAppiiError(code: string, pattern?: RegExp) {
  return (err: unknown): boolean => err instanceof AppiiError && err.code === code && (!pattern || pattern.test(err.message));
}

class RecordingLauncher extends BrowserLauncher {
  launches = 0;
  readonly #setup: (context: BrowserContext) => Promise<BrowserContext>;

  constructor(setup: (context: BrowserContext) => Promise<BrowserContext> = async (c) => c) {
    super({ headless: true });
    this.#setup = setup;
  }

  override async launch(): Promise<LaunchedBrowser> {
    this.launches++;
    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    return { browser, context: await this.#setup(context) };
  }
}

class FailingLauncher extends BrowserLauncher {
  override async launch(): Promise<LaunchedBrowser> {
    throw new AppiiError('BROWSER', 'no browser in this test');
  }
}

describe('CaptureSession end to end', () => {
  test('captures a scripted login, API traffic, cookies, storage and live pages', async () => {
    const seen: Exchange[] = [];
    const session = CaptureSession.create({
      url: site.url,
      headless: true,
      idleMs: 400,
      onExchange: (e) => seen.push(e),
      script: async (page) => {
        await page.goto(site.origin + '/login');
        await page.fill('#email', FIXTURE_USER.email);
        await page.fill('#password', FIXTURE_USER.password);
        await Promise.all([page.waitForURL('**/account'), page.click('#login button[type=submit]')]);
        await page.goto(site.origin + '/app');
        await page.waitForFunction(() => document.getElementById('out')?.textContent === 'done 2');
        await page.goto(site.origin + '/signup');
      },
    });
    const capture = await session.run();

    assert.equal(capture.version, 1);
    assert.equal(capture.tool.name, 'appii');
    assert.equal(capture.startUrl, site.url);
    assert.ok(Date.parse(capture.startedAt) <= Date.parse(capture.endedAt));
    assert.equal(seen.length, capture.exchanges.length);

    const home = only(capture, 'GET', '/');
    assert.ok(Http.getHeaderAll(home.response!.headers, 'set-cookie').some((c) => c.startsWith('sid=') && /HttpOnly/i.test(c)));
    assert.ok(Http.getHeaderAll(home.response!.headers, 'set-cookie').some((c) => c.startsWith('theme=dark')));
    const sid = capture.cookies.find((c) => c.name === 'sid');
    const auth = capture.cookies.find((c) => c.name === 'auth');
    assert.ok(sid && auth);
    assert.equal(sid.httpOnly, true);
    assert.equal(auth.httpOnly, true);
    assert.equal(sid.hostOnly, true);
    assert.equal(sid.domain, '127.0.0.1');
    assert.equal(sid.expires, null);
    assert.ok(capture.cookies.some((c) => c.name === 'csrf' && c.sameSite === 'Strict'));
    assert.ok(capture.cookies.some((c) => c.name === 'theme' && c.expires !== null));

    for (const e of capture.exchanges) {
      if (pathOf(e) === '/' || Http.originOf(e.request.url) !== site.origin) continue;
      assert.match(Http.getHeader(e.request.headers, 'cookie') ?? '', new RegExp(`(^|; )sid=${sid.value}(;|$)`), `Cookie header on ${e.request.method} ${pathOf(e)}`);
    }

    const login = only(capture, 'POST', '/login');
    const account = only(capture, 'GET', '/account');
    assert.equal(login.response?.status, 303);
    assert.equal(account.redirectedFrom, login.id);
    assert.equal(account.response?.status, 200);
    assert.equal(login.pageUrl, site.origin + '/login');
    assert.ok(Http.getHeaderAll(login.response!.headers, 'set-cookie').some((c) => c.startsWith('auth=')));
    const form = new URLSearchParams(Http.bodyText(login.request.body));
    assert.equal(form.get('email'), FIXTURE_USER.email);
    assert.equal(form.get('action'), 'login');
    const csrf = form.get('csrf_token');
    assert.ok(csrf && csrf.length > 10);

    const list = only(capture, 'GET', '/api/items?page=1&limit=2');
    assert.equal(list.resourceType, 'fetch');
    assert.equal((Http.bodyJson(list.response?.body) as { total: number }).total, 3);
    assert.equal(only(capture, 'GET', '/api/items?page=2&limit=2').resourceType, 'xhr');
    assert.equal(only(capture, 'GET', '/api/items/999').response?.status, 404);
    const posts = capture.exchanges.filter((e) => e.request.method === 'POST' && pathOf(e) === '/api/items');
    assert.equal(posts.length, 2);
    for (const post of posts) {
      assert.equal(Http.getHeader(post.request.headers, 'x-csrf-token'), capture.cookies.find((c) => c.name === 'csrf')?.value);
      assert.ok(Http.bodyJson(post.request.body));
    }
    assert.deepEqual(posts.map((p) => p.response?.status).sort(), [201, 400]);
    const graphql = only(capture, 'POST', '/graphql');
    assert.equal((Http.bodyJson(graphql.request.body) as { operationName: string }).operationName, 'GetItem');

    const storage = capture.storage.find((s) => s.origin === site.origin);
    assert.equal(storage?.localStorage.lastVisit, 'today');
    assert.equal(storage?.sessionStorage.tab, 'one');

    const loginPage = capture.pages.find((p) => p.url === site.origin + '/login');
    assert.ok(loginPage, 'login page snapshot');
    assert.equal(loginPage.title, 'Login');
    assert.ok(loginPage.html.includes(`name="csrf_token" value="${csrf}"`), 'hidden csrf_token input with its value');
    assert.ok(!capture.pages.some((p) => p.html.includes(FIXTURE_USER.password)), 'typed passwords never reach snapshots');
    const signup = capture.pages.find((p) => p.url === site.origin + '/signup');
    assert.ok(signup && signup.html.includes('id="signup"') && signup.html.startsWith('<!DOCTYPE html>'));
    const keys = capture.pages.map((p) => p.url + '\n' + p.html);
    assert.equal(new Set(keys).size, keys.length, 'snapshots are deduplicated');
  });

  test('records WebSocket frames during a session', async () => {
    const capture = await CaptureSession.create({
      url: sockets.url,
      headless: true,
      idleMs: 200,
      script: async (page) => {
        await page.waitForFunction(() => document.getElementById('log')?.textContent === 'closed');
      },
    }).run();
    assert.equal(capture.websockets.length, 1);
    const ws = capture.websockets[0]!;
    assert.equal(ws.url, sockets.origin.replace('http:', 'ws:') + '/ws');
    assert.ok(ws.closedAt);
    const frames = ws.messages.map((m) => `${m.direction}:${m.opcode}:${m.data}`);
    assert.ok(frames.includes('sent:text:hello'));
    assert.ok(frames.includes('received:text:echo:hello'));
    assert.ok(frames.includes('sent:binary:AQID'));
    assert.ok(frames.includes('received:binary:AwIB'));
    assert.ok(sockets.received.some((f) => f.opcode === 1 && f.payload.toString() === 'hello'));
  });

  test('ends a headless session without script on network idle after the start page', async () => {
    const started = Date.now();
    const capture = await CaptureSession.create({ url: site.origin + '/app', headless: true, idleMs: 500 }).run();
    assert.ok(Date.now() - started < 15000);
    assert.ok(capture.exchanges.some((e) => pathOf(e) === '/graphql'));
    assert.ok(capture.exchanges.some((e) => pathOf(e) === '/api/items?page=2&limit=2'));
    assert.ok(capture.pages.some((p) => p.url === site.origin + '/app' && p.html.includes('<div id="out">done 2</div>')));
  });

  test('per-run collaborators come from the injected factories', async () => {
    const monitors: NetworkIdleMonitor[] = [];
    const waits: number[] = [];
    const snapshotters: PageSnapshotter[] = [];
    class CountingIdleMonitor extends NetworkIdleMonitor {
      override waitForIdle(idleMs: number): Promise<void> {
        waits.push(idleMs);
        return super.waitForIdle(idleMs);
      }
    }
    const session = new CaptureSession(
      { url: site.origin + '/products', headless: true, idleMs: 150 },
      {
        launcher: new BrowserLauncher({ headless: true }),
        recorder: new TrafficRecorder(),
        cookies: new CookieParser(),
        idle: () => {
          const monitor = new CountingIdleMonitor();
          monitors.push(monitor);
          return monitor;
        },
        snapshots: () => {
          const snapshotter = new PageSnapshotter();
          snapshotters.push(snapshotter);
          return snapshotter;
        },
      },
    );
    const capture = await session.run();
    assert.equal(monitors.length, 1);
    assert.equal(snapshotters.length, 1);
    assert.ok(waits.includes(150), JSON.stringify(waits));
    assert.ok(capture.exchanges.some((e) => pathOf(e) === '/products'));
  });

  test('durationMs bounds a session', async () => {
    const started = Date.now();
    const capture = await CaptureSession.create({ url: site.origin + '/products', headless: true, durationMs: 700 }).run();
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 650, `ran ${elapsed}ms`);
    assert.ok(capture.exchanges.some((e) => pathOf(e) === '/products'));
  });

  test('stop() ends a headless session early and still returns the data', async () => {
    const session: CaptureSession = CaptureSession.create({
      url: site.origin + '/products',
      headless: true,
      durationMs: 60000,
      onExchange: (e) => {
        if (pathOf(e) === '/products') session.stop();
      },
    });
    const started = Date.now();
    const capture = await session.run();
    assert.ok(Date.now() - started < 20000);
    assert.equal(session.stopped, true);
    assert.ok(capture.exchanges.some((e) => pathOf(e) === '/products'));
    assert.ok(capture.pages.some((p) => p.url === site.origin + '/products'));
    assert.ok(capture.cookies.length === 0 || capture.cookies.every((c) => typeof c.name === 'string'));
  });

  test('an AbortSignal ends a session early and still returns the data', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const capture = await CaptureSession.create({
      url: site.origin + '/app',
      headless: true,
      durationMs: 60000,
      signal: controller.signal,
      onExchange: (e) => {
        if (pathOf(e) === '/graphql') controller.abort();
      },
    }).run();
    assert.ok(Date.now() - started < 20000);
    assert.ok(capture.exchanges.some((e) => pathOf(e) === '/graphql'));
    assert.ok(capture.storage.some((s) => s.origin === site.origin && s.localStorage.lastVisit === 'today'));
  });

  test('an already aborted signal returns an empty capture without launching a browser', async () => {
    const controller = new AbortController();
    controller.abort();
    const launcher = new FailingLauncher();
    const capture = await new CaptureSession({ url: site.url, signal: controller.signal }, { launcher, recorder: new TrafficRecorder(), cookies: new CookieParser() }).run();
    assert.deepEqual(capture.exchanges, []);
    assert.equal(capture.startUrl, site.url);
  });

  test('run() can only be called once', async () => {
    const session = CaptureSession.create({ url: site.origin + '/products', headless: true, idleMs: 100 });
    await session.run();
    await assert.rejects(session.run(), isAppiiError('CAPTURE', /already run/));
  });
});

describe('CaptureSession dependency injection and failures', () => {
  test('uses an injected launcher, recorder and cookie parser', async () => {
    const launcher = new RecordingLauncher(async (context) => {
      await context.addCookies([{ name: 'seeded', value: 'yes', domain: '127.0.0.1', path: '/', httpOnly: false, secure: false, sameSite: 'Lax', expires: -1 }]);
      return context;
    });
    const recorder = new TrafficRecorder({ captureBodies: false });
    const session = new CaptureSession({ url: site.origin + '/app', idleMs: 300 }, { launcher, recorder, cookies: new CookieParser() });
    assert.equal(session.recorder, recorder);
    const capture = await session.run();
    assert.equal(launcher.launches, 1);
    assert.ok(capture.cookies.some((c) => c.name === 'seeded' && c.value === 'yes'));
    assert.ok(capture.exchanges.length > 5);
    assert.ok(capture.exchanges.every((e) => e.response?.body === undefined && e.request.body === undefined));
    assert.match(Http.getHeader(only(capture, 'GET', '/app').request.headers, 'cookie') ?? '', /seeded=yes/);
  });

  test('falls back to replaying Set-Cookie headers when the browser cookie jar cannot be read', async () => {
    const launcher = new RecordingLauncher(
      async (context) =>
        new Proxy(context, {
          get(target, prop) {
            if (prop === 'cookies') return async () => Promise.reject(new Error('cookie store unavailable'));
            if (prop === 'browser') return () => null;
            const value: unknown = Reflect.get(target, prop, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }),
    );
    const capture = await new CaptureSession({ url: site.url, idleMs: 200 }, { launcher, recorder: new TrafficRecorder(), cookies: new CookieParser() }).run();
    const names = capture.cookies.map((c) => c.name).sort();
    assert.deepEqual(names, ['sid', 'theme']);
    assert.equal(capture.cookies.find((c) => c.name === 'sid')?.httpOnly, true);
  });

  test('launch failures propagate unchanged', async () => {
    const session = new CaptureSession({ url: site.url }, { launcher: new FailingLauncher(), recorder: new TrafficRecorder(), cookies: new CookieParser() });
    await assert.rejects(session.run(), isAppiiError('BROWSER', /no browser in this test/));
  });

  test('a failing script yields a CAPTURE error that still carries the recorded data', async () => {
    const session = CaptureSession.create({
      url: site.origin + '/products',
      headless: true,
      script: async (page) => {
        await page.goto(site.origin + '/search?q=gad');
        throw new Error('boom');
      },
    });
    await assert.rejects(session.run(), (err: unknown) => {
      assert.ok(err instanceof AppiiError);
      assert.equal(err.code, 'CAPTURE');
      assert.match(err.message, /Capture script failed: boom/);
      const capture = (err.details as { capture: Capture }).capture;
      assert.ok(capture.exchanges.some((e) => pathOf(e) === '/search?q=gad'));
      assert.ok(capture.pages.some((p) => p.url.includes('/search')));
      return true;
    });
  });

  test('an unreachable start URL fails a headless capture with the partial data attached', async () => {
    const session = CaptureSession.create({ url: 'http://127.0.0.1:1/', headless: true });
    await assert.rejects(session.run(), (err: unknown) => {
      assert.ok(err instanceof AppiiError);
      assert.equal(err.code, 'CAPTURE');
      assert.match(err.message, /Cannot open http:\/\/127\.0\.0\.1:1\//);
      const capture = (err.details as { capture: Capture }).capture;
      assert.ok(capture.exchanges.some((e) => e.error && !e.response));
      return true;
    });
  });

  test('validates options eagerly', () => {
    assert.throws(() => CaptureSession.create({ url: 'not a url' }), isAppiiError('BAD_INPUT'));
    assert.throws(() => CaptureSession.create({ url: 'ftp://example.com/' }), isAppiiError('BAD_INPUT'));
    assert.throws(() => CaptureSession.create({ durationMs: -1 }), isAppiiError('BAD_INPUT'));
    assert.throws(() => CaptureSession.create({ idleMs: Number.NaN }), isAppiiError('BAD_INPUT'));
  });

  test('BrowserLauncher maps options onto Playwright and reports missing storage state', async () => {
    const headed = new BrowserLauncher({ headless: false, userAgent: 'appii-test', args: ['--lang=en'], storageState: 'state.json' });
    assert.deepEqual(headed.launchOptions(), { headless: false, args: ['--lang=en'] });
    assert.deepEqual(headed.contextOptions(), { userAgent: 'appii-test', viewport: null, storageState: 'state.json' });
    const headless = new BrowserLauncher({ viewport: { width: 800, height: 600 } });
    assert.equal(headless.headless, true);
    assert.deepEqual(headless.contextOptions(), { viewport: { width: 800, height: 600 } });
    await assert.rejects(new BrowserLauncher({ storageState: '/nonexistent/appii-state.json' }).launch(), isAppiiError('NOT_FOUND'));
    await assert.rejects(new BrowserLauncher({ executablePath: '/nonexistent/chrome' }).launch(), isAppiiError('BROWSER', /Cannot launch Chromium/));
  });
});

describe('LiveDom, PageSnapshotter and NetworkIdleMonitor', () => {
  let browser: Browser;
  before(async () => {
    browser = await chromium.launch({ headless: true });
  });
  after(async () => {
    await browser?.close();
  });

  test('LiveDom copies control state into a clone without touching the page', async () => {
    const page = await browser.newPage();
    try {
      await page.goto(site.origin + '/signup');
      const before = await page.evaluate(() => document.documentElement.outerHTML);
      await page.fill('[name=username]', 'new_user');
      await page.fill('[name=age]', '42');
      await page.selectOption('[name=country]', 'ca');
      await page.check('input[name=plan][value=pro]');
      await page.selectOption('[name=interests]', ['b']);
      await page.fill('[name=bio]', 'Edited bio');
      await page.check('[name=terms]');
      await page.evaluate(() => {
        const input = document.createElement('input');
        input.type = 'password';
        input.name = 'secret';
        document.querySelector('form')!.append(input);
        input.value = 'hunter2';
        const hidden = document.createElement('input');
        hidden.type = 'hidden';
        hidden.name = 'token';
        document.querySelector('form')!.append(hidden);
        hidden.value = 'js-set';
      });
      const html = withoutLiveAttributes(await new LiveDom(page).serialize());
      assert.ok(html.startsWith('<!DOCTYPE html><html>'));
      assert.match(html, /<input type="text" name="username"[^>]*value="new_user"/);
      assert.match(html, /<input type="number" name="age"[^>]*value="42"/);
      assert.match(html, /<option value="ca" selected="">Canada<\/option>/);
      assert.match(html, /<option value="">Choose\.\.\.<\/option>/);
      assert.match(html, /<input type="radio" name="plan" value="free">/);
      assert.match(html, /<input type="radio" name="plan" value="pro" checked="">/);
      assert.match(html, /<option value="a">A<\/option><option value="b" selected="">B<\/option><option value="c">C<\/option>/);
      assert.match(html, /<textarea name="bio" maxlength="200">Edited bio<\/textarea>/);
      assert.match(html, /<input type="checkbox" name="terms" required="" checked="">/);
      assert.match(html, /<input type="hidden" name="token" value="js-set">/);
      assert.ok(!html.includes('hunter2'));
      const now = await page.evaluate(() => document.documentElement.outerHTML);
      const withoutAdded = now.replace(/<input type="password" name="secret"><input type="hidden" name="token" value="js-set">/, '');
      assert.equal(withoutAdded, before, 'page DOM is unchanged apart from the test-added inputs');
      const snapshot = await new LiveDom(page).snapshot();
      assert.equal(snapshot.title, 'Signup');
      assert.equal(snapshot.url, site.origin + '/signup');
      assert.ok(!Number.isNaN(Date.parse(snapshot.capturedAt)));
    } finally {
      await page.close();
    }
  });

  test('LiveDom leaves untouched selects and sensitive autocomplete fields alone', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(
        '<form><select name="s"><option value="x" disabled>X</option><option value="y">Y</option></select><input name="cc" autocomplete="billing cc-number"><input name="plain"></form>',
      );
      await page.fill('[name=cc]', '4111111111111111');
      await page.fill('[name=plain]', 'visible');
      const html = withoutLiveAttributes(await new LiveDom(page).serialize());
      assert.ok(html.includes('<option value="x" disabled="">X</option><option value="y">Y</option>'));
      assert.ok(!html.includes('4111'));
      assert.ok(html.includes('name="plain" value="visible"'));
    } finally {
      await page.close();
    }
  });

  test('PageSnapshotter snapshots each load, deduplicates and skips non-web pages', async () => {
    const context = await browser.newContext();
    try {
      const snapshotter = new PageSnapshotter({ debounceMs: 50 });
      snapshotter.attach(context);
      const page = await context.newPage();
      assert.equal(await snapshotter.prepare(page), true);
      await page.goto(site.origin + '/products');
      await page.goto(site.origin + '/search?q=wid');
      await new Promise((r) => setTimeout(r, 200));
      await snapshotter.finish();
      snapshotter.detach();
      const urls = snapshotter.snapshots.map((s) => s.url);
      assert.deepEqual([...new Set(urls)], [site.origin + '/products', site.origin + '/search?q=wid']);
      assert.equal(urls.length, 2);
      assert.ok(snapshotter.snapshots.every((s) => !s.url.startsWith('about:')));
    } finally {
      await context.close();
    }
  });

  test('PageSnapshotter captures the live form at submit time, before the page navigates away', async () => {
    const context = await browser.newContext();
    try {
      const snapshotter = new PageSnapshotter({ debounceMs: 5000 });
      assert.equal(await snapshotter.attach(context), true);
      assert.match(snapshotter.hookScript(), /addEventListener\("submit"/);
      const page = await context.newPage();
      assert.equal(await snapshotter.prepare(page), true);
      await page.goto(site.origin + '/login');
      await page.evaluate(() => {
        const search = document.querySelector('input[name=q]') as HTMLInputElement;
        search.value = 'set by a script';
      });
      await page.fill('#email', FIXTURE_USER.email);
      await page.fill('#password', FIXTURE_USER.password);
      await page.check('input[name=remember]');
      await Promise.all([page.waitForURL('**/account'), page.click('#login button[type=submit]')]);
      await snapshotter.settled();
      snapshotter.detach();
      const logins = snapshotter.snapshots.filter((s) => s.url === site.origin + '/login');
      assert.ok(logins.some((s) => s.html.includes('value="set by a script"')), 'submit-time snapshot has the value a script set');
      assert.ok(logins.every((s) => !s.html.includes(FIXTURE_USER.email)), 'what the user typed is not recorded as the default value');
      assert.ok(logins.every((s) => /<input type="checkbox" name="remember" value="yes">/.test(withoutLiveAttributes(s.html))), 'a box the user checked is not recorded as checked by default');
      assert.ok(logins.every((s) => /<input id="email" type="email" name="email" required="" autocomplete="username" value="">/.test(withoutLiveAttributes(s.html))), 'the email keeps its empty default');
      assert.ok(snapshotter.snapshots.every((s) => !s.html.includes(FIXTURE_USER.password)));
      assert.ok(logins.some((s) => /<input type="hidden" name="csrf_token" value="[0-9a-f]+">/.test(withoutLiveAttributes(s.html))));
    } finally {
      await context.close();
    }
  });

  test('NetworkIdleMonitor waits for in-flight requests and ignores stalled ones', async () => {
    const context = await browser.newContext();
    try {
      const monitor = new NetworkIdleMonitor({ stalledAfterMs: 300 });
      monitor.attach(context);
      const page = await context.newPage();
      await page.goto(site.origin + '/products');
      const seen = page.waitForRequest((r) => r.url().includes('/slow'));
      await page.evaluate(() => {
        void fetch('/slow?ms=3000').catch(() => undefined);
      });
      await seen;
      assert.equal(monitor.inflight, 1);
      const started = Date.now();
      await monitor.waitForIdle(100);
      const waited = Date.now() - started;
      assert.ok(waited >= 250 && waited < 2500, `waited ${waited}ms`);
      monitor.detach();
      assert.equal(monitor.inflight, 0);
    } finally {
      await context.close();
    }
  });
});
