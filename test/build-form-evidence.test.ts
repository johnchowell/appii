import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { FormLinker, FormSchemaCombiner, ModelBuilder, ModelValidator } from '../src/build/index.js';
import { ExporterRegistry, TsEndpointWriter } from '../src/export/index.js';
import { SubmissionRules } from '../src/forms/index.js';
import type { ApiModel, Capture, Endpoint, FormDescriptor, JsonSchema } from '../src/model/index.js';
import { SummaryPresenter } from '../src/present/index.js';
import { Schema } from '../src/shared/index.js';
import { SchemaCheck } from './fixtures/build-schema-check.js';
import { TsClientHarness } from './fixtures/export-ts-harness.js';
import { CaptureFactory } from './helpers/capture-factory.js';

const FORM = 'application/x-www-form-urlencoded';

function build(capture: Capture): ApiModel {
  return ModelBuilder.create({ now: new Date(0) }).build(capture);
}

function find(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((endpoint) => endpoint.method === method && endpoint.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

function prop(schema: JsonSchema | undefined, name: string): JsonSchema {
  const found = Schema.properties(schema)[name];
  assert.ok(found, `${name} in ${Object.keys(Schema.properties(schema)).join(', ')}`);
  return found;
}

function paths(model: ApiModel): string[] {
  return model.endpoints.map((endpoint) => `${endpoint.method} ${endpoint.path}`);
}

function openapi(model: ApiModel): string {
  return ExporterRegistry.default().export(model, 'openapi').content;
}

function filterForm(authors: readonly string[], tags: readonly string[], selected?: string): string {
  const options = (values: readonly string[], chosen?: string): string => ['----------', ...values].map((value) => `<option${value === chosen ? ' selected' : ''}>${value}</option>`).join('');
  return CaptureFactory.page(
    'Search',
    `<form name="filterform" method="post" action="/filter.aspx"><select name="author" onchange="this.form.submit()">${options(authors, selected)}</select><select name="tag">${options(tags)}</select><input type="hidden" name="__VIEWSTATE" value="vs"><input type="submit" name="submit_button" value="Search"></form>`,
  );
}

function postback(f: CaptureFactory, page: string, body: string): void {
  f.exchange({ method: 'POST', url: '/filter.aspx', resourceType: 'document', pageUrl: f.url(page), requestHeaders: { 'content-type': FORM }, requestBody: body, status: 200, responseHeaders: { 'content-type': 'text/html' }, responseBody: '<p>results</p>' });
}

function quotesCapture(): Capture {
  const f = new CaptureFactory();
  f.document('/search.aspx', filterForm(['Albert', 'Jane'], []));
  f.snapshot('/search.aspx', 'Search', filterForm(['Albert', 'Jane'], []));
  postback(f, '/search.aspx', 'author=Albert&tag=----------&__VIEWSTATE=vs');
  f.snapshot('/filter.aspx', 'Search', filterForm(['Albert', 'Jane'], ['a1', 'a2'], 'Albert'));
  postback(f, '/filter.aspx', 'author=Albert&tag=a1&submit_button=Search&__VIEWSTATE=vs');
  return f.capture();
}

describe('select options that change between page states are evidence, not the closed set (QTS-2)', () => {
  const model = build(quotesCapture());
  const filter = find(model, 'POST', '/filter.aspx');
  const schema = filter.requestBody?.schema;

  test('a select whose options differ between snapshots of one form accepts any value and keeps the seen options as examples', () => {
    const tag = prop(schema, 'tag');
    assert.equal(tag.enum, undefined);
    assert.equal(tag.const, undefined);
    assert.equal(tag['x-appii-dynamic-options'], true);
    assert.deepEqual(tag.examples, ['----------', 'a1', 'a2']);
    assert.equal(tag['x-html-type'], 'select-one');
    assert.ok(SchemaCheck.valid(schema, { author: 'Jane', tag: 'j1', __VIEWSTATE: 'vs', submit_button: 'Search' }));
  });

  test('a select with the same options in every page state keeps its enum', () => {
    const author = prop(schema, 'author');
    assert.deepEqual(author.enum, ['----------', 'Albert', 'Jane']);
    assert.equal(author['x-appii-dynamic-options'], undefined);
  });

  test('a value submitted from a page whose select did not offer it opens the choice', () => {
    const f = new CaptureFactory();
    f.document('/filter.aspx', filterForm(['Albert', 'Jane'], ['a1', 'a2'], 'Albert'));
    postback(f, '/filter.aspx', 'author=Jane&tag=j1&submit_button=Search&__VIEWSTATE=vs');
    const tag = prop(find(build(f.capture()), 'POST', '/filter.aspx').requestBody?.schema, 'tag');
    assert.equal(tag.enum, undefined);
    assert.deepEqual(tag.examples, ['----------', 'a1', 'a2']);
  });

  test('one page state with no contrary evidence keeps a closed enum', () => {
    const f = new CaptureFactory();
    f.document('/search.aspx', filterForm(['Albert', 'Jane'], ['x']));
    postback(f, '/search.aspx', 'author=Albert&tag=x&submit_button=Search&__VIEWSTATE=vs');
    const tag = prop(find(build(f.capture()), 'POST', '/filter.aspx').requestBody?.schema, 'tag');
    assert.deepEqual(tag.enum, ['----------', 'x']);
  });

  test('OpenAPI declares no enum for the open choice', () => {
    const document = JSON.parse(openapi(model)) as { components: { schemas: Record<string, JsonSchema> } };
    const request = Object.values(document.components.schemas).find((candidate) => Schema.properties(candidate).tag !== undefined);
    assert.ok(request);
    const tag = prop(request, 'tag');
    assert.equal(tag.enum, undefined);
    assert.deepEqual(tag.examples, ['----------', 'a1', 'a2']);
  });

  describe('the generated TypeScript client', () => {
    let harness: TsClientHarness;
    before(async () => {
      harness = await TsClientHarness.open('appii-qts2-');
    });
    after(async () => {
      await harness?.close();
    });

    test('accepts a tag of another author at compile time and at run time', async () => {
      const { mod, file } = await harness.load(model, 'client.ts');
      const name = `validate${TsEndpointWriter.pascal(filter.name)}`;
      assert.deepEqual(TsClientHarness.validator(mod, name)({ author: 'Jane', tag: 'j1', submit_button: 'Search' }), []);
      const type = `${TsEndpointWriter.pascal(filter.name)}Body`;
      await writeFile(join(harness.dir, 'use.ts'), `import type { ${type} } from './client.js';\nexport const body: ${type} = { author: 'Jane', tag: 'j1' };\n`);
      const result = await harness.compile([file, 'use.ts'], true);
      assert.equal(result.code, 0, result.output);
    });
  });
});

describe('script submissions without a submitter (QTS-3)', () => {
  test('form.submit() sends no submitter, so the submitter is optional and every observed body matches the schema', () => {
    const body = find(build(quotesCapture()), 'POST', '/filter.aspx').requestBody;
    assert.ok(!Schema.requiredSet(body?.schema).has('submit_button'), JSON.stringify(body?.schema?.required));
    assert.equal(prop(body?.schema, 'submit_button').const, 'Search');
    assert.equal(body?.examples.length, 2);
    for (const example of body?.examples ?? []) assert.deepEqual(SchemaCheck.errors(body?.schema, example), [], JSON.stringify(example));
  });

  test('observed requests without the submitter make it optional when the form is overlaid on them', () => {
    const form: JsonSchema = { type: 'object', properties: { q: { type: 'string' }, go: { type: 'string', const: 'Go', 'x-html-type': 'submit' } }, required: ['q', 'go'] };
    const lacking: JsonSchema = { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] };
    const carrying: JsonSchema = { type: 'object', properties: { q: { type: 'string' }, go: { type: 'string' } }, required: ['q', 'go'] };
    assert.deepEqual(new FormSchemaCombiner().overlay(form, lacking).required, ['q']);
    assert.deepEqual(new FormSchemaCombiner().overlay(form, carrying).required, ['q', 'go']);
  });

  test('a submitter stays required when every observed submission carries it', () => {
    const f = new CaptureFactory();
    f.document('/search.aspx', filterForm(['Albert'], ['x']));
    postback(f, '/search.aspx', 'author=Albert&tag=x&submit_button=Search&__VIEWSTATE=vs');
    assert.deepEqual(find(build(f.capture()), 'POST', '/filter.aspx').requestBody?.schema?.required, ['submit_button']);
  });

  test('a form the user cannot submit still marks its password field secret in the requests that carry its fields', () => {
    const f = new CaptureFactory();
    f.document('/find', CaptureFactory.page('Find', '<form action="/search"><input name="q"><input type="password" name="pin"></form>'));
    f.document('/search?q=hello&pin=PIN_SECRET_42', CaptureFactory.page('Results', 'ok'));
    const model = build(f.capture());
    const search = find(model, 'GET', '/search');
    assert.equal(search.kind, 'form');
    assert.ok(!JSON.stringify(model).includes('PIN_SECRET_42'));
    assert.deepEqual(model.forms[0]?.endpoints, [search.id]);
  });

  test('a form the user cannot submit is linked to the request its script sent', () => {
    const f = new CaptureFactory();
    const html = CaptureFactory.page('Auto', '<form method="post" action="/sso"><input type="hidden" name="SAMLResponse" value="r"><input type="hidden" name="RelayState" value="s"></form>');
    f.document('/auto', html);
    f.exchange({ method: 'POST', url: '/sso', resourceType: 'document', pageUrl: f.url('/auto'), requestHeaders: { 'content-type': FORM }, requestBody: 'SAMLResponse=r&RelayState=s', status: 302, responseHeaders: { location: '/home' } });
    const sso = find(build(f.capture()), 'POST', '/sso');
    assert.equal(sso.kind, 'form');
    assert.equal(sso.form?.pageUrl, f.url('/auto'));
  });
});

function booksPage(f: CaptureFactory, path: string, from?: string): void {
  const items = Array.from({ length: 20 }, (_, i) => `<li><article><h3><a href="/catalogue/book_${i}/index.html">Book ${i}</a></h3><form><button type="submit" class="btn">Add to basket</button></form></article></li>`).join('');
  const html = CaptureFactory.page('Books', `<div id="default"><form method="get" class="form-horizontal"><div style="display:none"></div><strong>20</strong> results</form><ol>${items}</ol></div>`);
  f.document(path, html, from ? { pageUrl: f.url(from) } : {});
  f.snapshot(path, 'Books', html);
}

describe('forms that add nothing to a navigation or that the browser cannot submit (BOOKS-3, WIKI-3)', () => {
  const f = new CaptureFactory('https://books.example');
  booksPage(f, '/index.html');
  booksPage(f, '/catalogue/page-2.html', '/index.html');
  booksPage(f, '/index.html?', '/index.html');
  const model = build(f.capture());

  test('field-less forms and forms with an unnamed button keep page loads as documents named as pages', () => {
    assert.deepEqual(
      model.endpoints.map((endpoint) => [endpoint.path, endpoint.kind, endpoint.form === undefined, endpoint.queryParams.length]),
      [
        ['/catalogue/page-2.html', 'document', true, 0],
        ['/index.html', 'document', true, 0],
      ],
    );
    for (const endpoint of model.endpoints) assert.match(endpoint.name, /Page$/);
    assert.ok(!openapi(model).includes('Submitted by the form'));
    assert.deepEqual(new ModelValidator().validate(model), []);
  });

  test('the form inventory still names the page each button form reloads, and the empty form submits nowhere', () => {
    const id = (path: string): string | undefined => model.endpoints.find((endpoint) => endpoint.path === path)?.id;
    const basket = model.forms.filter((form) => form.submitters.length === 1);
    assert.deepEqual(
      basket.map((form) => [form.endpoints, form.instances]),
      [
        [[id('/index.html')], 40],
        [[id('/catalogue/page-2.html')], 20],
      ],
    );
    const empty = model.forms.filter((form) => form.submitters.length === 0);
    assert.deepEqual(empty.map((form) => [form.endpoints, form.instances]), [[[], 3]]);
  });

  test('radio-only forms without a button are not submittable: no query parameters and no endpoint for a URL set by replaceState', () => {
    const w = new CaptureFactory('https://wiki.example');
    const prefs = '<form><input type="radio" name="skin-pref-theme" value="day" checked><input type="radio" name="skin-pref-theme" value="night"></form><form><input type="radio" name="skin-pref-width" value="1" checked><input type="radio" name="skin-pref-width" value="0"></form>';
    w.document('/wiki/Ada', CaptureFactory.page('Ada', prefs));
    w.snapshot('/wiki/Ada', 'Ada', CaptureFactory.page('Ada', prefs));
    w.document('/wiki/Mech_engineer', CaptureFactory.page('Mech', prefs), { pageUrl: w.url('/wiki/Ada') });
    w.snapshot('/wiki/Mech_engineering', 'Mech', CaptureFactory.page('Mech', prefs));
    const wiki = build(w.capture());
    assert.ok(wiki.endpoints.length > 0);
    for (const page of wiki.endpoints) {
      assert.ok(!page.path.includes('Mech_engineering'), page.path);
      assert.equal(page.kind, 'document');
      assert.equal(page.count > 0, true);
      assert.deepEqual(page.queryParams, []);
      assert.equal(page.form, undefined);
    }
    assert.ok(wiki.forms.every((form) => form.endpoints?.length === 0));
  });

  test('a submittable GET form that was never submitted leaves the page load alone; a submitted one defines its endpoint', () => {
    const w = new CaptureFactory('https://wiki.example');
    const html = CaptureFactory.page(
      'Main',
      `<form id="frb" method="get" action="/wiki/Main_Page"><input type="radio" name="amount" value="5" checked><input type="radio" name="amount" value="10"><input type="text" name="other"><button name="method" value="card">Card</button><button name="method" value="paypal">PayPal</button></form>
       <form id="search" action="/w/index.php"><input type="search" name="search"><input type="hidden" name="title" value="Special:Search"><button>Go</button></form>`,
    );
    w.document('/wiki/Main_Page', html);
    w.snapshot('/wiki/Main_Page', 'Main', html);
    w.exchange({ url: '/w/index.php?search=Ada&title=Special%3ASearch', resourceType: 'document', pageUrl: w.url('/wiki/Main_Page'), status: 302, responseHeaders: { location: '/wiki/Ada' } });
    const wiki = build(w.capture());
    const main = find(wiki, 'GET', '/wiki/Main_Page');
    assert.equal(main.kind, 'document');
    assert.equal(main.form, undefined);
    assert.deepEqual(main.queryParams, []);
    const search = find(wiki, 'GET', '/w/index.php');
    assert.equal(search.kind, 'form');
    assert.equal(search.count, 1);
    assert.deepEqual(search.queryParams.map((param) => param.name).sort(), ['search', 'title']);
    assert.deepEqual(wiki.forms.find((form) => form.id === 'frb')?.endpoints, [main.id]);
  });

  test('implicit submission follows HTML: one text field without a button submits, two do not, a disabled default button blocks it', () => {
    const fields = (html: string): Pick<FormDescriptor, 'fields' | 'submitters'> => {
      const e = new CaptureFactory();
      e.snapshot('/f', 'F', CaptureFactory.page('F', html));
      const form = build(e.capture()).forms[0];
      assert.ok(form);
      return form;
    };
    assert.equal(SubmissionRules.implicitlySubmittable(fields('<form action="/s"><input name="q"><input type="checkbox" name="c"></form>')), true);
    assert.equal(SubmissionRules.implicitlySubmittable(fields('<form action="/s"><input name="a"><input type="email" name="b"></form>')), false);
    assert.equal(SubmissionRules.implicitlySubmittable(fields('<form action="/s"><input type="radio" name="r" value="1"></form>')), false);
    assert.equal(SubmissionRules.implicitlySubmittable(fields('<form action="/s"><input name="q"><button disabled>Go</button><button>Other</button></form>')), false);
    const e = new CaptureFactory();
    e.document('/', CaptureFactory.page('Home', '<form action="/one"><input name="q"></form><form action="/two"><input name="a"><input name="b"></form>'));
    assert.deepEqual(paths(build(e.capture())), ['GET /', 'GET /one']);
  });
});

describe('form submissions among page loads (WIKI-4)', () => {
  test('FormLinker tells navigations a form produced from plain page loads and link-equivalent forms', () => {
    const w = new CaptureFactory('https://wiki.example');
    const html = CaptureFactory.page('Main', '<form action="/w/index.php"><input type="search" name="search"><button>Go</button></form><form><button>Reload</button></form>');
    const main = w.document('/wiki/Main_Page', html);
    w.snapshot('/wiki/Main_Page', 'Main', html);
    const search = w.exchange({ url: '/w/index.php?search=Ada', resourceType: 'document', pageUrl: w.url('/wiki/Main_Page'), status: 302, responseHeaders: { location: '/wiki/Ada' } });
    const plain = w.document('/w/index.php?title=Ada', '<p>x</p>', { pageUrl: w.url('/wiki/Main_Page') });
    const reload = w.document('/wiki/Main_Page?', html, { pageUrl: w.url('/wiki/Main_Page') });
    const submitted = FormLinker.create().submitted(w.capture());
    assert.equal(submitted(search), true);
    assert.equal(submitted(main), false);
    assert.equal(submitted(plain), false);
    assert.equal(submitted(reload), false);
  });
});

describe('the form inventory groups identical forms (BOOKS-4)', () => {
  const f = new CaptureFactory();
  const add = (n: number): string => Array.from({ length: n }, (_, i) => `<li><form method="post" action="/basket/add"><input type="hidden" name="product" value="${i}"><button>Add to basket</button></form></li>`).join('');
  f.document('/list/1', CaptureFactory.page('One', `<ol>${add(20)}</ol><form action="/search"><input name="q"></form>`));
  f.document('/list/2', CaptureFactory.page('Two', `<ol>${add(20)}</ol>`));
  const model = build(f.capture());

  test('20 identical forms on 2 pages are one entry with 40 instances and both pages', () => {
    const basket = model.forms.filter((form) => form.action.endsWith('/basket/add'));
    assert.equal(basket.length, 1);
    assert.equal(basket[0]?.instances, 40);
    assert.deepEqual(basket[0]?.pages, [f.url('/list/1'), f.url('/list/2')]);
    assert.equal(model.forms.length, 2);
    assert.equal(model.forms.find((form) => form.action.endsWith('/search'))?.instances, undefined);
    assert.deepEqual(new ModelValidator().validate(model), []);
  });

  test('the summary and the HTML report count distinct forms and their instances', () => {
    assert.equal(SummaryPresenter.forms(model.forms), '2 distinct, 41 on pages (2 linked to endpoints)');
    const html = ExporterRegistry.default().export(model, 'html').content;
    const section = html.slice(html.indexOf('<section id="forms"'), html.indexOf('</section>', html.indexOf('<section id="forms"')));
    assert.equal((section.match(/<tr>/g) ?? []).length, 3);
  });
});

describe('forms on client-side routes (SPA-4)', () => {
  const login = '<form><input name="email" type="email" required><input name="password" type="password" required minlength="8"><button type="submit">Sign in</button></form>';
  const register = '<form><input name="username" required><input name="email" type="email"><input name="password" type="password"><button type="submit" disabled>Sign up</button></form>';

  function spa(submitted: boolean): Capture {
    const f = new CaptureFactory('https://app.example');
    f.document('/', CaptureFactory.page('App', '<main id="app"></main>'));
    f.snapshot('/login', 'App', CaptureFactory.page('App', `<main id="app">${login}</main>`));
    f.snapshot('/register', 'App', CaptureFactory.page('App', `<main id="app">${register}</main>`));
    if (submitted) {
      f.json('POST', 'https://api.example/api/users/login', 200, { user: { token: 't' } }, {
        pageUrl: f.url('/login'),
        requestHeaders: { 'content-type': 'application/json' },
        requestBody: { json: { user: { email: 'u@example.com', password: 'secret-password' } } },
      });
      f.json('GET', 'https://api.example/api/user', 200, { user: { email: 'u@example.com' } }, { pageUrl: f.url('/login') });
    }
    return f.capture();
  }

  test('an action-less form on a route the server never served gets no native endpoint, so no password goes into a query string', () => {
    const model = ModelBuilder.create({ now: new Date(0), allOrigins: true }).build(spa(false));
    assert.deepEqual(paths(model), ['GET /']);
    assert.deepEqual(
      model.forms.map((form) => [new URL(form.pageUrl).pathname, form.explicitAction, form.endpoints]),
      [
        ['/login', false, []],
        ['/register', false, []],
      ],
    );
    assert.ok(!JSON.stringify(model.endpoints).includes('password'));
  });

  test('the request the submit produced is the endpoint of the form, and the form rules apply to its JSON body', () => {
    const model = ModelBuilder.create({ now: new Date(0), allOrigins: true }).build(spa(true));
    assert.ok(!paths(model).includes('GET /login'), paths(model).join(', '));
    const endpoint = find(model, 'POST', '/api/users/login');
    assert.equal(endpoint.kind, 'json');
    assert.equal(endpoint.form?.pageUrl, 'https://app.example/login');
    const user = prop(endpoint.requestBody?.schema, 'user');
    assert.equal(prop(user, 'password')['x-html-minlength'], 8);
    assert.equal(prop(user, 'email')['x-html-type'], 'email');
    assert.deepEqual(model.forms.map((form) => form.endpoints), [[endpoint.id], []]);
    assert.equal(find(model, 'GET', '/api/user').form, undefined);
  });

  test('a route the server also sent as a page keeps that page a document, and the form describes its script request', () => {
    const f = new CaptureFactory('https://app.example');
    f.document('/login', CaptureFactory.page('App', '<main id="app"></main>'));
    f.snapshot('/login', 'App', CaptureFactory.page('App', `<main id="app">${login}</main>`));
    f.json('POST', '/api/users/login', 200, { user: { token: 't' } }, {
      pageUrl: f.url('/login'),
      requestHeaders: { 'content-type': 'application/json' },
      requestBody: { json: { user: { email: 'u@example.com', password: 'secret-password' } } },
    });
    const model = build(f.capture());
    const page = find(model, 'GET', '/login');
    assert.equal(page.kind, 'document');
    assert.deepEqual(page.queryParams, []);
    const api = find(model, 'POST', '/api/users/login');
    assert.equal(api.form?.pageUrl, f.url('/login'));
    assert.deepEqual([...(model.forms[0]?.endpoints ?? [])].sort(), [page.id, api.id].sort());
  });

  test('the model validator checks the recorded action, instance and page fields', () => {
    const model = ModelBuilder.create({ now: new Date(0), allOrigins: true }).build(spa(false));
    assert.deepEqual(new ModelValidator().validate(model), []);
    const broken = structuredClone(model);
    const form = broken.forms[0] as unknown as Record<string, unknown>;
    form.explicitAction = 'no';
    form.instances = 'two';
    form.pages = [1];
    (broken.forms[0]?.submitters[0] as unknown as Record<string, unknown>).explicitFormAction = 'yes';
    assert.deepEqual(new ModelValidator().validate(broken), [
      'forms[0].explicitAction: expected true or false',
      'forms[0].submitters[0].explicitFormAction: expected true or false',
      'forms[0].instances: expected a number',
      'forms[0].pages: expected an array of strings',
    ]);
  });

  test('an action-less form on a page the server sent still posts to that page', () => {
    const f = new CaptureFactory();
    f.document('/contact', CaptureFactory.page('Contact', '<form method="post"><input name="message"><button>Send</button></form>'));
    const model = build(f.capture());
    assert.equal(find(model, 'POST', '/contact').kind, 'form');
    assert.equal(model.forms[0]?.explicitAction, false);
  });
});
