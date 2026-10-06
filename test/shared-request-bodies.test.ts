import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EndpointFactory } from '../src/build/index.js';
import type { BodyShape, Endpoint } from '../src/model/index.js';
import { RequestBodies } from '../src/shared/index.js';

function shape(kind: BodyShape['kind'], mimeType: string, example: unknown): BodyShape {
  return { kind, mimeType, examples: [example] };
}

function post(): Endpoint {
  const endpoint = EndpointFactory.blank({ method: 'POST', origin: 'https://httpbin.org', path: '/post', kind: 'form' });
  endpoint.requestBody = shape('form', 'application/x-www-form-urlencoded', { custname: 'Ann' });
  endpoint.otherRequestBodies = [
    shape('json', 'application/json; charset=utf-8', { name: 'n' }),
    shape('json', 'application/json', { name: 'second' }),
    shape('multipart', 'multipart/form-data; boundary=x', { upload: 'notes.txt' }),
    shape('empty', '', ''),
  ];
  endpoint.form = { pageUrl: 'https://httpbin.org/forms/post', selector: 'form', fields: [], submitters: [], tokenFields: [] } as unknown as NonNullable<Endpoint['form']>;
  return endpoint;
}

describe('RequestBodies: every request media type of an endpoint, for every exporter and presenter (HTTPBIN-2)', () => {
  test('the shapes list the primary body first and each other media type once', () => {
    const endpoint = post();
    assert.deepEqual(RequestBodies.shapes(endpoint).map((each) => RequestBodies.mediaType(each)), ['application/x-www-form-urlencoded', 'application/json', 'multipart/form-data']);
    assert.deepEqual(RequestBodies.shapes({ ...endpoint, requestBody: undefined } as unknown as Endpoint).map((each) => each.kind), ['json', 'multipart']);
  });

  test('a variant is the endpoint with that body alone, without the form of the primary body', () => {
    const endpoint = post();
    const variants = RequestBodies.variants(endpoint);
    assert.deepEqual(variants.map((variant) => variant.mediaType), ['application/json', 'multipart/form-data']);
    for (const variant of variants) {
      assert.equal(variant.endpoint.requestBody, variant.shape);
      assert.equal(variant.endpoint.otherRequestBodies, undefined);
      assert.equal(variant.endpoint.form, undefined);
      assert.equal(variant.endpoint.name, endpoint.name);
    }
    assert.ok(endpoint.form && endpoint.otherRequestBodies?.length === 4, 'the endpoint itself is unchanged');
  });

  test('a missing or malformed media type falls back to the one of the body kind', () => {
    assert.equal(RequestBodies.mediaType(shape('json', '', {})), 'application/json');
    assert.equal(RequestBodies.mediaType(shape('form', 'not a type', {})), 'application/x-www-form-urlencoded');
    assert.equal(RequestBodies.mediaType(shape('text', 'Text/Plain; charset=utf-8', '')), 'text/plain');
  });
});
