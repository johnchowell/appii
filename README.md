# appii

Turn any website into a usable API description. Browse a site in a real
Chromium while appii records the traffic, then get a list of its endpoints with
their parameters, JSON schemas, cookies, CSRF tokens and HTML form validation
rules, and export it as OpenAPI, Postman, curl, a typed TypeScript client and
more.

## Install

Requires Node.js 20.18 or newer.

```sh
npm install
npx playwright install chromium
npm run build
npm link        # puts the appii command on your PATH
```

Without building, run the CLI from the sources with `npx tsx src/cli.ts <command>`.

## Usage

### capture: record a browsing session

```sh
appii capture https://example.com
```

A Chromium window opens. Browse the site, log in, submit forms, then close the
window or press Ctrl+C. appii saves `capture.json` with every request and
response (bodies included), cookies (HttpOnly too), local and session storage,
WebSocket frames and page snapshots. Add `--headless --duration 30` to record
without a window, or convert a HAR file exported from DevTools with
`appii capture --from-har session.har`.

`--max-body` and `--max-total-body` limit the size of one body and of all
bodies, `--read-timeout` sets how long appii waits for a body after its request
ends, and `--user-agent` replaces the User-Agent of the browser. appii checks
that it can write the output file before the recording starts. If the file
cannot be saved after the recording, appii writes the recording to a file in
the temporary directory and the error message gives its path. If the browser
closes before the recording ends, for example because it crashed, appii saves
the requests recorded until then and exits with an error that says so. Pages
that the site opens in new tabs or windows are recorded too. appii asks for a
response body as soon as the browser reports the request finished, before a
script that waits for the page load can start the next navigation (Chromium
discards the bodies of a page once it navigates away). The first requests of a
new tab can start before appii's own browser session is attached to it; their
bodies are then read from the browser session that opened the tab, unless that
could make the browser send the request again (a compressed response with a
`Content-Length`), in which case the body is marked as not read. `-o -` writes the
capture to stdout and the summary to stderr, so `appii capture ... -o - | jq`
works.

#### Several URLs and logging in

```sh
appii capture https://example.com/ https://example.com/pricing https://example.com/docs --headless
```

opens the URLs in order in the same tab and waits until the network is idle
after each one. With a window, appii opens them in order and then leaves the
window to you.

To log in during the capture, name the fields of the login form with
`--login`, once per field:

```sh
export APPII_LOGIN_USERNAME='me@example.com'
export APPII_LOGIN_PASSWORD='...'
appii capture https://example.com/login https://example.com/account --headless \
  --login username --login password -o authed.json
```

After the first URL has loaded and the network is idle, appii looks for the
form whose controls include every given name. The controls of a form are the
ones the HTML standard gives it (a control outside the `<form>` element that
names it with the `form` attribute counts), open shadow roots are searched, and
a form that a script renders late is waited for, up to `--read-timeout`. When
two forms match, the visible one is used. appii then fills the form the way a
person would: it types into text fields so that the page sees `input` events
(a submit button that a script enables once the fields are filled works),
checks the checkbox or radio button with the given value and picks the option
of a select. It submits the form by clicking its default button, which is the
first submit button in tree order, or, when the form has no visible submit
button, by pressing Enter in the last text field it filled (implicit
submission; as in a browser, Enter does not submit a form that has no submit
button and more than one text field). `--login go=second`, with the name of a
submit button, clicks that button instead. appii waits until the page has
loaded and the network is idle, and then opens the other URLs.

`--login name` without a value reads the value from the environment variable
`APPII_LOGIN_<NAME>`: the name in upper case, with every character that is not
a letter or a digit turned into `_` (`--login user[email]` reads
`APPII_LOGIN_USER_EMAIL_`). It is an error when the variable is not set.
`--login name=value` gives the value on the command line, where other users of
the machine can see it, so prefer the variables for secrets. appii never
prints the values: the progress line, the summary, the warnings and the error
messages hide them. The capture file is the raw recording and holds the login
request as the browser sent it; appii writes it readable by you only. The
model built from it does not hold the password or the credentials.

The summary says that the form was submitted and where it went:

```
Login: submitted the form on https://example.com/login (username, password) by clicking its submit button;
       POST https://example.com/login answered 302; now on https://example.com/
```

appii prints a warning, and keeps the capture, when the submission answered
with a 4xx status or the login form is still on the page with an empty
password (the credentials were probably wrong), and when submitting sent no
request at all. When no form has all the names, the capture stops with an
error that lists the forms of the page and the names of their controls.

### build: infer the API

```sh
appii build capture.json
```

Writes `api.json`: endpoints with path templates, query and header parameters,
request and response schemas, auth cookies, bearer tokens, CSRF tokens and
where they come from, cookie roles, and the validation rules of the HTML forms
that submit to each endpoint. Like Chromium, appii reads a page without a
charset in its Content-Type header or a `<meta charset>` as windows-1252, and
reads form submissions in the charset of the form. Captures larger than the
largest string Node.js can hold are read piece by piece. A model written by an
older appii must be built again from its capture.

The build summary counts the requests and says which ones are not part of any
endpoint and why: requests to other origins, static assets, CORS preflights,
WebSocket handshakes, service worker responses, answers from the browser cache
and, with `--no-documents`, page loads. A navigation that an HTML form produced
(a GET search form, for example) is a form submission, not a page load, so
`--no-documents` keeps it. A GET form that was never submitted becomes an
endpoint (with 0 hits) only when it names an `action` that the capture did not
load as a page; a form without an `action`, such as a banner that page script
intercepts, and a form that targets a page that was loaded never do, with or
without `--no-documents`. `-o -` writes the model to stdout and the report to
stderr.

#### Several captures: update the model after logging in

```sh
appii capture https://example.com/login --headless -o anon.json
appii capture https://example.com/login https://example.com/account --headless \
  --login username --login password -o authed.json
appii build anon.json authed.json
```

A capture made without an account already gives the login endpoint: the login
form becomes an endpoint known from the form, with its fields and its CSRF
token, even though nobody submitted it. `appii build` with several captures or
HAR files builds one model from all of them, so the second build updates the
model with what logging in found (the login request, the credential it issued,
the endpoints that need it or only appear once logged in, the logout) and keeps
everything the anonymous capture found.

The inputs are merged before the build: the requests of all inputs (a request
that is in two inputs, for example when the same file is given twice, counts
once; requests read from a HAR file get ids derived from the entry, so this
holds for HAR files too), their page snapshots, storage and WebSockets, and
their cookies, where for cookies with the same name, domain, host-only flag,
path and partition key (the cookie identity of RFC 6265bis) the capture that
ended last wins. The start URL is the one of the earliest capture, and the
model covers the time from the earliest start to the latest end. With more
than one input, `source.captures` in `api.json` lists each input with its
file, start URL, time span and number of requests. `-o` must not name one of
the inputs.

`appii run` takes `--with <file>` (repeatable) to do the same in one step: it
records, then builds `api.json` from the earlier captures and the new one.

#### Credentials

A cookie, header or `Authorization` scheme is a credential of an endpoint only
with evidence, and every output (the `AUTH` column of `list`, the example
requests, the OpenAPI security, the Markdown and HTML reports, Postman and the
TypeScript client) follows the same rule, stored in `auth.sets`:

- `auth.sets` lists the credentials that each successful request carried
  together, such as `["cookie:sid", "http:bearer"]`. Credentials in one set
  are all needed (AND); different sets are alternatives (OR). `auth.anonymous`
  is `allowed` when a request without a logged-in credential got an answer
  that is not a failure (not 401 or 403 and not a redirect to the login page;
  a 302 or 303 to another page counts), so the credentials are optional;
  `list` then shows them with a `?` (`cookie?`). It is `refused` when every
  such request failed, and `untested` when no request without credentials was
  seen, as for an endpoint known only from a form. `auth.seen` says whether
  requests were seen anonymously, logged in, or both.
- An endpoint that answered only 401 or 403 to requests without credentials,
  while no credential was captured, needs a credential that appii did not
  see. It is never documented as public: the `AUTH` column shows `401?`,
  `--show` and the reports say `required, not captured (answered 401 without
  credentials)`, the example request and the `curl` function carry a note,
  and the OpenAPI operation has no `security` (instead of `security: []`) and
  `x-appii-auth: required-unobserved`.
- A session or auth cookie (by name) is a credential when the value that was
  sent came from a login: a response to a request with a password field, an
  `Authorization` header or an OAuth callback code set it, or a response to a
  request that already carried a logged-in value set it (except a sign-out).
  A value that a page load, a sign-out or any other response set is an
  anonymous session, so an endpoint called with it is public. A value that
  was never set in the capture (a preloaded session) counts as a login.
- A cookie whose value the page created with `document.cookie`, that the
  server never set, that is not HttpOnly and that no response ever contained
  is an analytics id, not a session (`role: tracking`). Analytics, preference
  and other cookies are never credentials, unless the same endpoint answered
  401, 403 or a redirect to the login page without them.
- `Authorization: Basic ...` maps to the OpenAPI `http`/`basic` scheme, and
  the example uses `curl -u "${APPII_USERNAME}:${APPII_PASSWORD}"`. Other
  schemes keep their name (`http`/`bearer`, `http`/`digest`).

`auth.cookies` still lists every cookie that the browser sent. The example
request sends only the credential cookies and the cookies that a CSRF token
depends on (`csrfToken.sessionCookies`, or the cookie a double-submit token
comes from).

#### Redaction

appii redacts secrets by name (passwords, tokens, API keys, `Cookie` and
`Authorization` values, secret query parameters) and by value: it collects
every secret value of the capture (the values of session, auth and CSRF
cookies, by evidence, and of other cookies with a secret name or a
token-shaped value; credentials, API keys, secret query, body and path values,
and the password of Basic credentials) and replaces that value, and its URL-,
form-, JSON- and HTML-encoded forms, wherever it appears in `api.json` and in
every export, also when the server echoes it in a response under another name.
Word-like values, and values that are not token-shaped and appear as ordinary
content in two or more unrelated places, are not replaced, so a cookie that
remembers a choice such as `view_mode=detailed` keeps the form options intact.
Values shorter than 6 characters are not replaced by value. CORS headers
(`Access-Control-Allow-Credentials: true`) and the messages under `errors`,
`error` and similar objects (`{"errors":{"token":["is missing"]}}`) are kept. `cookies[].valueExample`
shows only the length of a session, auth or CSRF cookie
(`<redacted> (24 characters)`), and at most the first 4 characters of a long
value of another cookie. `--no-redact` keeps every value.

#### Path templates

appii turns a path segment into a parameter from evidence, not from the word
before it:

- Integers, UUIDs, hex ids, dates and opaque tokens are parameters at once
  (`/items/42` becomes `/items/{itemId}`).
- Other values become a parameter when they vary and the requests behave as one
  resource: the same method, a 2xx response with the same content type and the
  same structure. For JSON the structure is the set of keys (optional keys may
  be missing); for HTML it is the element skeleton near the top of the page
  (tags and class names, not text). So `/tag/love/`, `/tag/life/` and
  `/tag/humor/` become `/tag/{tag}/`, while `/account/profile` and
  `/account/billing` with different pages stay two endpoints.
- A slug that carries a numeric id (`a-light-in-the-attic_1000`,
  `how-to-train-your-dragon-38`) is a parameter from two values, and a lone one
  is a parameter when the same place is already one elsewhere. A single plain
  word stays literal.
- A value that an earlier JSON response listed as an identifier (`slug`,
  `username`, `id` and similar keys), or that its own JSON response echoes in
  such a field, is a parameter even if it was seen once.
- A sibling that answers with another structure, sends other query parameters,
  or is not listed while its siblings are, stays literal: `/api/articles/feed`
  next to `/api/articles/{slug}`. Action words such as `login`, `new` or
  `settings` and paths whose forms send different fields also stay literal.
- A sibling that answered only 404 or 410 joins the parameter as an unknown id
  (a stale link or a typo). A sibling that answered 401 or 403 to the same
  anonymous client that read its siblings stays literal; one that was refused
  only because the request lacked the credentials its siblings were read with
  joins.
- Under a singular word, JSON values with the same structure become a
  parameter only with identifier evidence: three or more values, an id-like
  value, or an echo or a listing of each value. So `/search/title` and
  `/search/page` stay two endpoints. HTML pages keep the rule above.
- A number inside a file name becomes an in-segment parameter
  (`/catalogue/page-{page}.html`) once two numbers are seen.

A parameter takes the name of the response field that holds its value
(`{slug}`, `{username}`). Otherwise it is named after the segment before it: an
id under a plural collection gets `Id` (`{itemId}`), a value under a singular
word or a unit takes the word itself (`{page}`, `{status}`, `{bytes}`).

An endpoint name follows from its own path, not from the other endpoints that
were captured. A page load with path parameters ends with `By` and the
parameters: `getTagPageByTag`, `getCataloguePageByPage`,
`getCatalogueCategoryBookPageByBookAndPage`.

### list: look at the endpoints

```sh
appii list api.json --show 3
```

Without options it prints the endpoint table. `--show <#|id|name>` prints one
endpoint in detail with an example curl command, `--cookies` prints the cookie
table, and `--filter`, `--method`, `--kind`, `--origin` and `--json` narrow or
change the output. `--filter` finds words in the method, path, name, id or
GraphQL operation of an endpoint. `--origin` accepts an origin or a host with an
optional port (`example.com:443` matches `https://example.com`). The filters do
not apply to `--show`, so appii rejects them together. `list` also accepts
`capture.json` and HAR files directly.

When the submit buttons of a form send different fields, or several forms post
to one endpoint, the request body table marks a field that only some
submissions require with `if`. Below the table, one `When <field>=<value>:`
block per submission gives the fields that it requires, the fields that it does
not send, and its stricter rules.

The example curl command uses a shell variable only for a value that appii does
not know: a redacted secret, a CSRF token, a bearer token
(`${APPII_ACCESS_TOKEN}`), Basic credentials (`${APPII_USERNAME}` and
`${APPII_PASSWORD}`) or a cookie. The `Variables:` line names these
variables. All of them start with `APPII_`, so a field with the name `path` or
`home` cannot read a variable of your shell. A CSRF token that comes from a
cookie uses the variable of that cookie. Captured values are always sent as
literal text, also when they contain text such as `{{name}}` or `${NAME}`. The
`curl` script uses the same variables.

The example request is the request that the browser sends. For an HTML form,
appii uses the rules of the first submit button, and gives each field a value
that agrees with the form constraints. If appii cannot make a valid value, it
uses a variable. A file input without a file becomes an empty file part. The
example encodes the form in its charset and changes line breaks to CRLF. A
`text/plain` form sends `name=value` lines. The example also sends the
credential cookies of the endpoint and the cookies its CSRF tokens depend on
(see Credentials). Every command ends with `--compressed`, as the browser
always accepts compressed responses. The Markdown and HTML exports show the
same command.

`--show` lists every request body that the endpoint received (one block per
media type) with one example curl command per media type, marks a JSON lines
body, says where a redirect leads, and splits the cookies the endpoint needs
from the other cookies the browser sent. A form
field whose `<select>` options change with the page state shows
`options vary by page state` with the options seen.

Terminal output is ASCII: text from the site that is not ASCII appears as
`\u` escapes, so an accented name prints as `Andr\u00e9 Gide`. Add `--unicode`
to any command to show that text as UTF-8 instead. Control characters, bidirectional
overrides and other invisible formatting characters stay escaped, and tables
keep their columns aligned for wide characters.

### export: write a spec, client, script or report

```sh
appii export api.json --format openapi
```

Use `-o <file>` to choose the output file or `-o -` for stdout; `capture` and
`build` take `-o -` the same way and then print their report on stderr. `run`
writes two files and refuses `--out-dir -`. To write a file that is really
named `-`, use `-o ./-`. If the file is
a symbolic link, appii writes the file that the link points to; a FIFO or a
character device such as `/dev/null` is written in place, and an existing file
keeps its permissions (a file with secrets, such as an export without
redaction, can only lose permissions). `build`, `export` and `capture --from-har` refuse to
write over their input file, also through a link. Use
`--endpoints 1,3,getItem` to export a subset and `appii export --formats` to
list the formats:

| Format | Extension | Aliases | Description |
| --- | --- | --- | --- |
| `openapi` | `.json` | `oas`, `openapi-json`, `swagger` | OpenAPI 3.1 document (JSON) |
| `openapi-yaml` | `.yaml` | `openapi-yml`, `yaml`, `yml` | OpenAPI 3.1 document (YAML) |
| `postman` | `.json` | `postman-collection` | Postman Collection v2.1 with folders, variables and saved example responses |
| `curl` | `.sh` | `bash`, `sh`, `shell` | Bash script with one curl function per endpoint, a list command and a dispatcher |
| `typescript` | `.ts` | `client`, `ts` | Typed TypeScript client with cookie, CSRF and form validation handling |
| `har` | `.har` |  | HAR 1.2 archive with the captured sample exchanges of the selected endpoints |
| `html` | `.html` | `report` | Self-contained HTML report with charts, a searchable endpoint list and details |
| `markdown` | `.md` | `md` | Markdown documentation with endpoint tables, details and cookies |
| `json` | `.json` | `model` | The API model (api.json) as pretty-printed JSON |

The `curl` script has one function for each endpoint. Run it without arguments
to list the endpoints. The `ARGUMENTS` column shows the path parameters of an
endpoint, and its query parameters and the fields of its form, multipart or
top-level JSON body as `[name=]`; a query parameter and a body field with the
same name are `[query.name=]` and `[body.name=]`. Give path values after the
endpoint name or number, for example `bash endpoints.sh getItem 2`, and the
other values as `name=value` arguments, for example `bash endpoints.sh
listItems page=3`. If you do not give a value, the script uses the function's
`APPII_<NAME>` variable or the captured example; a query parameter that the
captured request did not send is sent only when you give it a value. The
default body of a form is the submission that the site received for the chosen
submit button. The script encodes each value for its position in the URL, form
or JSON body. Arguments that start with `-` go to curl. A bare `--`, the curl
options `--url`, `--next` and `-:`, and any other argument that no parameter
takes stop the script with an error before it sends a request. Every request
uses `--compressed`. `APPII_BASE_URL` sets the base URL and `APPII_COOKIE` sets
the Cookie header. An endpoint that received more than one body type has one
function per type (`postPost`, `postPostJson`, `postPostMultipart`), listed
below it. A multipart file part reads the file in `APPII_<FIELD>_FILE`
(default: the captured file name in the current directory). Sourcing the
script defines the functions without changing the options of your shell.

The `typescript` client fills CSRF tokens from the pages and responses that
the site uses. It keeps a page while the cookies for that page stay the same.
The client never sends a request two times on its own. If the server rejects
a request with status 400, 403, 419 or 422 and the client took a token from a
page that it loaded before, `response.staleTokens` names the token and the
page, and the client forgets that page, so the next request loads it again as
a browser would after a reload. `client.refreshTokens()` forgets all pages.
Send the request again only if the server can safely receive it two times.
The client does not check a form pattern that can take exponential or
high-degree polynomial time, such as `(a+)+b` or `(.*a){25}`, unless you pass
`unsafePatterns: true`.

The client types a redirect that it follows as the response of the endpoint
the redirect leads to (`responses[].redirectTo` in the model), so the 302 of a
login form is typed as the page it leads to; with `redirect: 'manual'` the
client returns the redirect itself. Method comments say which credential
cookies, bearer token or Basic credentials an endpoint needs.

The Markdown and HTML reports list the distinct forms with how many times and
on which pages each one appears. Their constraint cells list every enum value
and observed option in full, and the Markdown export adds a collapsed JSON
Schema block for each request body. Postman turns a parameter inside a path
segment into a collection variable (`page-{{page}}.html`). The `har` export
keeps textual request bodies, multipart bodies included, as plain text with
their parameters, and uses base64 only for bytes that are not text. It
replaces each distinct cookie value with its own placeholder (`<redacted>1`,
`<redacted>2`, ... per cookie name, the same in `Cookie` and `Set-Cookie`), so
`capture --from-har` of the export keeps which session each request carried
and builds the same credentials.

For a subset of the endpoints, the `json` export keeps only the cookies and
forms of the selected endpoints, and `setBy` and `usedBy` name only selected
endpoints. The site data (`origins`, `source` and `websockets`) does not change.
The `har` export redacts secrets also in compressed request bodies. If appii
cannot read a body completely, for example a truncated JSON body, the HAR keeps
the size and the truncated mark but not the body text. To export the `har`
format from an `api.json`, give the recorded traffic with `--capture <file>`;
for a model built from several captures, repeat `--capture` for each of them.

### All in one

```sh
appii run https://example.com
```

Captures, builds and lists in one step and writes `capture.json` and
`api.json` into `./appii-out`. It takes several URLs and `--login` like
`capture`, and `--with <file>` to build `api.json` from earlier captures too:

```sh
appii run https://example.com/login https://example.com/account --headless \
  --login username --login password --with anon.json --out-dir authed
```
 Run `appii help <command>` for every option and
`appii --version` (or `appii -V`) for the version.
