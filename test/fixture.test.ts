import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startFixtureSite } from './fixtures/site.js';

test('fixture site serves login form and json api', async () => {
  const site = await startFixtureSite();
  try {
    const home = await fetch(site.url);
    assert.equal(home.status, 200);
    assert.ok(home.headers.getSetCookie().some((c) => c.startsWith('sid=')));
    const items = (await (await fetch(site.origin + '/api/items?limit=2')).json()) as { items: unknown[] };
    assert.equal(items.items.length, 2);
    const login = await fetch(site.origin + '/login');
    assert.match(await login.text(), /csrf_token/);
  } finally {
    await site.close();
  }
});
