import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { HtmlExporter, MarkdownExporter } from '../src/export/index.js';
import { LoginModels } from './helpers/login-models.js';

const ORIGIN = 'https://quotes.example.test';

function section(markdown: string, heading: RegExp): string {
  const start = markdown.search(heading);
  assert.ok(start >= 0, String(heading));
  const rest = markdown.slice(start + 1);
  const end = rest.search(/\n<a id=|\n## /);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('Markdown and HTML show the login, the logout, the anonymous state and the login hint (L3, QL-2, QL-3, QL-6)', () => {
  test('the Markdown summary names the login and the logout with what they issue and revoke', () => {
    const markdown = new MarkdownExporter().export(LoginModels.form(ORIGIN)).content;
    assert.match(markdown, /\| Login \| \[\\#\d+ POST \/login\]\(#\d+-post-login\): Login: sends the user name in `username` and the password in `password`, and issues the cookie `session`\. \|/);
    assert.match(markdown, /\| Logout \| \[\\#\d+ GET \/logout\]\(#\d+-get-logout\): Logout: revokes the cookie `session`\. \|/);
  });

  test('an anonymous capture names the login form that was not submitted yet', () => {
    const markdown = new MarkdownExporter().export(LoginModels.anonymous(ORIGIN)).content;
    assert.match(markdown, /\| Login \| \[\\#\d+ POST \/login\]\([^)]+\): Login: sends the user name in `username` and the password in `password`; known from a form; not submitted yet\. \|/);
  });

  test('the Markdown table marks the login and logout rows and the details give role, anonymous state, seen states and the login hint', () => {
    const markdown = new MarkdownExporter().export(LoginModels.form(ORIGIN)).content;
    assert.match(markdown, /\n\| \d+ \| POST \| `\/login` \| \[postLogin\]\([^)]+\) \| form \| 302 \| login; csrf \| 1 \|\n/);
    assert.match(markdown, /\n\| \d+ \| GET \| `\/logout` \| \[getLogout\]\([^)]+\) \| document \| 302 \| logout; cookie session \(anonymous access not tested\) \| 1 \|\n/);
    const page = section(markdown, /\n### \d+\. getPageByPage/);
    assert.match(page, /- \*\*Anonymous:\*\* not tested: no request without credentials was captured/);
    assert.match(page, /- \*\*Seen:\*\* authenticated/);
    assert.match(page, /- \*\*Log in:\*\* Log in first with \[\\#\d+ postLogin\]\(#\d+-post-login\) \(POST \/login\)\./);
    const account = section(markdown, /\n### \d+\. getAccountPage/);
    assert.match(account, /- \*\*Anonymous:\*\* refused: every request without credentials failed/);
    const login = section(markdown, /\n### \d+\. postLogin/);
    assert.match(login, /- \*\*Role:\*\* Login: sends the user name in `username` and the password in `password`, and issues the cookie `session`\./);
    assert.match(login, /- \*\*Anonymous:\*\* allowed/);
  });

  test('the Markdown cookie table says which login issues the cookie and which logout revokes it', () => {
    const model = LoginModels.form(ORIGIN);
    const markdown = new MarkdownExporter().export(model).content;
    const cookies = markdown.slice(markdown.indexOf('## Cookies'));
    assert.match(cookies, /\| Name \| Domain \| Path \| Role \| HttpOnly \| Secure \| SameSite \| Partition \| Expires \| Set by \| Used by \| Issued by \| Revoked by \|/);
    assert.match(cookies, new RegExp(`\\| ${LoginModels.endpoint(model, 'POST', '/login').id} \\| ${LoginModels.endpoint(model, 'GET', '/logout').id} \\|\\n`));
  });

  test('the HTML report has login and logout facts, role badges, the anonymous state and the hint', () => {
    const model = LoginModels.form(ORIGIN);
    const html = new HtmlExporter().export(model).content;
    assert.match(html, /<dt>Login<\/dt><dd><a href="#endpoint-\d+">#\d+ POST \/login<\/a>: Login: sends the user name in <code>username<\/code> and the password in <code>password<\/code>, and issues the cookie <code>session<\/code>\.<\/dd>/);
    assert.match(html, /<dt>Logout<\/dt><dd><a href="#endpoint-\d+">#\d+ GET \/logout<\/a>: Logout: revokes the cookie <code>session<\/code>\.<\/dd>/);
    assert.match(html, /<span class="badge role" title="the login: it issues the credential">login<\/span>/);
    assert.match(html, /<span class="badge role" title="the logout: it revokes the credential">logout<\/span>/);
    assert.match(html, /<span class="badge auth" title="anonymous access not tested">auth~<\/span>/);
    assert.match(html, /<dt>Anonymous<\/dt><dd>not tested: no request without credentials was captured<\/dd>/);
    assert.match(html, /<dt>Seen<\/dt><dd>authenticated<\/dd>/);
    assert.match(html, /<dt>Log in<\/dt><dd>Log in first with <a href="#endpoint-\d+">#\d+ <code>postLogin<\/code><\/a> \(POST \/login\)\.<\/dd>/);
    assert.match(html, /<th>Issued by<\/th><th>Revoked by<\/th>/);
  });

  test('neither document holds a captured credential value', () => {
    const model = LoginModels.form(ORIGIN);
    for (const text of [new MarkdownExporter().export(model).content, new HtmlExporter().export(model).content]) {
      for (const secret of [LoginModels.USER, LoginModels.PASSWORD, LoginModels.AUTH_SESSION, LoginModels.ANON_SESSION, LoginModels.REVOKED_SESSION, LoginModels.CSRF]) assert.ok(!text.includes(secret), secret);
    }
  });
});
