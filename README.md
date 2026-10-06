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
that the site opens in new tabs or windows are recorded too.

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
`--no-documents` keeps it.

#### Credentials

A cookie, header or `Authorization` scheme is a credential of an endpoint only
with evidence, and every output (the `AUTH` column of `list`, the example
requests, the OpenAPI security, the Markdown and HTML reports, Postman and the
TypeScript client) follows the same rule, stored in `auth.sets`:

- `auth.sets` lists the credentials that each successful request carried
  together, such as `["cookie:sid", "http:bearer"]`. Credentials in one set
  are all needed (AND); different sets are alternatives (OR). `auth.anonymous`
  is true when a request without any credential succeeded, so the credentials
  are optional; `list` then shows them with a `?` (`cookie?`).
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
every secret value of the capture (cookie values except preferences,
credentials, API keys, secret query, body and path values, and the password of
Basic credentials) and replaces that value, and its URL-, form-, JSON- and
HTML-encoded forms, wherever it appears in `api.json` and in every export,
also when the server echoes it in a response under another name. Values
shorter than 6 characters are not replaced by value. `cookies[].valueExample`
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
- A number inside a file name becomes an in-segment parameter
  (`/catalogue/page-{page}.html`) once two numbers are seen.

A parameter takes the name of the response field that holds its value
(`{slug}`, `{username}`). Otherwise it is named after the segment before it: an
id under a plural collection gets `Id` (`{itemId}`), a value under a singular
word or a unit takes the word itself (`{page}`, `{status}`, `{bytes}`).

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
media type), marks a JSON lines body, says where a redirect leads, and splits
the cookies the endpoint needs from the other cookies the browser sent. A form
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

Use `-o <file>` to choose the output file or `-o -` for stdout. If the file is
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
endpoint and its query parameters as `[name=]`. Give path values after the
endpoint name or number, for example `bash endpoints.sh getItem 2`, and query
values as `name=value` arguments, for example `bash endpoints.sh listItems
page=3`. If you do not give a value, the script uses the function's
`APPII_<NAME>` variable or the captured example; a query parameter that the
captured request did not send is sent only when you give it a value. The
script encodes each value for its position in the URL or JSON body. Arguments
that start with `-` go to curl; any other argument that no parameter takes
stops the script with an error before it sends a request. Every request uses
`--compressed`. `APPII_BASE_URL` sets the base URL and `APPII_COOKIE` sets the
Cookie header.

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
on which pages each one appears. The `har` export keeps textual request bodies,
multipart bodies included, as plain text with their parameters, and uses
base64 only for bytes that are not text.

For a subset of the endpoints, the `json` export keeps only the cookies and
forms of the selected endpoints, and `setBy` and `usedBy` name only selected
endpoints. The site data (`origins`, `source` and `websockets`) does not change.
The `har` export redacts secrets also in compressed request bodies. If appii
cannot read a body completely, for example a truncated JSON body, the HAR keeps
the size and the truncated mark but not the body text.

### All in one

```sh
appii run https://example.com
```

Captures, builds and lists in one step and writes `capture.json` and
`api.json` into `./appii-out`. Run `appii help <command>` for every option and
`appii --version` (or `appii -V`) for the version.
