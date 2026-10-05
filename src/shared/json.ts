import { JSON_RAW_CONTROL_SOURCE, escapeJsonControls, toAscii } from './text.js';

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function sortKeysDeep<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => sortKeysDeep(v)) as T;
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeysDeep(value[key])])) as T;
  }
  return value;
}

export function stableStringify(value: unknown, indent = 2): string {
  return JSON.stringify(sortKeysDeep(value), null, indent);
}

export function prettyJson(value: unknown, indent = 2): string {
  return JSON.stringify(value, null, indent);
}

export const UNESCAPED_CONTROL_SOURCE = JSON_RAW_CONTROL_SOURCE;

export function printableJson(value: unknown, indent = 2): string {
  return escapeJsonControls(JSON.stringify(value, null, indent) ?? 'null');
}

export function asciiJson(value: unknown, indent = 2): string {
  return toAscii(printableJson(value, indent), 'escape');
}

export function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export function safeParse(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export function getPath(value: unknown, path: (string | number)[]): unknown {
  let cur: unknown = value;
  for (const key of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

export function walk(value: unknown, visit: (node: unknown, path: (string | number)[]) => void, path: (string | number)[] = []): void {
  visit(value, path);
  if (Array.isArray(value)) value.forEach((v, i) => walk(v, visit, [...path, i]));
  else if (isPlainObject(value)) for (const [k, v] of Object.entries(value)) walk(v, visit, [...path, k]);
}
