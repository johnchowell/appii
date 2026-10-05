import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Browser, Page } from 'playwright';
import type { FormDescriptor } from '../src/model/index.js';
import { FormExtractor } from '../src/forms/index.js';
import { PageServer } from './forms-harness.js';

const PAGE = 'https://legacy.example/cgi-bin/page';
const extractor = FormExtractor.create();

function names(form: FormDescriptor | undefined): { fields: string[]; submitters: string[] } {
  assert.ok(form, 'form exists');
  return { fields: form.fields.map((field) => field.name), submitters: form.submitters.map((field) => field.name) };
}

const TABLE_LOGIN =
  '<!doctype html><table><form method=post action="/login"><tr><td><input name=user value=u></td><td><input type=password name=pw value=p></td><td><input type=submit name=go value=Go></td></tr></form></table>';
const MISNESTED = '<!doctype html><div><form action="/m"><input name=a value=1></div><input name=b value=2><select name=c><option>x</select>';
const LEGACY_CASES = [
  TABLE_LOGIN,
  MISNESTED,
  '<!doctype html><form id=b action="/b"></form><table><form id=a action="/a"><tr><td><input name=x form=b><input name=y></td></tr></table><form id=c action="/c"><input name=z></form>',
  '<!doctype html><form id=f action="/f"><div></form><input name=inside_div></div><input name=after_div>',
  '<!doctype html><div><form id=g action="/g"><p><input name=g1></div><input name=g2 form=""><input name=g3 form="g"><textarea name=g4></textarea>',
];

describe('form owners set by the HTML parser form element pointer', () => {
  test('a form inside a table owns the controls that the parser creates after it', () => {
    const [form] = extractor.extract(TABLE_LOGIN, PAGE);
    assert.deepEqual(names(form), { fields: ['user', 'pw'], submitters: ['go'] });
    assert.equal(form?.method, 'POST');
    assert.equal(form?.action, 'https://legacy.example/login');
  });

  test('a form closed early by a misnested end tag keeps the controls that follow', () => {
    const [form] = extractor.extract(MISNESTED, PAGE);
    assert.deepEqual(names(form), { fields: ['a', 'b', 'c'], submitters: [] });
  });

  test('a form attribute wins over the form element pointer', () => {
    const forms = extractor.extract(LEGACY_CASES[2] ?? '', PAGE);
    assert.deepEqual(forms.map((form) => names(form).fields), [['x'], ['y', 'z']]);
    const [g] = extractor.extract(LEGACY_CASES[4] ?? '', PAGE);
    assert.deepEqual(names(g).fields, ['g1', 'g3', 'g4']);
  });

  test('controls in template contents are never associated by the pointer', () => {
    const forms = extractor.extract('<form id=t action="/t"><template><input name=in_template></template><input name=real>', PAGE);
    assert.deepEqual(forms.map((form) => names(form).fields), [['real']]);
  });
});

describe('live DOM marks are authoritative', () => {
  test('owner, index and selector marks from the live page decide the association', () => {
    const html = `<!doctype html><html><head></head><body>
      <table><form id="login" method="post" action="/login" data-appii-form-index="0" data-appii-selector="#app > form:nth-child(2)"></form><tbody><tr>
        <td><input name="user" data-appii-form-owner="0"></td>
        <td><input type="password" name="pw" data-appii-form-owner="0"></td>
        <td><input type="submit" name="go" value="Go" data-appii-form-owner="0"></td>
      </tr></tbody></table>
      <form action="/other" data-appii-form-index="2" data-appii-selector="form[name=&quot;o&quot;]" name="o">
        <input name="moved_away" data-appii-form-owner="">
        <input name="kept" data-appii-form-owner="2">
        <input name="to_login" data-appii-form-owner="0">
        <input name="lost_owner" data-appii-form-owner="1">
      </form>
      <input name="script_owned" data-appii-form-owner="2">
    </body></html>`;
    const forms = extractor.extract(html, PAGE);
    assert.deepEqual(forms.map((form) => form.index), [0, 2]);
    assert.deepEqual(forms.map((form) => form.selector), ['#app > form:nth-child(2)', 'form[name="o"]']);
    assert.deepEqual(names(forms[0]), { fields: ['user', 'pw', 'to_login'], submitters: ['go'] });
    assert.deepEqual(names(forms[1]), { fields: ['kept', 'script_owned'], submitters: [] });
  });

  test('pages without marks keep the computed index and selector', () => {
    const forms = extractor.extract('<form id="a"></form><form name="b"></form>', PAGE);
    assert.deepEqual(forms.map((form) => [form.index, form.selector]), [[0, 'form#a'], [1, 'form[name="b"]']]);
  });
});

describe('form owners match Chromium for legacy markup', () => {
  let browser: Browser | undefined;
  let server: PageServer | undefined;

  before(async () => {
    server = await PageServer.start();
    browser = await PageServer.launchBrowser();
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  test('raw HTML extraction gives the same controls as form.elements in Chromium', async () => {
    assert.ok(server && browser);
    for (const [i, html] of LEGACY_CASES.entries()) {
      const url = server.page(`/legacy${i}.html`, html);
      const page: Page = await browser.newPage();
      try {
        await page.goto(url);
        const live: string[][] = await page.evaluate(() =>
          Array.from(document.forms).map((form) => Array.from(form.elements).map((element) => element.getAttribute('name') ?? '')),
        );
        const ours = extractor.extract(html, url).map((form) => [...form.fields, ...form.submitters].sort((a, b) => a.order - b.order).map((field) => field.name));
        assert.deepEqual(ours, live, `case ${i}`);
      } finally {
        await page.close();
      }
    }
  });
});

describe('form extraction scales linearly', () => {
  function rows(count: number): string {
    const body = Array.from({ length: count }, (_, i) => `<tr><td>row ${i}</td><td><form method="post" action="/rows/${i}/delete"><input type="hidden" name="id" value="${i}"><button>Delete</button></form></td></tr>`).join('');
    return `<!doctype html><table>${body}</table>`;
  }

  function time(html: string): number {
    const start = performance.now();
    extractor.extract(html, PAGE);
    return performance.now() - start;
  }

  test('a page with four times as many anonymous forms takes far less than sixteen times as long', () => {
    const small = rows(1000);
    const large = rows(4000);
    time(small);
    const smallMs = Math.min(time(small), time(small));
    const largeMs = Math.min(time(large), time(large));
    assert.ok(largeMs < smallMs * 8, `1000 forms: ${smallMs.toFixed(1)} ms, 4000 forms: ${largeMs.toFixed(1)} ms`);
  });
});
