import type { Capture, Exchange, FormDescriptor, ResourceType } from '../model/index.js';
import { SubmissionRules } from '../forms/index.js';
import type { FormTarget } from '../forms/index.js';
import { Json } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import type { ParsedBody } from './body-parser.js';
import { Helpers } from './helpers.js';
import { HtmlPages } from './html-pages.js';

export interface ObservedSubmission {
  readonly exchange: Exchange;
  readonly entries: ReadonlyMap<string, readonly string[]>;
}

export interface ObservedSubmissionsDeps {
  body: BodyParser;
}

export class ObservedSubmissions {
  static readonly NAVIGATION: ResourceType = 'document';
  static readonly SCRIPT_TYPES: ReadonlySet<ResourceType> = new Set(['fetch', 'xhr']);
  static readonly QUERY_METHOD = 'GET';
  static readonly LINE_BREAK = '\r\n';
  static readonly ENTRY_BODIES: ReadonlySet<string> = new Set(['form', 'multipart', 'text', 'empty']);

  readonly #body: BodyParser;
  readonly #navigations = new Map<string, Exchange[]>();
  readonly #scripts = new Map<string, Exchange[]>();
  readonly #documents = new Set<string>();
  readonly #pages = new Set<string>();
  readonly #parsed = new Map<string, ReadonlyMap<string, readonly string[]> | undefined>();

  constructor(capture: Capture, deps: ObservedSubmissionsDeps) {
    this.#body = deps.body;
    for (const exchange of capture.exchanges) {
      const url = Helpers.httpUrl(exchange.request.url);
      if (!url) continue;
      if (exchange.resourceType === ObservedSubmissions.NAVIGATION) {
        this.#documents.add(HtmlPages.documentKey(exchange.request.url));
        if (exchange.request.method.toUpperCase() === ObservedSubmissions.QUERY_METHOD) this.#pages.add(url.origin + url.pathname);
        if (exchange.pageUrl === undefined || exchange.redirectedFrom !== undefined) continue;
        ObservedSubmissions.#push(this.#navigations, ObservedSubmissions.key(exchange.pageUrl, exchange.request.method, url), exchange);
      } else if (ObservedSubmissions.SCRIPT_TYPES.has(exchange.resourceType) && exchange.pageUrl !== undefined) {
        ObservedSubmissions.#push(this.#scripts, HtmlPages.documentKey(exchange.pageUrl), exchange);
      }
    }
  }

  static create(capture: Capture): ObservedSubmissions {
    return new ObservedSubmissions(capture, { body: BodyParser.create() });
  }

  static key(pageUrl: string, method: string, url: URL): string {
    const target = new URL(url.href);
    target.hash = '';
    if (method.toUpperCase() === ObservedSubmissions.QUERY_METHOD) target.search = '';
    return JSON.stringify([HtmlPages.documentKey(pageUrl), method.toUpperCase(), target.href]);
  }

  loadedPage(url: URL): boolean {
    return this.#pages.has(url.origin + url.pathname);
  }

  serverDocument(pageUrl: string): boolean {
    return this.#documents.has(HtmlPages.documentKey(pageUrl));
  }

  submissions(form: FormDescriptor, target: Pick<FormTarget, 'method' | 'url'>): ObservedSubmission[] {
    const url = Helpers.httpUrl(target.url);
    if (!url) return [];
    const accepted = SubmissionRules.acceptedNames(form);
    const out: ObservedSubmission[] = [];
    for (const exchange of this.#navigations.get(ObservedSubmissions.key(form.pageUrl, target.method, url)) ?? []) {
      const entries = this.entries(exchange, form.charset);
      if (entries && [...entries.keys()].every((name) => accepted.has(name))) out.push({ exchange, entries });
    }
    return out;
  }

  scripted(form: FormDescriptor): Exchange[] {
    const names = SubmissionRules.fieldNames(form);
    if (names.length === 0) return [];
    return (this.#scripts.get(HtmlPages.documentKey(form.pageUrl)) ?? []).filter((exchange) => {
      const carried = this.#names(exchange, form.charset);
      return names.every((name) => carried.has(name));
    });
  }

  entries(exchange: Exchange, charset: string): ReadonlyMap<string, readonly string[]> | undefined {
    const key = JSON.stringify([exchange.id, charset]);
    if (this.#parsed.has(key)) return this.#parsed.get(key);
    const entries = this.#entries(exchange, charset);
    this.#parsed.set(key, entries);
    return entries;
  }

  #entries(exchange: Exchange, charset: string): Map<string, string[]> | undefined {
    if (exchange.request.method.toUpperCase() === ObservedSubmissions.QUERY_METHOD) {
      const query = ObservedSubmissions.#query(exchange.request.url);
      return query === undefined ? undefined : ObservedSubmissions.#pairs(BodyParser.urlencodedPairs(query, charset));
    }
    return ObservedSubmissions.#bodyEntries(this.#body.request(exchange.request, charset));
  }

  static #bodyEntries(parsed: ParsedBody): Map<string, string[]> | undefined {
    if (!ObservedSubmissions.ENTRY_BODIES.has(parsed.kind)) return undefined;
    if (parsed.kind === 'text') return typeof parsed.value === 'string' ? ObservedSubmissions.#pairs(ObservedSubmissions.#lines(parsed.value)) : undefined;
    const out = new Map<string, string[]>();
    if (!Json.isPlainObject(parsed.value)) return out;
    for (const [name, value] of Object.entries(parsed.value)) {
      out.set(name, (Array.isArray(value) ? value : [value]).map((item) => (typeof item === 'string' ? item : BodyParser.isUploadedFile(item) ? item.filename : '')));
    }
    return out;
  }

  #names(exchange: Exchange, charset: string): Set<string> {
    const names = new Set<string>();
    const url = Helpers.httpUrl(exchange.request.url);
    if (url) for (const name of url.searchParams.keys()) names.add(name);
    const parsed = this.#body.request(exchange.request, charset);
    if (parsed.kind === 'json') ObservedSubmissions.#keys(parsed.value, names);
    else for (const name of ObservedSubmissions.#bodyEntries(parsed)?.keys() ?? []) names.add(name);
    return names;
  }

  static #keys(value: unknown, into: Set<string>): void {
    if (Array.isArray(value)) {
      for (const item of value) ObservedSubmissions.#keys(item, into);
      return;
    }
    if (!Json.isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      ObservedSubmissions.#keys(child, into);
    }
  }

  static #query(raw: string): string | undefined {
    const hash = raw.indexOf('#');
    const base = hash < 0 ? raw : raw.slice(0, hash);
    const mark = base.indexOf('?');
    return mark < 0 ? undefined : base.slice(mark + 1);
  }

  static #lines(text: string): [string, string][] {
    return text
      .split(ObservedSubmissions.LINE_BREAK)
      .filter((line) => line !== '')
      .map((line): [string, string] => {
        const eq = line.indexOf('=');
        return eq < 0 ? [line, ''] : [line.slice(0, eq), line.slice(eq + 1)];
      });
  }

  static #pairs(pairs: readonly (readonly [string, string])[]): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const [name, value] of pairs) out.set(name, [...(out.get(name) ?? []), value]);
    return out;
  }

  static #push(map: Map<string, Exchange[]>, key: string, exchange: Exchange): void {
    const list = map.get(key);
    if (list) list.push(exchange);
    else map.set(key, [exchange]);
  }
}
