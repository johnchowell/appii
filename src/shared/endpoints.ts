import type { ApiModel, Endpoint } from '../model/index.js';
import { AppiiError } from './errors.js';
import { decodeComponent } from './http.js';

export class EndpointIndex {
  static readonly TEMPLATE_SEGMENT: RegExp = /^(?:\{[^{}/]+\}|[^{}])+$/;

  readonly #numbers = new Map<Endpoint, number>();

  constructor(readonly endpoints: readonly Endpoint[]) {
    endpoints.forEach((e, i) => this.#numbers.set(e, i + 1));
  }

  static of(model: ApiModel): EndpointIndex {
    return new EndpointIndex(model.endpoints);
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
    const suggestions = this.endpoints
      .filter((e) => e.name.toLowerCase().includes(lower) || e.path.toLowerCase().includes(lower))
      .slice(0, 5)
      .map((e) => `${this.numberOf(e)} ${e.name}`);
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
