import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import type { ApiModel, CookieInfo } from '../src/model/index.js';
import {
  BasePresenter,
  CookieListPresenter,
  EndpointDetailPresenter,
  EndpointListPresenter,
  PresenterFactory,
  SchemaTree,
  SummaryPresenter,
} from '../src/present/index.js';
import type { PresenterOptions } from '../src/present/index.js';
import { Ansi, AppiiError, EndpointIndex, Samples, isAppiiError } from '../src/shared/index.js';
import { LiteralPlaceholderSite } from './fixtures/foundation-literal-placeholders.js';
import { ExportModel } from './helpers/export-model.js';
import { PresentModels } from './helpers/present-models.js';
import { CaptureFactory } from './helpers/capture-factory.js';
import { ModelBuilder } from '../src/build/index.js';

const FIXTURE: ApiModel = PresentModels.fixture();
const MIXED: ApiModel = PresentModels.mixed();
const EMPTY: ApiModel = PresentModels.empty();
const WIDTHS = [60, 100, 160];

const lines = (text: string) => text.split('\n');
const badInput = (err: unknown) => isAppiiError(err) && err.code === 'BAD_INPUT';

function assertFits(text: string, width: number, label: string): void {
  for (const line of lines(text)) assert.ok(Ansi.width(line) <= width, `${label}: line wider than ${width}: ${JSON.stringify(Ansi.strip(line))}`);
}

function assertAscii(text: string, label: string): void {
  for (let i = 0; i < text.length; i++) assert.ok(text.charCodeAt(i) < 128, `${label}: non-ASCII at ${i}`);
}

function tableRows(text: string): string[][] {
  return lines(Ansi.strip(text))
    .filter((line) => line.startsWith('| '))
    .map((line) => line.slice(2, -2).split(' | ').map((cell) => cell.trim()));
}

function numberedRows(text: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const row of tableRows(text)) if (/^\d+$/.test(row[0] ?? '')) out.set(Number(row[0]), row);
  return out;
}

function section(text: string, title: string): string[] {
  const all = lines(Ansi.strip(text));
  const start = all.indexOf(title);
  assert.ok(start >= 0, `missing section ${title}`);
  const out: string[] = [];
  for (let i = start + 2; i < all.length; i++) {
    const next = all[i + 1];
    if (next !== undefined && /^-+$/.test(next) && all[i] !== '' && i > start + 2) break;
    out.push(all[i]!);
  }
  while (out.length > 0 && out[out.length - 1] === '') out.pop();
  return out;
}

function renderAll(options: PresenterOptions, model: ApiModel): Record<string, string> {
  const factory = new PresenterFactory(options);
  const out: Record<string, string> = {
    summary: factory.summary().render(model),
    list: factory.list().render(model),
    cookies: factory.cookies().render(model),
  };
  for (const { number } of EndpointIndex.of(model).entries()) out[`detail ${number}`] = factory.detail().render({ model, ref: number });
  return out;
}

describe('every presenter output', () => {
  for (const [label, model] of [
    ['fixture', FIXTURE],
    ['mixed', MIXED],
    ['empty', EMPTY],
  ] as const) {
    test(`${label}: fits widths 60/100/160, is ASCII, and ANSI on/off differ only by escape codes`, () => {
      for (const width of WIDTHS) {
        const plain = renderAll({ width }, model);
        const color = renderAll({ width, color: true }, model);
        for (const [name, text] of Object.entries(plain)) {
          const where = `${label} ${name} @${width}`;
          assertFits(text, width, where);
          assertFits(color[name] ?? '', width, `${where} color`);
          assertAscii(text, where);
          assertAscii(color[name] ?? '', `${where} color`);
          assert.doesNotMatch(text, /\x1b/, where);
          assert.equal(Ansi.strip(color[name] ?? ''), text, where);
          assert.equal(text.endsWith('\n'), false, where);
        }
        if (model !== EMPTY) assert.match(color.list ?? '', /\x1b\[/);
      }
    });
  }

  test('data with control characters and non-ASCII text is neutralized', () => {
    const model = structuredClone(MIXED);
    const endpoint = model.endpoints[0]!;
    endpoint.name = 'caf\u00e9\u2028\x1b[2J';
    endpoint.path = '/\u65e5\u672c/\x07';
    model.name = 'Sm\u00f6rg\u00e5s\x1b]0;pwned\x07';
    model.cookies[0]!.valueExample = '\x1b[5mblink\u00e9';
    for (const width of WIDTHS) {
      for (const [name, text] of Object.entries(renderAll({ width, color: true }, model))) {
        assertAscii(text, name);
        assertFits(text, width, name);
        assert.doesNotMatch(Ansi.strip(text), /\x1b|\x07/, name);
      }
    }
    const list = new PresenterFactory({ width: 160 }).list().render(model);
    assert.match(list, /\/\\u65e5\\u672c\/\\x07/);
    assert.match(list, /^Sm\\u00f6rg\\u00e5s\\x1b\]0;pwned\\x07/);
    const detail = new PresenterFactory({ width: 160 }).detail().render({ model, ref: 1 });
    assert.match(detail, /Name: +caf\\u00e9\\u2028\\x1b\[2J/);
    const listOrders = new PresenterFactory({ width: 160 }).detail().render({ model: MIXED, ref: 'listOrders' });
    assert.match(listOrders, /\\x1b\[31mred\\x1b\[0m/);
  });

  test('compose escapes control characters that a block did not clean and keeps only the Ansi styles', () => {
    class RawPresenter extends BasePresenter<string> {
      render(input: string): string {
        return this.compose([this.ansi.bold('Title'), [input, `${this.ansi.red('x')}\x9b2J`]]);
      }
    }
    const raw = 'a\x1b]0;pwned\x07b\x1b[2Jc\rd\x08e\x7ff';
    const plain = new RawPresenter({ width: 200 }).render(raw);
    assert.equal(plain, 'Title\n\na\\x1b]0;pwned\\x07b\\x1b[2Jc\\x0dd\\x08e\\x7ff\nx\\x9b2J');
    const colored = new RawPresenter({ width: 200, color: true }).render(raw);
    assert.equal(Ansi.strip(colored), plain);
    assert.deepEqual(colored.match(/\x1b\[[0-9;]*m/g), ['\x1b[1m', '\x1b[22m', '\x1b[31m', '\x1b[39m']);
    assert.doesNotMatch(Ansi.strip(colored), /[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
  });
});

describe('SummaryPresenter', () => {
  test('shows the name, origins, capture span and counts', () => {
    const out = new SummaryPresenter().render(FIXTURE);
    const all = lines(out);
    assert.equal(all[0], 'shop.example.com');
    assert.equal(all[1], '----------------');
    assert.ok(all.includes('Primary origin: https://shop.example.com'));
    assert.ok(all.includes('Other origins:  none'));
    assert.ok(all.includes('Start URL:      https://shop.example.com/'));
    assert.ok(all.includes('Captured:       2026-01-01T00:00:00.000Z to 2026-01-01T00:00:01.700Z (1.7 s)'));
    assert.ok(all.includes('Endpoints:  12 (json 3, form 3, graphql 1, document 5), 12 first-party'));
    assert.ok(all.includes('Requests:   14 captured, 14 matched to endpoints'));
    assert.ok(all.includes('Cookies:    4 (session 1, auth 1, csrf 1, preference 1), 2 HttpOnly'));
    assert.ok(all.includes('Forms:      3 (3 linked to endpoints)'));
    assert.ok(all.includes('WebSockets: 0'));
  });

  test('the Forms line counts the forms that are linked to endpoints, also when two forms post to one endpoint', () => {
    const flow = CaptureFactory.fixture();
    flow.factory.snapshot('/other', 'Other', '<form id="quick" method="post" action="/login"><input name="email" type="email" required><input name="password" type="password"><button>Go</button></form>');
    flow.factory.snapshot('/close', 'Close', '<form method="dialog"><button>x</button></form>');
    const model = ModelBuilder.create({ now: PresentModels.NOW }).build(flow.factory.capture({ startUrl: flow.factory.url('/') }));
    assert.equal(model.forms.length, 5);
    assert.equal(model.endpoints.filter((endpoint) => endpoint.form !== undefined).length, 3);
    assert.ok(lines(new SummaryPresenter().render(model)).includes('Forms:      5 (4 linked to endpoints)'));
    const old = { ...model, forms: model.forms.map(({ endpoints: _ids, ...form }) => form) };
    assert.ok(lines(new SummaryPresenter().render(old)).includes('Forms:      5'));
  });

  test('lists other origins, websockets, the source file and third-party counts', () => {
    const model = { ...MIXED, source: { ...MIXED.source, file: 'captures/app.json' } };
    const out = lines(new SummaryPresenter({ width: 100 }).render(model));
    assert.ok(out.includes('Other origins:  https://collect.tracker.net'));
    assert.ok(out.includes('Source file:    captures/app.json'));
    assert.ok(out.includes('WebSockets: 1 (2 messages)'));
    assert.ok(out.some((line) => /^Endpoints: +7 \(json 5, document 1, other 1\), 6 first-party$/.test(line)));
  });

  test('summarizes empty models and partial capture spans', () => {
    const out = lines(new SummaryPresenter().render(EMPTY));
    assert.equal(out[0], 'empty');
    assert.ok(out.includes('Endpoints:  0'));
    assert.ok(out.includes('Cookies:    0'));
    assert.equal(SummaryPresenter.span(undefined, undefined), 'unknown');
    assert.equal(SummaryPresenter.span('2026-01-01T00:00:00Z', undefined), 'since 2026-01-01T00:00:00Z');
    assert.equal(SummaryPresenter.span(undefined, '2026-01-01T00:00:00Z'), 'until 2026-01-01T00:00:00Z');
    assert.equal(SummaryPresenter.span('2026-01-01T00:00:00Z', '2026-01-01T00:02:05Z'), '2026-01-01T00:00:00Z to 2026-01-01T00:02:05Z (2 min 5 s)');
    assert.equal(SummaryPresenter.span('garbage', '2026-01-01T00:00:00Z'), 'garbage to 2026-01-01T00:00:00Z');
    assert.equal(SummaryPresenter.span('2026-01-02T00:00:00Z', '2026-01-01T00:00:00Z'), '2026-01-02T00:00:00Z to 2026-01-01T00:00:00Z');
    assert.equal(SummaryPresenter.tally(['b', 'z', 'a', 'b'], ['a', 'b']), 'a 1, b 2, z 1');
  });
});

describe('EndpointListPresenter', () => {
  test('renders one origin section with every column at a wide width', () => {
    const out = new EndpointListPresenter({ width: 160 }).render(FIXTURE);
    const all = lines(out);
    assert.equal(all[0], 'shop.example.com: 12 endpoints at https://shop.example.com');
    assert.equal(all.filter((line) => line.includes('https://shop.example.com')).length, 1);
    assert.ok(!all.some((line) => /\(12 endpoints\)/.test(line)));
    assert.deepEqual(tableRows(out)[0], ['#', 'METHOD', 'PATH', 'QUERY', 'BODY', 'STATUS', 'AUTH', 'HITS']);
    const rows = numberedRows(out);
    assert.equal(rows.size, 12);
    assert.deepEqual(rows.get(3), ['3', 'GET', '/api/items', 'page*, limit*', '', '200', 'cookie', '2']);
    assert.deepEqual(rows.get(4), ['4', 'POST', '/api/items', '', 'json: name, price', '201 400', 'cookie,csrf', '2']);
    assert.deepEqual(rows.get(5), ['5', 'GET', '/api/items/{itemId}', '', '', '200 404', 'cookie', '3']);
    assert.deepEqual(rows.get(7), ['7', 'POST', '/graphql#GetItem', '', 'graphql: $id', '200', 'cookie', '1']);
    assert.deepEqual(rows.get(9), ['9', 'POST', '/login', '', 'form: csrf_token, email, password +2', '303', 'cookie,csrf', '1']);
    assert.deepEqual(rows.get(12), ['12', 'POST', '/signup', 'draft', 'multipart: username, email, age +10', '-', 'cookie', '0']);
    const index = EndpointIndex.of(FIXTURE);
    for (const [number, row] of rows) assert.equal(index.get(number)?.path, row[2]?.replace(/#.*$/, ''));
    assert.doesNotMatch(out, /Columns hidden/);
  });

  test('drops low-priority columns at narrow widths and says which', () => {
    const narrow = new EndpointListPresenter({ width: 60 }).render(FIXTURE);
    assert.deepEqual(tableRows(narrow)[0], ['#', 'METHOD', 'PATH', 'STATUS', 'HITS']);
    assert.match(narrow, /Columns hidden to fit 60 characters: QUERY, BODY, AUTH/);
    const medium = new EndpointListPresenter({ width: 100 }).render(FIXTURE);
    assert.deepEqual(tableRows(medium)[0], ['#', 'METHOD', 'PATH', 'QUERY', 'STATUS', 'AUTH', 'HITS']);
    assert.match(medium, /Columns hidden to fit 100 characters: BODY/);
  });

  test('filters keep the stable model numbers and describe themselves', () => {
    const out = new EndpointListPresenter({ width: 160, filter: { method: 'post' } }).render(FIXTURE);
    const all = lines(out);
    assert.equal(all[0], 'shop.example.com: 4 of 12 endpoints at https://shop.example.com');
    assert.ok(all.includes('Filter: method POST'));
    assert.deepEqual([...numberedRows(out).keys()], [4, 7, 9, 12]);
    const items = new EndpointListPresenter({ width: 160, filter: { text: 'items', kind: ['json'] } }).render(FIXTURE);
    assert.deepEqual([...numberedRows(items).keys()].filter((n) => n < 100), [3, 4, 5]);
    const none = new EndpointListPresenter({ filter: { text: 'zzz' } }).render(FIXTURE);
    assert.match(none, /No endpoints match the filter\./);
    assert.doesNotMatch(none, /Details:/);
  });

  test('groups by origin with a shared column layout and marks third-party sections', () => {
    const out = new EndpointListPresenter({ width: 160 }).render(MIXED);
    const all = lines(out);
    const first = all.indexOf('https://app.example.org (6 endpoints)');
    const second = all.indexOf('https://collect.tracker.net (1 endpoint, third-party)');
    assert.ok(first > 0 && second > first);
    assert.equal(all[first + 1], all[second + 1]);
    assert.deepEqual(numberedRows(out).get(7)?.slice(0, 4), ['7', 'POST', '/v2/collect', 'tid*']);
    assert.equal(numberedRows(out).get(1)?.[6], 'header');
    assert.equal(numberedRows(out).get(2)?.[6], 'bearer');
  });

  test('draws a top-10 hits chart, a status distribution line and command hints', () => {
    const out = new EndpointListPresenter({ width: 100 }).render(FIXTURE);
    const all = lines(out);
    const start = all.indexOf('Top 10 endpoints by hits');
    assert.ok(start > 0);
    const chart = all.slice(start + 1, start + 11);
    assert.match(chart[0]!, /^ 5 GET  \/api\/items\/\{itemId\} +#+ 3$/);
    assert.deepEqual(
      chart.map((line) => Number(/^ ?(\d+) /.exec(line)?.[1])),
      [5, 3, 4, 1, 2, 6, 7, 8, 9, 11],
    );
    const bars = chart.map((line) => (/ (#+) \d+$/.exec(line)?.[1] ?? '').length);
    assert.equal(bars[0], 40);
    assert.ok(bars[1]! < bars[0]! && bars[9]! >= 1 && bars[1]! > bars[9]!);
    assert.equal(all[start + 11], '');
    assert.ok(all.includes('Statuses: 200 x10  201 x1  303 x1  400 x1  404 x1'));
    assert.equal(all[all.length - 2], 'Details: appii list <file> --show <#>');
    assert.equal(all[all.length - 1], 'Export:  appii export <file> --format openapi');
    const top = EndpointListPresenter.topByHits(FIXTURE.endpoints, EndpointIndex.of(FIXTURE), 3);
    assert.deepEqual(top.map((endpoint) => endpoint.id), ['get-api-items-itemid', 'get-api-items', 'post-api-items']);
    assert.deepEqual([...EndpointListPresenter.statusTotals(FIXTURE.endpoints)], [[200, 10], [201, 1], [303, 1], [400, 1], [404, 1]]);
  });

  test('hints use the file name when known, quoted for the shell when needed', () => {
    const named = lines(new EndpointListPresenter({ file: 'api.json' }).render(FIXTURE));
    assert.equal(named[named.length - 2], 'Details: appii list api.json --show <#>');
    assert.equal(named[named.length - 1], 'Export:  appii export api.json --format openapi');
    const spaced = lines(new EndpointListPresenter({ file: "my api's.json" }).render(FIXTURE));
    assert.equal(spaced[spaced.length - 1], `Export:  appii export 'my api'\\''s.json' --format openapi`);
    assert.equal(BasePresenter.fileArgument(undefined), '<file>');
    assert.equal(BasePresenter.fileArgument(''), '<file>');
    assert.equal(BasePresenter.fileArgument('out/api-v2.json'), 'out/api-v2.json');
  });

  test('colors methods, statuses and path parameters only when enabled', () => {
    const color = new EndpointListPresenter({ width: 160, color: true }).render(FIXTURE);
    assert.ok(color.includes(Ansi.color.cyan('{itemId}')));
    assert.ok(color.includes(Ansi.color.yellow('POST')));
    assert.ok(color.includes(Ansi.color.yellow('404')));
    assert.ok(color.includes(Ansi.color.bold('shop.example.com: 12 endpoints at https://shop.example.com')));
  });

  test('hints can be turned off, and a filter that leaves one origin names it in the heading', () => {
    const quiet = new EndpointListPresenter({ width: 160, hints: false }).render(FIXTURE);
    assert.doesNotMatch(quiet, /Details:|Export:/);
    assert.match(new EndpointListPresenter({ width: 160 }).render(FIXTURE), /\nExport: +appii export <file> --format openapi$/);
    const third = new EndpointListPresenter({ width: 160, filter: { origin: 'collect.tracker.net' } }).render(MIXED);
    assert.equal(lines(third)[0], 'app.example.org: 1 of 7 endpoints at https://collect.tracker.net (third-party)');
    assert.ok(!lines(third).some((line) => line.startsWith('https://collect.tracker.net (')));
    const both = lines(new EndpointListPresenter({ width: 160 }).render(MIXED));
    assert.equal(both[0], 'app.example.org: 7 endpoints');
  });

  test('says when a model has no endpoints', () => {
    const out = new EndpointListPresenter().render(EMPTY);
    assert.deepEqual(lines(out), ['empty: 0 endpoints', '------------------', '', 'No endpoints in this model.']);
  });
});

describe('EndpointDetailPresenter', () => {
  const detail = (ref: string | number, options: PresenterOptions = { width: 120 }, model: ApiModel = FIXTURE) => new EndpointDetailPresenter(options).render({ model, ref });

  test('resolves numbers, ids, names and keys, case-insensitively', () => {
    const expected = detail(4);
    for (const ref of ['4', 'post-api-items', 'createItem', 'CREATEITEM', 'POST https://shop.example.com/api/items']) assert.equal(detail(ref), expected, ref);
  });

  test('unknown references raise the EndpointIndex NOT_FOUND error with suggestions', () => {
    assert.throws(
      () => detail('items'),
      (err: unknown) => {
        assert.ok(err instanceof AppiiError);
        assert.equal(err.code, 'NOT_FOUND');
        const details = err.details as { suggestions: string[]; count: number };
        assert.equal(details.count, 12);
        assert.ok(details.suggestions.includes('3 listItems'));
        return true;
      },
    );
    assert.throws(() => detail(99), (err: unknown) => isAppiiError(err) && err.code === 'NOT_FOUND');
    assert.throws(() => detail(0), (err: unknown) => isAppiiError(err) && err.code === 'NOT_FOUND');
  });

  test('title, facts and names', () => {
    const all = lines(detail(4));
    assert.equal(all[0], 'POST https://shop.example.com/api/items');
    assert.equal(all[1], '#4  kind json  2 hits  first-party  seen as fetch');
    assert.equal(all[2], 'Name: createItem');
    assert.equal(all[3], 'Id:   post-api-items');
    const graphql = lines(detail(7));
    assert.equal(graphql[0], 'POST https://shop.example.com/graphql#GetItem');
    assert.ok(graphql.includes('Operation: GetItem'));
    const long = lines(detail(3, { width: 60 }, MIXED));
    assert.equal(long[0], 'GET https://app.example.org/api/v1/organizations/{organizati');
    assert.equal(long[1], 'onId}/projects/{projectId}/environments/production-eu-west-1');
  });

  test('path, query and header parameter tables', () => {
    const path = tableRows(section(detail(5), 'Path parameters').join('\n'));
    assert.deepEqual(path, [
      ['NAME', 'REQ', 'TYPE', 'CONSTRAINTS', 'EXAMPLES'],
      ['itemId', 'yes', 'integer', '', '1, 2, 999'],
    ]);
    const query = tableRows(section(detail(3), 'Query parameters').join('\n'));
    assert.deepEqual(query.slice(1), [
      ['page', 'yes', 'integer', '', '1, 2'],
      ['limit', 'yes', 'integer', '', '2'],
    ]);
    const headers = tableRows(section(detail(4), 'Header parameters').join('\n'));
    assert.deepEqual(headers.slice(1), [['x-csrf-token', 'yes', 'string', '', '<redacted>']]);
    assert.doesNotMatch(detail(1), /parameters/);
  });

  test('request body with schema rows, GraphQL query and form validation rules', () => {
    const body = section(detail(4), 'Request body');
    assert.equal(body[0], 'Type: application/json (json)');
    assert.deepEqual(tableRows(body.join('\n')).slice(1), [
      ['name', 'string', 'no', ''],
      ['price', 'integer', 'yes', ''],
    ]);
    const graphql = section(detail(7), 'Request body');
    assert.ok(graphql.includes('Query: query GetItem($id: ID!) { item(id: $id) { id name } }'));
    assert.ok(tableRows(graphql.join('\n')).some((row) => row[0] === 'variables.id'));
    const signupText = section(detail(12, { width: 160 }), 'Request body');
    const signup = tableRows(signupText.join('\n'));
    const rule = (field: string) => signup.find((row) => row[0] === field);
    assert.deepEqual(rule('username'), ['username', 'string', 'if', 'pattern [a-z0-9_]{3,16}']);
    assert.deepEqual(rule('age'), ['age', 'number|empty', 'no', 'html number, range 13..120, step 1']);
    assert.deepEqual(rule('country'), ['country', 'enum(3)', 'if', 'one of us|ca|"", default ""']);
    assert.deepEqual(rule('interests[]'), ['interests[]', 'enum(3)', 'no', 'one of a|b|c']);
    assert.deepEqual(rule('terms'), ['terms', 'const on', 'if', 'html checkbox, always on']);
    assert.deepEqual(rule('intent'), ['intent', 'enum(2)', 'yes', 'html submit, one of create|draft']);
    const create = signupText.indexOf('When intent=create ("Create"):');
    const draft = signupText.indexOf('When intent=draft ("Save draft"), no form validation:');
    assert.ok(create > 0 && draft > create, signupText.join('\n'));
    assert.equal(signupText[create + 1], '  Requires: username, email, country, terms');
    const createRows = tableRows(signupText.slice(create, draft).join('\n')).filter((row) => row[0] !== '');
    assert.deepEqual(createRows.map((row) => row[0]), ['FIELD', 'username', 'email', 'age', 'country']);
    assert.match(createRows[1]?.slice(1).join(' ') ?? '', /^string yes pattern \[a-z0-9_\]\{3,16\}, length 1\.\.$/);
    assert.deepEqual(createRows[3], ['age', 'integer|empty', 'no', 'html number, range 13..120, step 1']);
    assert.deepEqual(createRows[4], ['country', 'enum(2)', 'yes', 'one of us|ca']);
    assert.deepEqual(tableRows(signupText.slice(draft).join('\n')).slice(1), [['country', 'enum(3)', 'no', 'one of ""|us|ca, default ""']]);
    assert.ok(!signupText.some((line) => line.startsWith('Required if')));
    assert.doesNotMatch(section(detail(4), 'Request body').join('\n'), /When /);
  });

  test('exclusive submitters show what each submission requires and what it must not send', () => {
    const f = new CaptureFactory();
    f.snapshot(
      '/admin/post/add/',
      'Add post',
      '<form method="post" action="/admin/post/add/"><input name="title" required maxlength="50"><input type="submit" name="_save" value="Save"><input type="submit" name="_continue" value="Save and continue"></form>',
    );
    f.snapshot(
      '/cart',
      'Cart',
      '<form method="post" action="/cart"><input type="number" name="quantity" required value="1"><button name="update" value="1">Update</button></form><form method="post" action="/cart"><input name="discount" required><button name="apply" value="1">Apply</button></form>',
    );
    const model = ModelBuilder.create({ now: PresentModels.NOW }).build(f.capture());
    const admin = section(detail('post-admin-post-add', { width: 100 }, model), 'Request body');
    assert.ok(admin.includes('When _save=Save:'), admin.join('\n'));
    assert.equal(admin[admin.indexOf('When _save=Save:') + 1], '  Not sent: _continue');
    assert.equal(admin[admin.indexOf('When _continue=Save and continue:') + 1], '  Not sent: _save');
    const cart = section(detail('post-cart', { width: 100 }, model), 'Request body');
    assert.deepEqual(cart.slice(cart.indexOf('When update=1:'), cart.indexOf('When update=1:') + 3), ['When update=1:', '  Requires: quantity', '  Not sent: apply']);
    assert.deepEqual(cart.slice(cart.indexOf('When apply=1:'), cart.indexOf('When apply=1:') + 3), ['When apply=1:', '  Requires: discount', '  Not sent: update']);
    const list = numberedRows(new EndpointListPresenter({ width: 160 }).render(model));
    const bodies = [...list.values()].map((row) => row[4]);
    assert.ok(bodies.includes('form: title, _save|_continue'), bodies.join(' / '));
    assert.ok(bodies.includes('form: quantity, update|apply, discount'), bodies.join(' / '));
    assert.equal(numberedRows(new EndpointListPresenter({ width: 160 }).render(FIXTURE)).get(12)?.[4], 'multipart: username, email, age +10');
  });

  test('narrow widths wrap constraints instead of cutting them', () => {
    const out = detail(12, { width: 60 });
    const rows = lines(section(out, 'Request body').join('\n')).filter((line) => line.startsWith('|'));
    const text = rows.map((line) => line.slice(2, -2).split(' | ')[3]?.trim() ?? '').join('').replace(/\s+/g, '');
    assert.match(text, /range13\.\.120,step1/);
    assert.match(text, /pattern\[a-z0-9_\]\{3,16\}/);
    assert.doesNotMatch(text, /\.\.\.(?!\d)/);
    assert.ok(section(out, 'Request body').includes('  Requires: username, email, country, terms'));
    assert.ok(section(out, 'Request body').includes('When intent=draft ("Save draft"), no form validation:'));
    assertFits(out, 60, 'signup @60');
  });

  test('form source section', () => {
    const form = section(detail(12), 'Form source');
    assert.ok(form.includes('Page:         https://shop.example.com/signup'));
    assert.ok(form.includes('Selector:     form#signup'));
    assert.ok(form.includes('Enctype:      multipart/form-data'));
    assert.ok(form.includes('Token fields: none'));
    assert.ok(form.includes('Submitter 1:  intent=create "Create"'));
    assert.ok(form.includes('Submitter 2:  intent=draft "Save draft" formaction https://shop.example.com/signup?draft=1 novalidate'));
    assert.ok(section(detail(9), 'Form source').includes('Token fields: csrf_token'));
    assert.doesNotMatch(detail(4), /Form source/);
    assert.equal(EndpointDetailPresenter.submitter({ name: '', order: 0, kind: 'button', type: 'submit', value: '', hasValueAttribute: false, checked: false, disabled: true, readOnly: false, required: false, multiple: false, formMethod: 'GET', formEnctype: 'text/plain' }), '(unnamed) formmethod GET formenctype text/plain disabled');
  });

  test('auth section with the CSRF token table', () => {
    const auth = section(detail(4), 'Auth');
    assert.ok(auth.includes('Cookies: auth, csrf, sid, theme'));
    assert.ok(auth.includes('Bearer:  no'));
    assert.ok(auth.includes('CSRF:    1 token'));
    assert.deepEqual(tableRows(auth.join('\n')), [
      ['LOCATION', 'NAME', 'SOURCE', 'SOURCE NAME', 'SOURCE URL'],
      ['header', 'x-csrf-token', 'cookie', 'csrf', ''],
    ]);
    const login = tableRows(section(detail(9), 'Auth').join('\n'));
    assert.deepEqual(login[1], ['body', 'csrf_token', 'hidden-field', 'csrf_token', 'https://shop.example.com/login']);
    const bearer = section(detail('createOrder', { width: 100 }, MIXED), 'Auth');
    assert.ok(bearer.includes('Bearer:  yes'));
    assert.ok(bearer.includes('Headers: authorization'));
    assert.ok(section(detail(1), 'Auth').includes('CSRF:    none'));
  });

  test('responses per status with counts, MIME types, headers and schema rows', () => {
    const responses = section(detail(4), 'Responses');
    assert.equal(responses[0], '201  1 hit  application/json (json)');
    assert.ok(responses.includes('400  1 hit  application/json (json)'));
    assert.ok(responses.includes('Headers: content-type'));
    assert.ok(tableRows(responses.join('\n')).some((row) => row[0] === 'errors.price' && row[1] === 'array<string>'));
    const login = section(detail(9), 'Responses');
    assert.deepEqual(login, ['303  1 hit  no body', 'Headers: location, set-cookie: auth']);
    assert.deepEqual(section(detail(12), 'Responses'), ['No responses observed; this endpoint is known from a form.']);
    const deleted = section(detail('delete-api-v1-users-userid', {}, MIXED), 'Responses');
    assert.equal(deleted[0], '204  1 hit  no body');
  });

  test('marks structured bodies whose content was not captured', () => {
    const model = structuredClone(FIXTURE);
    const response = model.endpoints[3]!.responses[0]!;
    response.body = { kind: 'json', mimeType: 'application/json', examples: [] };
    assert.ok(section(new EndpointDetailPresenter().render({ model, ref: 4 }), 'Responses').includes('Schema unknown (the body was not captured).'));
  });

  test('samples table', () => {
    const samples = tableRows(section(detail(5), 'Samples').join('\n'));
    assert.deepEqual(samples[0], ['STATUS', 'URL', 'STARTED']);
    assert.deepEqual(samples.slice(1).map((row) => [row[0], row[1]]), [
      ['200', 'https://shop.example.com/api/items/1'],
      ['200', 'https://shop.example.com/api/items/2'],
      ['404', 'https://shop.example.com/api/items/999'],
    ]);
    assert.doesNotMatch(detail(12), /Samples/);
  });

  test('example curl links CSRF headers to their cookie and is valid shell at any width', () => {
    const wide = section(detail(4, { width: 200 }), 'Example request (curl)');
    const command = wide.slice(0, wide.indexOf(''));
    assert.deepEqual(command, [
      "curl -sS -X POST 'https://shop.example.com/api/items' \\",
      '  -H "x-csrf-token: ${APPII_CSRF}" \\',
      "  -H 'Content-Type: application/json' \\",
      '  -b "auth=${APPII_AUTH}; csrf=${APPII_CSRF}; sid=${APPII_SID}; theme=${APPII_THEME}" \\',
      `  --data-raw '{"name":"Thing","price":5}' \\`,
      '  --compressed',
    ]);
    assert.equal(wide[wide.length - 1], 'Variables: APPII_AUTH APPII_CSRF APPII_SID APPII_THEME');
    const argv = (script: string) =>
      execFileSync('sh', ['-c', script.replace(/^curl\b/, "printf '<%s>\\n'")], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', APPII_AUTH: 'a', APPII_CSRF: 'c c', APPII_SID: 's', APPII_THEME: 't' } }).toString();
    for (const ref of [4, 9, 12]) {
      const reference = section(detail(ref, { width: 400 }), 'Example request (curl)');
      const expected = argv(reference.slice(0, reference.indexOf('')).join('\n'));
      for (const width of [40, 60, 100]) {
        const curl = section(detail(ref, { width }), 'Example request (curl)');
        const folded = curl.slice(0, curl.indexOf(''));
        assert.ok(folded.every((line) => line.length <= width));
        assert.equal(argv(folded.join('\n')), expected, `#${ref} @${width}`);
      }
    }
  });

  test('bearer endpoints get a Bearer placeholder and multipart text fields are sent as literal strings', () => {
    const bearer = detail('createOrder', { width: 200 }, MIXED);
    assert.match(bearer, /-H "authorization: Bearer \$\{APPII_ACCESS_TOKEN\}"/);
    assert.match(bearer, /Variables: APPII_ACCESS_TOKEN/);
    const signup = detail(12, { width: 200 });
    assert.match(signup, /--form-string 'username=username'/);
    assert.match(signup, /--form-string 'interests=a' \\\n {2}--form-string 'interests=c'/);
    const login = detail(9, { width: 200 });
    assert.match(login, /--data-urlencode "csrf_token=\$\{APPII_CSRF_TOKEN\}"/);
  });

  test('exampleRequest links double-submit cookies and leaves other placeholders alone', () => {
    const endpoint = EndpointIndex.of(FIXTURE).require(4);
    const sample = EndpointDetailPresenter.exampleRequest(endpoint);
    assert.deepEqual(sample, Samples.requestSample(endpoint));
    assert.equal(String(sample.cookie), 'auth={{auth}}; csrf={{csrf}}; sid={{sid}}; theme={{theme}}');
    assert.equal(String(sample.headers.find((header) => header.name === 'x-csrf-token')?.value), '{{csrf}}');
    const bodyToken = {
      ...endpoint,
      auth: { ...endpoint.auth, csrf: [{ location: 'body' as const, name: 'token', source: 'cookie' as const, sourceName: 'csrf' }] },
    };
    const body = Samples.plainValue(EndpointDetailPresenter.exampleRequest(bodyToken).body?.value) as Record<string, unknown>;
    assert.equal(body.token, '{{csrf}}');
    const root = EndpointDetailPresenter.exampleRequest(EndpointIndex.of(FIXTURE).require(1));
    assert.equal(root.cookie, undefined);
    assert.equal(root.method, 'GET');
    assert.equal(String(root.url), 'https://shop.example.com/');
    assert.deepEqual(root.headers, []);
    assert.equal(root.body, undefined);
    const detail = new EndpointDetailPresenter({ width: 200 }).render({ model: FIXTURE, ref: 4 });
    assert.equal(detail.split(' -b ').length - 1, 1, detail);
  });

  test('create() builds the default collaborators', () => {
    assert.equal(EndpointDetailPresenter.create({ width: 90, color: true }).render({ model: FIXTURE, ref: 4 }), new EndpointDetailPresenter({ width: 90, color: true }).render({ model: FIXTURE, ref: 4 }));
    assert.equal(EndpointListPresenter.create({ width: 90 }).render(FIXTURE), new EndpointListPresenter({ width: 90 }).render(FIXTURE));
    assert.equal(BasePresenter.ansiFor({ color: true }).enabled, true);
    assert.equal(BasePresenter.ansiFor().enabled, false);
  });

  test('collaborators can be substituted', () => {
    const shallow = new EndpointDetailPresenter({ width: 120 }, { tree: new SchemaTree({ maxDepth: 1 }) }).render({ model: MIXED, ref: 'createOrder' });
    assert.ok(tableRows(section(shallow, 'Request body').join('\n')).some((row) => row[0] === 'customer' && row[3] === '+2 nested'));
    assert.ok(!tableRows(section(shallow, 'Request body').join('\n')).some((row) => row[0] === 'customer.name'));
  });
});

describe('CookieListPresenter', () => {
  test('renders every cookie with flags, expiry and endpoint numbers', () => {
    const out = new CookieListPresenter({ width: 160 }).render(FIXTURE);
    const rows = tableRows(out);
    assert.equal(lines(out)[0], 'shop.example.com: 4 cookies');
    assert.deepEqual(rows[0], ['NAME', 'DOMAIN', 'PATH', 'ROLE', 'FLAGS', 'EXPIRES', 'SET BY', 'USED BY', 'VALUE']);
    assert.deepEqual(rows.slice(1), [
      ['auth', 'shop.example.com', '/', 'auth', 'HttpOnly SameSite=Lax', 'session', '9', '2-7,10-12', 'feed...'],
      ['csrf', 'shop.example.com', '/', 'csrf', 'SameSite=Strict', 'session', '6', '3-5,7,10-12', '0123...'],
      ['sid', 'shop.example.com', '/', 'session', 'HttpOnly SameSite=Lax', 'session', '1', '2-12', 'a1b2...'],
      ['theme', 'shop.example.com', '/', 'preference', 'SameSite=Lax', '2026-01-01T01:00:00Z', '1', '2-12', 'dark'],
    ]);
    assert.match(out, /SET BY and USED BY list endpoint numbers from the endpoint list\./);
    assert.doesNotMatch(out, /Columns hidden/);
  });

  test('narrow widths hide optional columns and say so', () => {
    const out = new CookieListPresenter({ width: 100 }).render(FIXTURE);
    assert.deepEqual(tableRows(out)[0], ['NAME', 'PATH', 'ROLE', 'FLAGS', 'EXPIRES', 'SET BY', 'USED BY']);
    assert.match(out, /Columns hidden to fit 100 characters: DOMAIN, VALUE/);
    assertFits(out, 100, 'cookies @100');
  });

  test('a filter keeps the cookies of matching endpoints', () => {
    const out = new CookieListPresenter({ width: 160, filter: { text: 'login' } }).render(FIXTURE);
    assert.equal(lines(out)[0], 'shop.example.com: 3 of 4 cookies');
    assert.ok(lines(out).includes('Filter: cookies of endpoints matching text "login"'));
    assert.deepEqual(tableRows(out).slice(1).map((row) => row[0]), ['auth', 'sid', 'theme']);
    const none = new CookieListPresenter({ filter: { origin: 'nowhere.test' } }).render(FIXTURE);
    assert.match(none, /No cookies belong to the matching endpoints\./);
  });

  test('styles roles and bolds names when color is on', () => {
    const out = new CookieListPresenter({ width: 160, color: true }).render(FIXTURE);
    assert.ok(out.includes(Ansi.color.magenta('csrf')));
    assert.ok(out.includes(Ansi.color.bold('theme')));
    assert.ok(out.includes(Ansi.color.green('preference')));
  });

  test('static helpers: ranges, flags and expiry', () => {
    assert.equal(CookieListPresenter.ranges([12, 1, 2, 3, 5, 6, 9, 10, 11, 3]), '1-3,5,6,9-12');
    assert.equal(CookieListPresenter.ranges([]), '');
    assert.equal(CookieListPresenter.ranges([7]), '7');
    const cookie: CookieInfo = { name: 'x', domain: '.example.com', path: '/', httpOnly: false, secure: true, sameSite: 'None', session: false, expires: '2027-02-03T04:05:06.789Z', role: 'tracking', setBy: [], usedBy: [], valueExample: '' };
    assert.equal(CookieListPresenter.flags(cookie), 'Secure SameSite=None');
    assert.equal(CookieListPresenter.flags({ ...cookie, secure: false, sameSite: null }), '');
    assert.equal(CookieListPresenter.expires(cookie), '2027-02-03T04:05:06Z');
    assert.equal(CookieListPresenter.expires({ ...cookie, session: true }), 'session');
    assert.equal(CookieListPresenter.expires({ ...cookie, expires: 'not a date' }), 'not a date');
  });

  test('survives malformed roles and enum values from hand-edited model files', () => {
    const model = structuredClone(FIXTURE);
    const loose = model as unknown as { cookies: Record<string, unknown>[]; endpoints: { auth: { csrf: Record<string, unknown>[] } }[] };
    loose.cookies[0]!.role = '__proto__';
    loose.cookies[1]!.role = 'constructor';
    loose.cookies[2]!.sameSite = 'Lax\x1b[31m';
    loose.endpoints[3]!.auth.csrf[0]!.source = 'evil\x1b[2J';
    const cookies = new CookieListPresenter({ width: 160, color: true }).render(model);
    assert.ok(cookies.includes(Ansi.color.dim('__proto__')));
    assert.ok(cookies.includes(Ansi.color.dim('constructor')));
    assert.doesNotMatch(Ansi.strip(cookies), /\x1b/);
    assert.doesNotMatch(Ansi.strip(new EndpointDetailPresenter({ color: true }).render({ model, ref: 4 })), /\x1b/);
    assert.equal(CookieListPresenter.roleStyle('auth'), 'yellow');
    assert.equal(CookieListPresenter.roleStyle('toString'), 'dim');
  });

  test('shows unknown endpoint ids verbatim and dashes for empty lists', () => {
    const model = structuredClone(FIXTURE);
    model.cookies[0]!.setBy = ['ghost-endpoint', 'post-login'];
    model.cookies[0]!.usedBy = [];
    const row = tableRows(new CookieListPresenter({ width: 160 }).render(model))[1];
    assert.equal(row?.[6], '9,ghost-endpoint');
    assert.equal(row?.[7], '-');
  });

  test('empty models', () => {
    assert.match(new CookieListPresenter().render(EMPTY), /No cookies were recorded\./);
  });
});

describe('PresenterFactory', () => {
  test('builds presenters that share one set of options', () => {
    const factory = new PresenterFactory({ width: 60, color: true, filter: { method: 'GET' } });
    assert.ok(factory.summary() instanceof SummaryPresenter);
    assert.ok(factory.list() instanceof EndpointListPresenter);
    assert.ok(factory.detail() instanceof EndpointDetailPresenter);
    assert.ok(factory.cookies() instanceof CookieListPresenter);
    const list = factory.list().render(FIXTURE);
    assertFits(list, 60, 'factory list');
    assert.match(list, /\x1b\[/);
    assert.match(Ansi.strip(list), /8 of 12 endpoints/);
  });

  test('create() maps kinds to presenters and rejects unknown kinds', () => {
    const factory = new PresenterFactory();
    assert.ok(factory.create('summary') instanceof SummaryPresenter);
    assert.ok(factory.create('list') instanceof EndpointListPresenter);
    assert.ok(factory.create('cookies') instanceof CookieListPresenter);
    assert.equal(factory.create('detail').render({ model: FIXTURE, ref: 1 }), factory.detail().render({ model: FIXTURE, ref: 1 }));
    assert.throws(() => factory.create('table' as 'list'), badInput);
    assert.deepEqual(PresenterFactory.KINDS, ['summary', 'list', 'detail', 'cookies']);
    assert.equal(PresenterFactory.isKind('cookies'), true);
    assert.equal(PresenterFactory.isKind('nope'), false);
  });

  test('copies its options and validates the width eagerly', () => {
    const filter = { method: 'GET' };
    const factory = new PresenterFactory({ filter });
    filter.method = 'POST';
    assert.equal(factory.options.filter?.method, 'GET');
    assert.throws(() => new PresenterFactory({ width: 0 }), badInput);
    assert.throws(() => new SummaryPresenter({ width: Number.NaN }), badInput);
    assert.equal(lines(new SummaryPresenter({ width: 30.8 }).render(FIXTURE)).every((line) => line.length <= 30), true);
  });
});

describe('EndpointDetailPresenter example requests', () => {
  const curlBlock = (text: string): string[] => {
    const block = section(text, 'Example request (curl)');
    const end = block.indexOf('');
    return end < 0 ? block : block.slice(0, end);
  };
  const argv = (script: string, env: Record<string, string> = {}): string[] =>
    execFileSync('bash', ['-c', `curl() { printf '%s\\n' "$@"; }; ${script}`], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env } })
      .toString()
      .split('\n')
      .slice(0, -1);

  test('captured values that look like placeholders stay literal and read no variables', () => {
    const model = LiteralPlaceholderSite.model();
    for (const name of ['getSearch', 'postNote', 'postForm']) {
      const text = new EndpointDetailPresenter({ width: 100 }).render({ model, ref: name });
      assert.ok(!text.includes('${'), text);
      assert.ok(!text.includes('Variables:'), text);
      const args = argv(curlBlock(text).join('\n'), LiteralPlaceholderSite.LEAK_ENV);
      assert.ok(!args.some((arg) => arg.includes('leak')), args.join('\n'));
    }
    const search = argv(curlBlock(new EndpointDetailPresenter({ width: 100 }).render({ model, ref: 'getSearch' })).join('\n'));
    assert.ok(search.includes('x-trace: {{github_token}}'), search.join('\n'));
  });

  test('the example sends the exact UTF-8 bytes and control characters at any width', () => {
    const city = ExportModel.endpoint({
      method: 'POST',
      path: '/city',
      kind: 'form',
      requestBody: { mimeType: 'application/x-www-form-urlencoded', kind: 'form', examples: [{ ville: 'Montr\u00e9al', note: 'a\tb', long: 'x'.repeat(70) + '\u00e9' }] },
    });
    const model = ExportModel.model([city]);
    for (const width of [40, 60, 100]) {
      const text = new EndpointDetailPresenter({ width }).render({ model, ref: 1 });
      assertAscii(text, `width ${width}`);
      const block = curlBlock(text);
      assert.ok(block.every((line) => line.length <= width), block.join('\n'));
      const args = argv(block.join('\n'));
      assert.ok(args.includes('ville=Montr%C3%A9al'), args.join('\n'));
      assert.ok(args.includes('note=a%09b'), args.join('\n'));
      assert.ok(args.includes('long=' + 'x'.repeat(70) + '%C3%A9'), args.join('\n'));
    }
  });
});
