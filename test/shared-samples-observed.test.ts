import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Endpoint, EndpointForm, EndpointSample, FormField, ParamInfo } from '../src/model/index.js';
import { Samples } from '../src/shared/index.js';

const ORIGIN = 'https://api.realworld.example';

function param(name: string, required: boolean, examples: string[]): ParamInfo {
  return { name, in: 'query', required, schema: { type: 'string' }, examples };
}

function sample(query: string, status = 200): EndpointSample {
  return { exchangeId: `ex-${query}`, url: `${ORIGIN}/api/articles?${query}`, status, startedAt: '2026-01-01T00:00:00.000Z' };
}

function articles(samples: EndpointSample[]): Endpoint {
  return {
    id: 'articles',
    name: 'listArticles',
    key: `GET ${ORIGIN}/api/articles`,
    method: 'GET',
    origin: ORIGIN,
    path: '/api/articles',
    kind: 'json',
    firstParty: true,
    pathParams: [],
    queryParams: [param('limit', true, ['10']), param('offset', true, ['0']), param('tag', false, ['ai', 'backend']), param('author', false, ['mike']), param('favorited', false, ['mike'])],
    headerParams: [],
    responses: [],
    auth: { cookies: [], headers: [], bearer: false, csrf: [] },
    resourceTypes: ['fetch'],
    samples,
    count: samples.length,
  };
}

describe('the example request is a request that the browser sent (SPA-3)', () => {
  test('mutually exclusive optional filters are never combined', () => {
    const endpoint = articles([sample('limit=10&offset=0'), sample('tag=ai&limit=10&offset=0'), sample('author=mike&limit=10&offset=0')]);
    const example = Samples.requestSample(endpoint);
    assert.equal(example.url.toString(), `${ORIGIN}/api/articles?limit=10&offset=0`);
    assert.deepEqual(example.query.map((entry) => entry.name), ['limit', 'offset']);
  });

  test('the first successful request wins, in the order and with the values that it sent', () => {
    const endpoint = articles([sample('tag=x&limit=1&offset=0', 500), sample('tag=backend&limit=20&offset=40'), sample('limit=10&offset=0')]);
    assert.equal(Samples.requestSample(endpoint).url.toString(), `${ORIGIN}/api/articles?tag=backend&limit=20&offset=40`);
    assert.equal(Samples.requestSample(endpoint, { requiredOnly: true }).url.toString(), `${ORIGIN}/api/articles?limit=20&offset=40`);
  });

  test('a redacted value becomes a placeholder and a missing required parameter is added', () => {
    const endpoint = articles([sample('tag=%3Credacted%3E&offset=5')]);
    const example = Samples.requestSample(endpoint);
    assert.equal(example.url.toString(), `${ORIGIN}/api/articles?tag={{tag}}&offset=5&limit=10`);
  });

  test('without a captured request the example sends the required parameters only', () => {
    assert.equal(Samples.requestSample(articles([])).url.toString(), `${ORIGIN}/api/articles?limit=10&offset=0`);
  });
});

describe('a form example is the observed submission of the chosen submitter (QTS-R1)', () => {
  const field = (name: string, value: string, type: string): FormField => ({
    name,
    order: 0,
    kind: type === 'submit' ? 'input' : 'select',
    type,
    value,
    hasValueAttribute: true,
    checked: false,
    disabled: false,
    readOnly: false,
    required: false,
    multiple: false,
  });
  const form: EndpointForm = {
    pageUrl: `${ORIGIN}/search.aspx`,
    selector: 'form[name="filterform"]',
    action: `${ORIGIN}/filter.aspx`,
    method: 'POST',
    enctype: 'application/x-www-form-urlencoded',
    charset: 'UTF-8',
    fields: [field('author', '----------', 'select-one'), field('tag', '----------', 'select-one'), field('__VIEWSTATE', 'vs', 'hidden')],
    submitters: [field('submit_button', 'Search', 'submit')],
    tokenFields: ['__VIEWSTATE'],
  };
  const filter = (examples: Record<string, string>[]): Endpoint => ({
    ...articles([]),
    id: 'filter',
    key: `POST ${ORIGIN}/filter.aspx`,
    method: 'POST',
    path: '/filter.aspx',
    kind: 'form',
    queryParams: [],
    form,
    requestBody: { mimeType: 'application/x-www-form-urlencoded', kind: 'form', examples },
  });
  const postback = { author: 'Jane Austen', tag: '----------', __VIEWSTATE: 'vs' };
  const search = { author: 'Jane Austen', tag: 'aliteracy', submit_button: 'Search', __VIEWSTATE: 'vs' };

  test('the example that carries the submitter is used, not the first example plus the submitter', () => {
    const sample = Samples.requestSample(filter([postback, search]));
    assert.deepEqual(Samples.plainValue(sample.body?.value), search);
  });

  test('without an example of the submitter the first example gets the submitter', () => {
    const sample = Samples.requestSample(filter([postback]));
    assert.deepEqual(Samples.plainValue(sample.body?.value), { ...postback, submit_button: 'Search' });
  });
});

describe('a partly redacted value keeps its text and names each secret after its key (NEW-2)', () => {
  test('text around the redaction stays literal', () => {
    const text = Samples.redactedText('token=<redacted>\nnote=hello', 'body');
    assert.deepEqual(text.parts, [
      { kind: 'literal', text: 'token=' },
      { kind: 'placeholder', name: 'token' },
      { kind: 'literal', text: '\nnote=hello' },
    ]);
    assert.equal(Samples.redactedText('<redacted>', 'password').toString(), '{{password}}');
    assert.equal(Samples.redactedText('Bearer <redacted>', 'authorization').toString(), 'Bearer {{authorization}}');
    assert.equal(Samples.redactedText('<redacted>:<redacted>', 'pair').toString(), '{{pair}}:{{pair_2}}');
    assert.equal(Samples.redactedText('https://x.test/cb?code=<redacted>&state=1', 'next').toString(), 'https://x.test/cb?code={{code}}&state=1');
  });

  test('query values and JSON strings keep the text around a redaction', () => {
    const endpoint = articles([sample('next=https%3A%2F%2Fx.test%2F%3Ftoken%3D%3Credacted%3E&offset=0')]);
    assert.equal(Samples.requestSample(endpoint).url.toString(), `${ORIGIN}/api/articles?next=https%3A%2F%2Fx.test%2F%3Ftoken%3D{{token}}&offset=0&limit=10`);
    assert.deepEqual(Samples.plainValue(Samples.capturedValue({ note: 'see <redacted> here', key: '<redacted>' })), { note: 'see {{note}} here', key: '{{key}}' });
  });
});
