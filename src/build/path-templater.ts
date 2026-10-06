import { Http, Json, Text } from '../shared/index.js';
import { Helpers } from './helpers.js';
import type { PathEvidence } from './path-evidence.js';
import { Redactor } from './redactor.js';
import { SegmentJudge } from './segment-judge.js';
import type { ValueProfile } from './segment-judge.js';

export type { PathEvidence, PathObservation } from './path-evidence.js';

export type SegmentKind = 'integer' | 'uuid' | 'hex' | 'date' | 'token' | 'slug' | 'literal';

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

export interface SegmentRule {
  kind: Exclude<SegmentKind, 'literal'>;
  test: (segment: string) => boolean;
}

export interface PathTemplaterDeps {
  judge?: SegmentJudge;
}

export interface FileNumber {
  readonly stem: string;
  readonly digits: string;
  readonly extension: string;
}

interface Row {
  readonly path: string;
  readonly segments: readonly string[];
  readonly decoded: readonly string[];
  readonly kinds: readonly SegmentKind[];
  readonly files: readonly (FileNumber | undefined)[];
  readonly open: boolean[];
  readonly partial: boolean[];
  readonly pinned: Set<number>;
  readonly evidence: PathEvidence | undefined;
}

interface Bucket {
  readonly position: number;
  readonly rows: Row[];
}

export class PathTemplater {
  static readonly RULES: readonly SegmentRule[] = [
    { kind: 'integer', test: (segment) => /^[0-9]+$/.test(segment) },
    { kind: 'uuid', test: (segment) => /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(segment) },
    { kind: 'date', test: (segment) => /^[0-9]{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12][0-9]|3[01])$/.test(segment) },
    { kind: 'hex', test: (segment) => Redactor.isHexValue(segment) },
    { kind: 'token', test: (segment) => Redactor.looksSecret(Http.decodeComponent(segment)) },
    { kind: 'token', test: (segment) => Redactor.isOpaqueToken(segment) },
    { kind: 'slug', test: (segment) => PathTemplater.isSlugWithId(Http.decodeComponent(segment)) },
  ];
  static readonly FILE_SEGMENT: RegExp = /\.(?:html?|php|aspx?|jsp|cgi|js|mjs|css|json|xml|txt|csv|png|jpe?g|gif|svg|webp|ico|pdf|zip|map)$/i;
  static readonly FIXED_SEGMENTS: readonly RegExp[] = [
    /^v[0-9]+(?:\.[0-9]+)*$/i,
    /^(?:api|apis|graphql|gql|rest|rpc|json|xml|ajax|public|static|assets|admin|auth|oauth|oauth2|\.well-known|well-known|www)$/i,
    PathTemplater.FILE_SEGMENT,
  ];
  static readonly SLUG_TRAILING_ID: RegExp = /^(?=.*[a-z])([a-z0-9]+(?:[-_.][a-z0-9]+)*)[-_][0-9]+$/i;
  static readonly SLUG_LEADING_ID: RegExp = /^[0-9]+[-_]([a-z][a-z0-9]*(?:[-_.][a-z0-9]+)*)$/i;
  static readonly FILE_NUMBER: RegExp = /^(.*?)([0-9]+)(\.[A-Za-z0-9]+)$/;
  static readonly ID_KINDS: ReadonlySet<SegmentKind> = new Set(['integer', 'uuid', 'hex', 'token']);
  static readonly OPEN_KINDS: ReadonlySet<SegmentKind> = new Set(['integer', 'uuid', 'hex', 'token', 'date']);
  static readonly NAMED_KINDS: ReadonlySet<SegmentKind> = new Set(['literal', 'slug']);
  static readonly ACTION_PHRASE_WORDS = 2;
  static readonly IDENTITY_KEY = 'id';
  static readonly ACTION_WORDS: ReadonlySet<string> = new Set([
    'login', 'logout', 'logon', 'logoff', 'signin', 'signout', 'signup', 'register', 'registration', 'me', 'self', 'current', 'search', 'new', 'create',
    'edit', 'update', 'delete', 'remove', 'verify', 'confirm', 'activate', 'reset', 'forgot', 'recover', 'refresh', 'settings', 'preferences', 'password',
    'export', 'import', 'upload', 'download', 'bulk', 'batch', 'count', 'stats', 'summary', 'autocomplete', 'suggest', 'validate', 'invite', 'subscribe',
    'unsubscribe', 'callback', 'authorize', 'session', 'sessions', 'token', 'tokens',
  ]);
  static readonly UNIT_WORDS: ReadonlySet<string> = new Set([
    'bytes', 'bits', 'kb', 'mb', 'gb', 'chars', 'characters', 'words', 'lines', 'pixels', 'px', 'ms', 'milliseconds', 'seconds', 'secs', 'minutes',
    'mins', 'hours', 'days', 'weeks', 'months', 'years', 'times', 'percent',
  ]);

  readonly #judge: SegmentJudge;

  constructor(deps: PathTemplaterDeps = {}) {
    this.#judge = deps.judge ?? new SegmentJudge();
  }

  static create(): PathTemplater {
    return new PathTemplater({ judge: new SegmentJudge() });
  }

  static isOpaqueToken(segment: string): boolean {
    return Redactor.isOpaqueToken(segment);
  }

  static isFixed(segment: string): boolean {
    return PathTemplater.FIXED_SEGMENTS.some((pattern) => pattern.test(segment));
  }

  static isSlugWithId(segment: string): boolean {
    return PathTemplater.slugStem(segment) !== undefined;
  }

  static slugStem(segment: string): string | undefined {
    if (PathTemplater.isFixed(segment)) return undefined;
    return (PathTemplater.SLUG_TRAILING_ID.exec(segment) ?? PathTemplater.SLUG_LEADING_ID.exec(segment))?.[1];
  }

  static fileNumber(segment: string): FileNumber | undefined {
    if (!PathTemplater.FILE_SEGMENT.test(segment)) return undefined;
    const match = PathTemplater.FILE_NUMBER.exec(segment);
    if (!match) return undefined;
    return { stem: match[1] ?? '', digits: match[2] ?? '', extension: match[3] ?? '' };
  }

  static segments(path: string): string[] {
    return path.startsWith('/') ? path.slice(1).split('/') : [path];
  }

  static isAction(segment: string): boolean {
    const words = Text.letterWords(segment);
    if (words.length === 0) return false;
    if (PathTemplater.ACTION_WORDS.has(words.join(''))) return true;
    return words.length <= PathTemplater.ACTION_PHRASE_WORDS && words.some((word) => PathTemplater.ACTION_WORDS.has(word));
  }

  classify(segment: string): SegmentKind {
    if (segment === '' || PathTemplater.isFixed(segment)) return 'literal';
    return PathTemplater.RULES.find((rule) => rule.test(segment))?.kind ?? 'literal';
  }

  template(paths: string[], evidence: ReadonlyMap<string, PathEvidence> = new Map()): Map<string, PathTemplate> {
    const rows = Helpers.distinct(paths).map((path) => this.#row(path, evidence.get(path)));
    this.#generalize(rows);
    const echoes = PathTemplater.#prefixEchoes(rows);
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = JSON.stringify([row.path.startsWith('/'), row.segments.map((segment, i) => PathTemplater.#mask(row, i, segment))]);
      const group = groups.get(key);
      if (group) group.push(row);
      else groups.set(key, [row]);
    }
    const out = new Map<string, PathTemplate>();
    for (const members of groups.values()) {
      const template = PathTemplater.#build(members, echoes);
      for (const member of members) out.set(member.path, template);
    }
    return out;
  }

  #row(path: string, evidence: PathEvidence | undefined): Row {
    if (!path.startsWith('/')) {
      return { path, segments: [path], decoded: [path], kinds: ['literal'], files: [undefined], open: [false], partial: [false], pinned: new Set(), evidence };
    }
    const segments = PathTemplater.segments(path);
    const kinds = segments.map((segment) => this.classify(segment));
    return {
      path,
      segments,
      decoded: segments.map((segment) => Http.decodeComponent(segment)),
      kinds,
      files: segments.map((segment) => PathTemplater.fileNumber(segment)),
      open: kinds.map((kind) => PathTemplater.OPEN_KINDS.has(kind)),
      partial: segments.map(() => false),
      pinned: new Set(),
      evidence,
    };
  }

  #generalize(rows: readonly Row[]): void {
    for (let changed = true; changed; ) {
      changed = this.#settle(rows);
      if (PathTemplater.#propagate(rows)) changed = true;
      if (PathTemplater.#numberFiles(rows)) changed = true;
    }
  }

  #settle(rows: readonly Row[]): boolean {
    const buckets = new Map<string, Bucket>();
    const idShapes = new Set<string>();
    for (const row of rows) {
      row.segments.forEach((_, position) => {
        const key = PathTemplater.#shape(row, position);
        if (PathTemplater.ID_KINDS.has(row.kinds[position] ?? 'literal')) idShapes.add(key);
        if (!PathTemplater.#eligible(row, position)) return;
        const bucket = buckets.get(key);
        if (bucket) bucket.rows.push(row);
        else buckets.set(key, { position, rows: [row] });
      });
    }
    const touched = new Set<Row>();
    for (const [key, bucket] of buckets) {
      if (bucket.rows.some((row) => touched.has(row))) continue;
      const decision = this.#judge.decide(PathTemplater.#profiles(bucket), idShapes.has(key));
      if (!decision) continue;
      for (const row of bucket.rows) {
        if (decision.open.has(row.segments[bucket.position] ?? '')) row.open[bucket.position] = true;
        else row.pinned.add(bucket.position);
        touched.add(row);
      }
    }
    return touched.size > 0;
  }

  static #eligible(row: Row, position: number): boolean {
    if (position < 1 || row.open[position] || row.partial[position] || row.pinned.has(position) || !row.path.startsWith('/')) return false;
    const segment = row.decoded[position] ?? '';
    if (segment === '' || PathTemplater.isFixed(segment)) return false;
    if (row.open[position - 1] || row.partial[position - 1]) return false;
    const parent = row.decoded[position - 1] ?? '';
    return parent !== '' && !PathTemplater.isFixed(parent);
  }

  static #profiles(bucket: Bucket): ValueProfile[] {
    const { position } = bucket;
    const byValue = new Map<string, Row[]>();
    for (const row of bucket.rows) {
      const value = row.segments[position] ?? '';
      const list = byValue.get(value);
      if (list) list.push(row);
      else byValue.set(value, [row]);
    }
    const formPinned = PathTemplater.#formPinned(bucket.rows, position);
    return [...byValue].map(([value, rows]) => {
      const first = rows[0];
      const kind = first?.kinds[position] ?? 'literal';
      const decoded = first?.decoded[position] ?? value;
      return {
        value,
        idLike: kind !== 'literal',
        pinned: PathTemplater.#actionValue(decoded, kind) || formPinned.has(value),
        observations: rows.flatMap((row) => row.evidence?.observations ?? []),
        reference: rows.some((row) => row.evidence?.references?.has(position) === true),
        identifierEcho: rows.some((row) => (row.evidence?.echoes?.get(position) ?? []).some((echo) => echo.identifier)),
      };
    });
  }

  static #actionValue(decoded: string, kind: SegmentKind): boolean {
    if (kind !== 'slug') return PathTemplater.isAction(decoded);
    const stem = PathTemplater.slugStem(decoded);
    return stem !== undefined && PathTemplater.ACTION_WORDS.has(Text.letterWords(stem).join(''));
  }

  static #propagate(rows: readonly Row[]): boolean {
    const opened = new Map<string, { values: Set<string>; slug: boolean }>();
    for (const row of rows) {
      row.segments.forEach((segment, position) => {
        if (!row.open[position] || position < 1) return;
        const key = PathTemplater.#prefix(row, position);
        const entry = opened.get(key) ?? { values: new Set<string>(), slug: false };
        entry.values.add(segment);
        if (row.kinds[position] === 'slug') entry.slug = true;
        opened.set(key, entry);
      });
    }
    let changed = false;
    for (const row of rows) {
      row.segments.forEach((segment, position) => {
        if (!PathTemplater.#eligible(row, position)) return;
        const known = opened.get(PathTemplater.#prefix(row, position));
        const kind = row.kinds[position] ?? 'literal';
        if (!known || !(known.values.has(segment) || (kind === 'slug' && known.slug))) return;
        if (PathTemplater.#actionValue(row.decoded[position] ?? segment, kind)) return;
        row.open[position] = true;
        changed = true;
      });
    }
    return changed;
  }

  static #numberFiles(rows: readonly Row[]): boolean {
    const buckets = new Map<string, { pattern: string; slots: [Row, number][]; digits: Set<string> }>();
    const patterns = new Set<string>();
    for (const row of rows) {
      row.files.forEach((file, position) => {
        if (!file) return;
        const pattern = JSON.stringify([file.stem, file.extension]);
        if (row.partial[position]) {
          patterns.add(pattern);
          return;
        }
        if (row.open[position]) return;
        const key = JSON.stringify([PathTemplater.#shape(row, position), pattern]);
        const bucket = buckets.get(key) ?? { pattern, slots: [], digits: new Set<string>() };
        bucket.slots.push([row, position]);
        bucket.digits.add(file.digits);
        buckets.set(key, bucket);
      });
    }
    for (const bucket of buckets.values()) if (bucket.digits.size >= SegmentJudge.MIN_VARYING_VALUES) patterns.add(bucket.pattern);
    let changed = false;
    for (const bucket of buckets.values()) {
      if (!patterns.has(bucket.pattern)) continue;
      for (const [row, position] of bucket.slots) row.partial[position] = true;
      changed = true;
    }
    return changed;
  }

  static #mask(row: Row, position: number, segment: string): unknown {
    if (row.open[position]) return 0;
    const file = row.files[position];
    if (row.partial[position] && file) return { stem: file.stem, extension: file.extension };
    return segment;
  }

  static #shape(row: Row, position: number): string {
    return JSON.stringify([position, row.segments.map((other, j) => (j === position ? null : PathTemplater.#mask(row, j, other)))]);
  }

  static #prefix(row: Row, position: number): string {
    return JSON.stringify(row.segments.slice(0, position).map((other, j) => PathTemplater.#mask(row, j, other)));
  }

  static #formPinned(rows: readonly Row[], position: number): Set<string> {
    const pinned = new Set<string>();
    const fields = new Map<string, Set<string>>();
    for (const row of rows) {
      const found = row.evidence;
      if (!found) continue;
      const value = row.segments[position] ?? '';
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

  static #formNames(form: string): string[] {
    const parsed = Json.safeParse(form);
    return parsed.ok && Array.isArray(parsed.value) ? parsed.value.filter((name): name is string => typeof name === 'string') : [];
  }

  static #subset(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    for (const item of a) if (!b.has(item)) return false;
    return true;
  }

  static #build(members: readonly Row[], echoes: ReadonlyMap<string, string>): PathTemplate {
    const first = members[0]!;
    if (!first.path.startsWith('/')) return { template: first.path, params: [] };
    const taken = new Set<string>();
    const params: PathParam[] = [];
    const segments = first.segments.map((segment, position) => {
      const file = first.files[position];
      if (first.partial[position] && file) {
        const name = Text.uniqueName(PathTemplater.#fileParamName(first, position, file), taken);
        params.push({ name, position, kind: 'integer', examples: Helpers.distinct(members.map((member) => member.files[position]?.digits ?? '')) });
        return `${file.stem}{${name}}${file.extension}`;
      }
      if (!first.open[position]) return segment;
      const kind = PathTemplater.#mergeKinds(members.map((member) => member.kinds[position] ?? 'literal'));
      const name = Text.uniqueName(PathTemplater.#paramName(members, position, kind, echoes), taken);
      const examples = Helpers.distinct(members.map((member) => member.decoded[position] ?? ''));
      params.push({ name, position, kind, examples });
      return `{${name}}`;
    });
    return { template: '/' + segments.join('/'), params };
  }

  static #prefixEchoes(rows: readonly Row[]): Map<string, string> {
    const counts = new Map<string, Map<string, number>>();
    for (const row of rows) {
      row.segments.forEach((_, position) => {
        if (!row.open[position] || !PathTemplater.NAMED_KINDS.has(row.kinds[position] ?? 'literal')) return;
        const key = PathTemplater.#prefix(row, position);
        const tally = counts.get(key) ?? new Map<string, number>();
        for (const echo of row.evidence?.echoes?.get(position) ?? []) tally.set(echo.key, (tally.get(echo.key) ?? 0) + 1);
        counts.set(key, tally);
      });
    }
    const out = new Map<string, string>();
    for (const [key, tally] of counts) {
      const best = PathTemplater.#mostCounted(tally);
      if (best !== undefined) out.set(key, best);
    }
    return out;
  }

  static #mostCounted(tally: ReadonlyMap<string, number>): string | undefined {
    let best: string | undefined;
    let most = 0;
    for (const [key, count] of tally) {
      if (count > most) {
        best = key;
        most = count;
      }
    }
    return best;
  }

  static #paramName(members: readonly Row[], position: number, kind: SegmentKind, echoes: ReadonlyMap<string, string>): string {
    const first = members[0]!;
    if (!PathTemplater.NAMED_KINDS.has(kind)) return PathTemplater.#fallbackName(first, position, kind);
    const tally = new Map<string, number>();
    for (const member of members) {
      for (const echo of member.evidence?.echoes?.get(position) ?? []) tally.set(echo.key, (tally.get(echo.key) ?? 0) + 1);
    }
    const echo = PathTemplater.#mostCounted(tally) ?? echoes.get(PathTemplater.#prefix(first, position));
    const named = echo === undefined ? '' : Text.camelCase(echo);
    if (named === '' || named.startsWith('_')) return PathTemplater.#fallbackName(first, position, kind);
    return named === PathTemplater.IDENTITY_KEY ? PathTemplater.#fallbackName(first, position, 'token') : named;
  }

  static #fallbackName(row: Row, position: number, kind: SegmentKind): string {
    const base = PathTemplater.#ancestor(row, position);
    if (kind === 'date') return base ? `${Text.camelCase(Text.singularizePhrase(base))}Date` : 'date';
    if (PathTemplater.NAMED_KINDS.has(kind)) return base ? Text.camelCase(Text.singularizePhrase(base)) : 'slug';
    if (!base) return 'id';
    const words = Text.letterWords(base);
    if (PathTemplater.UNIT_WORDS.has(words[words.length - 1] ?? '')) return Text.camelCase(base);
    const singular = Text.singularizePhrase(base);
    return singular.toLowerCase() === base.toLowerCase() ? Text.camelCase(base) : `${Text.camelCase(singular)}Id`;
  }

  static #fileParamName(row: Row, position: number, file: FileNumber): string {
    const words = Text.letterWords(Http.decodeComponent(file.stem));
    const last = words[words.length - 1];
    return last !== undefined ? Text.camelCase(last) : PathTemplater.#fallbackName(row, position, 'integer');
  }

  static #ancestor(row: Row, position: number): string {
    for (let i = position - 1; i >= 0; i--) {
      if (row.open[i] || row.partial[i]) continue;
      const segment = row.decoded[i] ?? '';
      if (segment !== '' && !PathTemplater.isFixed(segment)) return segment;
    }
    return '';
  }

  static #mergeKinds(kinds: readonly SegmentKind[]): SegmentKind {
    const distinct = new Set(kinds);
    if (distinct.size === 1) return kinds[0] ?? 'literal';
    if (distinct.has('literal')) return 'literal';
    return distinct.has('slug') ? 'slug' : 'token';
  }
}
