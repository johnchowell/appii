import type { ApiModel, CsrfToken, Endpoint } from '../model/index.js';
import { AppiiError } from './errors.js';
import { decodeComponent, parseUrl } from './http.js';
import { closest } from './text.js';

export class EndpointIndex {
  static readonly TEMPLATE_SEGMENT: RegExp = /^(?:\{[^{}/]+\}|[^{}])+$/;
  static readonly PAGE_LOAD_METHOD = 'GET';

  readonly #numbers = new Map<Endpoint, number>();

  constructor(readonly endpoints: readonly Endpoint[]) {
    endpoints.forEach((e, i) => this.#numbers.set(e, i + 1));
  }

  static of(model: ApiModel): EndpointIndex {
    return new EndpointIndex(model.endpoints);
  }

  static subset(model: ApiModel, selected: readonly Endpoint[]): ApiModel {
    const chosen = new Set(selected);
    const endpoints = model.endpoints.filter((endpoint) => chosen.has(endpoint));
    if (endpoints.length === model.endpoints.length) return model;
    const ids = new Set(endpoints.map((endpoint) => endpoint.id));
    const sent = new Set(endpoints.flatMap((endpoint) => endpoint.auth.cookies));
    const forms = new Set(endpoints.flatMap((endpoint) => (endpoint.form ? [EndpointIndex.#formKey(endpoint.form.pageUrl, endpoint.form.selector)] : [])));
    const cookies = model.cookies
      .filter((cookie) => [...cookie.setBy, ...cookie.usedBy].some((id) => ids.has(id)) || (cookie.setBy.length === 0 && cookie.usedBy.length === 0 && sent.has(cookie.name)))
      .map((cookie) => {
        const { issuedBy, revokedBy, ...rest } = cookie;
        const issued = (issuedBy ?? []).filter((id) => ids.has(id));
        const revoked = (revokedBy ?? []).filter((id) => ids.has(id));
        return {
          ...rest,
          setBy: cookie.setBy.filter((id) => ids.has(id)),
          usedBy: cookie.usedBy.filter((id) => ids.has(id)),
          ...(issued.length > 0 ? { issuedBy: issued } : {}),
          ...(revoked.length > 0 ? { revokedBy: revoked } : {}),
        };
      });
    const kept = model.forms.flatMap((form) => {
      if (form.endpoints === undefined) return forms.has(EndpointIndex.#formKey(form.pageUrl, form.selector)) ? [form] : [];
      const linked = form.endpoints.filter((id) => ids.has(id));
      return linked.length > 0 ? [{ ...form, endpoints: linked }] : [];
    });
    return { ...model, endpoints, cookies, forms: kept };
  }

  static tokenRequest(token: CsrfToken): string | undefined {
    if (token.source === 'cookie') return undefined;
    const method = token.sourceMethod?.toUpperCase();
    return method === undefined || method === EndpointIndex.PAGE_LOAD_METHOD ? undefined : method;
  }

  static tokenSource(token: CsrfToken, endpoints: readonly Endpoint[]): Endpoint | undefined {
    const method = EndpointIndex.tokenRequest(token);
    const url = parseUrl(token.sourceUrl);
    if (method === undefined || !url) return undefined;
    return endpoints.find((endpoint) => endpoint.method.toUpperCase() === method && endpoint.origin === url.origin && EndpointIndex.matchPath(endpoint.path, url.pathname) !== undefined);
  }

  static #formKey(pageUrl: string, selector: string): string {
    return JSON.stringify([pageUrl, selector]);
  }

  static statuses(endpoint: Endpoint): number[] {
    return [...new Set(endpoint.responses.map((response) => response.status))].sort((a, b) => a - b);
  }

  static matchPath(template: string, path: string): Record<string, string> | undefined {
    if (!template.startsWith('/') || !path.startsWith('/')) return template === path ? {} : undefined;
    const expected = template.split('/');
    const actual = path.split('/');
    if (expected.length !== actual.length) return undefined;
    const values: [string, string][] = [];
    for (let i = 0; i < expected.length; i++) {
      const pattern = expected[i] ?? '';
      const segment = actual[i] ?? '';
      if (!pattern.includes('{') || pattern.includes('}{') || !EndpointIndex.TEMPLATE_SEGMENT.test(pattern)) {
        if (pattern !== segment) return undefined;
        continue;
      }
      const names: string[] = [];
      const source = pattern.replace(/\{([^{}/]+)\}|[^{}]+/g, (part: string, name: string | undefined) => {
        if (name !== undefined) {
          names.push(name);
          return '(.+?)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      });
      const m = new RegExp(`^${source}$`).exec(segment);
      if (!m) return undefined;
      names.forEach((name, j) => values.push([name, decodeComponent(m[j + 1] ?? '')]));
    }
    return Object.fromEntries(values);
  }

  numberOf(endpoint: Endpoint): number {
    const n = this.#numbers.get(endpoint);
    if (n !== undefined) return n;
    const i = this.endpoints.findIndex((e) => e.id === endpoint.id);
    return i < 0 ? 0 : i + 1;
  }

  get(ref: string | number): Endpoint | undefined {
    const text = String(ref).trim();
    if (/^\d+$/.test(text)) return this.endpoints[Number(text) - 1];
    const exact = this.endpoints.find((e) => e.id === text || e.name === text || e.key === text);
    if (exact) return exact;
    const lower = text.toLowerCase();
    return this.endpoints.find((e) => e.id.toLowerCase() === lower || e.name.toLowerCase() === lower || e.key.toLowerCase() === lower);
  }

  require(ref: string | number): Endpoint {
    const found = this.get(ref);
    if (found) return found;
    const lower = String(ref).toLowerCase();
    const guess = closest(String(ref).trim(), this.endpoints.map((e) => e.name));
    const similar = this.endpoints.filter((e) => e.name === guess);
    const matching = this.endpoints.filter((e) => e.name !== guess && (e.name.toLowerCase().includes(lower) || e.path.toLowerCase().includes(lower)));
    const suggestions = [...similar, ...matching].slice(0, 5).map((e) => `${this.numberOf(e)} ${e.name}`);
    throw new AppiiError('NOT_FOUND', `No endpoint matches '${ref}' (use a list number, id, or name)`, {
      details: { suggestions, count: this.endpoints.length },
    });
  }

  select(refs?: readonly (string | number)[]): Endpoint[] {
    if (!refs || refs.length === 0) return [...this.endpoints];
    const chosen = new Set(refs.map((r) => this.require(r)));
    return this.endpoints.filter((e) => chosen.has(e));
  }

  entries(): { number: number; endpoint: Endpoint }[] {
    return this.endpoints.map((endpoint, i) => ({ number: i + 1, endpoint }));
  }
}
