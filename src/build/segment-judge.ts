import type { PathObservation } from './path-evidence.js';
import { ResponseStructure } from './response-structure.js';

export interface ValueProfile {
  readonly value: string;
  readonly idLike: boolean;
  readonly pinned: boolean;
  readonly observations: readonly PathObservation[];
  readonly reference: boolean;
  readonly identifierEcho: boolean;
}

export interface BucketDecision {
  readonly open: ReadonlySet<string>;
  readonly pin: ReadonlySet<string>;
}

export type ValueRelation = 'alike' | 'conflict' | 'neutral';

export class SegmentJudge {
  static readonly MIN_VARYING_VALUES = 2;
  static readonly MIN_REFERENCES_TO_PIN = 2;

  static isSuccess(observation: PathObservation): boolean {
    return observation.status !== undefined && observation.status >= 200 && observation.status < 300;
  }

  static relation(a: ValueProfile, b: ValueProfile): ValueRelation {
    const left = SegmentJudge.#successes(a);
    const right = SegmentJudge.#successes(b);
    let alike = false;
    let conflict = false;
    for (const [method, mine] of left) {
      const theirs = right.get(method);
      if (!theirs) continue;
      let compatible = false;
      for (const x of mine) {
        for (const y of theirs) {
          if (x.mime !== y.mime) continue;
          if (x.structure && y.structure) {
            if (!ResponseStructure.alike(x.structure, y.structure)) continue;
            alike = true;
          }
          compatible = true;
        }
      }
      if (!compatible) conflict = true;
    }
    if (conflict) return 'conflict';
    return alike ? 'alike' : 'neutral';
  }

  static fingerprint(profile: ValueProfile): string {
    const parts = profile.observations.filter((observation) => SegmentJudge.isSuccess(observation)).map((observation) => `${observation.method} ${observation.mime} ${observation.structure?.digest ?? ''}`);
    return JSON.stringify([...new Set(parts)].sort());
  }

  decide(profiles: readonly ValueProfile[], idShape: boolean): BucketDecision | undefined {
    const candidates = profiles.filter((profile) => !profile.pinned && (!idShape || profile.idLike));
    const core = SegmentJudge.#core(candidates);
    if (core.length === 0) return undefined;
    const members = new Set(core);
    const eligible = new Set(candidates);
    const representatives = SegmentJudge.#representatives(core);
    const open = new Set<string>();
    const pin = new Set<string>();
    for (const profile of profiles) {
      const joins = members.has(profile) || (eligible.has(profile) && SegmentJudge.#joins(profile, core, representatives));
      (joins ? open : pin).add(profile.value);
    }
    return { open, pin };
  }

  static #core(candidates: readonly ValueProfile[]): ValueProfile[] {
    const ordered = [...candidates].sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
    const groups: { members: ValueProfile[]; representatives: Map<string, ValueProfile> }[] = [];
    for (const profile of ordered.filter((candidate) => SegmentJudge.#structured(candidate))) {
      const print = SegmentJudge.fingerprint(profile);
      const group = groups.find(({ members, representatives }) => {
        const [first] = members;
        if (first === undefined || SegmentJudge.relation(first, profile) !== 'alike') return false;
        return representatives.has(print) || [...representatives.values()].every((member) => SegmentJudge.relation(member, profile) !== 'conflict');
      });
      if (group) {
        group.members.push(profile);
        if (!group.representatives.has(print)) group.representatives.set(print, profile);
      } else {
        groups.push({ members: [profile], representatives: new Map([[print, profile]]) });
      }
    }
    let best: ValueProfile[] = [];
    for (const group of groups) if (group.members.length > best.length) best = group.members;
    if (best.length >= SegmentJudge.MIN_VARYING_VALUES) return best;
    const ids = SegmentJudge.#compatible(ordered.filter((profile) => profile.idLike));
    if (ids.length >= SegmentJudge.MIN_VARYING_VALUES) return ids;
    return SegmentJudge.#compatible(ordered.filter((profile) => profile.reference || profile.identifierEcho));
  }

  static #representatives(profiles: readonly ValueProfile[]): ValueProfile[] {
    const out = new Map<string, ValueProfile>();
    for (const profile of profiles) {
      const print = SegmentJudge.fingerprint(profile);
      if (!out.has(print)) out.set(print, profile);
    }
    return [...out.values()];
  }

  static #compatible(profiles: readonly ValueProfile[]): ValueProfile[] {
    const kept: ValueProfile[] = [];
    const prints = new Map<string, ValueProfile>();
    for (const profile of profiles) {
      const print = SegmentJudge.fingerprint(profile);
      if (!prints.has(print) && ![...prints.values()].every((other) => SegmentJudge.relation(other, profile) !== 'conflict')) continue;
      kept.push(profile);
      if (!prints.has(print)) prints.set(print, profile);
    }
    return kept;
  }

  static #structured(profile: ValueProfile): boolean {
    return profile.observations.some((observation) => SegmentJudge.isSuccess(observation) && observation.structure !== undefined);
  }

  static #successes(profile: ValueProfile): Map<string, PathObservation[]> {
    const out = new Map<string, PathObservation[]>();
    for (const observation of profile.observations) {
      if (!SegmentJudge.isSuccess(observation)) continue;
      const list = out.get(observation.method);
      if (list) list.push(observation);
      else out.set(observation.method, [observation]);
    }
    return out;
  }

  static #joins(profile: ValueProfile, core: readonly ValueProfile[], representatives: readonly ValueProfile[]): boolean {
    if (representatives.some((member) => SegmentJudge.relation(member, profile) === 'conflict')) return false;
    if (!SegmentJudge.#sharesMethod(profile, core)) return false;
    if (SegmentJudge.#queryMismatch(profile, core)) return false;
    return !SegmentJudge.#referenceMismatch(profile, core);
  }

  static #sharesMethod(profile: ValueProfile, core: readonly ValueProfile[]): boolean {
    const methods = new Set(core.flatMap((member) => member.observations.map((observation) => observation.method)));
    return profile.observations.length === 0 || methods.size === 0 || profile.observations.some((observation) => methods.has(observation.method));
  }

  static #queryMismatch(profile: ValueProfile, core: readonly ValueProfile[]): boolean {
    const own = new Set(profile.observations.flatMap((observation) => observation.query));
    if (own.size === 0) return false;
    const shared = new Set(core.flatMap((member) => member.observations.flatMap((observation) => observation.query)));
    if (shared.size === 0) return true;
    return ![...own].some((name) => shared.has(name));
  }

  static #referenceMismatch(profile: ValueProfile, core: readonly ValueProfile[]): boolean {
    if (profile.reference || profile.idLike || !profile.observations.some((observation) => observation.status !== undefined)) return false;
    return core.filter((member) => member.reference).length >= SegmentJudge.MIN_REFERENCES_TO_PIN;
  }
}
