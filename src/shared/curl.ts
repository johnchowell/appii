import type { RequestSample } from './samples.js';
import { hasPlaceholder } from './samples.js';
import { isPlainObject } from './json.js';
import { shellQuote } from './text.js';

export interface CurlOptions {
  variables?: 'literal' | 'shell';
  cookie?: string;
  multiline?: boolean;
  extraArgs?: string[];
}

export function shellArg(value: string, variables: 'literal' | 'shell' = 'literal'): string {
  if (variables === 'literal' || !hasPlaceholder(value)) return shellQuote(value);
  let out = '"';
  let last = 0;
  const re = /\{\{([a-z0-9_]+)\}\}/g;
  for (let m = re.exec(value); m; m = re.exec(value)) {
    out += escapeDouble(value.slice(last, m.index)) + '${' + m[1]!.toUpperCase() + '}';
    last = m.index + m[0].length;
  }
  return out + escapeDouble(value.slice(last)) + '"';
}

function escapeDouble(s: string): string {
  return s.replace(/[\\"$`]/g, (c) => '\\' + c);
}

export function placeholderNames(sample: RequestSample): string[] {
  const names = new Set<string>();
  const scan = (s: string) => {
    for (const m of s.matchAll(/\{\{([a-z0-9_]+)\}\}/g)) names.add(m[1]!.toUpperCase());
  };
  scan(sample.url);
  sample.headers.forEach((h) => scan(h.value));
  if (sample.body) scan(typeof sample.body.value === 'string' ? sample.body.value : JSON.stringify(sample.body.value ?? ''));
  return [...names].sort();
}

function stringify(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}

export function curlCommand(sample: RequestSample, opts: CurlOptions = {}): string {
  const vars = opts.variables ?? 'literal';
  const head: string[] = ['curl', '-sS'];
  if (sample.method !== 'GET' || sample.body) head.push('-X', sample.method);
  head.push(shellArg(sample.url, vars));
  const groups: string[][] = [head];
  for (const h of sample.headers) groups.push(['-H', shellArg(`${h.name}: ${h.value}`, vars)]);
  if (opts.cookie) groups.push(['-b', opts.cookie]);
  const body = sample.body;
  if (body) {
    if ((body.kind === 'form' || body.kind === 'multipart') && isPlainObject(body.value)) {
      const flag = body.kind === 'form' ? '--data-urlencode' : '-F';
      for (const [k, v] of Object.entries(body.value)) {
        const values = Array.isArray(v) ? v : [v];
        for (const item of values) {
          if (body.kind === 'multipart' && isPlainObject(item) && typeof item.filename === 'string') {
            groups.push([flag, shellArg(`${k}=@${item.filename || 'file.bin'}`, vars)]);
          } else {
            groups.push([flag, shellArg(`${k}=${stringify(item)}`, vars)]);
          }
        }
      }
    } else if (body.value !== undefined) {
      groups.push(['--data-raw', shellArg(stringify(body.value), vars)]);
    }
  }
  for (const a of opts.extraArgs ?? []) groups.push([a]);
  const parts = groups.map((g) => g.join(' '));
  return opts.multiline === false ? parts.join(' ') : parts.join(' \\\n  ');
}
