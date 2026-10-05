import { Http, Json, Text } from '../shared/index.js';
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
    { kind: 'hex', test: (segment) => Redactor.isHexValue(segment) },
    { kind: 'token', test: (segment) => Redactor.looksSecret(Http.decodeComponent(segment)) },
    { kind: 'token', test: (segment) => Redactor.isOpaqueToken(segment) },
  ];
  static readonly FIXED_SEGMENTS: readonly RegExp[] = [
    /^v[0-9]+(?:\.[0-9]+)*$/i,
    /^(?:api|apis|graphql|gql|rest|rpc|json|xml|ajax|public|static|assets|admin|auth|oauth|oauth2|\.well-known|well-known|www)$/i,
    /\.(?:html?|php|aspx?|jsp|cgi|js|mjs|css|json|xml|txt|csv|png|jpe?g|gif|svg|webp|ico|pdf|zip|map)$/i,
  ];
  static readonly ID_KINDS: ReadonlySet<SegmentKind> = new Set(['integer', 'uuid', 'hex', 'token']);
  static readonly MIN_DISTINCT_LITERALS = 3;
  static readonly ACTION_WORDS: ReadonlySet<string> = new Set([
    'login', 'logout', 'logon', 'logoff', 'signin', 'signout', 'signup', 'register', 'registration', 'me', 'self', 'current', 'search', 'new', 'create',
    'edit', 'update', 'delete', 'remove', 'verify', 'confirm', 'activate', 'reset', 'forgot', 'recover', 'refresh', 'settings', 'preferences', 'password',
    'export', 'import', 'upload', 'download', 'bulk', 'batch', 'count', 'stats', 'summary', 'autocomplete', 'suggest', 'validate', 'invite', 'subscribe',
    'unsubscribe', 'callback', 'authorize', 'session', 'sessions', 'token', 'tokens',
  ]);

  static isOpaqueToken(segment: string): boolean {
    return Redactor.isOpaqueToken(segment);
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
      const idShapes = new Set<string>();
      for (const row of rows) {
        row.segments.forEach((segment, position) => {
          if (PathTemplater.ID_KINDS.has(row.kinds[position] ?? 'literal')) idShapes.add(PathTemplater.#shape(row, position));
          if (!this.#eligible(row, position)) return;
          const key = PathTemplater.#shape(row, position);
          let bucket = buckets.get(key);
          if (!bucket) {
            bucket = { position, rows: [], values: new Set() };
            buckets.set(key, bucket);
          }
          bucket.rows.push(row);
          bucket.values.add(segment);
        });
      }
      for (const [key, bucket] of buckets) {
        if (bucket.values.size < PathTemplater.MIN_DISTINCT_LITERALS || idShapes.has(key)) continue;
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

  static #shape(row: Row, position: number): string {
    return JSON.stringify([position, row.segments.map((other, j) => (j === position ? null : row.open[j] ? 0 : other))]);
  }

  static #pinned(rows: readonly Row[], position: number, evidence: ReadonlyMap<string, PathEvidence>): Set<string> {
    const pinned = new Set<string>();
    const fields = new Map<string, Set<string>>();
    for (const row of rows) {
      const value = row.segments[position] ?? '';
      if (PathTemplater.isAction(Http.decodeComponent(value))) pinned.add(value);
      const found = evidence.get(row.path);
      if (!found) continue;
      const names = fields.get(value) ?? new Set<string>();
      for (const form of found.forms) for (const name of PathTemplater.#formNames(form)) names.add(name);
      for (const name of found.names) names.add(name);
      fields.set(value, names);
    }
    const evidenced = [...fields].filter(([, names]) => names.size > 0);
    if (evidenced.length < 2) return pinned;
    for (const [value, names] of evidenced) {
      const others = evidenced.filter(([other]) => other !== value);
      if (others.every(([, other]) => !PathTemplater.#subset(names, other) && !PathTemplater.#subset(other, names))) pinned.add(value);
    }
    return pinned;
  }

  static isAction(segment: string): boolean {
    return Text.letterWords(segment).some((word) => PathTemplater.ACTION_WORDS.has(word));
  }

  static #formNames(form: string): string[] {
    const parsed = Json.safeParse(form);
    return parsed.ok && Array.isArray(parsed.value) ? parsed.value.filter((name): name is string => typeof name === 'string') : [];
  }

  static #subset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    for (const item of a) if (!b.has(item)) return false;
    return true;
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
}
