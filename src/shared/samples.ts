import type { BodyKind, BodyShape, Endpoint, EndpointForm, FormEnctype, FormField, FormMethod, ParamInfo } from '../model/index.js';
import { EndpointIndex } from './endpoints.js';
import { mimeEssence, parseUrl } from './http.js';
import { isPlainObject } from './json.js';
import { SampleText } from './sample-text.js';
import type { SampleTextInput } from './sample-text.js';
import { sampleValue } from './schema.js';

export const REDACTED = '<redacted>';
export const SECRET_NAME = 'secret';
export const BEARER_TOKEN = 'access_token';
export const BEARER_SCHEME = 'Bearer';
export const AUTHORIZATION_HEADER = 'Authorization';
export const CONTENT_TYPE_HEADER = 'Content-Type';
export const COOKIE_SEPARATOR = '; ';
export const IMAGE_SUBMITTER = 'image';
export const IMAGE_COORDINATES: readonly string[] = Object.freeze(['x', 'y']);
export const IMAGE_COORDINATE_VALUE = '0';
export const BODYLESS_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD']);
export const JSON_MIME = 'application/json';
export const BINARY_MIME = 'application/octet-stream';

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
}

export interface FormEntry {
  readonly name: string;
  readonly value: SampleText;
  readonly file: boolean;
}

export interface SampleOptions {
  baseUrl?: SampleTextInput;
  requiredOnly?: boolean;
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

export function capturedValue(value: unknown, key = ''): SampleValue {
  if (isRedacted(value)) return placeholder(key || SECRET_NAME);
  if (value instanceof SampleText) return value;
  if (typeof value === 'string') return SampleText.literal(value);
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
  const example = shape.examples[0];
  if (example !== undefined) return capturedValue(example);
  if (!shape.schema) return undefined;
  return capturedValue(sampleValue(shape.schema));
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
  const quoted = (text: SampleText): SampleText => SampleText.concat('"', text.mapLiterals((literal) => escape(JSON.stringify(literal).slice(1, -1))), '"');
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
      out.push(isFileValue(each) ? { name, value: each.filename, file: true } : { name, value: textValue(each), file: false });
    }
  }
  return out;
}

export function placeholderNames(sample: RequestSample, extra: readonly SampleText[] = []): string[] {
  const names = new Set<string>();
  const texts = [sample.url, ...sample.headers.map((header) => header.value), ...extra];
  if (sample.body) texts.push(jsonText(sample.body.value));
  for (const text of texts) for (const name of text.placeholders()) names.add(name);
  return [...names].sort();
}

export function cookieJar(endpoint: Endpoint): SampleText | undefined {
  if (endpoint.auth.cookies.length === 0) return undefined;
  return SampleText.join(
    endpoint.auth.cookies.map((name) => SampleText.concat(`${name}=`, placeholder(name))),
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
  const { path, params } = samplePath(endpoint);
  const query = sampleQuery(endpoint, submission, opts).map((entry) => ({ name: entry.name, value: link(entry.value) }));
  const search = query.map((entry) => SampleText.concat(`${encodeURIComponent(entry.name)}=`, entry.value.mapLiterals(encodeURIComponent)));
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
  return body ? { ...sample, body: { ...body, value: linkValue(body.value, link) } } : sample;
}

function paramValue(param: ParamInfo): SampleText {
  const example = param.examples.find((e) => !isRedacted(e));
  if (example !== undefined) return SampleText.literal(example);
  if (param.examples.length) return placeholder(param.name);
  const v = sampleValue(param.schema, param.name);
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

function samplePath(endpoint: Endpoint): { path: SampleText; params: SampleEntry[] } {
  const byName = new Map(endpoint.pathParams.map((param) => [param.name, param]));
  const params: SampleEntry[] = [];
  const parts: SampleTextInput[] = [];
  let last = 0;
  for (const match of endpoint.path.matchAll(/\{([^{}]+)\}/g)) {
    const name = match[1] ?? '';
    const param = byName.get(name);
    const value = param ? paramValue(param) : placeholder(name);
    params.push({ name, value });
    parts.push(endpoint.path.slice(last, match.index), value.mapLiterals(encodeURIComponent));
    last = match.index + match[0].length;
  }
  parts.push(endpoint.path.slice(last));
  return { path: SampleText.concat(...parts), params };
}

function sampleQuery(endpoint: Endpoint, submission: FormSubmission | undefined, opts: SampleOptions): SampleEntry[] {
  const entries = new Map<string, SampleValue>();
  if (submission && !BODYLESS_METHODS.has(endpoint.method)) {
    for (const [name, value] of submission.action.searchParams) if (!entries.has(name)) entries.set(name, isRedacted(value) ? placeholder(name) : SampleText.literal(value));
    const formNames = actionQueryNames(submission.form);
    for (const param of endpoint.queryParams) {
      if (param.required && !formNames.has(param.name) && !entries.has(param.name)) entries.set(param.name, paramValue(param));
    }
  } else {
    for (const param of endpoint.queryParams) {
      if (param.required || (!opts.requiredOnly && param.examples.length > 0)) entries.set(param.name, paramValue(param));
    }
    if (submission) applySubmitter(entries, submission);
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

function sampleHeaders(endpoint: Endpoint, opts: SampleOptions): SampleEntry[] {
  const headers: SampleEntry[] = [];
  const bearer = SampleText.concat(`${BEARER_SCHEME} `, placeholder(BEARER_TOKEN));
  const authorization = AUTHORIZATION_HEADER.toLowerCase();
  for (const param of endpoint.headerParams) {
    if (opts.requiredOnly && !param.required) continue;
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
  if (!shape || shape.kind === 'empty' || BODYLESS_METHODS.has(endpoint.method)) return undefined;
  let value = bodySample(shape);
  if (isRecord(value)) {
    const entries = new Map<string, SampleValue>(Object.entries(value));
    if (submission) applySubmitter(entries, submission);
    for (const token of endpoint.auth.csrf) if (token.location === 'body') entries.set(token.name, placeholder(token.name));
    value = Object.fromEntries(entries);
  }
  const mimeType = shape.mimeType || (shape.kind === 'json' || shape.kind === 'graphql' ? JSON_MIME : BINARY_MIME);
  return { kind: shape.kind, mimeType, value };
}
