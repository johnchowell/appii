import type { Endpoint } from '../model/index.js';

export interface PathPlan {
  key: string;
  method: string;
  server: string;
  endpoints: Endpoint[];
  renames: Map<string, string>;
}

export interface PathPlanResult {
  plans: PathPlan[];
  skipped: Endpoint[];
}

export interface PathPlannerServers {
  base: (origin: string) => string;
}

interface PathItemSlot {
  readonly key: string;
  readonly methods: Set<string>;
}

export class OpenApiPathPlanner {
  static readonly METHODS: ReadonlySet<string> = new Set(['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace']);
  static readonly PARAM_PATTERN: RegExp = /\{[^}]*\}/g;

  plan(endpoints: readonly Endpoint[], servers: PathPlannerServers): PathPlanResult {
    const groups: Endpoint[][] = [];
    const graphql = new Map<string, Endpoint[]>();
    for (const endpoint of endpoints) {
      if (endpoint.kind !== 'graphql') {
        groups.push([endpoint]);
        continue;
      }
      const key = `${endpoint.method.toUpperCase()} ${endpoint.origin}${endpoint.path}`;
      const group = graphql.get(key);
      if (group) group.push(endpoint);
      else {
        const created = [endpoint];
        graphql.set(key, created);
        groups.push(created);
      }
    }
    const slots = new Map<string, PathItemSlot>();
    const plans: PathPlan[] = [];
    const skipped: Endpoint[] = [];
    for (const group of groups) {
      const first = group[0];
      if (!first) continue;
      const method = first.method.toLowerCase();
      const placed = OpenApiPathPlanner.METHODS.has(method) ? this.#place(first, method, slots) : undefined;
      if (!placed) {
        skipped.push(...group);
        continue;
      }
      plans.push({ key: placed.key, method, server: servers.base(first.origin) + placed.prefix, endpoints: group, renames: placed.renames });
    }
    return { plans, skipped };
  }

  static shape(path: string): string {
    return path.replace(OpenApiPathPlanner.PARAM_PATTERN, '{}');
  }

  static isPathTemplate(path: string): boolean {
    return path.startsWith('/') && !/[?#]/.test(path);
  }

  #place(endpoint: Endpoint, method: string, slots: Map<string, PathItemSlot>): { key: string; prefix: string; renames: Map<string, string> } | undefined {
    if (!OpenApiPathPlanner.isPathTemplate(endpoint.path)) return undefined;
    const parts = endpoint.path.slice(1).split('/');
    for (let moved = 0; moved < parts.length; moved++) {
      if (moved > 0 && (parts[moved - 1] ?? '').includes('{')) return undefined;
      const key = '/' + parts.slice(moved).join('/');
      const shape = OpenApiPathPlanner.shape(key);
      const slot = slots.get(shape);
      if (slot?.methods.has(method)) continue;
      const target = slot ?? { key, methods: new Set<string>() };
      if (!slot) slots.set(shape, target);
      target.methods.add(method);
      return { key: target.key, prefix: moved === 0 ? '' : '/' + parts.slice(0, moved).join('/'), renames: OpenApiPathPlanner.#renames(key, target.key) };
    }
    return undefined;
  }

  static #renames(from: string, to: string): Map<string, string> {
    const out = new Map<string, string>();
    const source = from.match(OpenApiPathPlanner.PARAM_PATTERN) ?? [];
    const target = to.match(OpenApiPathPlanner.PARAM_PATTERN) ?? [];
    source.forEach((param, i) => {
      const renamed = target[i];
      if (renamed !== undefined && renamed !== param) out.set(param.slice(1, -1), renamed.slice(1, -1));
    });
    return out;
  }
}
