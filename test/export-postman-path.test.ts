import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { PostmanExporter } from '../src/export/index.js';
import type { Endpoint, ParamInfo } from '../src/model/index.js';
import { Json } from '../src/shared/index.js';
import { ExportModel } from './helpers/export-model.js';

type Item = Record<string, unknown>;

function obj(value: unknown): Record<string, unknown> {
  assert.ok(Json.isPlainObject(value), `expected an object, got ${JSON.stringify(value)}`);
  return value;
}

function requests(collection: Record<string, unknown>): Item[] {
  return (collection.item as Item[]).flatMap((folder) => folder.item as Item[]);
}

function param(name: string, type: string, examples: string[]): ParamInfo {
  return { name, in: 'path', required: true, schema: { type }, examples };
}

function page(path: string, params: ParamInfo[], name: string): Endpoint {
  return ExportModel.endpoint({ method: 'GET', path, kind: 'document', pathParams: params, name, id: name });
}

function resolve(text: string, variables: Map<string, string>, local: Map<string, string>): string {
  return text.replace(/\{\{([^{}]+)\}\}/g, (_match: string, key: string) => variables.get(key) ?? `<${key}>`).replace(/\/:([A-Za-z0-9_]+)/g, (_match: string, key: string) => `/${local.get(key) ?? `<${key}>`}`);
}

describe('Postman keeps path parameters inside a segment as variables (BOOKS-R3)', () => {
  const catalogue = page('/catalogue/page-{page}.html', [param('page', 'integer', ['2', '3'])], 'getCataloguePage');
  const category = page('/catalogue/category/books/{book}/page-{page}.html', [param('book', 'string', ['mystery_3']), param('page', 'integer', ['2'])], 'getCatalogueCategoryBooksPage');
  const archive = page('/archive/report-{page}.pdf', [param('page', 'string', ['q3'])], 'getArchiveReport');
  const collection = JSON.parse(new PostmanExporter().export(ExportModel.model([catalogue, category, archive])).content) as Record<string, unknown>;
  const byName = new Map(requests(collection).map((item) => [String(obj(item.request).description).match(/`([^`]+)`/)?.[1] ?? '', obj(obj(item.request).url)]));
  const variables = new Map((collection.variable as Item[]).map((variable) => [String(variable.key), String(variable.value)]));

  test('a value inside a segment is a collection variable, not the captured value', () => {
    const url = byName.get('getCataloguePage');
    assert.ok(url);
    assert.equal(url.raw, '{{baseUrl}}/catalogue/page-{{page}}.html');
    assert.deepEqual(url.path, ['catalogue', 'page-{{page}}.html']);
    assert.equal(url.variable, undefined);
    assert.deepEqual(
      (collection.variable as Item[]).find((variable) => variable.key === 'page'),
      { key: 'page', value: '2', type: 'string', description: 'integer path parameter' },
    );
  });

  test('a whole segment stays a :name variable next to an in-segment one of the same name and type', () => {
    const url = byName.get('getCatalogueCategoryBooksPage');
    assert.ok(url);
    assert.equal(url.raw, '{{baseUrl}}/catalogue/category/books/:book/page-{{page}}.html');
    assert.deepEqual(url.path, ['catalogue', 'category', 'books', ':book', 'page-{{page}}.html']);
    assert.deepEqual(url.variable, [{ key: 'book', value: 'mystery_3', description: 'string' }]);
  });

  test('the same name with another type gets its own variable', () => {
    const url = byName.get('getArchiveReport');
    assert.ok(url);
    assert.equal(url.raw, '{{baseUrl}}/archive/report-{{page_2}}.pdf');
    assert.equal(variables.get('page_2'), 'q3');
  });

  test('every referenced variable is defined and the defaults give the captured URLs', () => {
    for (const [name, url] of byName) {
      for (const match of String(url.raw).matchAll(/\{\{([^{}]+)\}\}/g)) assert.ok(variables.has(match[1] ?? ''), `${name}: ${match[1]}`);
    }
    const local = (url: Record<string, unknown>): Map<string, string> => new Map(((url.variable as Item[] | undefined) ?? []).map((variable) => [String(variable.key), String(variable.value)]));
    const urls = [...byName.values()].map((url) => resolve(String(url.raw), variables, local(url)));
    assert.deepEqual(urls, [
      `${ExportModel.ORIGIN}/catalogue/page-2.html`,
      `${ExportModel.ORIGIN}/catalogue/category/books/mystery_3/page-2.html`,
      `${ExportModel.ORIGIN}/archive/report-q3.pdf`,
    ]);
    const other = new Map([...variables, ['page', '5']]);
    assert.equal(resolve(String(byName.get('getCataloguePage')?.raw), other, new Map()), `${ExportModel.ORIGIN}/catalogue/page-5.html`);
  });

  test('a path variable never takes the name of the base URL or of a placeholder', () => {
    const csrf = ExportModel.endpoint({
      method: 'POST',
      path: '/items/{baseUrl}-{csrf}',
      kind: 'json',
      name: 'postItem',
      id: 'postItem',
      pathParams: [param('baseUrl', 'string', ['a']), param('csrf', 'string', ['b'])],
      auth: { cookies: [], headers: [], anonymous: 'untested', bearer: false, csrf: [{ name: 'csrf', location: 'header', source: 'meta', sourceName: 'csrf-token' }] },
    });
    const own = JSON.parse(new PostmanExporter().export(ExportModel.model([csrf])).content) as Record<string, unknown>;
    const url = obj(obj(requests(own)[0]?.request).url);
    assert.equal(url.raw, '{{baseUrl}}/items/{{baseUrl_2}}-{{csrf_2}}');
    assert.deepEqual((own.variable as Item[]).map((variable) => [variable.key, variable.value]), [
      ['baseUrl', ExportModel.ORIGIN],
      ['csrf', ''],
      ['baseUrl_2', 'a'],
      ['csrf_2', 'b'],
    ]);
  });
});
