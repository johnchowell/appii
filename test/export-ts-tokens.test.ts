import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApiModel, Endpoint } from '../src/model/index.js';
import { TsClientHarness } from './fixtures/export-ts-harness.js';
import type { Module, SentRequest } from './fixtures/export-ts-harness.js';
import { CaptureFactory } from './helpers/capture-factory.js';

function find(model: ApiModel, method: string, path: string): Endpoint {
  const found = model.endpoints.find((endpoint) => endpoint.method === method && endpoint.path === path);
  assert.ok(found, `${method} ${path} in ${model.endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}`);
  return found;
}

function line(request: SentRequest): string {
  return `${request.method} ${new URL(request.url).pathname}`;
}

describe('CSRF token from the response of a POST endpoint (EXP2-5, FB-12)', () => {
  let harness: TsClientHarness;
  let model: ApiModel;
  let mod: Module;

  before(async () => {
    harness = await TsClientHarness.open();
    const f = new CaptureFactory('https://app.example.com');
    f.json('POST', '/api/session', 200, { csrfToken: 'Tok-AAAAAAAAAAAAAAAAAAAAAAAA1' }, { requestType: 'application/json', requestBody: { json: { device: 'web' } } });
    f.json('POST', '/api/items', 201, { id: 1 }, {
      requestType: 'application/json',
      requestBody: { json: { name: 'x' } },
      requestHeaders: { 'content-type': 'application/json', 'x-csrf-token': 'Tok-AAAAAAAAAAAAAAAAAAAAAAAA1' },
    });
    model = TsClientHarness.build(f);
    assert.deepEqual(find(model, 'POST', '/api/items').auth.csrf.map((token) => [token.source, token.sourceMethod]), [['response', 'POST']]);
    mod = (await harness.load(model)).mod;
  });

  after(async () => {
    await harness?.close();
  });

  function server(): ReturnType<typeof TsClientHarness.recorder> {
    return TsClientHarness.recorder((request) => {
      const path = new URL(request.url).pathname;
      if (path === '/api/session') return request.method === 'POST' ? TsClientHarness.json({ csrfToken: 'T1' }) : new Response('Method Not Allowed', { status: 405 });
      if (path === '/api/items') return TsClientHarness.json({ id: 1 }, request.headers.get('x-csrf-token') === 'T1' ? 201 : 403);
      return new Response('not found', { status: 404 });
    });
  }

  test('the client reads the token from the latest session response and never sends GET to the source', async () => {
    const recorder = server();
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    const session = find(model, 'POST', '/api/session');
    const items = find(model, 'POST', '/api/items');
    await TsClientHarness.call(client, session.name, { body: { device: 'web' } });
    const created = await TsClientHarness.call(client, items.name, { body: { name: 'x' } });
    assert.equal(created.status, 201);
    assert.deepEqual(recorder.sent.map(line), ['POST /api/session', 'POST /api/items']);
    assert.equal(recorder.sent[1]?.headers.get('x-csrf-token'), 'T1');
  });

  test('against a real HTTP server the session call fills the token and no GET reaches the POST-only source', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/session' && req.method === 'POST') {
        res.end(JSON.stringify({ csrfToken: 'live-token' }));
      } else if (req.url === '/api/items' && req.method === 'POST') {
        res.statusCode = req.headers['x-csrf-token'] === 'live-token' ? 201 : 403;
        res.end(JSON.stringify({ id: 7 }));
      } else {
        res.statusCode = 405;
        res.end('{}');
      }
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const client = TsClientHarness.client(mod, model, { baseUrl: base });
      await TsClientHarness.call(client, find(model, 'POST', '/api/session').name, { body: { device: 'web' } });
      const created = await TsClientHarness.call(client, find(model, 'POST', '/api/items').name, { body: { name: 'x' } });
      assert.equal(created.status, 201);
      assert.deepEqual(created.data, { id: 7 });
      assert.deepEqual(seen, ['POST /api/session', 'POST /api/items']);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
    }
  });

  test('without the session response the request goes out without a token and the error names the call to make first', async () => {
    const recorder = server();
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    const session = find(model, 'POST', '/api/session');
    const items = find(model, 'POST', '/api/items');
    const MissingTokenError = mod.MissingTokenError as new (...args: never[]) => Error;
    await assert.rejects(TsClientHarness.call(client, items.name, { body: { name: 'x' } }), (err: unknown) => {
      assert.ok(err instanceof MissingTokenError);
      assert.equal(
        err.message,
        `The server rejected the request with status 403. The client did not send the token x-csrf-token. This token comes from the response of POST https://app.example.com/api/session. Call ${session.name}() first.`,
      );
      return true;
    });
    assert.deepEqual(recorder.sent.map(line), ['POST /api/items']);
    assert.equal(recorder.sent[0]?.headers.get('x-csrf-token'), null);
  });
});

describe('hidden-field token of the submitted form (EXP2-6, EXP2-20)', () => {
  let harness: TsClientHarness;
  let model: ApiModel;
  let mod: Module;
  let register: Endpoint;

  before(async () => {
    harness = await TsClientHarness.open();
    const f = new CaptureFactory('https://sym.example.com');
    const html = `<!doctype html><html><body>
<form name="newsletter" action="/newsletter" method="post"><input type="email" name="email"><input type="hidden" name="_token" value="NEWSLETTER-TOKEN-0123456789abcdef"><button>Go</button></form>
<form name="registration" action="/register" method="post"><input type="text" name="registration[username]" required><input type="hidden" name="_token" value="REGISTRATION-TOKEN-0123456789abcdef"><button>Register</button></form>
</body></html>`;
    f.document('/register', html);
    f.exchange({
      url: '/register',
      method: 'POST',
      pageUrl: f.url('/register'),
      requestType: 'application/x-www-form-urlencoded',
      requestBody: 'registration%5Busername%5D=bob&_token=REGISTRATION-TOKEN-0123456789abcdef',
      status: 302,
      responseHeaders: { location: '/done' },
    });
    model = TsClientHarness.build(f);
    register = find(model, 'POST', '/register');
    mod = (await harness.load(model)).mod;
  });

  after(async () => {
    await harness?.close();
  });

  async function submit(page: string): Promise<string> {
    const recorder = TsClientHarness.recorder((request) => {
      const path = new URL(request.url).pathname;
      if (request.method === 'GET' && path === '/register') return TsClientHarness.html(page);
      return new Response('done', { status: 200 });
    });
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    await TsClientHarness.call(client, register.name, { body: { 'registration[username]': 'bob' } });
    const post = recorder.sent.find((request) => request.method === 'POST');
    return new URLSearchParams(await TsClientHarness.text(post?.body)).get('_token') ?? '';
  }

  test('the token comes from the registration form, not from an earlier form or from markup that is not a form', async () => {
    const page = `<!doctype html><html><body>
<!-- <form name="registration"><input type="hidden" name="_token" value="COMMENT"></form> -->
<script>document.write('<form name="registration"><input type="hidden" name="_token" value="SCRIPT">');</script>
<template><form name="registration"><input type="hidden" name="_token" value="TEMPLATE"></form></template>
<textarea><form name="registration"><input type="hidden" name="_token" value="TEXTAREA"></textarea>
<form name="newsletter" action="/newsletter" method="post"><input type="hidden" name="_token" value="NEWS-2"><form name="registration"><input type="hidden" name="_token" value="NESTED"></form>
<form NAME = 'registration' action="/register" method="post"><input type="text" name="registration[username]"><input type=hidden name="_token" value="REG-2&amp;more"></form>
</body></html>`;
    assert.equal(await submit(page), 'REG-2&more');
  });

  test('an input outside the form joins it through the form attribute', async () => {
    const page = `<form name="newsletter" action="/newsletter" method="post"><input type="hidden" name="_token" value="NEWS-3"></form>
<form id="reg" name="registration" action="/register" method="post"><input name="registration[username]"></form>
<input type="hidden" name="_token" value="ORPHAN" form="missing"><input type="hidden" name="_token" value="OWNED-3" form="reg">`;
    assert.equal(await submit(page), 'OWNED-3');
  });

  test('1 MiB hostile pages are scanned in linear time', { timeout: 60_000 }, async () => {
    for (const unit of ['<input ', '<input a="']) {
      const hostile = unit.repeat(Math.ceil(1_048_576 / unit.length));
      const started = performance.now();
      assert.equal(await submit(hostile), '');
      const elapsed = performance.now() - started;
      assert.ok(elapsed < 2_000, `${unit}: scan took ${Math.round(elapsed)} ms`);
    }
    const closed = '<input '.repeat(50_000) + '>' + '<input a="'.repeat(35_000) + '">' + '<!--'.repeat(90_000) + '-->';
    assert.equal(await submit(`${closed}<form name="registration" action="/register" method="post"><input type="hidden" name="_token" value="REG-4"></form>`), 'REG-4');
  });
});

describe('stale page tokens (EXP2-10, RETRY-1)', () => {
  let harness: TsClientHarness;
  let model: ApiModel;
  let mod: Module;
  let endpoint: Endpoint;

  before(async () => {
    harness = await TsClientHarness.open();
    const f = new CaptureFactory('https://rot.example.com');
    f.document('/form', CaptureFactory.page('Form', '<form action="/form" method="post"><input type="hidden" name="csrf_token" value="tok-0000000000000000"><input name="q"><button>Go</button></form>'));
    f.exchange({ url: '/form', method: 'POST', pageUrl: f.url('/form'), resourceType: 'document', requestType: 'application/x-www-form-urlencoded', requestBody: 'csrf_token=tok-0000000000000000&q=x', status: 200, responseType: 'text/plain', responseBody: 'ok' });
    model = TsClientHarness.build(f);
    endpoint = find(model, 'POST', '/form');
    assert.deepEqual(endpoint.auth.csrf.map((token) => token.source), ['hidden-field']);
    mod = (await harness.load(model)).mod;
  });

  after(async () => {
    await harness?.close();
  });

  function rotating(rejection: number, session: boolean): ReturnType<typeof TsClientHarness.recorder> {
    let current = 1;
    return TsClientHarness.recorder(async (request) => {
      if (request.method === 'GET') return TsClientHarness.html(`<form action="/form" method="post"><input type="hidden" name="csrf_token" value="T${current}"><input name="q"></form>`);
      const token = new URLSearchParams(await TsClientHarness.text(request.body)).get('csrf_token');
      if (token !== `T${current}`) return new Response('stale', { status: rejection });
      current++;
      return new Response('ok', { status: 200, headers: session ? { 'set-cookie': `sid=${current}; Path=/` } : {} });
    });
  }

  for (const status of [400, 403, 419, 422]) {
    test(`a ${status} answer to a page token is returned as it is, and the client never sends the request again on its own (RETRY-1)`, async () => {
      const recorder = rotating(status, false);
      const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
      const first = await TsClientHarness.call(client, endpoint.name, { body: { q: 'a' } });
      assert.equal(first.status, 200);
      assert.equal(first.staleTokens, undefined);
      const second = await TsClientHarness.call(client, endpoint.name, { body: { q: 'b' } });
      assert.equal(second.status, status);
      assert.deepEqual(recorder.sent.map(line), ['GET /form', 'POST /form', 'POST /form']);
      assert.deepEqual(second.staleTokens?.tokens, ['csrf_token']);
      assert.deepEqual(second.staleTokens?.pages, ['https://rot.example.com/form']);
      assert.match(second.staleTokens?.message ?? '', new RegExp(`status ${status}\\..*csrf_token.*refreshTokens\\(\\)`));
      client.refreshTokens();
      assert.equal((await TsClientHarness.call(client, endpoint.name, { body: { q: 'b' } })).status, 200);
      assert.deepEqual(recorder.sent.map(line), ['GET /form', 'POST /form', 'POST /form', 'GET /form', 'POST /form']);
    });
  }

  test('a rejection right after the client loaded the page has no stale token notice', async () => {
    const recorder = TsClientHarness.recorder((request) =>
      request.method === 'GET' ? TsClientHarness.html('<form action="/form" method="post"><input type="hidden" name="csrf_token" value="T1"><input name="q"></form>') : new Response('bad input', { status: 422 }),
    );
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    const response = await TsClientHarness.call(client, endpoint.name, { body: { q: 'a' } });
    assert.equal(response.status, 422);
    assert.equal(response.staleTokens, undefined);
    assert.deepEqual(recorder.sent.map(line), ['GET /form', 'POST /form']);
  });

  test('a session change loads the page again before the next submission, like a browser', async () => {
    const recorder = rotating(403, true);
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    assert.equal((await TsClientHarness.call(client, endpoint.name, { body: { q: 'a' } })).status, 200);
    assert.equal((await TsClientHarness.call(client, endpoint.name, { body: { q: 'b' } })).status, 200);
    assert.deepEqual(recorder.sent.map(line), ['GET /form', 'POST /form', 'GET /form', 'POST /form']);
  });

  test('a token that the caller gives is sent as it is and gets no stale token notice', async () => {
    const recorder = rotating(403, false);
    const client = TsClientHarness.client(mod, model, { fetch: recorder.fetch });
    const response = await TsClientHarness.call(client, endpoint.name, { body: { q: 'a', csrf_token: 'mine' } });
    assert.equal(response.status, 403);
    assert.equal(response.staleTokens, undefined);
    assert.deepEqual(recorder.sent.map(line), ['POST /form']);
  });
});
