import type { BodyKind, BodyShape, Endpoint, EndpointForm, EndpointSample, FormEnctype, FormField, FormMethod, JsonSchema, ParamInfo } from '../model/index.js';
import { CharsetEncoder } from './charset.js';
import { Credentials } from './credentials.js';
import { EndpointIndex } from './endpoints.js';
import { mimeEssence, parseUrl } from './http.js';
import { isPlainObject, setOwn } from './json.js';
import { SampleText } from './sample-text.js';
import type { SampleTextInput } from './sample-text.js';
import { isFileSchema, items, primaryType, properties, resolveConditions, sampleValue } from './schema.js';

export const REDACTED = '<redacted>';
export const SECRET_NAME = 'secret';
export const BEARER_TOKEN = 'access_token';
export const BEARER_SCHEME = 'Bearer';
export const AUTHORIZATION_HEADER = 'Authorization';
export const BASIC_SCHEME = 'basic';
export const BASIC_USER = 'username';
export const BASIC_PASSWORD = 'password';
export const CONTENT_TYPE_HEADER = 'Content-Type';
export const COOKIE_SEPARATOR = '; ';
export const IMAGE_SUBMITTER = 'image';
export const IMAGE_COORDINATES: readonly string[] = Object.freeze(['x', 'y']);
export const IMAGE_COORDINATE_VALUE = '0';
export const BODYLESS_METHODS: readonly string[] = Object.freeze(['GET', 'HEAD']);
export const JSON_MIME = 'application/json';
export const BINARY_MIME = 'application/octet-stream';
export const TEXT_PLAIN = 'text/plain';
export const CRLF = '\r\n';
export const LINE_FEED = '\n';
export const SUCCESS_MIN = 200;
export const SUCCESS_MAX = 299;
export const NEWLINE_SOURCE = '\r\n|\r|\n';
export const FORM_BODY_KINDS: readonly BodyKind[] = Object.freeze<BodyKind[]>(['form', 'multipart', 'text']);
export const REDACTED_KEY: RegExp = /([A-Za-z0-9_.\-[\]]+)=$/;
export const REPEAT_SEPARATOR = '_';

export interface SampleEntry {
  readonly name: string;
  readonly value: SampleText;
}

export interface SampleRecord {
  readonly [key: string]: SampleValue;
}

export type SampleValue = SampleText | number | boolean | null | readonly SampleValue[] | SampleRecord;

export interface SampleBody {
  readonly kind: BodyKind;
  readonly mimeType: string;
  readonly value: SampleValue | undefined;
  readonly charset?: string;
}

export interface RequestSample {
  readonly method: string;
  readonly url: SampleText;
  readonly base: SampleText;
  readonly path: SampleText;
  readonly pathParams: readonly SampleEntry[];
  readonly query: readonly SampleEntry[];
  readonly headers: readonly SampleEntry[];
  readonly body?: SampleBody;
  readonly cookie?: SampleText;
  readonly user?: SampleText;
}

export interface FormEntry {
  readonly name: string;
  readonly value: SampleText;
  readonly file: boolean;
  readonly contentType?: SampleText;
}

export interface SampleOptions {
  baseUrl?: SampleTextInput;
  requiredOnly?: boolean;
  cookie?: SampleText | false;
  pathVariables?: boolean;
}

export interface JsonTextOptions {
  indent?: number;
  escape?: (content: string) => string;
}

export interface FormSubmission {
  readonly form: EndpointForm;
  readonly submitter?: FormField;
  readonly method: FormMethod;
  readonly action: URL;
  readonly enctype: FormEnctype;
}

export function placeholder(name: string): SampleText {
  return SampleText.placeholder(name);
}

export function isRedacted(value: unknown): boolean {
  return typeof value === 'string' && value.includes(REDACTED);
}

export function isRecord(value: unknown): value is SampleRecord {
  return isPlainObject(value);
}

export function redactedText(value: string, key = ''): SampleText {
  const fallback = key || SECRET_NAME;
  if (value === REDACTED) return placeholder(fallback);
  const pieces = value.split(REDACTED);
  const used = new Map<string, number>();
  const parts: SampleTextInput[] = [];
  pieces.forEach((piece, i) => {
    if (i > 0) {
      const name = SampleText.placeholderName(REDACTED_KEY.exec(pieces[i - 1] ?? '')?.[1] ?? fallback);
      const seen = (used.get(name) ?? 0) + 1;
      used.set(name, seen);
      parts.push(placeholder(seen === 1 ? name : `${name}${REPEAT_SEPARATOR}${seen}`));
    }
    parts.push(piece);
  });
  return SampleText.concat(...parts);
}

export function capturedText(value: string, key = ''): SampleText {
  return isRedacted(value) ? redactedText(value, key) : SampleText.literal(value);
}

export function capturedValue(value: unknown, key = ''): SampleValue {
  if (value instanceof SampleText) return value;
  if (typeof value === 'string') return capturedText(value, key);
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) return value.map((item: unknown) => (item === undefined ? null : capturedValue(item, key)));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .map(([name, item]) => [name, capturedValue(item, name)]),
    );
  }
  return SampleText.literal(JSON.stringify(value) ?? String(value));
}

export function bodySample(shape: BodyShape | undefined): SampleValue | undefined {
  if (!shape || shape.kind === 'empty') return undefined;
  if (shape.jsonLines === true) return jsonLinesSample(shape);
  const example = shape.examples[0];
  if (example !== undefined) return capturedValue(example);
  if (!shape.schema) return undefined;
  return capturedValue(sampleValue(shape.schema));
}

export function jsonLinesSample(shape: BodyShape): SampleText | undefined {
  const items = shape.examples.length > 0 ? shape.examples : shape.schema ? [sampleValue(shape.schema)] : [];
  if (items.length === 0) return undefined;
  return SampleText.concat(...items.flatMap((item) => [jsonText(capturedValue(item)), LINE_FEED]));
}

export function emptyFile(): SampleRecord {
  return { filename: SampleText.literal(''), contentType: SampleText.literal(BINARY_MIME), size: 0 };
}

export function crlf(text: string): string {
  return text.replace(new RegExp(NEWLINE_SOURCE, 'g'), CRLF);
}

export function normalizeNewlines(value: SampleValue | undefined): SampleValue | undefined {
  if (value instanceof SampleText) return value.mapLiterals(crlf);
  if (Array.isArray(value)) return value.map((item: SampleValue) => normalizeNewlines(item) ?? null);
  if (isRecord(value) && !isFileValue(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [crlf(name), normalizeNewlines(item) ?? null]));
  return value;
}

export function textPlain(value: SampleValue | undefined): SampleText {
  return SampleText.concat(...formEntries(value).flatMap((entry) => [entry.name, '=', entry.value, CRLF]));
}

export function parseTextPlain(text: string): Record<string, string | string[]> | undefined {
  if (!text.endsWith(CRLF)) return undefined;
  const out = new Map<string, string[]>();
  for (const line of text.slice(0, -CRLF.length).split(CRLF)) {
    const eq = line.indexOf('=');
    if (eq < 0) return undefined;
    const name = line.slice(0, eq);
    out.set(name, [...(out.get(name) ?? []), line.slice(eq + 1)]);
  }
  return Object.fromEntries([...out].map(([name, values]) => [name, values.length === 1 ? (values[0] ?? '') : values]));
}

export function submittedExample(shape: BodyShape, submission: FormSubmission): unknown {
  const fields = (example: unknown): unknown => (typeof example === 'string' && submission.enctype === TEXT_PLAIN ? parseTextPlain(example) : example);
  const chosen = submission.submitter ? submitterEntries(submission.submitter) : [];
  const sent = (record: unknown, name: string, value: string): boolean => {
    if (!isPlainObject(record) || !Object.hasOwn(record, name)) return false;
    const item = record[name];
    return item === value || (Array.isArray(item) && item.includes(value));
  };
  if (chosen.length > 0) {
    const match = shape.examples.find((example) => chosen.every(([name, value]) => sent(fields(example), name, value)));
    if (match !== undefined) return match;
  }
  return shape.examples[0];
}

export function formSample(shape: BodyShape, submission: FormSubmission): SampleValue | undefined {
  const example = submittedExample(shape, submission);
  if (typeof example === 'string' && submission.enctype === TEXT_PLAIN) return capturedValue(parseTextPlain(example) ?? example);
  if (example !== undefined) return capturedValue(example);
  if (!shape.schema) return undefined;
  const submitter = submission.submitter ? Object.fromEntries(submitterEntries(submission.submitter)) : {};
  const schema = resolveConditions(shape.schema, submitter) ?? shape.schema;
  const value = sampleValue(schema, '', { missing: (name) => placeholder(name) });
  return capturedValue(shape.kind === 'multipart' ? withEmptyFiles(value, schema) : value);
}

function withEmptyFiles(value: unknown, schema: JsonSchema): unknown {
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = { ...value };
  for (const [name, property] of Object.entries(properties(schema))) {
    if (!Object.hasOwn(out, name)) continue;
    const list = primaryType(property) === 'array';
    if (!isFileSchema(list ? items(property) : property)) continue;
    setOwn(out, name, list ? [emptyFile()] : emptyFile());
  }
  return out;
}

export function plainValue(value: SampleValue | undefined): unknown {
  if (value instanceof SampleText) return value.toString();
  if (Array.isArray(value)) return value.map((item: SampleValue) => plainValue(item));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, plainValue(item)]));
  return value;
}

export function jsonText(value: SampleValue | undefined, options: JsonTextOptions = {}): SampleText {
  const pad = ' '.repeat(Math.max(0, Math.floor(options.indent ?? 0)));
  const escape = options.escape ?? ((content: string): string => content);
  const quoted = (text: SampleText): SampleText => SampleText.concat('"', text.mapLiterals((literal) => escape(JSON.stringify(literal).slice(1, -1))).encoded('json'), '"');
  const write = (node: SampleValue | undefined, depth: number): SampleText => {
    if (node instanceof SampleText) return quoted(node);
    if (node === null || node === undefined) return SampleText.literal('null');
    if (typeof node === 'number') return SampleText.literal(JSON.stringify(node));
    if (typeof node === 'boolean') return SampleText.literal(String(node));
    const inner = pad === '' ? '' : '\n' + pad.repeat(depth + 1);
    const outer = pad === '' ? '' : '\n' + pad.repeat(depth);
    if (Array.isArray(node)) {
      const items = node.map((item: SampleValue) => write(item, depth + 1));
      return items.length === 0 ? SampleText.literal('[]') : SampleText.concat('[', inner, SampleText.join(items, ',' + inner), outer, ']');
    }
    const record = node as SampleRecord;
    const members = Object.entries(record).map(([name, item]) => SampleText.concat(quoted(SampleText.literal(name)), pad === '' ? ':' : ': ', write(item, depth + 1)));
    return members.length === 0 ? SampleText.literal('{}') : SampleText.concat('{', inner, SampleText.join(members, ',' + inner), outer, '}');
  };
  return write(value, 0);
}

export function textValue(value: SampleValue | undefined): SampleText {
  if (value instanceof SampleText) return value;
  if (value === null || value === undefined) return SampleText.literal('');
  if (typeof value === 'number' || typeof value === 'boolean') return SampleText.literal(String(value));
  return jsonText(value);
}

export function isFileValue(value: SampleValue | undefined): value is SampleRecord & { readonly filename: SampleText } {
  return isRecord(value) && value.filename instanceof SampleText;
}

export function formEntries(value: SampleValue | undefined): FormEntry[] {
  if (!isRecord(value)) return [];
  const out: FormEntry[] = [];
  for (const [name, item] of Object.entries(value)) {
    for (const each of Array.isArray(item) ? (item as readonly SampleValue[]) : [item]) {
      if (!isFileValue(each)) out.push({ name, value: textValue(each), file: false });
      else if (each.contentType instanceof SampleText) out.push({ name, value: each.filename, file: true, contentType: each.contentType });
      else out.push({ name, value: each.filename, file: true });
    }
  }
  return out;
}

export function placeholderNames(sample: RequestSample, extra: readonly SampleText[] = []): string[] {
  const names = new Set<string>();
  const texts = [sample.url, ...sample.headers.map((header) => header.value), ...(sample.cookie ? [sample.cookie] : []), ...(sample.user ? [sample.user] : []), ...extra];
  if (sample.body) texts.push(jsonText(sample.body.value));
  for (const text of texts) for (const name of text.placeholders()) names.add(name);
  return [...names].sort();
}

export function renamePlaceholders(sample: RequestSample, rename: (name: string) => string): RequestSample {
  const text = (value: SampleText): SampleText => value.map((name) => placeholder(rename(name)));
  const entry = (item: SampleEntry): SampleEntry => ({ name: item.name, value: text(item.value) });
  const out: RequestSample = {
    method: sample.method,
    url: text(sample.url),
    base: text(sample.base),
    path: text(sample.path),
    pathParams: sample.pathParams.map(entry),
    query: sample.query.map(entry),
    headers: sample.headers.map(entry),
  };
  const withBody = sample.body ? { ...out, body: { ...sample.body, value: linkValue(sample.body.value, text) } } : out;
  const withUser = sample.user ? { ...withBody, user: text(sample.user) } : withBody;
  return sample.cookie ? { ...withUser, cookie: text(sample.cookie) } : withUser;
}

export function cookieJar(endpoint: Endpoint): SampleText | undefined {
  const names = Credentials.exampleCookies(endpoint);
  if (names.length === 0) return undefined;
  return SampleText.join(
    names.map((name) => SampleText.concat(`${name}=`, placeholder(name))),
    COOKIE_SEPARATOR,
  );
}

export function submitterEntries(field: FormField): [string, string][] {
  if (field.type === IMAGE_SUBMITTER) {
    const prefix = field.name === '' ? '' : `${field.name}.`;
    return IMAGE_COORDINATES.map((axis): [string, string] => [prefix + axis, IMAGE_COORDINATE_VALUE]);
  }
  return field.name === '' ? [] : [[field.name, field.value]];
}

export function formSubmission(endpoint: Endpoint): FormSubmission | undefined {
  const form = endpoint.form;
  if (!form) return undefined;
  const enabled = form.submitters.filter((submitter) => !submitter.disabled);
  const mime = mimeEssence(endpoint.requestBody?.mimeType);
  const candidates: FormSubmission[] = [];
  for (const submitter of enabled.length > 0 ? enabled : [undefined]) {
    const method = submitter?.formMethod ?? form.method;
    const action = parseUrl(submitter?.formAction ?? form.action);
    if (method !== endpoint.method || !action || action.origin !== endpoint.origin) continue;
    if (EndpointIndex.matchPath(endpoint.path, action.pathname) === undefined) continue;
    const enctype = submitter?.formEnctype ?? form.enctype;
    candidates.push(submitter ? { form, submitter, method, action, enctype } : { form, method, action, enctype });
  }
  return candidates.find((candidate) => candidate.method === 'GET' || mime === '' || candidate.enctype === mime) ?? candidates[0];
}

export function requestSample(endpoint: Endpoint, opts: SampleOptions = {}): RequestSample {
  const submission = formSubmission(endpoint);
  const links = csrfLinks(endpoint);
  const link = (text: SampleText): SampleText => text.map((name) => placeholder(links.get(name) ?? name));
  const base = typeof opts.baseUrl === 'string' || opts.baseUrl === undefined ? SampleText.literal((opts.baseUrl ?? endpoint.origin).replace(/\/+$/, '')) : opts.baseUrl;
  const { path, params } = samplePath(endpoint, opts.pathVariables === true);
  const query = sampleQuery(endpoint, submission, opts).map((entry) => ({ name: entry.name, value: link(entry.value) }));
  const component = queryComponent(submission);
  const search = query.map((entry) => SampleText.concat(`${component(entry.name)}=`, entry.value.mapLiterals(component).encoded('component')));
  const url = SampleText.concat(base, link(path), search.length > 0 ? SampleText.concat('?', SampleText.join(search, '&')) : '');
  const headers = sampleHeaders(endpoint, opts);
  const body = sampleBody(endpoint, submission);
  if (body && body.kind !== 'multipart' && !headers.some((header) => header.name.toLowerCase() === CONTENT_TYPE_HEADER.toLowerCase())) {
    headers.push({ name: CONTENT_TYPE_HEADER, value: SampleText.literal(body.mimeType) });
  }
  const sample: RequestSample = {
    method: endpoint.method,
    url,
    base,
    path: link(path),
    pathParams: params.map((entry) => ({ name: entry.name, value: link(entry.value) })),
    query,
    headers: headers.map((header) => ({ name: header.name, value: link(header.value) })),
  };
  const cookie = opts.cookie === false ? undefined : (opts.cookie ?? cookieJar(endpoint));
  const user = basicAuth(endpoint) ? SampleText.concat(placeholder(BASIC_USER), ':', placeholder(BASIC_PASSWORD)) : undefined;
  const withUser = user === undefined ? sample : { ...sample, user };
  const withCookie = cookie === undefined ? withUser : { ...withUser, cookie };
  return body ? { ...withCookie, body: { ...body, value: linkValue(body.value, link) } } : withCookie;
}

export function queryComponent(submission: FormSubmission | undefined): (text: string) => string {
  const encoder = submission?.method === 'GET' ? CharsetEncoder.for(submission.form.charset) : undefined;
  return (text: string): string => (encoder ? encoder.formComponent(text) : encodeURIComponent(text));
}

export function observedSample(endpoint: Endpoint): EndpointSample | undefined {
  return endpoint.samples.find((sample) => sample.status !== undefined && sample.status >= SUCCESS_MIN && sample.status <= SUCCESS_MAX) ?? endpoint.samples[0];
}

export function observedQuery(endpoint: Endpoint): [string, string][] {
  const sample = observedSample(endpoint);
  const url = sample === undefined ? undefined : parseUrl(sample.url);
  const out: [string, string][] = [];
  if (url) for (const [name, value] of url.searchParams) if (!out.some(([known]) => known === name)) out.push([name, value]);
  return out;
}

function paramValue(param: ParamInfo): SampleText {
  const example = param.examples.find((e) => !isRedacted(e));
  if (example !== undefined) return SampleText.literal(example);
  const redacted = param.examples[0];
  if (redacted !== undefined) return redactedText(redacted, param.name);
  const v = sampleValue(param.schema, param.name, { missing: () => undefined });
  if (v === null || v === undefined) return placeholder(param.name);
  return SampleText.literal(typeof v === 'string' ? v : JSON.stringify(v));
}

function csrfLinks(endpoint: Endpoint): Map<string, string> {
  const links = new Map<string, string>();
  for (const token of endpoint.auth.csrf) {
    if (token.source !== 'cookie' || token.sourceName === undefined || token.sourceName === '') continue;
    links.set(SampleText.placeholderName(token.name), SampleText.placeholderName(token.sourceName));
  }
  return links;
}

function linkValue(value: SampleValue | undefined, link: (text: SampleText) => SampleText): SampleValue | undefined {
  if (value instanceof SampleText) return link(value);
  if (Array.isArray(value)) return value.map((item: SampleValue) => linkValue(item, link) ?? null);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, linkValue(item, link) ?? null]));
  return value;
}

function samplePath(endpoint: Endpoint, variables: boolean): { path: SampleText; params: SampleEntry[] } {
  const byName = new Map(endpoint.pathParams.map((param) => [param.name, param]));
  const params: SampleEntry[] = [];
  const parts: SampleTextInput[] = [];
  let last = 0;
  for (const match of endpoint.path.matchAll(/\{([^{}]+)\}/g)) {
    const name = match[1] ?? '';
    const param = byName.get(name);
    const value = param ? paramValue(param) : placeholder(name);
    params.push({ name, value });
    parts.push(endpoint.path.slice(last, match.index), variables ? placeholder(name).encoded('component') : value.mapLiterals(encodeURIComponent).encoded('component'));
    last = match.index + match[0].length;
  }
  parts.push(endpoint.path.slice(last));
  return { path: SampleText.concat(...parts), params };
}

function sampleQuery(endpoint: Endpoint, submission: FormSubmission | undefined, opts: SampleOptions): SampleEntry[] {
  const entries = new Map<string, SampleValue>();
  if (submission && !BODYLESS_METHODS.includes(endpoint.method)) {
    for (const [name, value] of submission.action.searchParams) if (!entries.has(name)) entries.set(name, capturedText(value, name));
    const formNames = actionQueryNames(submission.form);
    for (const param of endpoint.queryParams) {
      if (param.required && !formNames.has(param.name) && !entries.has(param.name)) entries.set(param.name, paramValue(param));
    }
  } else if (submission) {
    for (const param of endpoint.queryParams) if (param.required || !opts.requiredOnly) entries.set(param.name, paramValue(param));
    applySubmitter(entries, submission);
  } else {
    const params = new Map(endpoint.queryParams.map((param) => [param.name, param]));
    for (const [name, value] of observedQuery(endpoint)) {
      if (opts.requiredOnly && params.get(name)?.required !== true) continue;
      entries.set(name, capturedText(value, name));
    }
    for (const param of endpoint.queryParams) if (param.required && !entries.has(param.name)) entries.set(param.name, paramValue(param));
  }
  for (const token of endpoint.auth.csrf) if (token.location === 'query') entries.set(token.name, placeholder(token.name));
  return [...entries].map(([name, value]) => ({ name, value: textValue(value) }));
}

function actionQueryNames(form: EndpointForm): Set<string> {
  const names = new Set<string>();
  for (const action of [form.action, ...form.submitters.map((submitter) => submitter.formAction)]) {
    const url = action === undefined ? undefined : parseUrl(action);
    if (url) for (const name of url.searchParams.keys()) names.add(name);
  }
  return names;
}

function applySubmitter(entries: Map<string, SampleValue>, submission: FormSubmission): void {
  const chosen = submission.submitter ? submitterEntries(submission.submitter) : [];
  const keep = new Set([...chosen.map(([name]) => name), ...submission.form.fields.map((field) => field.name)]);
  for (const other of submission.form.submitters) {
    if (other === submission.submitter) continue;
    for (const [name] of submitterEntries(other)) if (!keep.has(name)) entries.delete(name);
  }
  for (const [name, value] of chosen) entries.set(name, SampleText.literal(value));
}

export function basicAuth(endpoint: Endpoint): boolean {
  return !endpoint.auth.bearer && (Credentials.schemes(endpoint).includes(BASIC_SCHEME) || (endpoint.auth.schemes ?? []).includes(BASIC_SCHEME));
}

function sampleHeaders(endpoint: Endpoint, opts: SampleOptions): SampleEntry[] {
  const headers: SampleEntry[] = [];
  const bearer = SampleText.concat(`${BEARER_SCHEME} `, placeholder(BEARER_TOKEN));
  const authorization = AUTHORIZATION_HEADER.toLowerCase();
  const basic = basicAuth(endpoint);
  for (const param of endpoint.headerParams) {
    if (opts.requiredOnly && !param.required) continue;
    if (basic && param.name.toLowerCase() === authorization) continue;
    const value = paramValue(param);
    const replace = endpoint.auth.bearer && param.name.toLowerCase() === authorization && !value.isLiteral;
    headers.push({ name: param.name, value: replace ? bearer : value });
  }
  for (const token of endpoint.auth.csrf) {
    if (token.location !== 'header') continue;
    const index = headers.findIndex((header) => header.name.toLowerCase() === token.name.toLowerCase());
    const entry = { name: index < 0 ? token.name : (headers[index]?.name ?? token.name), value: placeholder(token.name) };
    if (index < 0) headers.push(entry);
    else headers[index] = entry;
  }
  if (endpoint.auth.bearer && !headers.some((header) => header.name.toLowerCase() === authorization)) {
    headers.push({ name: AUTHORIZATION_HEADER, value: bearer });
  }
  return headers;
}

function sampleBody(endpoint: Endpoint, submission: FormSubmission | undefined): SampleBody | undefined {
  const shape = endpoint.requestBody;
  if (!shape || shape.kind === 'empty' || BODYLESS_METHODS.includes(endpoint.method)) return undefined;
  const form = submission !== undefined && FORM_BODY_KINDS.includes(shape.kind) ? submission : undefined;
  let value = form ? formSample(shape, form) : bodySample(shape);
  if (isRecord(value)) {
    const entries = new Map<string, SampleValue>(Object.entries(value));
    if (submission) applySubmitter(entries, submission);
    for (const token of endpoint.auth.csrf) if (token.location === 'body') entries.set(token.name, placeholder(token.name));
    value = Object.fromEntries(entries);
    if (form) value = normalizeNewlines(value);
    if (form?.enctype === TEXT_PLAIN) value = textPlain(value);
  }
  const mimeType = shape.mimeType || (shape.kind === 'json' || shape.kind === 'graphql' ? JSON_MIME : BINARY_MIME);
  return form ? { kind: shape.kind, mimeType, value, charset: form.form.charset } : { kind: shape.kind, mimeType, value };
}
