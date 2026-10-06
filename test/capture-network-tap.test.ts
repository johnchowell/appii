import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { CDPSession } from 'playwright';
import { PageNetworkTap, SessionConnection } from '../src/capture/index.js';

class FakeSession extends EventEmitter {
  readonly sent: string[] = [];

  async send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.sent.push(method);
    if (method === 'Network.getResponseBody') return { body: `body of ${String(params.requestId)}`, base64Encoded: false };
    return {};
  }

  request(requestId: string, url: string): void {
    this.emit('Network.requestWillBeSent', {
      requestId,
      request: { url, method: 'GET', headers: {} },
      wallTime: 1000,
      timestamp: 10,
      type: 'XHR',
    });
  }

  respond(requestId: string, url: string): void {
    this.emit('Network.responseReceived', { requestId, timestamp: 11, response: { url, status: 200, headers: {} } });
  }

  finish(requestId: string): void {
    this.emit('Network.loadingFinished', { requestId, timestamp: 12, encodedDataLength: 4 });
  }

  served(requestId: string): void {
    this.emit('Network.requestServedFromCache', { requestId });
  }
}

function tap(): { session: FakeSession; tap: PageNetworkTap } {
  const session = new FakeSession();
  return { session, tap: PageNetworkTap.create(new SessionConnection(session as unknown as CDPSession)) };
}

describe('PageNetworkTap response bodies across debugger sessions', () => {
  test('waits for a response that reaches the session after another session reported the request finished', async () => {
    const { session, tap: network } = tap();
    session.request('r1', 'http://x/a');
    const record = network.claim({ method: 'GET', url: 'http://x/a', startTime: 0 });
    assert.ok(record);
    const body = network.responseBody(record);
    setTimeout(() => {
      session.respond('r1', 'http://x/a');
      session.finish('r1');
    }, 50);
    assert.equal((await body)?.bytes.toString(), 'body of r1');
  });

  test('gives up after the session lag limit when the response never reaches the session', async () => {
    const { session, tap: network } = tap();
    session.request('r2', 'http://x/b');
    const record = network.claim({ method: 'GET', url: 'http://x/b', startTime: 0 });
    assert.ok(record);
    const started = Date.now();
    assert.equal(await network.responseBody(record), undefined);
    const waited = Date.now() - started;
    assert.ok(waited >= PageNetworkTap.SESSION_LAG_MS - 50 && waited < PageNetworkTap.SESSION_LAG_MS + 1000, `waited ${waited} ms`);
    assert.ok(!session.sent.includes('Network.getResponseBody'));
  });

  test('reads the body of a request whose response the session saw, however long the body takes', async () => {
    const { session, tap: network } = tap();
    session.request('r3', 'http://x/c');
    session.respond('r3', 'http://x/c');
    const record = network.claim({ method: 'GET', url: 'http://x/c', startTime: 0 });
    assert.ok(record);
    const body = network.responseBody(record);
    setTimeout(() => session.finish('r3'), PageNetworkTap.SESSION_LAG_MS + 300);
    assert.equal((await body)?.bytes.toString(), 'body of r3');
  });
});

describe('PageNetworkTap claims across debugger sessions', () => {
  test('claims a memory-cache hit that reaches the session after another session reported it finished (SPA-6)', async () => {
    const { session, tap: network } = tap();
    const query = { method: 'GET', url: 'http://x/logo.svg', startTime: 0 };
    assert.equal(network.claim(query), undefined);
    const claimed = network.claimWhenSeen(query, 1000);
    setTimeout(() => {
      session.request('r1', 'http://x/logo.svg');
      session.served('r1');
      session.respond('r1', 'http://x/logo.svg');
      session.finish('r1');
    }, 30);
    const record = await claimed;
    assert.ok(record);
    assert.equal(record.requestId, 'r1');
    assert.equal(record.cache, 'memory');
    assert.equal(record.claimed, true);
    assert.equal(network.claim(query), undefined);
    assert.equal((await network.responseBody(record))?.bytes.toString(), 'body of r1');
  });

  test('gives each of two waiting claims for the same URL its own request, in order', async () => {
    const { session, tap: network } = tap();
    const query = { method: 'GET', url: 'http://x/a.js', startTime: 0 };
    const first = network.claimWhenSeen(query, 1000);
    const second = network.claimWhenSeen(query, 1000);
    setTimeout(() => {
      session.request('r1', 'http://x/a.js');
      session.finish('r1');
      session.request('r2', 'http://x/a.js');
      session.finish('r2');
    }, 20);
    const records = await Promise.all([first, second]);
    assert.deepEqual(records.map((record) => record?.requestId).sort(), ['r1', 'r2']);
  });

  test('ignores requests that do not match and gives up after the timeout', async () => {
    const { session, tap: network } = tap();
    const started = Date.now();
    const claimed = network.claimWhenSeen({ method: 'GET', url: 'http://x/wanted', startTime: 0 }, 150);
    session.request('r1', 'http://x/other');
    assert.equal(await claimed, undefined);
    const waited = Date.now() - started;
    assert.ok(waited >= 140 && waited < 1000, `waited ${waited} ms`);
    assert.equal(network.claim({ method: 'GET', url: 'http://x/other', startTime: 0 })?.requestId, 'r1');
  });

  test('releases waiting claims when the tap closes', async () => {
    const { tap: network } = tap();
    const started = Date.now();
    const claimed = network.claimWhenSeen({ method: 'GET', url: 'http://x/never', startTime: 0 }, 5000);
    await network.close();
    assert.equal(await claimed, undefined);
    assert.ok(Date.now() - started < 1000);
  });
});
