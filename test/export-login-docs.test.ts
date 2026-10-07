import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CurlExporter, HtmlExporter, MarkdownExporter } from '../src/export/index.js';
import { Text } from '../src/shared/index.js';
import { LoginModels } from './helpers/login-models.js';
import { LoginShell } from './helpers/login-shell.js';
import { LoginSite } from './helpers/login-site.js';

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
    assert.match(markdown, /\| Login \| \[\\#\d+ POST \/login\]\(#\d+-post-login\): sends the user name in `username` and the password in `password`, and issues the cookie `session`\. \|/);
    assert.match(markdown, /\| Logout \| \[\\#\d+ GET \/logout\]\(#\d+-get-logout\): revokes the cookie `session`\. \|/);
    assert.doesNotMatch(markdown, /\| (Login|Logout) \| [^|\n]*\): (Login|Logout): /);
  });

  test('an anonymous capture names the login form that was not submitted yet', () => {
    const markdown = new MarkdownExporter().export(LoginModels.anonymous(ORIGIN)).content;
    assert.match(markdown, /\| Login \| \[\\#\d+ POST \/login\]\([^)]+\): sends the user name in `username` and the password in `password`; known from a form; not submitted yet\. \|/);
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
    assert.match(html, /<dt>Login<\/dt><dd><a href="#endpoint-\d+">#\d+ POST \/login<\/a>: sends the user name in <code>username<\/code> and the password in <code>password<\/code>, and issues the cookie <code>session<\/code>\.<\/dd>/);
    assert.match(html, /<dt>Logout<\/dt><dd><a href="#endpoint-\d+">#\d+ GET \/logout<\/a>: revokes the cookie <code>session<\/code>\.<\/dd>/);
    assert.doesNotMatch(html, /<dt>(Login|Logout)<\/dt><dd><a [^>]*>[^<]*<\/a>: (Login|Logout): /);
    assert.match(html, /<dt>Role<\/dt><dd>Login: sends the user name in <code>username<\/code>/);
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

describe('Markdown and HTML show the CSRF binding and point the login example to the curl function (P3)', () => {
  const site = new LoginSite();
  let dir = '';

  before(async () => {
    await site.start();
    dir = await mkdtemp(join(tmpdir(), 'appii-login-steps-'));
  });

  after(async () => {
    await site.stop();
    await rm(dir, { recursive: true, force: true });
  });

  test('the CSRF fact names the session cookie the token is bound to, in Markdown and HTML', () => {
    const model = LoginModels.form(ORIGIN);
    const login = section(new MarkdownExporter().export(model).content, /\n### \d+\. postLogin/);
    assert.match(login, /- \*\*CSRF:\*\* `csrf_token` in the body, from hidden-field `csrf_token` on `https:\/\/quotes\.example\.test\/login`, bound to the cookie `session`\n/);
    const html = new HtmlExporter().export(model).content;
    assert.match(html, /<dt>CSRF<\/dt><dd><code>csrf_token<\/code> in the body, from hidden-field <code>csrf_token<\/code> on <code>https:\/\/quotes\.example\.test\/login<\/code>, bound to the cookie <code>session<\/code><\/dd>/);
  });

  test('the login details explain the session-bound token and give the curl export commands', () => {
    const login = section(new MarkdownExporter().export(LoginModels.form(ORIGIN)).content, /\n### \d+\. postLogin/);
    const steps = login.slice(login.indexOf('**Session steps**'));
    assert.match(steps, /The token `csrf_token` changes with the session: request GET `https:\/\/quotes\.example\.test\/login`, read the hidden field `csrf_token`, and send it with the cookie `session` from the same session\. The example above leaves these steps to you; the curl export does them with a cookie jar:/);
    assert.ok(steps.includes('```bash\nappii export api.json --format curl -o endpoints.sh\nbash endpoints.sh postLogin username=VALUE password=VALUE\n```'), steps);
    assert.match(steps, /It keeps the cookies the login sets in its jar, so the functions you call after it are logged in\. It stops and names the variable when the user name or the password is missing\./);
    const html = new HtmlExporter().export(LoginModels.form(ORIGIN)).content;
    assert.match(html, /<h3>Session steps<\/h3><p>The token <code>csrf_token<\/code> changes with the session: request GET <code>https:\/\/quotes\.example\.test\/login<\/code>, read the hidden field <code>csrf_token<\/code>, and send it with the cookie <code>session<\/code> from the same session\./);
    assert.ok(html.includes(Text.escapeHtml('appii export api.json --format curl -o endpoints.sh\nbash endpoints.sh postLogin username=VALUE password=VALUE')), 'the HTML report has the same commands');
  });

  test('the documented curl command logs in against a live server and the next function is logged in', async () => {
    const model = LoginModels.form(site.origin);
    const markdown = new MarkdownExporter().export(model).content;
    const command = /\nbash endpoints\.sh (\S+) username=VALUE password=VALUE\n/.exec(markdown);
    assert.ok(command?.[1], markdown);
    await writeFile(join(dir, 'endpoints.sh'), new CurlExporter().export(model).content);
    site.reset();
    const env = { APPII_COOKIE_JAR: join(dir, 'docs-jar.txt') };
    const login = await LoginShell.run(['endpoints.sh', command[1], 'username=docs-user', 'password=pw', '-o', '/dev/null'], dir, env);
    assert.equal(login.code, 0, login.stderr);
    const account = await LoginShell.run(['endpoints.sh', LoginModels.endpoint(model, 'GET', '/account').name], dir, env);
    assert.match(account.stdout, /Account of docs-user/);
    assert.deepEqual(site.requests.map((request) => `${request.method} ${request.path}`), ['GET /login', 'POST /login', 'GET /account']);
  });

  test('the command uses the name of the curl function when it differs from the endpoint name', () => {
    const model = LoginModels.form(ORIGIN);
    LoginModels.endpoint(model, 'POST', '/login').name = 'list';
    const markdown = new MarkdownExporter().export(model).content;
    assert.ok(markdown.includes('\nbash endpoints.sh listEndpoint username=VALUE password=VALUE\n'), markdown);
    assert.match(new CurlExporter().export(model).content, /\nlistEndpoint\(\) \{/);
  });

  test('a bearer login says where the curl function keeps the token; an endpoint without a fetched token and without a role has no steps', () => {
    const markdown = new MarkdownExporter().export(LoginModels.bearer(ORIGIN)).content;
    const login = section(markdown, /\n### \d+\. postAuthLogin/);
    assert.match(login, /The example above sends the login on its own; the curl export sends it with a cookie jar:/);
    assert.match(login, /It saves the bearer token from the response in the token file `APPII_TOKEN_FILE`, so the functions you call after it send it\./);
    assert.doesNotMatch(login, /keeps the cookies the login sets/);
    assert.doesNotMatch(section(markdown, /\n### \d+\. getMe/), /Session steps/);
  });
});

