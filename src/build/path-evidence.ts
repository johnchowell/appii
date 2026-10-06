import type { ValueEcho } from './identifier-index.js';
import type { StructureSignature } from './response-structure.js';

export interface PathObservation {
  readonly method: string;
  readonly status?: number;
  readonly mime: string;
  readonly structure?: StructureSignature;
  readonly query: readonly string[];
}

export interface PathEvidence {
  readonly forms: ReadonlySet<string>;
  readonly names: ReadonlySet<string>;
  readonly observations?: readonly PathObservation[];
  readonly references?: ReadonlySet<number>;
  readonly echoes?: ReadonlyMap<number, readonly ValueEcho[]>;
}
