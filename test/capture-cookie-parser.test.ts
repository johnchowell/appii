import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { CookieParser } from '../src/capture/index.js';
import type { Cookie, Exchange } from '../src/model/index.js';

const NOW = new Date('2026-06-01T12:00:00.000Z');
const NOW_S = NOW.getTime() / 1000;
const parser = new CookieParser({ now: () => NOW });

function exchange(url: string, setCookies: string[], startedAt = NOW.toISOString(), durationMs = 0): Exchange {
  return {
    id: url + startedAt,
    source: 'browser',
    resourceType: 'document',
    startedAt,
    durationMs,
    request: { method: 'GET', url, headers: [] },
    response: { status: 200, statusText: 'OK', headers: setCookies.map((value) => ({ name: 'Set-Cookie', value })) },
  };
}

describe('CookieParser.tokenize', () => {
  test('splits name, value and attributes with whitespace trimming', () => {
    const parts = CookieParser.tokenize(' sid = abc ; Path=/x ;HttpOnly; SameSite = Lax ');
    assert.deepEqual(parts, {
      name: 'sid',
      value: 'abc',
      attributes: [
        { name: 'Path', value: '/x' },
        { name: 'HttpOnly', value: '' },
        { name: 'SameSite', value: 'Lax' },
      ],
    });
  });

  test('a pair without "=" is a nameless cookie and "=" alone is rejected', () => {
    assert.deepEqual(CookieParser.tokenize('justvalue'), { name: '', value: 'justvalue', attributes: [] });
    assert.equal(CookieParser.tokenize('='), null);
    assert.equal(CookieParser.tokenize('  ;Path=/'), null);
  });

  test('keeps quotes and "=" inside values', () => {
    assert.equal(CookieParser.tokenize('q="a b"')?.value, '"a b"');
    assert.equal(CookieParser.tokenize('jwt=a.b=c==; Path=/')?.value, 'a.b=c==');
  });

  test('rejects control characters but allows horizontal tab', () => {
    assert.equal(CookieParser.tokenize('a=b\u0001c'), null);
    assert.equal(CookieParser.tokenize('a=b\nc'), null);
    assert.equal(CookieParser.tokenize('a=b\u007f'), null);
    assert.equal(CookieParser.tokenize('a=\tb\t')?.value, 'b');
  });

  test('enforces the 4096 octet name+value limit and drops attributes over 1024 octets', () => {
    assert.equal(CookieParser.tokenize('a=' + 'x'.repeat(4096)), null);
    assert.equal(CookieParser.tokenize('a=' + 'x'.repeat(4095))?.value.length, 4095);
    const parts = CookieParser.tokenize(`a=b; Path=/${'p'.repeat(1100)}; Secure`);
    assert.deepEqual(parts?.attributes, [{ name: 'Secure', value: '' }]);
  });
});

describe('CookieParser.parseDate (RFC 6265bis cookie-date)', () => {
  const at = (iso: string) => Date.parse(iso);
  test('parses the common date formats', () => {
    assert.equal(CookieParser.parseDate('Wed, 21 Oct 2015 07:28:00 GMT'), at('2015-10-21T07:28:00Z'));
    assert.equal(CookieParser.parseDate('Sunday, 06-Nov-94 08:49:37 GMT'), at('1994-11-06T08:49:37Z'));
    assert.equal(CookieParser.parseDate('Sun Nov  6 08:49:37 1994'), at('1994-11-06T08:49:37Z'));
    assert.equal(CookieParser.parseDate('Thu, 01 Jan 1970 00:00:00 GMT'), 0);
    assert.equal(CookieParser.parseDate('1 jan 05 1:2:3'), at('2005-01-01T01:02:03Z'));
    assert.equal(CookieParser.parseDate('31 December 2099 23:59:59'), at('2099-12-31T23:59:59Z'));
  });

  test('rejects invalid dates', () => {
    assert.equal(CookieParser.parseDate('31 Feb 2020 00:00:00'), null);
    assert.equal(CookieParser.parseDate('01 Jan 1600 00:00:00'), null);
    assert.equal(CookieParser.parseDate('01 Jan 2020 24:00:00'), null);
    assert.equal(CookieParser.parseDate('01 Jan 2020 00:60:00'), null);
    assert.equal(CookieParser.parseDate('01 Jan 2020'), null);
    assert.equal(CookieParser.parseDate('Jan 2020 00:00:00'), null);
    assert.equal(CookieParser.parseDate('garbage'), null);
    assert.equal(CookieParser.parseDate('0 Jan 2020 00:00:00'), null);
  });
});

describe('CookieParser.parse storage model', () => {
  test('host-only cookie with default-path', () => {
    const c = parser.parse('sid=1; HttpOnly', 'https://www.example.com/a/b/c?x=1');
    assert.deepEqual(c, {
      name: 'sid',
      value: '1',
      domain: 'www.example.com',
      path: '/a/b',
      expires: null,
      httpOnly: true,
      secure: false,
      sameSite: null,
      hostOnly: true,
    });
    assert.equal(parser.parse('a=1', 'https://example.com/')?.path, '/');
    assert.equal(parser.parse('a=1', 'https://example.com/single')?.path, '/');
    assert.equal(parser.parse('a=1', 'https://example.com/dir/')?.path, '/dir');
  });

  test('Path attribute: explicit, invalid and empty values', () => {
    assert.equal(parser.parse('a=1; Path=/api', 'https://example.com/x/y')?.path, '/api');
    assert.equal(parser.parse('a=1; Path=api', 'https://example.com/x/y')?.path, '/x');
    assert.equal(parser.parse('a=1; Path=', 'https://example.com/x/y')?.path, '/x');
    assert.equal(parser.parse('a=1; Path=/one; Path=/two', 'https://example.com/')?.path, '/two');
  });

  test('Domain attribute: leading dot, case, matching and mismatching', () => {
    const c = parser.parse('a=1; Domain=.EXAMPLE.com', 'https://shop.example.com/');
    assert.equal(c?.domain, 'example.com');
    assert.equal(c?.hostOnly, false);
    assert.equal(parser.parse('a=1; Domain=shop.example.com', 'https://shop.example.com/')?.hostOnly, false);
    assert.equal(parser.parse('a=1; Domain=other.com', 'https://shop.example.com/'), null);
    assert.equal(parser.parse('a=1; Domain=ample.com', 'https://example.com/'), null);
    assert.equal(parser.parse('a=1; Domain=deep.shop.example.com', 'https://shop.example.com/'), null);
    assert.equal(parser.parse('a=1; Domain=', 'https://shop.example.com/')?.hostOnly, true);
    assert.equal(parser.parse('a=1; Domain=ex\u00e4mple.com', 'https://example.com/'), null);
  });

  test('rejects public suffix domains unless identical to the host', () => {
    assert.equal(parser.parse('a=1; Domain=com', 'https://example.com/'), null);
    assert.equal(parser.parse('a=1; Domain=co.uk', 'https://shop.example.co.uk/'), null);
    assert.equal(parser.parse('a=1; Domain=github.io', 'https://user.github.io/'), null);
    const same = parser.parse('a=1; Domain=github.io', 'https://github.io/');
    assert.equal(same?.hostOnly, true);
    assert.equal(same?.domain, 'github.io');
    assert.equal(parser.parse('a=1; Domain=localhost', 'http://localhost:3000/')?.hostOnly, true);
  });

  test('IP hosts: identical Domain becomes host-only, anything else is rejected', () => {
    const c = parser.parse('a=1; Domain=127.0.0.1', 'http://127.0.0.1:8080/');
    assert.equal(c?.hostOnly, true);
    assert.equal(c?.domain, '127.0.0.1');
    assert.equal(parser.parse('a=1; Domain=0.0.1', 'http://127.0.0.1/'), null);
    assert.equal(parser.parse('a=1', 'http://[::1]:8080/')?.domain, '[::1]');
  });

  test('Max-Age wins over Expires regardless of order and is capped at 400 days', () => {
    const later = 'Wed, 21 Oct 2099 07:28:00 GMT';
    assert.equal(parser.parse(`a=1; Max-Age=60; Expires=${later}`, 'https://example.com/')?.expires, NOW_S + 60);
    assert.equal(parser.parse(`a=1; Expires=${later}; Max-Age=60`, 'https://example.com/')?.expires, NOW_S + 60);
    assert.equal(parser.parse(`a=1; Expires=${later}`, 'https://example.com/')?.expires, NOW_S + 400 * 86400);
    assert.equal(parser.parse('a=1; Max-Age=999999999', 'https://example.com/')?.expires, NOW_S + 400 * 86400);
    assert.equal(parser.parse('a=1; Expires=Wed, 21 Oct 2026 07:28:00 GMT', 'https://example.com/')?.expires, Date.parse('2026-10-21T07:28:00Z') / 1000);
  });

  test('invalid Max-Age values are ignored and zero or negative means already expired', () => {
    assert.equal(parser.parse('a=1; Max-Age=1a', 'https://example.com/')?.expires, null);
    assert.equal(parser.parse('a=1; Max-Age=+5', 'https://example.com/')?.expires, null);
    assert.equal(parser.parse('a=1; Max-Age=0', 'https://example.com/')?.expires, 0);
    assert.equal(parser.parse('a=1; Max-Age=-10', 'https://example.com/')?.expires, 0);
    const old = parser.parse('a=1; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'https://example.com/');
    assert.ok(old && CookieParser.isExpired(old, NOW.getTime()));
    assert.equal(parser.parse('a=1; Expires=nonsense', 'https://example.com/')?.expires, null);
  });

  test('Secure requires a potentially trustworthy origin like Chrome', () => {
    assert.equal(parser.parse('a=1; Secure', 'http://example.com/'), null);
    assert.equal(parser.parse('a=1; Secure', 'https://example.com/')?.secure, true);
    for (const url of ['http://127.0.0.1:9000/', 'http://127.8.9.10/', 'http://localhost/', 'http://app.localhost/', 'http://[::1]/', 'wss://example.com/']) {
      assert.equal(parser.parse('a=1; Secure', url)?.secure, true, url);
    }
  });

  test('SameSite values, defaults and SameSite=None requiring Secure', () => {
    assert.equal(parser.parse('a=1; SameSite=strict', 'https://example.com/')?.sameSite, 'Strict');
    assert.equal(parser.parse('a=1; SameSite=LAX', 'https://example.com/')?.sameSite, 'Lax');
    assert.equal(parser.parse('a=1; SameSite=bogus', 'https://example.com/')?.sameSite, null);
    assert.equal(parser.parse('a=1; SameSite=None', 'https://example.com/'), null);
    assert.equal(parser.parse('a=1; SameSite=None; Secure', 'https://example.com/')?.sameSite, 'None');
    assert.equal(parser.parse('a=1; SameSite=Strict; SameSite=bogus', 'https://example.com/')?.sameSite, null);
  });

  test('__Secure- prefix requires Secure (case-insensitive)', () => {
    assert.equal(parser.parse('__Secure-a=1', 'https://example.com/'), null);
    assert.equal(parser.parse('__SECURE-a=1', 'https://example.com/'), null);
    assert.equal(parser.parse('__Secure-a=1; Secure', 'https://example.com/')?.name, '__Secure-a');
    assert.equal(parser.parse('__Secure-a=1; Secure', 'http://example.com/'), null);
  });

  test('__Host- prefix requires Secure, host-only and an explicit Path=/', () => {
    assert.ok(parser.parse('__Host-a=1; Secure; Path=/', 'https://example.com/x'));
    assert.equal(parser.parse('__Host-a=1; Secure', 'https://example.com/'), null);
    assert.equal(parser.parse('__Host-a=1; Path=/', 'https://example.com/'), null);
    assert.equal(parser.parse('__Host-a=1; Secure; Path=/x', 'https://example.com/'), null);
    assert.equal(parser.parse('__Host-a=1; Secure; Path=/; Domain=example.com', 'https://example.com/'), null);
    assert.equal(parser.parse('__host-a=1; Secure', 'https://example.com/'), null);
    assert.ok(parser.parse('__Host-a=1; Secure; Path=/', 'http://127.0.0.1/'));
  });

  test('nameless cookies may not smuggle a prefix through the value', () => {
    assert.equal(parser.parse('__Host-a', 'https://example.com/'), null);
    assert.equal(parser.parse('__secure-x', 'https://example.com/'), null);
    assert.equal(parser.parse('plain', 'https://example.com/')?.value, 'plain');
  });

  test('non-network schemes and invalid URLs are rejected', () => {
    assert.equal(parser.parse('a=1', 'file:///tmp/x.html'), null);
    assert.equal(parser.parse('a=1', 'not a url'), null);
    assert.ok(parser.parse('a=1', 'ws://example.com/socket'));
  });

  test('uses the injected clock by default and the real clock otherwise', () => {
    const before = Date.now() / 1000;
    const c = new CookieParser().parse('a=1; Max-Age=10', 'https://example.com/');
    assert.ok(c && c.expires !== null && c.expires >= before + 10 && c.expires <= Date.now() / 1000 + 10);
  });
});

describe('CookieParser helpers', () => {
  test('domain matching follows RFC 6265bis 5.1.3', () => {
    assert.ok(CookieParser.domainMatches('a.example.com', 'example.com'));
    assert.ok(CookieParser.domainMatches('EXAMPLE.com', 'example.COM'));
    assert.ok(!CookieParser.domainMatches('badexample.com', 'example.com'));
    assert.ok(!CookieParser.domainMatches('example.com', 'a.example.com'));
    assert.ok(!CookieParser.domainMatches('1.2.3.4', '2.3.4'));
  });

  test('path matching follows RFC 6265bis 5.1.4', () => {
    assert.ok(CookieParser.pathMatches('/api', '/api'));
    assert.ok(CookieParser.pathMatches('/api/items', '/api'));
    assert.ok(CookieParser.pathMatches('/api/items', '/api/'));
    assert.ok(!CookieParser.pathMatches('/apix', '/api'));
    assert.ok(!CookieParser.pathMatches('/', '/api'));
  });

  test('fromPlaywright maps leading-dot domains, session expiry and sameSite', () => {
    assert.deepEqual(
      CookieParser.fromPlaywright({ name: 'a', value: '1', domain: '.example.com', path: '/', expires: -1, httpOnly: true, secure: true, sameSite: 'None' }),
      { name: 'a', value: '1', domain: 'example.com', path: '/', expires: null, httpOnly: true, secure: true, sameSite: 'None', hostOnly: false },
    );
    const hostOnly = CookieParser.fromPlaywright({ name: 'b', value: '2', domain: '127.0.0.1', path: '/x', expires: 1791169944.5, httpOnly: false, secure: false, sameSite: 'Lax' });
    assert.equal(hostOnly.hostOnly, true);
    assert.equal(hostOnly.domain, '127.0.0.1');
    assert.equal(hostOnly.expires, 1791169944.5);
  });
});

describe('CookieParser.replay', () => {
  const byName = (cookies: Cookie[]) => Object.fromEntries(cookies.map((c) => [`${c.name}@${c.domain}${c.path}`, c.value]));

  test('applies Set-Cookie headers in order so later values win', () => {
    const jar = parser.replay([exchange('https://example.com/', ['a=1', 'b=1']), exchange('https://example.com/', ['a=2'])]);
    assert.deepEqual(byName(jar), { 'a@example.com/': '2', 'b@example.com/': '1' });
  });

  test('Max-Age=0 and past Expires delete existing cookies', () => {
    const jar = parser.replay([
      exchange('https://example.com/', ['a=1', 'b=1', 'c=1']),
      exchange('https://example.com/logout', ['a=; Max-Age=0', 'b=; Expires=Thu, 01 Jan 1970 00:00:00 GMT', 'zzz=; Max-Age=0']),
    ]);
    assert.deepEqual(byName(jar), { 'c@example.com/': '1' });
  });

  test('name, domain, host-only flag and path form the identity', () => {
    const jar = parser.replay([
      exchange('https://shop.example.com/a/b', ['a=host', 'a=domain; Domain=example.com', 'a=root; Path=/', 'a=api; Path=/api']),
      exchange('https://shop.example.com/a/b', ['a=host2']),
    ]);
    assert.equal(jar.length, 4);
    const host = jar.find((c) => c.hostOnly && c.path === '/a');
    assert.equal(host?.value, 'host2');
    assert.equal(jar.find((c) => !c.hostOnly)?.value, 'domain');
  });

  test('cookies expire relative to capture time, not to the import time', () => {
    const t0 = '2020-01-01T00:00:00.000Z';
    const jar = parser.replay([exchange('https://example.com/', ['short=1; Max-Age=10', 'long=1; Max-Age=3600'], t0)]);
    assert.deepEqual(jar.map((c) => c.name).sort(), ['long', 'short']);
    const later = parser.replay([
      exchange('https://example.com/', ['short=1; Max-Age=10', 'long=1; Max-Age=3600'], t0),
      exchange('https://example.com/next', [], '2020-01-01T00:01:00.000Z'),
    ]);
    assert.deepEqual(later.map((c) => c.name), ['long']);
  });

  test('a non-secure origin cannot overwrite a secure cookie', () => {
    const jar = parser.replay([exchange('https://example.com/', ['sid=secure; Secure']), exchange('http://example.com/', ['sid=plain', 'other=1'])]);
    assert.deepEqual(byName(jar), { 'sid@example.com/': 'secure', 'other@example.com/': '1' });
  });

  test('rejected cookies are skipped and multi-line headers are split', () => {
    const jar = parser.replay([exchange('http://example.com/', ['ok=1\nbad=1; Secure\n__Host-x=1', 'also=2'])]);
    assert.deepEqual(byName(jar), { 'ok@example.com/': '1', 'also@example.com/': '2' });
  });

  test('starts from an existing jar and ignores exchanges without a response', () => {
    const base: Cookie = { name: 'seed', value: '0', domain: 'example.com', path: '/', expires: null, httpOnly: false, secure: false, sameSite: null, hostOnly: true };
    const failed: Exchange = { ...exchange('https://example.com/', []), response: undefined, error: 'net::ERR_FAILED' };
    delete failed.response;
    const jar = parser.replay([failed, exchange('https://example.com/', ['seed=; Max-Age=0', 'next=1'])], [base]);
    assert.deepEqual(byName(jar), { 'next@example.com/': '1' });
    assert.deepEqual(parser.replay([], [base]), [base]);
  });
});
