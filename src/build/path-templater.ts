import { Http, Text } from '../shared/index.js';
import { Helpers } from './helpers.js';
import { Redactor } from './redactor.js';

export type SegmentKind = 'integer' | 'uuid' | 'hex' | 'date' | 'token' | 'literal';

export interface PathParam {
  name: string;
  position: number;
  kind: SegmentKind;
  examples: string[];
}

export interface PathTemplate {
  template: string;
  params: PathParam[];
}

export interface PathEvidence {
  readonly forms: ReadonlySet<string>;
  readonly names: ReadonlySet<string>;
}

export interface SegmentRule {
  kind: Exclude<SegmentKind, 'literal'>;
  test: (segment: string) => boolean;
}

interface Row {
  readonly path: string;
  readonly segments: readonly string[];
  readonly kinds: SegmentKind[];
  readonly open: boolean[];
}

export class PathTemplater {
  static readonly RULES: readonly SegmentRule[] = [
    { kind: 'integer', test: (segment) => /^[0-9]+$/.test(segment) },
    { kind: 'uuid', test: (segment) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(segment) },
    { kind: 'date', test: (segment) => /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/.test(segment) },
    {
      kind: 'hex',
      test: (segment) => /^(?:[0-9a-f]{16,}|[0-9A-F]{16,})$/.test(segment) && /[0-9]/.test(segment) && /[a-fA-F]/.test(segment),
    },
    { kind: 'token', test: (segment) => Redactor.looksSecret(Http.decodeComponent(segment)) },
    { kind: 'token', test: (segment) => PathTemplater.isOpaqueToken(segment) },
  ];
  static readonly FIXED_SEGMENTS: readonly RegExp[] = [
    /^v[0-9]+(?:\.[0-9]+)*$/i,
    /^(?:api|apis|graphql|gql|rest|rpc|json|xml|ajax|public|static|assets|admin|auth|oauth|oauth2|\.well-known|well-known|www)$/i,
    /\.(?:html?|php|aspx?|jsp|cgi|js|mjs|css|json|xml|txt|csv|png|jpe?g|gif|svg|webp|ico|pdf|zip|map)$/i,
  ];
  static readonly ID_KINDS: ReadonlySet<SegmentKind> = new Set(['integer', 'uuid', 'hex', 'token']);
  static readonly MIN_DISTINCT_LITERALS = 3;
  static readonly TOKEN_CHARACTERS: RegExp = /^[A-Za-z0-9_-]+$/;
  static readonly LONG_TOKEN_LENGTH = 16;
  static readonly LONG_TOKEN_TRANSITIONS = 3;
  static readonly MIXED_TOKEN_LENGTH = 10;
  static readonly MIXED_TOKEN_TRANSITIONS = 2;

  static isOpaqueToken(segment: string): boolean {
    if (!PathTemplater.TOKEN_CHARACTERS.test(segment) || !/[0-9]/.test(segment) || !/[A-Za-z]/.test(segment)) return false;
    const transitions = PathTemplater.#transitions(segment);
    if (segment.length >= PathTemplater.LONG_TOKEN_LENGTH && transitions >= PathTemplater.LONG_TOKEN_TRANSITIONS) return true;
    return (
      segment.length >= PathTemplater.MIXED_TOKEN_LENGTH &&
      /[a-z]/.test(segment) &&
      /[A-Z]/.test(segment) &&
      transitions >= PathTemplater.MIXED_TOKEN_TRANSITIONS
    );
  }

  static isFixed(segment: string): boolean {
    return PathTemplater.FIXED_SEGMENTS.some((pattern) => pattern.test(segment));
  }

  static segments(path: string): string[] {
    return path.startsWith('/') ? path.slice(1).split('/') : [path];
  }

  classify(segment: string): SegmentKind {
    if (segment === '' || PathTemplater.isFixed(segment)) return 'literal';
    return PathTemplater.RULES.find((rule) => rule.test(segment))?.kind ?? 'literal';
  }

  template(paths: string[], evidence: ReadonlyMap<string, PathEvidence> = new Map()): Map<string, PathTemplate> {
    const rows = Helpers.distinct(paths).map((path) => this.#row(path));
    this.#generalize(rows, evidence);
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.path.startsWith('/'), row.segments.map((segment, i) => (row.open[i] ? null : segment))]);
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    const out = new Map<string, PathTemplate>();
    for (const members of groups.values()) {
      const template = this.#build(members);
      for (const member of members) out.set(member.path, template);
    }
    return out;
  }

  #row(path: string): Row {
    if (!path.startsWith('/')) return { path, segments: [path], kinds: ['literal'], open: [false] };
    const segments = PathTemplater.segments(path);
    const kinds = segments.map((segment) => this.classify(segment));
    return { path, segments, kinds, open: kinds.map((kind) => kind !== 'literal') };
  }

  #generalize(rows: readonly Row[], evidence: ReadonlyMap<string, PathEvidence>): void {
    for (let changed = true; changed; ) {
      changed = false;
      const buckets = new Map<string, { position: number; rows: Row[]; values: Set<string> }>();
      for (const row of rows) {
        row.segments.forEach((segment, position) => {
          if (!this.#eligible(row, position)) return;
          const shape = row.segments.map((other, j) => (j === position ? null : row.open[j] ? 0 : other));
          const key = JSON.stringify([position, shape]);
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = { position, rows: [], values: new Set() };
            buckets.set(key, bucket);
          }
          bucket.rows.push(row);
          bucket.values.add(segment);
        });
      }
      for (const bucket of buckets.values()) {
        if (bucket.values.size < PathTemplater.MIN_DISTINCT_LITERALS) continue;
        const pinned = PathTemplater.#pinned(bucket.rows, bucket.position, evidence);
        const open = bucket.rows.filter((row) => !pinned.has(row.segments[bucket.position] ?? ''));
        if (new Set(open.map((row) => row.segments[bucket.position])).size < PathTemplater.MIN_DISTINCT_LITERALS) continue;
        for (const row of open) row.open[bucket.position] = true;
        changed = true;
      }
    }
  }

  #eligible(row: Row, position: number): boolean {
    if (position < 1 || row.open[position] || !row.path.startsWith('/')) return false;
    const segment = Http.decodeComponent(row.segments[position] ?? '');
    if (segment === '' || PathTemplater.isFixed(segment)) return false;
    if (row.open[position - 1]) return false;
    const parent = Http.decodeComponent(row.segments[position - 1] ?? '');
    if (parent === '' || PathTemplater.isFixed(parent)) return false;
    return Text.singularize(parent).toLowerCase() !== parent.toLowerCase();
  }

  #build(members: readonly Row[]): PathTemplate {
    const first = members[0]!;
    if (!first.path.startsWith('/')) return { template: first.path, params: [] };
    const taken = new Set<string>();
    const params: PathParam[] = [];
    const segments = first.segments.map((segment, position) => {
      if (!first.open[position]) return segment;
      const kind = PathTemplater.#mergeKinds(members.map((member) => member.kinds[position] ?? 'literal'));
      const name = Text.uniqueName(PathTemplater.#paramName(first, position, kind), taken);
      const examples = Helpers.distinct(members.map((member) => Http.decodeComponent(member.segments[position] ?? '')));
      params.push({ name, position, kind, examples });
      return `{${name}}`;
    });
    return { template: '/' + segments.join('/'), params };
  }

  static #pinned(rows: readonly Row[], position: number, evidence: ReadonlyMap<string, PathEvidence>): Set<string> {
    const byValue = new Map<string, { forms: Set<string>; names: Set<string> }>();
    for (const row of rows) {
      const found = evidence.get(row.path);
      if (!found || (found.forms.size === 0 && found.names.size === 0)) continue;
      const value = row.segments[position] ?? '';
      const entry = byValue.get(value) ?? { forms: new Set<string>(), names: new Set<string>() };
      for (const form of found.forms) entry.forms.add(form);
      for (const name of found.names) entry.names.add(name);
      byValue.set(value, entry);
    }
    const parent = new Map([...byValue.keys()].map((value) => [value, value]));
    const root = (value: string): string => {
      let current = value;
      while (parent.get(current) !== current) current = parent.get(current) ?? current;
      for (let next = value; next !== current; ) {
        const up = parent.get(next) ?? current;
        parent.set(next, current);
        next = up;
      }
      return current;
    };
    const join = (groups: ReadonlyMap<string, string[]>): void => {
      for (const members of groups.values()) for (const member of members.slice(1)) parent.set(root(member), root(members[0] ?? member));
    };
    const byForm = new Map<string, string[]>();
    const byName = new Map<string, string[]>();
    const formless = new Set<string>();
    const add = (groups: Map<string, string[]>, key: string, value: string): void => {
      const list = groups.get(key);
      if (list) list.push(value);
      else groups.set(key, [value]);
    };
    for (const [value, entry] of byValue) {
      for (const form of entry.forms) add(byForm, form, value);
      for (const name of entry.names) add(byName, name, value);
      if (entry.forms.size === 0) formless.add(value);
    }
    join(byForm);
    join(new Map([...byName].filter(([, members]) => members.some((member) => formless.has(member)))));
    const classes = new Map<string, string[]>();
    for (const value of byValue.keys()) add(classes, root(value), value);
    if (classes.size < 2) return new Set();
    return new Set([...classes.values()].filter((members) => members.length === 1).flat());
  }

  static #paramName(row: Row, position: number, kind: SegmentKind): string {
    let base = '';
    for (let i = position - 1; i >= 0 && base === ''; i--) {
      if (row.open[i]) continue;
      const segment = Http.decodeComponent(row.segments[i] ?? '');
      if (segment === '' || PathTemplater.isFixed(segment)) continue;
      base = Text.camelCase(Text.singularize(segment));
    }
    if (kind === 'literal') return base || 'slug';
    if (kind === 'date') return base ? `${base}Date` : 'date';
    return base ? `${base}Id` : 'id';
  }

  static #mergeKinds(kinds: readonly SegmentKind[]): SegmentKind {
    const distinct = new Set(kinds);
    if (distinct.size === 1) return kinds[0] ?? 'literal';
    return distinct.has('literal') ? 'literal' : 'token';
  }

  static #transitions(segment: string): number {
    let count = 0;
    for (let i = 1; i < segment.length; i++) {
      const prev = segment.charAt(i - 1);
      const cur = segment.charAt(i);
      const prevDigit = prev >= '0' && prev <= '9';
      const curDigit = cur >= '0' && cur <= '9';
      const prevLetter = /[A-Za-z]/.test(prev);
      const curLetter = /[A-Za-z]/.test(cur);
      if ((prevDigit && curLetter) || (prevLetter && curDigit)) count++;
    }
    return count;
  }
}
