import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser, Page } from 'playwright';
import { CaptureSession, LiveDom, PageSnapshotter } from '../src/capture/index.js';
import { ModelBuilder } from '../src/build/index.js';
import { HtmlDocument, SelectorBuilder } from '../src/forms/index.js';
import { PageServers } from './fixtures/capture-pages.js';
import type { PageServer } from './fixtures/capture-pages.js';

const SECRET = 'hunter2-secret';

const SHADOW_SCRIPT = `<script>
customElements.define('login-box', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<form action="/signin" method="post"><input name="user" required minlength="3" pattern="[a-z]+"><input type="password" name="pass" required><button>Sign in</button></form>';
  }
});
</script>`;

const PAGES: Record<string, string> = {
  '/table': PageServers.html(
    'Table',
    '<table><form method="post" action="/login"><tr><td><input name="user" value="u"></td><td><input type="password" name="pw" value="p"></td><td><input type="submit" name="go" value="Go"></td></tr></form></table><input name="stray">',
  ),
  '/misnested': PageServers.html('Misnested', '<div><form action="/m"><input name="a" value="1"></div><input name="b" value="2"><select name="c"><option>x</option></select>'),
  '/scripted': PageServers.html(
    'Scripted',
    `<div id="root"></div><script>
const root = document.getElementById('root');
const p = document.createElement('p');
p.append(document.createElement('div'));
const form = document.createElement('form');
form.action = '/react';
form.innerHTML = '<input name="q">';
root.append(p, form);
</script>`,
  ),
  '/plain': PageServers.html(
    'Plain',
    '<form id="login" action="/a"><input name="a"></form><form name="search" action="/s"><input name="q"></form><form action="/x"><input name="x"></form><form action="/y"><input name="y" form="login"></form><form id="dup" action="/d1"></form><form id="DUP" action="/d2"></form><section id="box"><form action="/z"></form></section>',
  ),
  '/shadow': PageServers.html('Shadow', `<login-box></login-box>${SHADOW_SCRIPT}`),
  '/shadow-submit': PageServers.html(
    'Shadow submit',
    `<login-box></login-box>${SHADOW_SCRIPT}<script>
const box = document.querySelector('login-box');
const form = box.shadowRoot.querySelector('form');
form.addEventListener('submit', (event) => {
  event.preventDefault();
  fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)) }).then(() => {
    form.reset();
    document.title = 'sent';
  });
});
</script>`,
  ),
  '/toggle': PageServers.html(
    'Toggle',
    '<form action="/never"><input id="pw" type="password" name="password"><button type="button" id="show" onclick="document.getElementById(\'pw\').type = \'text\'">Show</button><input name="other" id="other"></form>',
  ),
  '/globals': PageServers.html(
    'Globals',
    `<form id="f" action="/report" method="post"><input name="who" value="x"><input type="hidden" name="globals" id="globals"><button>Send</button></form>
<script>
document.getElementById('f').addEventListener('submit', () => {
  document.getElementById('globals').value = Object.getOwnPropertyNames(window).filter((n) => /appii|playwright/i.test(n)).join(',');
});
</script>`,
  ),
};

let browser: Browser;
let server: PageServer;

before(async () => {
  browser = await chromium.launch({ headless: true });
  const routes: Record<string, (req: unknown, res: import('node:http').ServerResponse) => void> = {};
  for (const [path, html] of Object.entries(PAGES)) routes[path] = (_req, res) => PageServers.send(res, 200, 'text/html; charset=utf-8', html);
  for (const path of ['/signin', '/report', '/never', '/login', '/m']) routes[path] = (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Done', 'done'));
  routes['/cookies'] = (_req, res) =>
    PageServers.send(res, 200, 'text/html', PageServers.html('Cookies', '<p>cookies</p><script>fetch("/cookies-api")</script>'), { 'set-cookie': ['plain=1; Path=/', 'lax=1; Path=/; SameSite=Lax'] });
  routes['/cookies-api'] = (_req, res) => PageServers.send(res, 200, 'application/json', '{"ok":true}');
  server = await PageServers.start(routes);
});

after(async () => {
  await browser?.close();
  await server?.close();
});

async function withPage<T>(path: string, fn: (page: Page) => Promise<T>): Promise<T> {
  const page = await browser.newPage();
  try {
    await page.goto(server.url(path));
    return await fn(page);
  } finally {
    await page.close();
  }
}

function parse(html: string, path: string): HtmlDocument {
  return HtmlDocument.parse(html, server.url(path));
}

function attr(doc: HtmlDocument, name: string): (element: { attribs: Record<string, string> }) => string | undefined {
  return (element) => doc.attr(element as never, name);
}

describe('LiveDom form ownership and selectors', () => {
  test('marks every form with its document.forms index and every listed control with its live form owner', async () => {
    await withPage('/table', async (page) => {
      const owners = await page.evaluate(() => Array.from(document.querySelectorAll('input')).map((el) => `${el.name}:${el.form ? Array.from(document.forms).indexOf(el.form) : ''}`));
      assert.deepEqual(owners, ['user:0', 'pw:0', 'go:0', 'stray:']);
      const doc = parse(await new LiveDom(page).serialize(), '/table');
      const form = doc.forms()[0]!;
      assert.equal(doc.attr(form, LiveDom.FORM_INDEX_ATTRIBUTE), '0');
      const inputs = doc.elements.filter((el) => doc.isHtml(el, 'input'));
      assert.deepEqual(
        inputs.map((el) => `${doc.attr(el, 'name')}:${doc.attr(el, LiveDom.FORM_OWNER_ATTRIBUTE)}`),
        ['user:0', 'pw:0', 'go:0', 'stray:'],
      );
    });
  });

  test('a captured legacy table form keeps its controls in the model', async () => {
    const capture = await CaptureSession.create({
      url: server.url('/table'),
      headless: true,
      idleMs: 100,
      script: async (page) => {
        await page.fill('[name=user]', 'alice');
        await Promise.all([page.waitForURL('**/login'), page.click('[name=go]')]);
      },
    }).run();
    const model = ModelBuilder.create({}).build(capture);
    const form = model.forms.find((f) => f.action === server.url('/login'));
    assert.ok(form, 'the table form is in the model');
    assert.deepEqual(form.fields.map((f) => f.name), ['user', 'pw']);
    assert.deepEqual(form.submitters.map((f) => f.name), ['go']);
    const endpoint = model.endpoints.find((e) => e.method === 'POST' && e.path === '/login');
    assert.deepEqual(endpoint?.form?.fields.map((f) => f.name), ['user', 'pw']);
  });

  test('records ownership that the serialized markup cannot express', async () => {
    await withPage('/misnested', async (page) => {
      await page.evaluate(() => {
        const orphan = document.createElement('input');
        orphan.name = 'orphan';
        orphan.setAttribute('form', 'missing');
        document.body.append(orphan);
      });
      const doc = parse(await new LiveDom(page).serialize(), '/misnested');
      const owner = attr(doc, LiveDom.FORM_OWNER_ATTRIBUTE);
      const controls = doc.elements.filter((el) => doc.isHtml(el, 'input', 'select'));
      assert.deepEqual(
        controls.map((el) => `${doc.attr(el, 'name')}:${owner(el)}`),
        ['a:0', 'b:0', 'c:0', 'orphan:'],
      );
    });
  });

  test('computes the form selector in the live page, so it matches the live form even when the markup does not round-trip', async () => {
    await withPage('/scripted', async (page) => {
      const html = await new LiveDom(page).serialize();
      const doc = parse(html, '/scripted');
      const form = doc.forms()[0]!;
      const selector = doc.attr(form, LiveDom.SELECTOR_ATTRIBUTE);
      assert.ok(selector);
      const plain = parse(html.replace(/ data-appii-[a-z-]+="[^"]*"/g, ''), '/scripted');
      const reparsed = new SelectorBuilder().path(plain, plain.forms()[0]!);
      assert.notEqual(reparsed, selector, 'the re-parsed markup moves the form');
      const match = await page.evaluate((s) => {
        const found = document.querySelectorAll(s);
        return { count: found.length, isForm: found[0] === document.querySelector('form') };
      }, selector);
      assert.deepEqual(match, { count: 1, isForm: true });
    });
  });

  test('the model stores the selector that matches the form in the live page', async () => {
    const capture = await CaptureSession.create({ url: server.url('/scripted'), headless: true, idleMs: 100 }).run();
    const model = ModelBuilder.create({}).build(capture);
    const selector = model.forms.find((f) => f.action === server.url('/react'))?.selector ?? '';
    assert.ok(selector);
    await withPage('/scripted', async (page) => {
      const match = await page.evaluate((s) => {
        const found = document.querySelectorAll(s);
        return { count: found.length, isForm: found[0] === document.querySelector('form') };
      }, selector);
      assert.deepEqual(match, { count: 1, isForm: true });
    });
  });

  test('uses the same selector algorithm as Forms SelectorBuilder for markup that round-trips', async () => {
    await withPage('/plain', async (page) => {
      const html = await new LiveDom(page).serialize();
      const live = parse(html, '/plain');
      const plain = parse(html.replace(/ data-appii-[a-z-]+="[^"]*"/g, ''), '/plain');
      const builder = new SelectorBuilder();
      const expected = plain.forms().map((form) => builder.form(plain, form));
      const actual = live.forms().map((form) => live.attr(form, LiveDom.SELECTOR_ATTRIBUTE));
      assert.deepEqual(actual, expected);
      assert.deepEqual(actual.slice(0, 2), ['form#login', 'form[name="search"]']);
      assert.deepEqual(
        live.forms().map((form) => live.attr(form, LiveDom.FORM_INDEX_ATTRIBUTE)),
        ['0', '1', '2', '3', '4', '5', '6'],
      );
      const y = live.elements.find((el) => live.attr(el, 'name') === 'y')!;
      assert.equal(live.attr(y, LiveDom.FORM_OWNER_ATTRIBUTE), '0');
    });
  });
});

describe('LiveDom shadow trees', () => {
  test('serializes open shadow roots as declarative shadow DOM with live values and form attributes', async () => {
    await withPage('/shadow', async (page) => {
      await page.fill('login-box input[name=user]', 'alice');
      await page.fill('login-box input[name=pass]', SECRET);
      const html = await new LiveDom(page).serialize();
      assert.match(html, /<login-box><template shadowrootmode="open"><form action="\/signin" method="post" data-appii-form-index="0" data-appii-selector="[^"]+">/);
      assert.match(html, /<input name="user" required="" minlength="3" pattern="\[a-z\]\+" data-appii-form-owner="0" value="alice">/);
      assert.ok(!html.includes(SECRET));
      const reparsed = await browser.newPage();
      try {
        await reparsed.route('**/reparsed', (route) => route.fulfill({ contentType: 'text/html', body: html.replace(/<script>[\s\S]*?<\/script>/g, '') }));
        await reparsed.goto(server.url('/reparsed'));
        const fields = await reparsed.evaluate(() => {
          const form = document.querySelector('login-box')?.shadowRoot?.querySelector('form');
          return form ? Array.from(form.elements).map((el) => (el as HTMLInputElement).name) : [];
        });
        assert.deepEqual(fields, ['user', 'pass', '']);
      } finally {
        await reparsed.close();
      }
      const selector = /data-appii-selector="([^"]+)"/.exec(html)![1]!.replace(/&gt;/g, '>');
      assert.equal(await page.locator(selector).count(), 1);
      assert.equal(await page.locator(selector).getAttribute('action'), '/signin');
    });
  });

  test('takes a snapshot when a form inside a shadow root is submitted', async () => {
    const context = await browser.newContext();
    try {
      const snapshotter = new PageSnapshotter({ debounceMs: 60000 });
      await snapshotter.attach(context);
      const page = await context.newPage();
      await page.goto(server.url('/shadow-submit'));
      await page.fill('login-box input[name=user]', 'bob');
      await page.fill('login-box input[name=pass]', SECRET);
      await page.click('login-box button');
      await page.waitForFunction(() => document.title === 'sent');
      assert.equal(await page.inputValue('login-box input[name=user]'), '');
      await snapshotter.settled();
      snapshotter.detach();
      const snapshots = snapshotter.snapshots.filter((s) => s.url === server.url('/shadow-submit'));
      assert.ok(snapshots.some((s) => /<input name="user"[^>]*value="bob">/.test(s.html)), 'submit-time snapshot of the shadow form');
      assert.ok(snapshots.every((s) => !s.html.includes(SECRET)));
    } finally {
      await context.close();
    }
  });
});

describe('PageSnapshotter privacy and stealth', () => {
  test('never writes a value typed into a field that was a password field, even after a show-password toggle', async () => {
    const capture = await CaptureSession.create({
      url: server.url('/toggle'),
      headless: true,
      idleMs: 100,
      script: async (page) => {
        await page.fill('#pw', SECRET);
        await page.fill('#other', 'visible-value');
        await page.click('#show');
        assert.equal(await page.getAttribute('#pw', 'type'), 'text');
      },
    }).run();
    const pages = capture.pages.filter((p) => p.url === server.url('/toggle'));
    assert.ok(pages.some((p) => p.html.includes('value="visible-value"')), 'a snapshot was taken after typing');
    assert.ok(capture.pages.every((p) => !p.html.includes(SECRET)), 'the typed password is not in any snapshot');
  });

  test('installs no globals that page scripts can see, and still records submit-time snapshots', async () => {
    const capture = await CaptureSession.create({
      url: server.url('/globals'),
      headless: true,
      idleMs: 100,
      script: async (page) => {
        await page.fill('[name=who]', 'typed-before-submit');
        await Promise.all([page.waitForURL('**/report'), page.click('button')]);
      },
    }).run();
    const report = server.requests.find((r) => r.method === 'POST' && r.path === '/report');
    assert.ok(report);
    assert.equal(new URLSearchParams(report.body.toString()).get('globals'), '');
    assert.ok(capture.pages.some((p) => p.url === server.url('/globals') && p.html.includes('value="typed-before-submit"')));
  });
});

describe('BrowserStateTracker cookies', () => {
  test('reports SameSite as null for a cookie set without the attribute, as the Set-Cookie header says', async () => {
    const capture = await CaptureSession.create({ url: server.url('/cookies'), headless: true, idleMs: 100 }).run();
    const plain = capture.cookies.find((c) => c.name === 'plain');
    const lax = capture.cookies.find((c) => c.name === 'lax');
    assert.ok(plain && lax);
    assert.equal(plain.sameSite, null);
    assert.equal(lax.sameSite, 'Lax');
    assert.equal(plain.expires, null);
    const model = ModelBuilder.create({}).build(capture);
    assert.equal(model.cookies.find((c) => c.name === 'plain')?.sameSite, null);
    assert.equal(model.cookies.find((c) => c.name === 'lax')?.sameSite, 'Lax');
  });
});

describe('Headless captures identify as the browser itself', () => {
  test('sends the User-Agent and Sec-CH-UA brands of the same Chromium in headed mode', async () => {
    const capture = await CaptureSession.create({
      url: server.url('/cookies'),
      headless: true,
      idleMs: 100,
      script: async (page) => {
        const brands = await page.evaluate(() => (navigator as unknown as { userAgentData: { brands: { brand: string }[] } }).userAgentData.brands.map((b) => b.brand));
        assert.ok(!brands.includes('HeadlessChrome'), brands.join(','));
        assert.ok(brands.includes('Chromium'));
      },
    }).run();
    const major = browser.version().split('.')[0];
    const sent = capture.exchanges.filter((e) => e.request.url.startsWith(server.origin));
    assert.ok(sent.length >= 2);
    for (const e of sent) {
      const ua = e.request.headers.find((h) => h.name.toLowerCase() === 'user-agent')?.value ?? '';
      const ch = e.request.headers.find((h) => h.name.toLowerCase() === 'sec-ch-ua')?.value ?? '';
      assert.ok(!/headless/i.test(ua) && !/headless/i.test(ch), `${ua} | ${ch}`);
      assert.match(ua, new RegExp(` Chrome/${major}\\.0\\.0\\.0 `));
      assert.match(ch, new RegExp(`"Chromium";v="${major}"`));
    }
  });
});
