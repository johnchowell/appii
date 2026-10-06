import type { Exchange } from '../model/index.js';
import { Http, Json } from '../shared/index.js';
import type { ParsedBody } from './body-parser.js';
import type { Signature } from './exchange-signature.js';
import { Helpers } from './helpers.js';
import { IdentifierIndex } from './identifier-index.js';
import type { ValueEcho } from './identifier-index.js';
import type { PathEvidence, PathObservation } from './path-evidence.js';
import { PathTemplater } from './path-templater.js';
import { ResponseStructure } from './response-structure.js';

export interface EvidenceSource {
  readonly exchange: Exchange;
  readonly signature: Signature;
  readonly response: ParsedBody | undefined;
}

export type CredentialLookup = (exchange: Exchange) => readonly string[];

export interface PathEvidenceCollectorDeps {
  structures?: ResponseStructure;
}

interface Entry {
  readonly forms: Set<string>;
  readonly names: Set<string>;
  readonly observations: PathObservation[];
  readonly references: Set<number>;
  readonly echoes: Map<number, ValueEcho[]>;
}

export class PathEvidenceCollector {
  static readonly OPERATION_METHODS: ReadonlySet<string> = new Set(['POST']);
  static readonly FIELD_BODY_KINDS: ReadonlySet<string> = new Set(['form', 'multipart', 'json']);
  static readonly NO_CREDENTIALS: CredentialLookup = () => [];

  readonly #structures: ResponseStructure;

  constructor(deps: PathEvidenceCollectorDeps = {}) {
    this.#structures = deps.structures ?? new ResponseStructure();
  }

  static create(): PathEvidenceCollector {
    return new PathEvidenceCollector({ structures: new ResponseStructure() });
  }

  static isSuccess(exchange: Exchange): boolean {
    const status = exchange.response?.status;
    return status !== undefined && status >= 200 && status < 300;
  }

  static mayVary(path: string): boolean {
    const segments = PathTemplater.segments(path).map((segment) => Http.decodeComponent(segment));
    return segments.some((segment, i) => {
      const parent = segments[i - 1];
      return i > 0 && segment !== '' && !PathTemplater.isFixed(segment) && parent !== undefined && parent !== '' && !PathTemplater.isFixed(parent);
    });
  }

  collect(
    sources: readonly EvidenceSource[],
    forms: ReadonlyMap<string, PathEvidence> = new Map(),
    credentials: CredentialLookup = PathEvidenceCollector.NO_CREDENTIALS,
  ): Map<string, Map<string, PathEvidence>> {
    const index = new IdentifierIndex();
    for (const { exchange, response } of sources) {
      if (PathEvidenceCollector.isSuccess(exchange) && response?.kind === 'json') index.add(response.value, Helpers.startMs(exchange) + exchange.durationMs);
    }
    const out = new Map<string, Map<string, Entry>>();
    for (const source of sources) {
      const { signature } = source;
      const entry = PathEvidenceCollector.#entry(out, signature.origin, signature.path);
      const varies = PathEvidenceCollector.mayVary(signature.path);
      entry.observations.push(this.#observation(source, varies, credentials(source.exchange)));
      if (varies) PathEvidenceCollector.#identifiers(entry, source, index);
      const body = signature.request;
      if (!PathEvidenceCollector.OPERATION_METHODS.has(signature.method) || !PathEvidenceCollector.FIELD_BODY_KINDS.has(body.kind) || !Json.isPlainObject(body.value)) continue;
      for (const name of Object.keys(body.value)) entry.names.add(name);
    }
    for (const [target, found] of forms) {
      const url = Helpers.httpUrl(target);
      if (!url || !out.has(url.origin)) continue;
      const known = PathEvidenceCollector.#entry(out, url.origin, url.pathname);
      for (const form of found.forms) known.forms.add(form);
      for (const name of found.names) known.names.add(name);
    }
    return out;
  }

  #observation(source: EvidenceSource, varies: boolean, credentials: readonly string[]): PathObservation {
    const { exchange, signature, response } = source;
    const status = exchange.response?.status;
    const mime = response?.mimeType ?? Http.mimeEssence(exchange.response ? Http.getHeader(exchange.response.headers, 'content-type') : undefined);
    const structure = varies && PathEvidenceCollector.isSuccess(exchange) ? this.#structures.of(response, exchange.request.url) : undefined;
    return {
      method: signature.method,
      ...(status !== undefined ? { status } : {}),
      mime,
      ...(structure ? { structure } : {}),
      query: Helpers.distinct([...signature.url.searchParams.keys()]),
      ...(credentials.length > 0 ? { credentials: [...credentials] } : {}),
    };
  }

  static #identifiers(entry: Entry, source: EvidenceSource, index: IdentifierIndex): void {
    const { exchange, signature, response } = source;
    const at = Helpers.startMs(exchange);
    const echoed = PathEvidenceCollector.isSuccess(exchange) && response?.kind === 'json' && response.value !== undefined;
    PathTemplater.segments(signature.path).forEach((segment, position) => {
      const value = Http.decodeComponent(segment);
      if (position < 1 || value === '' || PathTemplater.isFixed(value)) return;
      if (index.seenBefore(value, at)) entry.references.add(position);
      const echo = echoed ? IdentifierIndex.echo(response.value, value) : undefined;
      if (!echo) return;
      const list = entry.echoes.get(position);
      if (list) list.push(echo);
      else entry.echoes.set(position, [echo]);
    });
  }

  static #entry(out: Map<string, Map<string, Entry>>, origin: string, path: string): Entry {
    const byPath = out.get(origin) ?? new Map<string, Entry>();
    out.set(origin, byPath);
    const found = byPath.get(path) ?? { forms: new Set<string>(), names: new Set<string>(), observations: [], references: new Set<number>(), echoes: new Map<number, ValueEcho[]>() };
    byPath.set(path, found);
    return found;
  }
}
