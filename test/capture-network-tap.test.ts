import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { CDPSession } from 'playwright';
import { PageNetworkTap } from '../src/capture/index.js';

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
}

function tap(): { session: FakeSession; tap: PageNetworkTap } {
  const session = new FakeSession();
  return { session, tap: new PageNetworkTap(session as unknown as CDPSession) };
}

describe('PageNetworkTap response bodies across debugger sessions', () => {
  test('waits for a response that reaches the session after another session reported the request finished', async () => {
    const { session, tap: network } = tap();
    session.request('r1', 'http://x/a');
    const record = network.claim('GET', 'http://x/a', 0);
    assert.ok(record);
    const body = network.responseBody(record);
    setTimeout(() => {
      session.respond('r1', 'http://x/a');
      session.finish('r1');
    }, 50);
    assert.equal((await body)?.toString(), 'body of r1');
  });

  test('gives up after the session lag limit when the response never reaches the session', async () => {
    const { session, tap: network } = tap();
    session.request('r2', 'http://x/b');
    const record = network.claim('GET', 'http://x/b', 0);
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
    const record = network.claim('GET', 'http://x/c', 0);
    assert.ok(record);
    const body = network.responseBody(record);
    setTimeout(() => session.finish('r3'), PageNetworkTap.SESSION_LAG_MS + 300);
    assert.equal((await body)?.toString(), 'body of r3');
  });
});
