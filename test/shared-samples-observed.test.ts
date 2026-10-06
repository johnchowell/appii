import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Endpoint, EndpointSample, ParamInfo } from '../src/model/index.js';
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
