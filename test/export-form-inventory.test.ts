import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelBuilder } from '../src/build/index.js';
import { ExporterRegistry } from '../src/export/index.js';
import type { ApiModel, Capture } from '../src/model/index.js';
import { EndpointDetailPresenter } from '../src/present/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const FORM = 'application/x-www-form-urlencoded';

function filterForm(tags: readonly string[]): string {
  const options = ['----------', ...tags].map((value) => `<option>${value}</option>`).join('');
  return CaptureFactory.page(
    'Search',
    `<form method="post" action="/filter.aspx"><select name="author"><option>Albert</option><option>Jane</option></select><select name="tag">${options}</select><input type="submit" name="submit_button" value="Search"></form>`,
  );
}

function capture(): Capture {
  const f = new CaptureFactory();
  const basket = Array.from({ length: 3 }, (_, i) => `<form method="post" action="/basket/add"><input type="hidden" name="product" value="${i}"><button>Add</button></form>`).join('');
  f.document('/list/1', CaptureFactory.page('One', basket));
  f.document('/list/2', CaptureFactory.page('Two', basket));
  f.document('/search.aspx', filterForm([]));
  f.snapshot('/search.aspx', 'Search', filterForm([]));
  f.exchange({ method: 'POST', url: '/filter.aspx', resourceType: 'document', pageUrl: f.url('/search.aspx'), requestHeaders: { 'content-type': FORM }, requestBody: 'author=Albert&tag=----------&submit_button=Search', status: 200, responseHeaders: { 'content-type': 'text/html' }, responseBody: '<p>r</p>' });
  f.snapshot('/filter.aspx', 'Search', filterForm(['a1', 'a2']));
  f.exchange({ method: 'POST', url: '/filter.aspx', resourceType: 'document', pageUrl: f.url('/filter.aspx'), requestHeaders: { 'content-type': FORM }, requestBody: 'author=Albert&tag=a1&submit_button=Search', status: 200, responseHeaders: { 'content-type': 'text/html' }, responseBody: '<p>r</p>' });
  return f.capture();
}

describe('form instances and options that vary by page state reach every output', () => {
  const model: ApiModel = ModelBuilder.create({ now: new Date(0) }).build(capture());

  test('Markdown and HTML show how often and where a merged form appears', () => {
    const basket = model.forms.find((form) => form.action.endsWith('/basket/add'));
    assert.equal(basket?.instances, 6);
    const markdown = ExporterRegistry.default().export(model, 'markdown').content;
    const forms = markdown.slice(markdown.indexOf('## Forms'));
    assert.match(forms, /\| Page \| Selector \| Method \| Action \| Encoding \| Fields \| Token fields \| Seen \|/);
    assert.match(forms, /6 times on 2 pages: `https:\/\/shop\.example\.com\/list\/1`, `https:\/\/shop\.example\.com\/list\/2`/);
    assert.match(markdown, /\| Forms \| 3 distinct, 8 on pages \|/);
    const html = ExporterRegistry.default().export(model, 'html').content;
    assert.match(html, /<th>Seen<\/th>/);
    assert.match(html, /<details><summary>6 times on 2 pages<\/summary><code>https:\/\/shop\.example\.com\/list\/1<\/code><br><code>https:\/\/shop\.example\.com\/list\/2<\/code><\/details>/);
  });

  test('list --show, Markdown and HTML say the options vary by page state', () => {
    const filter = model.endpoints.find((endpoint) => endpoint.method === 'POST' && endpoint.path === '/filter.aspx');
    assert.ok(filter);
    const expected = 'options vary by page state (observed: ----------|a1|a2)';
    const detail = new EndpointDetailPresenter({ width: 200 }).render({ model, ref: filter.id });
    assert.ok(detail.includes(expected), detail);
    const markdown = ExporterRegistry.default().export(model, 'markdown').content;
    assert.ok(markdown.includes(expected.replaceAll('|', '\\|')), 'markdown');
    assert.ok(ExporterRegistry.default().export(model, 'html').content.includes(expected), 'html');
  });
});
