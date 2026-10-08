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
discards the bodies of a page once it navigates away). A page script can
navigate faster than that, for example a script login that reads the JSON
answer, stores the token and moves to the next page at once. So the responses
to `fetch()` and `XMLHttpRequest` calls are held at their headers until appii
has asked the browser to stream their body to it (one round trip to the
browser, about 2 ms on a local machine), and the body then reaches the page and
appii together. Nothing is buffered: the page receives every chunk as it
arrives, an event stream (`text/event-stream`) and a response whose
`Content-Length` is above `--max-body` are let through without streaming, and
routes that a Playwright script sets still answer. The browser can report a held
response before it reports the request itself; appii then waits for the request
(at most 2 s, the response stays held) instead of letting the body through
unstreamed. Chromium reports that a `fetch()` response has finished only once
the page has read its body, and for a response that may not be stored
(`Cache-Control: no-store`) whose body the page never reads, it never does. So
appii does not wait for that report: the body has arrived once the bytes the
browser delivered reach the `Content-Length` (counted on the wire for a
compressed body), or, without a `Content-Length`, once Chromium delivered the
body in a single report and nothing followed for the idle time (Chromium reports
an unread body once, when the network has delivered all of it). Such a request
no longer keeps the network busy, so the capture moves on after the idle time
instead of after 30 s, and the recorded response has its full body and no
error, also when the page navigates away and the browser cancels the request. A
body that was cut off before all its bytes came is kept as a part and marked
truncated. Responses that a service
worker gives the page are not held and are read after they finish, so a page
that navigates away at once loses them. The first requests of a
new tab can start before appii's own browser session is attached to it; their
bodies are then read from the browser session that opened the tab, unless that
could make the browser send the request again (a compressed response with a
`Content-Length`), in which case the body is marked as not read. Page
snapshots record the values that page scripts put into form controls, but not
what was typed, checked or chosen by a trusted user action (yours, or
`--login`), so the model never takes a typed value, such as a login name, for
the default value of a field. `-o -` writes the capture to stdout and the
summary to stderr, so `appii capture ... -o - | jq` works.

Service workers are recorded too. A request that the page sends and its
service worker passes to the network (`fetch(event.request)`) is recorded once,
with the page URL and the headers, body and timing of the request that reached
the network; when the HTTP cache answers it, it is marked `servedBy: cache`. A
response that the worker makes itself is marked `servedBy: service-worker`. The
requests that the worker makes on its own, from its main script and the fetches
its script makes as it starts or during `install` to later ones, are recorded
as their own exchanges without a page URL. Playwright starts a new service
worker as soon as it attaches to it, before a session of appii could, so appii
has Playwright report the network of service workers itself: while a capture
runs, appii sets `PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS=1` in its own
process (and restores the previous value when the last capture in the process
ends), and Playwright then enables the network events of each worker before
the worker runs, so no request of the worker is missed. In a headless capture
the requests of a service worker carry the User-Agent of the page from the
first one on, because it is set on the worker before the worker runs. Two
things keep the headless identity: the main script, which Chromium fetches
itself, is sent with the `HeadlessChrome` User-Agent, and scripts in the worker
read the headless `navigator.userAgent`. A Blob or stream body that the worker
sends on its own is marked as not read (with its size), and the worker's own
requests that the HTTP cache answers are recorded like network requests.

#### Several URLs and logging in

```sh
appii capture https://example.com/ https://example.com/pricing https://example.com/docs --headless
```

opens the URLs in order in the same tab and waits until the network is idle
after each one, the first one included, so a login form that a script renders
after a fetch is recorded, and the requests the page still has in flight
finish, before the next URL opens. With a window, appii opens them in order and
then leaves the window to you.

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
request at all. When the browser's form validation refused the submission (a
`type=email` field without `@`, a `required` field left empty, a `pattern` or
`minlength` that the value does not meet), the browser fires an `invalid`
event at each field it refused and sends nothing; appii records those events
and names each field with the browser's own message, with the value hidden, and
the summary says the form was not submitted:

```
warning: the browser did not submit the login form: its form validation refused user[email] ("Please include an '@' in the email address. '<hidden>' is missing an '@'.")
Login: filled the form on https://example.com/signin (user[email], user[password]) and tried to submit it by clicking its submit button;
       not submitted: the browser's form validation refused user[email]; now on https://example.com/signin
```

A form with `novalidate`, or a submit button with `formnovalidate`, is not
validated, as in a browser. When no form has all the names, the capture stops
with an error that lists the forms of the page and the names of their
controls.

#### Probing the login form without an account

```sh
appii capture https://example.com/login --headless --probe-login -o anon.json
```

A login form whose `action` is the page itself and that a script sends (a
`fetch()` of JSON to `/api/auth/login`, for example) shows nothing about its
endpoint until it is submitted. `--probe-login` submits it without an account
and without letting anything reach the server: after the first URL has loaded
and the network is idle, appii looks for the login form (a form with exactly
one password field whose `autocomplete` is not `new-password`; a sign-up or
change-password form has two, or a new password), waiting for it up to
`--read-timeout`. It then stops every request the page starts, in the page, in
its frames (also those in another process) and in its service workers, at the
request stage of the DevTools Fetch domain, before anything leaves the
browser. It fills the user name field (`autocomplete` `username` or `email`, a
`type=email` field, or the one text field before the password) and the password
with placeholder values (`appii-probe-user`, `appii-probe@example.invalid`,
`appii-probe-password`, padded or cut to `minlength` and `maxlength`), checks
required checkboxes and fills other required fields, and submits the form like
`--login` does. Each request the page then tries to send is recorded with
source `probe` and no response; appii fails it in the browser, opens a blank
page so that the probed page cannot send anything later, stops intercepting
and opens the first URL again, so the rest of the capture is not affected. The
model takes from a probe only the method, URL and body shape of the request and
the form that sent it: it never counts as a hit, a sample, a credential or an
example, and the placeholder values never reach the model. A login request
that the page sends only after another request it makes first (a CSRF token
fetch, for example) is not seen, because that first request is stopped too.

```
Probed: POST /api/auth/login (stopped in the browser while probing the login form; not sent)

Probe:  filled the login form on https://example.com/login (username, password) with placeholder values and clicked
        its submit button; the page tried to send POST /api/auth/login; appii stopped it in the browser, so nothing
        reached the server; opened https://example.com/login again
```

When the page has no login form, appii warns and records the capture without
probing. `--probe-login` cannot be combined with `--login`. `appii run` takes
it too.

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
`--no-documents` keeps it. A sign-out navigation is an action too: a link such
as `GET /logout` that gets the logout role (see Credentials) stays with
`--no-documents`, so the model keeps the logout, its name (`getLogout`) and the
cookies it revokes (`revokedBy`). A GET form that was never submitted becomes an
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
token, even though nobody submitted it. For a login form that a script sends,
record the anonymous capture with `--probe-login` (see above). `appii build` with several captures or
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
file, start URL, time span and number of requests. The number of requests
counts the recorded requests only, like `source.exchanges`: a request that
`--probe-login` stopped in the browser is not one (the capture summary lists it
under `Probed`), so the numbers in `Built from` add up to `Requests`. An input whose requests all
come from an input given before it (the same file given twice, or a copy of
it) adds nothing, so it is listed once, in `source.captures` and in `Built
from`, and appii says so on stderr:

```
note: anon.json was given more than once; it is used once
note: copy.json holds the same requests as anon.json; it is used once
```

When only one input remains, the model names it in `source.file`, as if it was
given once. `-o` must not name one of the inputs.

`appii run` takes `--with <file>` (repeatable) to do the same in one step: it
records, then builds `api.json` from the earlier captures and the new one.

The captures are the source of the model, so to update a model, build it again
from its captures plus the new ones. Given an `api.json`, `appii build` stops
with an error that names the captures the model was made from (`source.file`
or `source.captures`) and the command that does that:

```
error: api.json is an API model (api.json), not a capture or HAR file; to update a model, build it again from the captures it was made from (anon.json) plus the new ones
Did you mean:
  appii build anon.json authed.json
```

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
  a redirect goes to the login page when the page it led to (the request the
  browser made for it, and the snapshots of that page taken before it loaded
  again) showed a login form, or when its path names a sign-in
  (`/login`, `/users/sign_in`); a page that showed the login form only while
  logged out, such as a single-page app route that renders the login form
  until the user logs in, does not make a later logged-in visit, or the login
  that redirects to it, a refusal;
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
- When such an endpoint was refused without credentials and never requested
  logged in, while a login of the model issued a credential that the browser
  would send to it (a cookie in `login.issues.cookies` whose domain, path and
  `Secure` flag match its URL, or, for a request that a script made to the
  origin of the login, the bearer token in `login.issues.tokens`), appii
  predicts that credential: `auth.sets` holds it, `auth.predicted` is `true`,
  `auth.anonymous` stays `refused` and `auth.seen` stays `anonymous`. A page
  load never carries a bearer token that a script holds, so a page gets no
  bearer prediction. When the logins issue different credentials for the
  endpoint, the evidence is ambiguous and nothing is predicted. `list` marks
  the label with `*` (`cookie*`), `--show` says `probably cookie session
  (issued by #4 POST /login; not observed on this endpoint)`, the Markdown,
  HTML and Postman descriptions say the same with `issued by the login`, the
  HTML badge is `auth*`, and the OpenAPI operation requires that credential in
  its `security`, has `x-appii-predicted: true` and says in its description
  `Credential: probably cookie session (issued by postLogin (POST /login); not
  observed on this endpoint).`
  The credentials of an endpoint known only from a form (see below) are
  predicted too and carry `auth.predicted: true`.
- A session or auth cookie (by name) is a credential when the value that was
  sent came from a login: a response to a request with a password field, an
  `Authorization` header or an OAuth callback code set it, or a response to a
  request that already carried a logged-in value set it (except a sign-out).
  A value that a page load, a sign-out or any other response set is an
  anonymous session, so an endpoint called with it is public. A value that
  was never set in the capture (a preloaded session) counts as a login.
- A cookie whose name says nothing about its role (`ledger_sid`,
  `wordpress_logged_in_<hash>`, `SSESS<hash>`,
  `.AspNetCore.Identity.Application`) becomes a session cookie
  (`role: session`) by what the login and the server do with it: a credential
  submission that was not refused (a password field, an OAuth callback code,
  or an `Authorization` header that later requests do not send again) set it
  to a new value, a later request sent that value, and the server kept it
  (its answer did not replace it). Without a recorded login, a request refused
  with one value and accepted with another (same method and path) is enough
  when that cookie is the only one that differs between the two requests. The
  login then issues the cookie (`login.issues`, `issuedBy`), the logout
  revokes it (`revokedBy`), its value is redacted, and endpoints called with
  it count as seen logged in. A cookie that the server sends again with a new
  value in every answer (a load balancer cookie), a cookie that a failed login
  set, a cookie that only a page script made, and a cookie whose name says
  CSRF, analytics or preference never become credentials this way.
- A cookie whose value the page created with `document.cookie`, that the
  server never set, that is not HttpOnly and that no response ever contained
  is an analytics id, not a session (`role: tracking`). Analytics, preference
  and other cookies are never credentials, unless the same endpoint answered
  401, 403 or a redirect to the login page without them and the server kept
  their values.
- `Authorization: Basic ...` maps to the OpenAPI `http`/`basic` scheme, and
  the example gives curl the user name and password from `APPII_USERNAME`
  and `APPII_PASSWORD` as its `user` option in a config on a file descriptor
  (`-K <(...)`), not as `-u` on the command line. Other schemes keep their
  name (`http`/`bearer`, `http`/`digest`).

`auth.cookies` still lists every cookie that the browser sent. The example
request sends only the credential cookies and the cookies that a CSRF token
depends on (`csrfToken.sessionCookies`, or the cookie a double-submit token
comes from).

For an endpoint known only from a form, appii has no request to read the
credentials from. It takes the cookies the browser held when it showed the
form: the cookies of the last request to that origin before the page snapshot
(or the page load), updated by the `Set-Cookie` headers of the responses that
came in before the snapshot, with the cookie rules of RFC 6265bis for the
form target. So a sign-up form seen before logging in needs no credential
even when the capture ends logged in, and a profile form seen only after
logging in needs the session even when a logout deleted it later.
`auth.anonymous` stays `untested`.

The source of a CSRF token (`auth.csrf[].source`) is what the server sent:
appii looks for the token value first in a cookie the request carried, then
in a meta tag or hidden field of the HTML that the server returned, then in a
JSON field or header of an earlier response (`response`, with `sourceUrl`,
`sourceMethod` and the field name in `sourceName`; GET responses first), and
only then in a meta tag or hidden field that exists only in the page snapshot.
A login form that a script renders with the token it fetched from
`/api/csrf` therefore names `GET /api/csrf` and its `csrfToken` field, which
the TypeScript client, the `curl` script and Postman fetch before they log in.
`sessionCookies` names the cookies the token is bound to: the cookies that
the request with the token sent with the same value that the token's source
response set, or that the source request sent and the server kept, whatever
their names (a session cookie with a name that says nothing, such as `tbk`,
included), and the logged-in credential cookies the request sent. Analytics and
preference cookies are never bound. `list --show` shows them under `BOUND TO`
and its example request sends them with `-b`.

The login role goes to an endpoint that accepts the password field of the
login form (in its query or request body) or that received a credential
submission. The page load of a form without an action, which a script
submits, is never the login; when no request of the form was recorded,
`list` names the form instead (see list). A page such as `/logout` that only
starts a sign-out request is a page, not the logout: the logout is the request
that revoked the credential.

When a script of the form, not the form itself, sent the request, the
endpoint has `form.submittedBy: script` and its request body keeps the type
that the script sent (such as `application/json`). That is a `fetch` or
`XMLHttpRequest` from the page of the form that carries every field the form
always submits (an unchecked checkbox or radio button and a multiple select
with nothing selected may be missing, as in the form data set of the HTML
standard): for a form without an `action`, a request to whatever URL the
script chose; for a form with an `action`, a request to that action with the
form's method while no navigation submitted the form, such as
`fetch(form.action, { method: 'POST', body: new FormData(form) })`. When the
script sent the fields as form data (`multipart/form-data`,
`application/x-www-form-urlencoded` or `text/plain`), they are the form's own
entries, so the request body keeps the field rules of the form (types,
`required`, lengths, patterns, select options and defaults) in the type that
was sent; a JSON body, which the script built itself, gets only the labels and
HTML hints of the form fields. The form's own `action`, `method`
and `enctype` stay in `form` as facts about the form, but they are not how the
endpoint is called.

A request that appii stopped while it probed a login form with placeholder
values (an exchange with `source: probe`, which has no response because it
never left the browser) only gives the endpoint its method, URL, request body
shape and content type, and links the form (`submittedBy: script` when a
script sent it). It is never a hit, a sample, an example, a credential
submission, a secret, or evidence of anonymous or logged-in access, and its
placeholder values appear nowhere. So an anonymous capture of a script login
already has the login endpoint: 0 hits, `login.evidence: form` and
`auth.anonymous: untested`, until a real login is recorded.

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

The user name of a login is personal data: the identifier field of a login
form or login request (`username`, `email` or the field that `autocomplete`
names) is redacted in examples, schemas and form descriptors, and its value is
replaced wherever it appears, unless `--no-redact` is given. When the user
name is an e-mail address, sites often show its local part as the account
name (`appii-test` for `appii-test@example.com`). If a response to a logged-in
request returns that local part (at least 3 characters) as a whole JSON string
or as a whole HTML text node, it is personal data too, and appii replaces it
where it is a whole value: a JSON string, a text node, a URL path segment or a
query value equal to it. The same holds for a user name that is too short to
be replaced by value (3 to 5 characters, such as `nora`): when a logged-in
response returns it as a whole JSON string or text node, it is replaced where
it is a whole value. Text that merely contains it (`Hello appii-test`,
`appii-test-notes`, `Ask nora about the plan`) is kept, so no other content is
replaced.

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

Below the table, `list` names the login and the logout and the endpoints that
appeared only after the login:

```text
Login:       #4 POST /login with username and password, issues cookie session
Logout:      #5 GET /logout, revokes cookie session
After login: 2,5-7 (seen only with a logged-in credential); 3 (found only on pages loaded while logged in; no request observed)
```

An endpoint known only from a form (0 hits) is listed under `After login` when
every page the form was found on loads only while logged in: the model has
requests for that page, and they were all seen logged in or refused without
credentials, such as a change-password form on `/account`. `--show` then says
`Seen: not observed; its form was found only on pages loaded while logged in`.

A login known only from a form says `known from a form; not submitted yet`.
A login form whose request was not recorded, such as a form without an action
that a script submits, has no login endpoint yet; `list` names the form and the
two ways to record its request, without an account (`--probe-login`) or with
one (`--login`):

```text
Login form:   on /login (username, password) has no action, so a script probably sends it; record its request without an account with appii capture https://example.com/login --headless --probe-login, or log in with --login
```
The `AUTH` column marks the rows `login` and `logout`. A credential label that
ends in `?` means that the endpoint also answered a request without that
credential (`auth.anonymous` is `allowed`), a label that ends in `~` means that
every request seen carried it, so anonymous access was not tested (`untested`),
a label that ends in `*` means that requests without it were refused and that
the credential is predicted from what the login issues (`auth.predicted`, see
Credentials), and a label without a mark means that requests without it were
refused (`refused`). A refusal can be a 401, a 403 or a redirect to the login page
(`302?` when no credential was captured). `--show` prints the role, the login
fields and what the login issues, `Anonymous: allowed | refused | not tested`
and `Seen: anonymous, authenticated`. Its CSRF table has a `BOUND TO` column
with the cookies each token belongs to (`sessionCookies`). For a login, and for
an endpoint whose CSRF token comes from another request (a hidden field, a
meta tag or a JSON response), `--show` adds `Session steps`: which request
gives the token, which cookie it goes with, and the two commands that do the
steps with a cookie jar, because the single example command cannot fetch the
token itself:

```text
appii export api.json --format curl -o endpoints.sh
bash endpoints.sh postLogin username=VALUE password=VALUE
```

`--cookies` adds a `Login and logout:` block that says which login issues each
credential cookie (`issuedBy`) and which logout revokes it (`revokedBy`).

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
`options vary by page state` with the options seen. Its `Form source` block
names the page, the form and its fields. The form selector has one CSS
selector per tree scope: when the form is inside an open shadow root, ` >> `
separates the selector of the shadow host from the selector inside its shadow
root (`:root > body:nth-child(2) > tb-app:nth-child(2) >> form:nth-child(2)`),
and a `Notation:` line says so. Playwright reads such a selector as is; in the
DOM, run each part with `querySelector` on the shadow root of the element the
part before it found. For a request that a script of the
form sent (`submittedBy: script`) it says `Sent by: a script of the form, not
the form itself` and `Sent as:` the type the script sent, instead of the
form's own enctype and submit buttons.

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
(default: the captured file name in the current directory); when the function
cannot read that file it stops with exit code 2 and names the variable before
it sends anything. Sourcing the script defines the functions without changing
the options of your shell.

No credential value is an argument of curl or of another process that the
script starts. A function writes a request body and the headers that can hold
a password, a token or another credential with shell builtins into a file
descriptor that curl reads (`--data-binary @<(...)`, `-H @<(...)`), so the
value is not in a process list. The cookie value in `APPII_COOKIE` and the
HTTP Basic user name and password go to curl the same way, as the `cookie`
and `user` options of a curl config on a file descriptor
(`-K <(appii_config cookie "$APPII_COOKIE")`); `appii_config` escapes `\`,
`"` and line breaks for the config syntax. The cookies of the jar are read
from its file. The one-command examples of `list --show`, Markdown and HTML
send their cookies as a `Cookie` line of the `-H @<(...)` header file. Give
the password in its variable rather than as an argument
(`bash endpoints.sh postLogin password=...` puts it on the command line of
bash); `read -rs` reads it without showing it and keeps it out of the shell
history.

The script keeps a cookie jar like a browser: every function reads and writes
the file in `APPII_COOKIE_JAR` (default: `<api name>-cookies.txt` in the
current directory), and a function whose request needs a CSRF token first
loads the page that holds the token into the same jar and reads the token from
it. So the login function and then any function that needs the login work in
the same shell without copying a cookie or a token:

```sh
source endpoints.sh
read -rs APPII_PASSWORD && export APPII_PASSWORD
postLogin username=me
getAccount
```

The login identifier and the password have no default value: give them in
`APPII_USERNAME` and `APPII_PASSWORD` (the variable names come from the field
names) or as arguments, or the function stops with a message that names the
variable. A token that only JavaScript puts into the page cannot be read from
the HTML; the function then prints a warning that names the URL it requested
(under `APPII_BASE_URL` when you set it) and the variable to set.

A login that answers with a bearer token in its JSON body
(`login.issues.tokens`, a field path such as `accessToken` or
`data.session.token`) saves the token in the file `APPII_TOKEN_FILE` (default:
`<api name>-token.txt` next to the cookie jar, readable only by you). A
function that sends a bearer token takes it from `APPII_ACCESS_TOKEN` or, when
that is empty, from the token file, so the login function and a protected
function work in the same shell like the cookie jar does:

```sh
source endpoints.sh
read -rs APPII_PASSWORD && export APPII_PASSWORD
postAuthLogin username=me
getProfile
```

The script never sends an empty `Authorization: Bearer` header. Without a
token, a function whose endpoint refused every anonymous request stops with
`getProfile: no bearer token: run postAuthLogin first or set
APPII_ACCESS_TOKEN.` and sends nothing; a function whose anonymous access was
not tested warns and sends the request without the header; one whose
anonymous access is allowed sends it without the header. An `Authorization`
header given as a curl argument (`-H`) is sent instead of the token. A login
response without the token leaves the token file as it was and says so, and
the logout function deletes the token file after its request.

The login function lets curl write the response into a file of its own and
reads the token from there, so it saves the token whatever output arguments
you add: with `-o FILE` (also `--output FILE`, `-oFILE`, `-so FILE` or
`-o -`) it then writes the response where they say, and when it cannot write
that file it says so, keeps the token and returns 23 as curl would. The curl
options that choose the output file themselves (`-O`, `--remote-name`,
`--remote-name-all`, `-J`, `--remote-header-name`, `--output-dir`) stop the
login function with exit code 2 before it sends anything.

The `typescript` client fills CSRF tokens from the pages and responses that
the site uses. It keeps a page while the cookies for that page stay the same.
If the page that should hold a CSRF token has none (for example a hidden
field that only a script adds) and the server rejects the request with a 4xx
status, the client throws `MissingTokenError`, which names the token, the page
it loaded and the field it looked for (`missing[].expected`), as the curl
script warns in the same case.
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
cookies, bearer token or Basic credentials an endpoint needs. The comment of
a logout says only what the model shows: that the cookie jar takes the new
cookies when the logout revokes a cookie (`revokedBy`), and that the client
forgets the bearer token only when a login returns one
(`login.issues.tokens`).

After `client.<login>(...)` the client's cookie jar holds the cookies that the
login issued, and a JSON token that the login returns (`login.issues.tokens`)
is sent as the bearer token of later calls, so the calls after the login are
logged in. The login identifier and password have no default values.

In OpenAPI, the login operation has `security: []` and `x-appii-role: login`
(the logout has `x-appii-role: logout`), and the description of each
credential security scheme names the operations that set the cookie, the
login operation that issues it and the logout operation that revokes it, each
by its operationId and its method and path, for example `Session cookie
session (HttpOnly), set by getLoginPage (GET /login), postLogin (POST /login),
getLogout (GET /logout).` An operation whose anonymous access was not tested
lists `{}` as an alternative to its credentials and says so.

An export of a subset that leaves out the login (or the logout) names it by
method and path and says how to add it, in every format, instead of linking
an endpoint that is not there: `Log in first with POST /login (not in this
export; add it with --endpoints postLogin).` In OpenAPI the security scheme
says `The login operation POST /login (not in this export; add it with
--endpoints postLogin) issues it.` An export of all endpoints links the login
as before.

Postman orders the collection for a Collection Runner run: the folder of the
login comes first (after the folder of the page that holds its CSRF token,
when that is another folder), the requests that need the login come next,
and the logout requests come last, in the folder `logout`. In its folder the
login comes right after the page that holds its CSRF token, and a test script
on that page stores the token in the variable that the login request sends. A
login that returns a bearer token has a test script that stores it in
`{{access_token}}`, the variable the bearer requests send. The collection
description names the login request and its folder, the variables without a
default that you set first (the user name and the password), the variables
that the test scripts fill, and the order.

The summary of the Markdown and HTML reports has a `Login` row and a `Logout`
row that link the endpoint and say what it sends and issues or revokes
(`Login | #3 POST /login: sends the user name in username and the password in
password, and issues the cookie session.`); the endpoint details say the same
after `Role: Login:` or `Role: Logout:`.

The Markdown and HTML reports name the session cookie a CSRF token is bound to
(`csrfToken.sessionCookies`: the token is only valid with the cookie that the
same response set). Their example request is one curl command for bash or
zsh (it uses process substitution). It stops before it sends anything when
the CSRF token, a cookie the token is bound to, the user name or the password
is not set, with a message that names where the value comes from and the curl
function that gets it, so it never sends an empty token. A form field or a
header whose value comes from a variable reaches curl through a file
descriptor, not as an argument:

```sh
: "${APPII_CSRF_TOKEN:?the hidden field csrf_token of GET https://quotes.toscrape.com/login; bash endpoints.sh postLogin fetches it}" "${APPII_USERNAME:?}" "${APPII_PASSWORD:?}" && curl -sS -X POST 'https://quotes.toscrape.com/login' \
  -H 'Content-Type: application/x-www-form-urlencoded' \
  -b "session=${APPII_SESSION:?the session cookie of GET https://quotes.toscrape.com/login that csrf_token is bound to; bash endpoints.sh postLogin keeps it}" \
  --data-urlencode 'csrf_token@'<(printf '%s' "${APPII_CSRF_TOKEN}") \
  --data-urlencode 'username@'<(printf '%s' "${APPII_USERNAME}") \
  --data-urlencode 'password@'<(printf '%s' "${APPII_PASSWORD}") \
  --compressed
```

The example in `list --show` stops the same way with the shell's own message
(`${APPII_CSRF_TOKEN:?}`), because it folds the command to the terminal width.
Site text in the message is percent-encoded where the shell would read it.

A cookie that no CSRF token is bound to is optional in the examples: it is
sent only when its variable is set, and the Cookie header holds exactly the
pairs that are set (no header when none is), for example
`-b "${APPII_SESSION:+session=$APPII_SESSION}${APPII_THEME:+${APPII_SESSION:+; }theme=$APPII_THEME}"`.
A bearer token is sent the same way only when `APPII_ACCESS_TOKEN` is set:
`-H @<(printf '%s\n' "${APPII_ACCESS_TOKEN:+authorization: Bearer $APPII_ACCESS_TOKEN}")`.

A value that goes into a JSON body is escaped for JSON (backslash, double
quote, and control characters as `\u00XX`) by the same `appii_json` encoder
that the curl export uses, so a password with a quote or a backslash arrives
as the same string. The example then sends the body from a process
substitution that defines the encoder, and the checks for the values in that
body come first, so an unset value stops the command before curl runs
(encoder shortened here):

```sh
: "${APPII_USERNAME:?}" "${APPII_PASSWORD:?}" && curl -sS -X POST 'https://example.com/api/auth/login' \
  -H 'Content-Type: application/json' \
  --data-binary @<(appii_json() { ...; }; printf -- '{"username":"'; appii_json APPII_USERNAME; printf -- '","password":"'; appii_json APPII_PASSWORD; printf -- '"}') \
  --compressed
```
For a login, and for an endpoint whose CSRF token comes from a page, a
`Session steps` paragraph says how to get the token and gives the curl export
commands that do it with a cookie jar, with the name of the curl function. The
password is read into its variable, not given as an argument:

```sh
appii export api.json --format curl -o endpoints.sh
read -rs APPII_PASSWORD && export APPII_PASSWORD
bash endpoints.sh postLogin username=VALUE
```

An endpoint that a script of a form sends (`form.submittedBy: "script"`, for
example a login form whose script posts JSON) is described as sent by a
script of that form, with the content type of the request that was observed:
`Sent by a script of the form form#login on https://example.com/login as
application/json.` OpenAPI `x-appii-form` then has `submittedBy: "script"`
instead of the form's `enctype`, and no export describes the form's own
action, method, enctype or charset as the request. The examples, the curl
script, the TypeScript client and the `har` export encode the body as the
script sent it (UTF-8, the observed type), not as the form would.

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
and builds the same credentials. The `har` export finds the values to hide
with the same credential input that `build` uses (the password, login page,
login identifier and personal fields of the forms), so a login identifier
that a response echoes, such as `"login":"mara.k"`, is `<redacted>` in the
HAR as it is in the model.

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
