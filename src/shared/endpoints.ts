import type { ApiModel, Endpoint } from '../model/index.js';
import { AppiiError } from './errors.js';

export class EndpointIndex {
  readonly #numbers = new Map<Endpoint, number>();

  constructor(readonly endpoints: readonly Endpoint[]) {
    endpoints.forEach((e, i) => this.#numbers.set(e, i + 1));
  }

  static of(model: ApiModel): EndpointIndex {
    return new EndpointIndex(model.endpoints);
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
