import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { AuthDetector, BodyParser, EndpointGrouper, FormCollector, HtmlPages, ModelBuilder, PageDocuments } from '../src/build/index.js';
import { FormExtractor, HtmlDocument, TokenDetector } from '../src/forms/index.js';
import type { FormDescriptor } from '../src/model/index.js';
import { Schema } from '../src/shared/index.js';
import { CaptureFactory } from './helpers/capture-factory.js';

class CountingExtractor extends FormExtractor {
  calls = 0;

  override extractDocument(doc: HtmlDocument): FormDescriptor[] {
    this.calls++;
    return super.extractDocument(doc);
  }
}

describe('PageDocuments', () => {
  test('a legacy table login page gives a POST endpoint with the fields the browser submits', () => {
    const f = new CaptureFactory('https://legacy.example.com');
    const html =
      '<!doctype html><title>Login</title><table><form method=post action="/cgi-bin/login.pl"><tr><td>User <input name=user required></td></tr><tr><td>Password <input type=password name=pass required></td></tr><tr><td><input type=submit name=go value="Log in"></td></tr></form></table>';
    f.document('/', html);
    const model = ModelBuilder.create({ now: new Date(0) }).build(f.capture({ startUrl: 'https://legacy.example.com/' }));
    const login = model.endpoints.find((endpoint) => endpoint.method === 'POST');
    assert.equal(login?.path, '/cgi-bin/login.pl');
    assert.deepEqual(login?.form?.fields.map((field) => field.name), ['user', 'pass']);
    assert.deepEqual(login?.form?.submitters.map((field) => field.name), ['go']);
    const schema = login?.requestBody?.schema;
    assert.deepEqual(Object.keys(Schema.properties(schema)), ['user', 'pass', 'go']);
    assert.deepEqual([...Schema.requiredSet(schema)], ['user', 'pass', 'go']);
    assert.equal(Schema.properties(schema).pass?.['x-html-type'], 'password');
  });

  test('each page is parsed and extracted once for the form collector and the CSRF source resolver', () => {
    const f = new CaptureFactory();
    const token = 'T0k3nValue-abcdef0123';
    f.snapshot('/a', 'A', `<form method="post" action="/a"><input type="hidden" name="_csrf" value="${token}"><input name="x"></form>`);
    f.document('/b', '<form method="post" action="/b"><input name="y"></form>');
    f.json('POST', '/api/save', 200, {}, { requestHeaders: { 'x-csrf-token': token } });
    const capture = f.capture();
    const tokens = new TokenDetector();
    const extractor = new CountingExtractor({ tokens });
    const body = BodyParser.create();
    const documents = new PageDocuments({ pages: new HtmlPages({ body }), extractor });
    assert.equal(documents.of(capture), documents.of(capture));
    const forms = new FormCollector({ documents }).collect(capture);
    assert.deepEqual(forms.map((form) => form.action), [f.url('/a'), f.url('/b')]);
    const endpoints = EndpointGrouper.create().group(capture.exchanges);
    new AuthDetector({ extractor, tokens, body, documents }).detect(endpoints, capture);
    assert.equal(extractor.calls, 2);
    const save = endpoints.find((endpoint) => endpoint.path === '/api/save');
    assert.deepEqual(save?.auth.csrf.map((csrf) => [csrf.source, csrf.sourceName]), [['hidden-field', '_csrf']]);
  });

  test('a capture that gains pages is parsed again', () => {
    const f = new CaptureFactory();
    f.snapshot('/a', 'A', '<form action="/a"><input name="x"></form>');
    const capture = f.capture();
    const documents = PageDocuments.create();
    assert.equal(documents.of(capture).length, 1);
    capture.pages.push({ url: f.url('/b'), title: 'B', capturedAt: capture.startedAt, html: '<form action="/b"></form>' });
    assert.equal(documents.of(capture).length, 2);
  });
});
