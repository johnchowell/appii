export type CharRanges = readonly (readonly [number, number])[];

export type PatternNode =
  | { readonly kind: 'set'; readonly set: CharRanges }
  | { readonly kind: 'seq'; readonly items: readonly PatternNode[] }
  | { readonly kind: 'alt'; readonly options: readonly PatternNode[] }
  | { readonly kind: 'repeat'; readonly body: PatternNode; readonly min: number; readonly max: number }
  | { readonly kind: 'empty' };

interface ParseState {
  readonly source: string;
  index: number;
  readonly hidden: PatternNode[];
}

export class PatternAudit {
  static readonly MAX_CODE_POINT = 0x10ffff;
  static readonly ANY: CharRanges = [[0, 0x10ffff]];
  static readonly DIGIT: CharRanges = [[0x30, 0x39]];
  static readonly WORD: CharRanges = [
    [0x30, 0x39],
    [0x41, 0x5a],
    [0x5f, 0x5f],
    [0x61, 0x7a],
  ];
  static readonly SPACE: CharRanges = [
    [0x09, 0x0d],
    [0x20, 0x20],
    [0xa0, 0xa0],
    [0x1680, 0x1680],
    [0x2000, 0x200a],
    [0x2028, 0x2029],
    [0x202f, 0x202f],
    [0x205f, 0x205f],
    [0x3000, 0x3000],
    [0xfeff, 0xfeff],
  ];
  static readonly LINE_TERMINATORS: CharRanges = [
    [0x0a, 0x0a],
    [0x0d, 0x0d],
    [0x2028, 0x2029],
  ];
  static readonly CONTROL_ESCAPES: Readonly<Record<string, number>> = { t: 0x09, n: 0x0a, v: 0x0b, f: 0x0c, r: 0x0d, '0': 0x00 };
  static readonly FLAGS = 'v';

  unsafe(source: string, flags: string = PatternAudit.FLAGS): boolean {
    try {
      new RegExp(source, flags);
    } catch {
      return false;
    }
    const state: ParseState = { source, index: 0, hidden: [] };
    let root: PatternNode;
    try {
      root = PatternAudit.#alternation(state);
    } catch {
      return true;
    }
    if (state.index < source.length) return true;
    return [root, ...state.hidden].some((node) => PatternAudit.exponential(node));
  }

  static exponential(node: PatternNode): boolean {
    switch (node.kind) {
      case 'seq':
        return node.items.some((item) => PatternAudit.exponential(item));
      case 'alt':
        return node.options.some((option) => PatternAudit.exponential(option));
      case 'repeat':
        if (node.max >= 2 && PatternAudit.#repeatable(node.body)) return true;
        return PatternAudit.exponential(node.body);
      default:
        return false;
    }
  }

  static ambiguous(node: PatternNode): boolean {
    switch (node.kind) {
      case 'seq': {
        if (node.items.some((item) => PatternAudit.ambiguous(item))) return true;
        for (let i = 0; i < node.items.length; i++) {
          const left = node.items[i];
          if (!left || !PatternAudit.#variable(left)) continue;
          for (let j = i + 1; j < node.items.length; j++) {
            const right = node.items[j];
            if (!right) break;
            if (PatternAudit.#variable(right) && PatternAudit.intersects(PatternAudit.last(left), PatternAudit.first(right))) return true;
            if (!PatternAudit.nullable(right)) break;
          }
        }
        return false;
      }
      case 'alt': {
        if (node.options.some((option) => PatternAudit.ambiguous(option))) return true;
        const options = node.options.filter((option) => !PatternAudit.#emptyOnly(option));
        for (let i = 0; i < options.length; i++) {
          for (let j = i + 1; j < options.length; j++) {
            const a = options[i];
            const b = options[j];
            if (a && b && PatternAudit.overlap(a, b)) return true;
          }
        }
        return false;
      }
      case 'repeat':
        return PatternAudit.ambiguous(node.body) || (node.max >= 2 && PatternAudit.#repeatable(node.body));
      default:
        return false;
    }
  }

  static #repeatable(body: PatternNode): boolean {
    if (PatternAudit.#emptyOnly(body)) return false;
    return PatternAudit.ambiguous(body) || PatternAudit.pumpable(body) || PatternAudit.nullable(body) || PatternAudit.shifting(body);
  }

  static shifting(body: PatternNode): boolean {
    const first = PatternAudit.first(body);
    const last = PatternAudit.last(body);
    return PatternAudit.#unbounded(body).some((inner) => {
      const chars = PatternAudit.chars(inner);
      return PatternAudit.intersects(chars, last) && PatternAudit.intersects(chars, first);
    });
  }

  static chars(node: PatternNode): CharRanges {
    switch (node.kind) {
      case 'set':
        return node.set;
      case 'seq':
        return node.items.reduce<CharRanges>((out, item) => PatternAudit.union(out, PatternAudit.chars(item)), []);
      case 'alt':
        return node.options.reduce<CharRanges>((out, option) => PatternAudit.union(out, PatternAudit.chars(option)), []);
      case 'repeat':
        return node.max === 0 ? [] : PatternAudit.chars(node.body);
      default:
        return [];
    }
  }

  static #unbounded(node: PatternNode): PatternNode[] {
    switch (node.kind) {
      case 'seq':
        return node.items.flatMap((item) => PatternAudit.#unbounded(item));
      case 'alt':
        return node.options.flatMap((option) => PatternAudit.#unbounded(option));
      case 'repeat': {
        const inner = PatternAudit.#unbounded(node.body);
        return node.max === Number.POSITIVE_INFINITY && !PatternAudit.#emptyOnly(node.body) ? [node.body, ...inner] : inner;
      }
      default:
        return [];
    }
  }

  static pumpable(node: PatternNode): boolean {
    switch (node.kind) {
      case 'repeat':
        if (PatternAudit.#emptyOnly(node.body)) return false;
        return (node.max > node.min && node.max >= 2) || (node.max >= 1 && PatternAudit.pumpable(node.body));
      case 'seq': {
        const solid = node.items.filter((item) => !PatternAudit.nullable(item));
        if (solid.length === 0) return node.items.some((item) => PatternAudit.pumpable(item));
        const [only] = solid;
        return solid.length === 1 && only !== undefined && PatternAudit.pumpable(only);
      }
      case 'alt':
        return node.options.some((option) => PatternAudit.pumpable(option));
      default:
        return false;
    }
  }

  static overlap(a: PatternNode, b: PatternNode): boolean {
    const fixedA = PatternAudit.#fixed(a);
    const fixedB = PatternAudit.#fixed(b);
    if (fixedA && fixedB) {
      const length = Math.min(fixedA.length, fixedB.length);
      for (let i = 0; i < length; i++) {
        const left = fixedA[i];
        const right = fixedB[i];
        if (!left || !right || !PatternAudit.intersects(left, right)) return false;
      }
      return true;
    }
    return PatternAudit.intersects(PatternAudit.first(a), PatternAudit.first(b));
  }

  static nullable(node: PatternNode): boolean {
    switch (node.kind) {
      case 'set':
        return false;
      case 'seq':
        return node.items.every((item) => PatternAudit.nullable(item));
      case 'alt':
        return node.options.some((option) => PatternAudit.nullable(option));
      case 'repeat':
        return node.min === 0 || PatternAudit.nullable(node.body);
      default:
        return true;
    }
  }

  static first(node: PatternNode): CharRanges {
    return PatternAudit.#edge(node, false);
  }

  static last(node: PatternNode): CharRanges {
    return PatternAudit.#edge(node, true);
  }

  static union(a: CharRanges, b: CharRanges): CharRanges {
    const sorted = [...a, ...b].sort((x, y) => x[0] - y[0]);
    const out: [number, number][] = [];
    for (const [lo, hi] of sorted) {
      const top = out[out.length - 1];
      if (top && lo <= top[1] + 1) top[1] = Math.max(top[1], hi);
      else out.push([lo, hi]);
    }
    return out;
  }

  static complement(ranges: CharRanges): CharRanges {
    const out: [number, number][] = [];
    let next = 0;
    for (const [lo, hi] of PatternAudit.union(ranges, [])) {
      if (lo > next) out.push([next, lo - 1]);
      next = Math.max(next, hi + 1);
    }
    if (next <= PatternAudit.MAX_CODE_POINT) out.push([next, PatternAudit.MAX_CODE_POINT]);
    return out;
  }

  static intersects(a: CharRanges, b: CharRanges): boolean {
    return a.some(([lo, hi]) => b.some(([otherLo, otherHi]) => lo <= otherHi && otherLo <= hi));
  }

  static #edge(node: PatternNode, end: boolean): CharRanges {
    switch (node.kind) {
      case 'set':
        return node.set;
      case 'seq': {
        let out: CharRanges = [];
        const items = end ? [...node.items].reverse() : node.items;
        for (const item of items) {
          out = PatternAudit.union(out, PatternAudit.#edge(item, end));
          if (!PatternAudit.nullable(item)) break;
        }
        return out;
      }
      case 'alt':
        return node.options.reduce<CharRanges>((out, option) => PatternAudit.union(out, PatternAudit.#edge(option, end)), []);
      case 'repeat':
        return node.max === 0 ? [] : PatternAudit.#edge(node.body, end);
      default:
        return [];
    }
  }

  static #variable(node: PatternNode): boolean {
    return node.kind === 'repeat' && node.max > node.min && !PatternAudit.#emptyOnly(node.body);
  }

  static #emptyOnly(node: PatternNode): boolean {
    return PatternAudit.first(node).length === 0;
  }

  static #fixed(node: PatternNode): CharRanges[] | undefined {
    if (node.kind === 'set') return [node.set];
    if (node.kind === 'empty') return [];
    if (node.kind === 'repeat' && node.min === node.max && node.max <= 64) {
      const body = PatternAudit.#fixed(node.body);
      return body === undefined ? undefined : Array.from({ length: node.min }, () => body).flat();
    }
    if (node.kind !== 'seq') return undefined;
    const out: CharRanges[] = [];
    for (const item of node.items) {
      const part = PatternAudit.#fixed(item);
      if (part === undefined) return undefined;
      out.push(...part);
    }
    return out;
  }

  static #alternation(state: ParseState): PatternNode {
    const options: PatternNode[] = [PatternAudit.#sequence(state)];
    while (state.source.charAt(state.index) === '|') {
      state.index++;
      options.push(PatternAudit.#sequence(state));
    }
    return options.length === 1 && options[0] ? options[0] : { kind: 'alt', options };
  }

  static #sequence(state: ParseState): PatternNode {
    const items: PatternNode[] = [];
    while (state.index < state.source.length) {
      const ch = state.source.charAt(state.index);
      if (ch === '|' || ch === ')') break;
      const atom = PatternAudit.#atom(state);
      items.push(PatternAudit.#quantified(state, atom));
    }
    return items.length === 1 && items[0] ? items[0] : { kind: 'seq', items };
  }

  static #quantified(state: ParseState, atom: PatternNode): PatternNode {
    const { source } = state;
    const ch = source.charAt(state.index);
    let min: number;
    let max: number;
    if (ch === '*' || ch === '+' || ch === '?') {
      state.index++;
      min = ch === '+' ? 1 : 0;
      max = ch === '?' ? 1 : Number.POSITIVE_INFINITY;
    } else if (ch === '{') {
      const match = /^\{([0-9]+)(,([0-9]*))?\}/.exec(source.slice(state.index));
      if (!match) throw new SyntaxError('Unexpected { in pattern');
      state.index += match[0].length;
      min = Number(match[1]);
      max = match[2] === undefined ? min : match[3] === '' || match[3] === undefined ? Number.POSITIVE_INFINITY : Number(match[3]);
    } else {
      return atom;
    }
    if (source.charAt(state.index) === '?') state.index++;
    return { kind: 'repeat', body: atom, min, max };
  }

  static #atom(state: ParseState): PatternNode {
    const { source } = state;
    const ch = source.charAt(state.index);
    if (ch === '(') return PatternAudit.#group(state);
    if (ch === '[') return PatternAudit.#class(state);
    if (ch === '\\') return PatternAudit.#escape(state, false);
    if (ch === '^' || ch === '$') {
      state.index++;
      return { kind: 'empty' };
    }
    if (ch === '.') {
      state.index++;
      return { kind: 'set', set: PatternAudit.complement(PatternAudit.LINE_TERMINATORS) };
    }
    const cp = source.codePointAt(state.index) ?? 0;
    state.index += cp > 0xffff ? 2 : 1;
    return { kind: 'set', set: [[cp, cp]] };
  }

  static #group(state: ParseState): PatternNode {
    const { source } = state;
    state.index++;
    let hidden = false;
    if (source.startsWith('?:', state.index)) state.index += 2;
    else if (source.startsWith('?=', state.index) || source.startsWith('?!', state.index)) {
      state.index += 2;
      hidden = true;
    } else if (source.startsWith('?<=', state.index) || source.startsWith('?<!', state.index)) {
      state.index += 3;
      hidden = true;
    } else if (source.startsWith('?<', state.index)) {
      const close = source.indexOf('>', state.index);
      if (close < 0) throw new SyntaxError('Unterminated group name');
      state.index = close + 1;
    } else if (source.charAt(state.index) === '?') {
      const colon = source.indexOf(':', state.index);
      if (colon < 0) throw new SyntaxError('Unknown group');
      state.index = colon + 1;
    }
    const body = PatternAudit.#alternation(state);
    if (source.charAt(state.index) !== ')') throw new SyntaxError('Unterminated group');
    state.index++;
    if (!hidden) return body;
    state.hidden.push(body);
    return { kind: 'empty' };
  }

  static #class(state: ParseState): PatternNode {
    const { source } = state;
    state.index++;
    const negated = source.charAt(state.index) === '^';
    if (negated) state.index++;
    let ranges: CharRanges = [];
    let complex = false;
    let depth = 0;
    while (state.index < source.length) {
      const ch = source.charAt(state.index);
      if (ch === ']' && depth === 0) break;
      if (ch === '[') {
        complex = true;
        depth++;
        state.index++;
        continue;
      }
      if (ch === ']') {
        depth--;
        state.index++;
        continue;
      }
      if (source.startsWith('&&', state.index) || source.startsWith('--', state.index)) {
        complex = true;
        state.index += 2;
        continue;
      }
      if (ch === '\\' && source.charAt(state.index + 1) === 'q') {
        complex = true;
        const close = source.indexOf('}', state.index);
        if (close < 0) throw new SyntaxError('Unterminated class string');
        state.index = close + 1;
        continue;
      }
      const low = PatternAudit.#classAtom(state);
      if (source.charAt(state.index) === '-' && source.charAt(state.index + 1) !== ']' && low.length === 1 && low[0] && low[0][0] === low[0][1]) {
        state.index++;
        const high = PatternAudit.#classAtom(state);
        const start = low[0][0];
        const end = high.length === 1 && high[0] && high[0][0] === high[0][1] ? high[0][0] : start;
        ranges = PatternAudit.union(ranges, [[start, Math.max(start, end)]]);
      } else {
        ranges = PatternAudit.union(ranges, low);
      }
    }
    if (source.charAt(state.index) !== ']') throw new SyntaxError('Unterminated class');
    state.index++;
    if (complex) return { kind: 'set', set: PatternAudit.ANY };
    return { kind: 'set', set: negated ? PatternAudit.complement(ranges) : ranges };
  }

  static #classAtom(state: ParseState): CharRanges {
    if (state.source.charAt(state.index) === '\\') {
      const node = PatternAudit.#escape(state, true);
      return node.kind === 'set' ? node.set : PatternAudit.ANY;
    }
    const cp = state.source.codePointAt(state.index) ?? 0;
    state.index += cp > 0xffff ? 2 : 1;
    return [[cp, cp]];
  }

  static #escape(state: ParseState, inClass: boolean): PatternNode {
    const { source } = state;
    const ch = source.charAt(state.index + 1);
    state.index += 2;
    const set = (ranges: CharRanges): PatternNode => ({ kind: 'set', set: ranges });
    switch (ch) {
      case 'd':
        return set(PatternAudit.DIGIT);
      case 'D':
        return set(PatternAudit.complement(PatternAudit.DIGIT));
      case 'w':
        return set(PatternAudit.WORD);
      case 'W':
        return set(PatternAudit.complement(PatternAudit.WORD));
      case 's':
        return set(PatternAudit.SPACE);
      case 'S':
        return set(PatternAudit.complement(PatternAudit.SPACE));
      case 'b':
        return inClass ? set([[0x08, 0x08]]) : { kind: 'empty' };
      case 'B':
        return { kind: 'empty' };
      case 'p':
      case 'P': {
        const close = source.indexOf('}', state.index);
        if (close < 0) throw new SyntaxError('Unterminated property escape');
        state.index = close + 1;
        return set(PatternAudit.ANY);
      }
      case 'k': {
        const close = source.indexOf('>', state.index);
        if (close < 0) throw new SyntaxError('Unterminated group reference');
        state.index = close + 1;
        return { kind: 'repeat', body: set(PatternAudit.ANY), min: 0, max: Number.POSITIVE_INFINITY };
      }
      case 'x': {
        const hex = source.slice(state.index, state.index + 2);
        state.index += 2;
        const cp = parseInt(hex, 16);
        return set([[cp, cp]]);
      }
      case 'u': {
        if (source.charAt(state.index) === '{') {
          const close = source.indexOf('}', state.index);
          if (close < 0) throw new SyntaxError('Unterminated code point escape');
          const cp = parseInt(source.slice(state.index + 1, close), 16);
          state.index = close + 1;
          return set([[cp, cp]]);
        }
        const cp = parseInt(source.slice(state.index, state.index + 4), 16);
        state.index += 4;
        return set([[cp, cp]]);
      }
      case 'c': {
        const cp = (source.charCodeAt(state.index) || 0) % 32;
        state.index++;
        return set([[cp, cp]]);
      }
      default: {
        if (!inClass && /^[1-9]$/.test(ch)) {
          while (/^[0-9]$/.test(source.charAt(state.index))) state.index++;
          return { kind: 'repeat', body: set(PatternAudit.ANY), min: 0, max: Number.POSITIVE_INFINITY };
        }
        const control = PatternAudit.CONTROL_ESCAPES[ch];
        if (control !== undefined) return set([[control, control]]);
        const cp = source.codePointAt(state.index - 1) ?? 0;
        if (cp > 0xffff) state.index++;
        return set([[cp, cp]]);
      }
    }
  }
}
