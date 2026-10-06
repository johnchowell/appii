import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EndpointFactory } from '../src/build/index.js';
import type { AnonymousAccess, Endpoint } from '../src/model/index.js';
import { Credentials } from '../src/shared/index.js';

function endpoint(anonymous: AnonymousAccess, sets: string[][], statuses: number[] = [200]): Endpoint {
  const value = EndpointFactory.blank({ method: 'GET', origin: 'https://site.example', path: '/x', kind: 'json' });
  value.count = statuses.length;
  value.responses = statuses.map((status) => ({ status, count: 1, headers: [] }));
  value.auth = { cookies: ['sid'], headers: [], bearer: false, csrf: [], anonymous, sets };
  return value;
}

describe('one anonymous-access rule for list, --show, OpenAPI and the clients (QL-4, QL-5)', () => {
  test('allowed is optional, refused is required, untested is not required but marked as not tested', () => {
    const sets = [['cookie:sid']];
    const allowed = endpoint('allowed', sets);
    const refused = endpoint('refused', sets, [200, 401]);
    const untested = endpoint('untested', sets);
    assert.deepEqual([Credentials.optional(allowed), Credentials.optional(refused), Credentials.optional(untested)], [true, false, true]);
    assert.deepEqual([Credentials.required(allowed), Credentials.required(refused), Credentials.required(untested)], [false, true, false]);
    assert.deepEqual([Credentials.untested(allowed), Credentials.untested(refused), Credentials.untested(untested)], [false, false, true]);
    assert.deepEqual([Credentials.kinds(allowed), Credentials.kinds(refused), Credentials.kinds(untested)], [['cookie?'], ['cookie'], ['cookie~']]);
    assert.deepEqual([Credentials.describe(allowed), Credentials.describe(refused), Credentials.describe(untested)], ['cookie sid (optional)', 'cookie sid', 'cookie sid (anonymous access not tested)']);
    assert.deepEqual([Credentials.anonymousLabel(allowed), Credentials.anonymousLabel(refused), Credentials.anonymousLabel(untested)], ['allowed', 'refused', 'not tested']);
  });

  test('a refusal without a captured credential lists every refusing status, redirects to the login page included', () => {
    assert.deepEqual(Credentials.refusals(endpoint('refused', [], [401, 403])), [401, 403]);
    assert.deepEqual(Credentials.refusals(endpoint('refused', [], [302])), [302]);
    assert.deepEqual(Credentials.kinds(endpoint('refused', [], [302])), ['302?']);
    assert.equal(Credentials.refusalNote(endpoint('refused', [], [302])), 'required, not captured (answered 302 without credentials)');
    assert.deepEqual(Credentials.refusals(endpoint('untested', [], [401])), []);
    assert.deepEqual(Credentials.refusals(endpoint('allowed', [], [401, 200])), []);
    assert.deepEqual(Credentials.refusals(endpoint('refused', [['cookie:sid']], [401, 200])), []);
  });
});
