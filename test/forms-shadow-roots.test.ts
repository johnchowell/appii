import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';
import { FormExtractor, HtmlDocument, SelectorBuilder } from '../src/forms/index.js';
import { CaptureSession } from '../src/capture/index.js';
import { ModelBuilder } from '../src/build/index.js';
import type { FormDescriptor } from '../src/model/index.js';
import { PageServers } from './fixtures/capture-pages.js';
import type { PageServer } from './fixtures/capture-pages.js';

const PAGE = 'https://example.com/account';
const extractor = FormExtractor.create();

const DECLARATIVE = `<!doctype html><html><head><title>Shadow</title></head><body>
<form id="light" action="/light"><input name="a"></form>
<label for="u">Light label</label>
<login-box><template shadowrootmode="open"><form id="f" action="/signin" method="post"><label for="u">User name</label><input id="u" name="user" required minlength="3"><input name="pass" type="password" pattern="[a-z]+"><button name="go" value="1">Go</button></form><input form="f" name="outside"><input form="light" name="foreign"></template></login-box>
<div><template shadowrootmode="closed"><form action="/closed" method="post"><input name="secret-question"></form></template></div>
<template><form action="/inert"><input name="x"></form></template>
<a><template shadowrootmode="open"><form action="/not-a-host"><input name="y"></form></template></a>
<x-twice><template shadowrootmode="open"><form action="/first"><input name="one"></form></template><template shadowrootmode="open"><form action="/second"><input name="two"></form></template></x-twice>
</body></html>`;

function byAction(forms: readonly FormDescriptor[], path: string): FormDescriptor | undefined {
  return forms.find((form) => new URL(form.action).pathname === path);
}

describe('declarative shadow roots in HTML (CAP-6)', () => {
  test('a form in a shadow root is extracted with its constraints, and plain templates stay inert', () => {
    const forms = extractor.extract(DECLARATIVE, PAGE);
    assert.deepEqual(forms.map((form) => new URL(form.action).pathname), ['/light', '/signin', '/closed', '/first']);
    const signin = byAction(forms, '/signin');
    assert.ok(signin);
    assert.equal(signin.method, 'POST');
    assert.deepEqual(
      signin.fields.map((field) => [field.name, field.required, field.minLength ?? null, field.pattern ?? null]),
      [
        ['user', true, 3, null],
        ['pass', false, null, '[a-z]+'],
        ['outside', false, null, null],
      ],
    );
    assert.deepEqual(signin.submitters.map((field) => field.name), ['go']);
  });

  test('ids, form owners and labels are scoped to the shadow tree', () => {
    const forms = extractor.extract(DECLARATIVE, PAGE);
    assert.deepEqual(byAction(forms, '/light')?.fields.map((field) => field.name), ['a']);
    assert.equal(byAction(forms, '/signin')?.fields[0]?.label, 'User name');
    const doc = HtmlDocument.parse(DECLARATIVE, PAGE);
    const user = doc.elements.find((element) => element.attribs.name === 'user');
    assert.ok(user);
    assert.equal(doc.byId('u'), undefined, 'the document tree has no element with id u');
    assert.equal(doc.byId('u', user), user);
    assert.equal(doc.inDocumentTree(user), false);
    assert.equal(doc.shadowRoots.length, 3);
    const host = doc.elements.find((element) => element.name === 'login-box');
    assert.ok(host);
    assert.deepEqual(doc.children(host), [], 'the declarative template is not a child of its host');
  });

  test('the form selector continues through the shadow host', () => {
    const html = '<div id="a"><x-box><template shadowrootmode="open"><form></form><form action="/two"></form></template></x-box></div>';
    const doc = HtmlDocument.parse(html, PAGE);
    const second = doc.forms()[1];
    assert.ok(second);
    assert.equal(new SelectorBuilder().form(doc, second), '#a > x-box:nth-child(1) > form:nth-child(2)');
  });
});

describe('declarative shadow roots match Chromium', () => {
  let browser: Browser;

  before(async () => {
    browser = await chromium.launch({ headless: true });
  });

  after(async () => {
    await browser?.close();
  });

  test('the same forms, controls and labels as the parsed DOM in Chromium', async () => {
    const page = await browser.newPage();
    try {
      await page.setContent(DECLARATIVE);
      const live = await page.evaluate(() => {
        const roots: (Document | ShadowRoot)[] = [document];
        for (const element of Array.from(document.querySelectorAll('*'))) if (element.shadowRoot) roots.push(element.shadowRoot);
        const out: { action: string; controls: string[]; labels: string[] }[] = [];
        for (const root of roots) {
          for (const form of Array.from(root.querySelectorAll('form'))) {
            const controls = Array.from(form.elements).map((control) => (control as HTMLInputElement).name);
            const labels = Array.from(form.elements).map((control) => Array.from((control as HTMLInputElement).labels ?? []).map((label) => label.textContent ?? '').join(' '));
            out.push({ action: form.getAttribute('action') ?? '', controls, labels });
          }
        }
        return out;
      });
      const forms = extractor.extract(DECLARATIVE, PAGE);
      const open = forms.filter((form) => new URL(form.action).pathname !== '/closed');
      assert.deepEqual(
        open.map((form) => ({
          action: new URL(form.action).pathname,
          controls: [...form.fields, ...form.submitters].sort((a, b) => a.order - b.order).map((field) => field.name),
          labels: [...form.fields, ...form.submitters].sort((a, b) => a.order - b.order).map((field) => (field.type === 'submit' ? '' : (field.label ?? ''))),
        })),
        live,
      );
    } finally {
      await page.close();
    }
  });
});

describe('a captured page whose form lives in a shadow root', () => {
  let server: PageServer;

  before(async () => {
    server = await PageServers.start({
      '/login': (_req, res) =>
        PageServers.send(
          res,
          200,
          'text/html',
          PageServers.html(
            'Login',
            `<login-box></login-box><script>
customElements.define('login-box', class extends HTMLElement {
  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    root.innerHTML = '<form action="/signin" method="post"><label for="u">User</label><input id="u" name="user" required minlength="3" pattern="[a-z]+"><input name="pass" type="password" required><button>Sign in</button></form>';
  }
});
</script>`,
          ),
        ),
      '/signin': (_req, res) => PageServers.send(res, 200, 'text/html', PageServers.html('Welcome', 'welcome')),
    });
  });

  after(async () => {
    await server?.close();
  });

  test('is linked to its POST endpoint in the model with its HTML rules', async () => {
    const capture = await CaptureSession.create({
      url: server.url('/login'),
      headless: true,
      idleMs: 200,
      script: async (page) => {
        await page.fill('login-box input[name=user]', 'alice');
        await page.fill('login-box input[name=pass]', 'secret');
        await Promise.all([page.waitForURL('**/signin'), page.click('login-box button')]);
      },
    }).run();
    const model = ModelBuilder.create({}).build(capture);
    const signin = model.endpoints.find((endpoint) => endpoint.method === 'POST' && endpoint.path === '/signin');
    assert.ok(signin, 'POST /signin is an endpoint');
    assert.ok(signin.form, 'the shadow form is linked to the endpoint');
    assert.deepEqual(
      signin.form.fields.map((field) => [field.name, field.required, field.minLength ?? null, field.pattern ?? null, field.label ?? null]),
      [
        ['user', true, 3, '[a-z]+', 'User'],
        ['pass', true, null, null, null],
      ],
    );
    assert.match(signin.form.selector, /login-box/);
    assert.ok(model.forms.some((form) => new URL(form.action).pathname === '/signin'));
  });
});
