import { Json, Text } from '../shared/index.js';

export interface ValueEcho {
  readonly key: string;
  readonly identifier: boolean;
  readonly depth: number;
  readonly exact: boolean;
}

export class IdentifierIndex {
  static readonly IDENTIFIER_WORDS: ReadonlySet<string> = new Set(['id', 'uuid', 'guid', 'slug', 'key', 'code', 'handle', 'login', 'username']);
  static readonly MAX_DEPTH = 8;
  static readonly MAX_VALUE_LENGTH = 200;
  static readonly MAX_ITEMS = 500;
  static readonly LOOSE_SEPARATORS: RegExp = /[\s_+-]+/g;

  readonly #first = new Map<string, number>();

  static create(): IdentifierIndex {
    return new IdentifierIndex();
  }

  static isIdentifierKey(key: string): boolean {
    const words = Text.words(key);
    const last = words[words.length - 1];
    return last !== undefined && IdentifierIndex.IDENTIFIER_WORDS.has(last);
  }

  static echo(value: unknown, segment: string): ValueEcho | undefined {
    if (segment === '' || segment.length > IdentifierIndex.MAX_VALUE_LENGTH) return undefined;
    const loose = IdentifierIndex.#loose(segment);
    let best: ValueEcho | undefined;
    IdentifierIndex.#visit(value, '', 0, (key, leaf, depth) => {
      const text = IdentifierIndex.#text(leaf);
      if (text === undefined || key === '') return;
      const exact = text === segment;
      if (!exact && IdentifierIndex.#loose(text) !== loose) return;
      const candidate: ValueEcho = { key, identifier: IdentifierIndex.isIdentifierKey(key), depth, exact };
      if (!best || IdentifierIndex.#better(candidate, best)) best = candidate;
    });
    return best;
  }

  add(value: unknown, at: number): void {
    IdentifierIndex.#visit(value, '', 0, (key, leaf) => {
      if (typeof leaf !== 'string' || leaf === '' || leaf.length > IdentifierIndex.MAX_VALUE_LENGTH || !IdentifierIndex.isIdentifierKey(key)) return;
      const known = this.#first.get(leaf);
      if (known === undefined || at < known) this.#first.set(leaf, at);
    });
  }

  seenBefore(value: string, at: number): boolean {
    const first = this.#first.get(value);
    return first !== undefined && first < at;
  }

  static #better(a: ValueEcho, b: ValueEcho): boolean {
    if (a.depth !== b.depth) return a.depth < b.depth;
    if (a.exact !== b.exact) return a.exact;
    return a.identifier && !b.identifier;
  }

  static #loose(text: string): string {
    return text.replace(IdentifierIndex.LOOSE_SEPARATORS, ' ').trim().toLowerCase();
  }

  static #text(leaf: unknown): string | undefined {
    if (typeof leaf === 'string') return leaf;
    if (typeof leaf === 'number' && Number.isSafeInteger(leaf)) return String(leaf);
    return undefined;
  }

  static #visit(value: unknown, key: string, depth: number, visitor: (key: string, leaf: unknown, depth: number) => void): void {
    if (depth > IdentifierIndex.MAX_DEPTH) return;
    if (Array.isArray(value)) {
      for (const item of value.slice(0, IdentifierIndex.MAX_ITEMS)) IdentifierIndex.#visit(item, key, depth, visitor);
      return;
    }
    if (Json.isPlainObject(value)) {
      for (const [name, child] of Object.entries(value)) IdentifierIndex.#visit(child, name, depth + 1, visitor);
      return;
    }
    visitor(key, value, depth);
  }
}
