import { CACHE_KINDS, CAPTURE_SOURCES, CAPTURE_VERSION, RESOURCE_TYPES, SAME_SITE_VALUES, SERVED_BY_VALUES } from '../model/index.js';
import type { Capture } from '../model/index.js';
import { Json } from '../shared/index.js';

type Check = (value: unknown, path: string, problems: string[]) => void;

export class CaptureValidator {
  static readonly VERSION = CAPTURE_VERSION;
  static readonly MAX_PROBLEMS = 25;
  static readonly SOURCES: ReadonlySet<string> = new Set(CAPTURE_SOURCES);
  static readonly RESOURCE_TYPES: ReadonlySet<string> = new Set(RESOURCE_TYPES);
  static readonly SAME_SITE: ReadonlySet<string> = new Set(SAME_SITE_VALUES);
  static readonly SERVED_BY: ReadonlySet<string> = new Set(SERVED_BY_VALUES);
  static readonly CACHE_KINDS: ReadonlySet<string> = new Set(CACHE_KINDS);

  validate(value: unknown): string[] {
    const problems: string[] = [];
    if (!Json.isPlainObject(value)) return ['capture must be a JSON object'];
    if (value.version !== CaptureValidator.VERSION) problems.push(`version must be ${CaptureValidator.VERSION}, got ${JSON.stringify(value.version)}`);
    const tool = value.tool;
    if (!Json.isPlainObject(tool) || typeof tool.name !== 'string' || typeof tool.version !== 'string') problems.push('tool must be { name, version }');
    CaptureValidator.#optionalString(value.startUrl, 'startUrl', problems);
    CaptureValidator.#date(value.startedAt, 'startedAt', problems);
    CaptureValidator.#date(value.endedAt, 'endedAt', problems);
    CaptureValidator.#list(value.exchanges, 'exchanges', CaptureValidator.#exchange, problems);
    CaptureValidator.#list(value.websockets, 'websockets', CaptureValidator.#websocket, problems);
    CaptureValidator.#list(value.cookies, 'cookies', CaptureValidator.#cookie, problems);
    CaptureValidator.#list(value.storage, 'storage', CaptureValidator.#storage, problems);
    CaptureValidator.#list(value.pages, 'pages', CaptureValidator.#page, problems);
    return problems.slice(0, CaptureValidator.MAX_PROBLEMS);
  }

  isCapture(value: unknown): value is Capture {
    return this.validate(value).length === 0;
  }

  cookies(value: unknown, path = 'cookies'): string[] {
    const problems: string[] = [];
    CaptureValidator.#list(value, path, CaptureValidator.#cookie, problems);
    return problems;
  }

  storage(value: unknown, path = 'storage'): string[] {
    const problems: string[] = [];
    CaptureValidator.#list(value, path, CaptureValidator.#storage, problems);
    return problems;
  }

  pages(value: unknown, path = 'pages'): string[] {
    const problems: string[] = [];
    CaptureValidator.#list(value, path, CaptureValidator.#page, problems);
    return problems;
  }

  static #list(value: unknown, path: string, check: Check, problems: string[]): void {
    if (!Array.isArray(value)) {
      problems.push(`${path} must be an array`);
      return;
    }
    for (let i = 0; i < value.length && problems.length < CaptureValidator.MAX_PROBLEMS; i++) check(value[i], `${path}[${i}]`, problems);
  }

  static #exchange(value: unknown, path: string, problems: string[]): void {
    if (!Json.isPlainObject(value)) {
      problems.push(`${path} must be an object`);
      return;
    }
    CaptureValidator.#string(value.id, `${path}.id`, problems);
    if (typeof value.source !== 'string' || !CaptureValidator.SOURCES.has(value.source)) problems.push(`${path}.source must be "browser" or "har"`);
    if (typeof value.resourceType !== 'string' || !CaptureValidator.RESOURCE_TYPES.has(value.resourceType)) problems.push(`${path}.resourceType is not a known resource type`);
    CaptureValidator.#optionalString(value.pageUrl, `${path}.pageUrl`, problems);
    CaptureValidator.#date(value.startedAt, `${path}.startedAt`, problems);
    CaptureValidator.#number(value.durationMs, `${path}.durationMs`, problems);
    CaptureValidator.#optionalString(value.error, `${path}.error`, problems);
    CaptureValidator.#optionalString(value.redirectedFrom, `${path}.redirectedFrom`, problems);
    CaptureValidator.#servedBy(value, path, problems);
    const request = value.request;
    if (!Json.isPlainObject(request)) problems.push(`${path}.request must be an object`);
    else {
      CaptureValidator.#string(request.method, `${path}.request.method`, problems);
      CaptureValidator.#string(request.url, `${path}.request.url`, problems);
      CaptureValidator.#headers(request.headers, `${path}.request.headers`, problems);
      CaptureValidator.#body(request.body, `${path}.request.body`, problems);
    }
    const response = value.response;
    if (response === undefined) return;
    if (!Json.isPlainObject(response)) {
      problems.push(`${path}.response must be an object`);
      return;
    }
    if (typeof response.status !== 'number' || !Number.isInteger(response.status)) problems.push(`${path}.response.status must be an integer`);
    CaptureValidator.#string(response.statusText, `${path}.response.statusText`, problems);
    CaptureValidator.#headers(response.headers, `${path}.response.headers`, problems);
    CaptureValidator.#body(response.body, `${path}.response.body`, problems);
    CaptureValidator.#optionalString(response.remoteAddress, `${path}.response.remoteAddress`, problems);
  }

  static #websocket(value: unknown, path: string, problems: string[]): void {
    if (!Json.isPlainObject(value)) {
      problems.push(`${path} must be an object`);
      return;
    }
    CaptureValidator.#string(value.id, `${path}.id`, problems);
    CaptureValidator.#string(value.url, `${path}.url`, problems);
    CaptureValidator.#optionalString(value.pageUrl, `${path}.pageUrl`, problems);
    CaptureValidator.#date(value.openedAt, `${path}.openedAt`, problems);
    if (value.closedAt !== undefined) CaptureValidator.#date(value.closedAt, `${path}.closedAt`, problems);
    CaptureValidator.#optionalString(value.error, `${path}.error`, problems);
    CaptureValidator.#list(
      value.messages,
      `${path}.messages`,
      (m, p, out) => {
        if (!Json.isPlainObject(m)) {
          out.push(`${p} must be an object`);
          return;
        }
        if (m.direction !== 'sent' && m.direction !== 'received') out.push(`${p}.direction must be "sent" or "received"`);
        if (m.opcode !== 'text' && m.opcode !== 'binary') out.push(`${p}.opcode must be "text" or "binary"`);
        CaptureValidator.#date(m.at, `${p}.at`, out);
        CaptureValidator.#string(m.data, `${p}.data`, out);
      },
      problems,
    );
  }

  static #cookie(value: unknown, path: string, problems: string[]): void {
    if (!Json.isPlainObject(value)) {
      problems.push(`${path} must be an object`);
      return;
    }
    for (const key of ['name', 'value', 'domain', 'path']) CaptureValidator.#string(value[key], `${path}.${key}`, problems);
    if (value.expires !== null && (typeof value.expires !== 'number' || !Number.isFinite(value.expires))) problems.push(`${path}.expires must be a number or null`);
    for (const key of ['httpOnly', 'secure', 'hostOnly']) if (typeof value[key] !== 'boolean') problems.push(`${path}.${key} must be a boolean`);
    if (value.sameSite !== null && (typeof value.sameSite !== 'string' || !CaptureValidator.SAME_SITE.has(value.sameSite))) {
      problems.push(`${path}.sameSite must be "Strict", "Lax", "None" or null`);
    }
    CaptureValidator.#optionalString(value.partitionKey, `${path}.partitionKey`, problems);
  }

  static #servedBy(value: Record<string, unknown>, path: string, problems: string[]): void {
    const servedBy = value.servedBy;
    if (servedBy !== undefined && (typeof servedBy !== 'string' || !CaptureValidator.SERVED_BY.has(servedBy))) {
      problems.push(`${path}.servedBy must be one of ${CaptureValidator.#quoted(CaptureValidator.SERVED_BY)}`);
    }
    const cacheKind = value.cacheKind;
    if (cacheKind === undefined) return;
    if (typeof cacheKind !== 'string' || !CaptureValidator.CACHE_KINDS.has(cacheKind)) problems.push(`${path}.cacheKind must be one of ${CaptureValidator.#quoted(CaptureValidator.CACHE_KINDS)}`);
    else if (servedBy !== 'cache') problems.push(`${path}.cacheKind is allowed only when servedBy is "cache"`);
  }

  static #quoted(values: ReadonlySet<string>): string {
    return [...values].map((v) => JSON.stringify(v)).join(', ');
  }

  static #storage(value: unknown, path: string, problems: string[]): void {
    if (!Json.isPlainObject(value)) {
      problems.push(`${path} must be an object`);
      return;
    }
    CaptureValidator.#string(value.origin, `${path}.origin`, problems);
    for (const key of ['localStorage', 'sessionStorage']) {
      const area = value[key];
      if (!Json.isPlainObject(area) || Object.values(area).some((v) => typeof v !== 'string')) problems.push(`${path}.${key} must map strings to strings`);
    }
  }

  static #page(value: unknown, path: string, problems: string[]): void {
    if (!Json.isPlainObject(value)) {
      problems.push(`${path} must be an object`);
      return;
    }
    CaptureValidator.#string(value.url, `${path}.url`, problems);
    CaptureValidator.#string(value.title, `${path}.title`, problems);
    CaptureValidator.#date(value.capturedAt, `${path}.capturedAt`, problems);
    CaptureValidator.#string(value.html, `${path}.html`, problems);
    if (value.characterSet !== undefined) CaptureValidator.#string(value.characterSet, `${path}.characterSet`, problems);
  }

  static #headers(value: unknown, path: string, problems: string[]): void {
    if (!Array.isArray(value)) {
      problems.push(`${path} must be an array`);
      return;
    }
    value.forEach((h, i) => {
      if (!Json.isPlainObject(h) || typeof h.name !== 'string' || typeof h.value !== 'string') problems.push(`${path}[${i}] must be { name, value } strings`);
    });
  }

  static #body(value: unknown, path: string, problems: string[]): void {
    if (value === undefined) return;
    if (!Json.isPlainObject(value)) {
      problems.push(`${path} must be an object`);
      return;
    }
    CaptureValidator.#string(value.mimeType, `${path}.mimeType`, problems);
    if (value.encoding !== 'utf8' && value.encoding !== 'base64') problems.push(`${path}.encoding must be "utf8" or "base64"`);
    CaptureValidator.#string(value.data, `${path}.data`, problems);
    CaptureValidator.#number(value.size, `${path}.size`, problems);
    if (value.truncated !== undefined && typeof value.truncated !== 'boolean') problems.push(`${path}.truncated must be a boolean`);
  }

  static #string(value: unknown, path: string, problems: string[]): void {
    if (typeof value !== 'string') problems.push(`${path} must be a string`);
  }

  static #optionalString(value: unknown, path: string, problems: string[]): void {
    if (value !== undefined && typeof value !== 'string') problems.push(`${path} must be a string`);
  }

  static #number(value: unknown, path: string, problems: string[]): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) problems.push(`${path} must be a non-negative number`);
  }

  static #date(value: unknown, path: string, problems: string[]): void {
    if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) problems.push(`${path} must be an ISO date string`);
  }
}
