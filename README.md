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

### build: infer the API

```sh
appii build capture.json
```

Writes `api.json`: endpoints with path templates, query and header parameters,
request and response schemas, auth cookies, bearer tokens, CSRF tokens and
where they come from, cookie roles, and the validation rules of the HTML forms
that submit to each endpoint.

### list: look at the endpoints

```sh
appii list api.json --show 3
```

Without options it prints the endpoint table. `--show <#|id|name>` prints one
endpoint in detail with an example curl command, `--cookies` prints the cookie
table, and `--filter`, `--method`, `--kind`, `--origin` and `--json` narrow or
change the output. `list` also accepts `capture.json` and HAR files directly.

### export: write a spec, client, script or report

```sh
appii export api.json --format openapi
```

Use `-o <file>` to choose the output file or `-o -` for stdout,
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

### All in one

```sh
appii run https://example.com
```

Captures, builds and lists in one step and writes `capture.json` and
`api.json` into `./appii-out`. Run `appii help <command>` for every option.
