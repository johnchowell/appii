import type { BodyKind, BodyShape, Endpoint, Header, ParamInfo } from '../model/index.js';
import { isPlainObject } from './json.js';
import { sampleValue } from './schema.js';
import { snakeCase } from './text.js';

export const REDACTED = '<redacted>';

export interface RequestSample {
  method: string;
  url: string;
  headers: Header[];
  body?: { kind: BodyKind; mimeType: string; value: unknown };
}

export interface SampleOptions {
  baseUrl?: string;
  requiredOnly?: boolean;
}

export function placeholder(name: string): string {
  return `{{${snakeCase(name) || 'value'}}}`;
}

export function hasPlaceholder(value: string): boolean {
  return /\{\{[a-z0-9_]+\}\}/.test(value);
}

function isRedacted(value: unknown): boolean {
  return typeof value === 'string' && value.includes(REDACTED);
}

function paramValue(param: ParamInfo): string {
  const example = param.examples.find((e) => !isRedacted(e));
  if (example !== undefined) return example;
  if (param.examples.length) return placeholder(param.name);
  const v = sampleValue(param.schema, param.name);
  return v === null || v === undefined ? placeholder(param.name) : typeof v === 'string' ? v : JSON.stringify(v);
}

function scrub(value: unknown, key = ''): unknown {
  if (isRedacted(value)) return placeholder(key || 'secret');
  if (Array.isArray(value)) return value.map((v) => scrub(v, key));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = scrub(v, k);
    return out;
  }
  return value;
}

export function bodySample(shape: BodyShape | undefined): unknown {
  if (!shape || shape.kind === 'empty') return undefined;
  const example = shape.examples[0];
  if (example !== undefined) return scrub(example);
  return scrub(sampleValue(shape.schema));
}

export function requestSample(endpoint: Endpoint, opts: SampleOptions = {}): RequestSample {
  const base = (opts.baseUrl ?? endpoint.origin).replace(/\/+$/, '');
  const pathParams = new Map(endpoint.pathParams.map((p) => [p.name, p]));
  const path = endpoint.path.replace(/\{([^}]+)\}/g, (_m, name: string) => {
    const p = pathParams.get(name);
    const v = p ? paramValue(p) : placeholder(name);
    return hasPlaceholder(v) ? v : encodeURIComponent(v);
  });
  const query = endpoint.queryParams
    .filter((p) => p.required || (!opts.requiredOnly && p.examples.length > 0))
    .map((p) => {
      const v = paramValue(p);
      const enc = (s: string) => (hasPlaceholder(s) ? s : encodeURIComponent(s));
      return `${encodeURIComponent(p.name)}=${enc(v)}`;
    });
  for (const t of endpoint.auth.csrf) {
    if (t.location === 'query' && !endpoint.queryParams.some((p) => p.name === t.name)) {
      query.push(`${encodeURIComponent(t.name)}=${placeholder(t.name)}`);
    }
  }
  const url = base + path + (query.length ? '?' + query.join('&') : '');
  const headers: Header[] = [];
  for (const h of endpoint.headerParams) {
    if (opts.requiredOnly && !h.required) continue;
    headers.push({ name: h.name, value: paramValue(h) });
  }
  for (const t of endpoint.auth.csrf) {
    if (t.location === 'header' && !headers.some((h) => h.name.toLowerCase() === t.name.toLowerCase())) {
      headers.push({ name: t.name, value: placeholder(t.name) });
    }
  }
  if (endpoint.auth.bearer && !headers.some((h) => h.name.toLowerCase() === 'authorization')) {
    headers.push({ name: 'Authorization', value: `Bearer ${placeholder('access_token')}` });
  }
  const sample: RequestSample = { method: endpoint.method, url, headers };
  const shape = endpoint.requestBody;
  if (shape && shape.kind !== 'empty' && endpoint.method !== 'GET' && endpoint.method !== 'HEAD') {
    let value = bodySample(shape);
    if (isPlainObject(value)) {
      const obj: Record<string, unknown> = { ...value };
      for (const t of endpoint.auth.csrf) if (t.location === 'body') obj[t.name] = placeholder(t.name);
      value = obj;
    }
    const mimeType = shape.mimeType || (shape.kind === 'json' || shape.kind === 'graphql' ? 'application/json' : 'application/octet-stream');
    sample.body = { kind: shape.kind, mimeType, value };
    if (!headers.some((h) => h.name.toLowerCase() === 'content-type') && shape.kind !== 'multipart') {
      headers.push({ name: 'Content-Type', value: mimeType });
    }
  }
  return sample;
}
