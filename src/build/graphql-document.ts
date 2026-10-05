import { Json } from '../shared/index.js';

export type GraphqlOperationType = 'query' | 'mutation' | 'subscription';

export interface GraphqlOperation {
  type: GraphqlOperationType;
  name?: string;
}

export class GraphqlDocument {
  static readonly OPERATION_TYPES: ReadonlySet<string> = new Set(['query', 'mutation', 'subscription']);
  static readonly DEFINITION_KEYWORDS: ReadonlySet<string> = new Set(['query', 'mutation', 'subscription', 'fragment']);
  static readonly IGNORED: RegExp = /[\s,\ufeff]/;
  static readonly FRAGMENT = 'fragment';
  static readonly TYPE_CONDITION = 'on';
  static readonly SPREAD = '...';
  static readonly NAME_START: RegExp = /[_A-Za-z]/;
  static readonly NAME_CONTINUE: RegExp = /[_0-9A-Za-z]/;
  static readonly BRACKETS_OPEN = '{([';
  static readonly BRACKETS_CLOSE = '})]';

  static looksLikeDocument(text: string): boolean {
    let i = GraphqlDocument.#skipIgnored(text, 0);
    if (text.charAt(i) === '{') {
      i = GraphqlDocument.#skipIgnored(text, i + 1);
      return GraphqlDocument.NAME_START.test(text.charAt(i)) || text.startsWith(GraphqlDocument.SPREAD, i);
    }
    const keyword = GraphqlDocument.#name(text, i);
    if (keyword === undefined || !GraphqlDocument.DEFINITION_KEYWORDS.has(keyword)) return false;
    i = GraphqlDocument.#skipIgnored(text, i + keyword.length);
    if (keyword === GraphqlDocument.FRAGMENT) {
      const name = GraphqlDocument.#name(text, i);
      if (name === undefined || name === GraphqlDocument.TYPE_CONDITION) return false;
      i = GraphqlDocument.#skipIgnored(text, i + name.length);
      if (GraphqlDocument.#name(text, i) !== GraphqlDocument.TYPE_CONDITION) return false;
      i = GraphqlDocument.#skipIgnored(text, i + GraphqlDocument.TYPE_CONDITION.length);
      const type = GraphqlDocument.#name(text, i);
      if (type === undefined) return false;
      i = GraphqlDocument.#skipIgnored(text, i + type.length);
    } else {
      const name = GraphqlDocument.#name(text, i);
      if (name !== undefined) i = GraphqlDocument.#skipIgnored(text, i + name.length);
      if (text.charAt(i) === '(') {
        const end = GraphqlDocument.#closing(text, i);
        if (end < 0) return false;
        i = GraphqlDocument.#skipIgnored(text, end + 1);
      }
    }
    while (text.charAt(i) === '@') {
      const directive = GraphqlDocument.#name(text, i + 1);
      if (directive === undefined) return false;
      i = GraphqlDocument.#skipIgnored(text, i + 1 + directive.length);
      if (text.charAt(i) === '(') {
        const end = GraphqlDocument.#closing(text, i);
        if (end < 0) return false;
        i = GraphqlDocument.#skipIgnored(text, end + 1);
      }
    }
    return text.charAt(i) === '{';
  }

  static isPersistedQuery(extensions: unknown): boolean {
    return Json.isPlainObject(extensions) && Json.isPlainObject(extensions.persistedQuery);
  }

  static #skipIgnored(text: string, start: number): number {
    const n = text.length;
    let i = start;
    while (i < n) {
      const ch = text.charAt(i);
      if (ch === '#') {
        while (i < n && text.charAt(i) !== '\n' && text.charAt(i) !== '\r') i++;
      } else if (GraphqlDocument.IGNORED.test(ch)) {
        i++;
      } else {
        break;
      }
    }
    return i;
  }

  static #name(text: string, start: number): string | undefined {
    if (!GraphqlDocument.NAME_START.test(text.charAt(start))) return undefined;
    let end = start + 1;
    while (end < text.length && GraphqlDocument.NAME_CONTINUE.test(text.charAt(end))) end++;
    return text.slice(start, end);
  }

  static #closing(text: string, open: number): number {
    let depth = 0;
    for (let i = open; i < text.length; ) {
      const ch = text.charAt(i);
      if (ch === '"') {
        i = GraphqlDocument.#skipString(text, i);
        continue;
      }
      if (ch === '#') {
        i = GraphqlDocument.#skipIgnored(text, i);
        continue;
      }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return i;
      }
      i++;
    }
    return -1;
  }

  static operations(source: string): GraphqlOperation[] {
    const tokens = GraphqlDocument.#tokens(source);
    const operations: GraphqlOperation[] = [];
    let depth = 0;
    let pending = false;
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (GraphqlDocument.BRACKETS_OPEN.includes(token)) {
        if (depth === 0 && token === '{') {
          if (!pending) operations.push({ type: 'query' });
          pending = false;
        }
        depth++;
        continue;
      }
      if (GraphqlDocument.BRACKETS_CLOSE.includes(token)) {
        depth = Math.max(0, depth - 1);
        continue;
      }
      if (depth > 0 || pending) continue;
      if (GraphqlDocument.OPERATION_TYPES.has(token)) {
        const operation: GraphqlOperation = { type: token as GraphqlOperationType };
        const next = tokens[i + 1];
        if (next !== undefined && GraphqlDocument.NAME_START.test(next.charAt(0))) {
          operation.name = next;
          i++;
        }
        operations.push(operation);
        pending = true;
      } else if (token === 'fragment') {
        pending = true;
      }
    }
    return operations;
  }

  static operationName(source: string, given?: unknown): string | undefined {
    if (typeof given === 'string' && given !== '') return given;
    const operations = GraphqlDocument.operations(source);
    return operations.length === 1 ? operations[0]?.name : undefined;
  }

  static #tokens(source: string): string[] {
    const out: string[] = [];
    const n = source.length;
    let i = 0;
    while (i < n) {
      const ch = source.charAt(i);
      if (ch === '#') {
        while (i < n && source.charAt(i) !== '\n' && source.charAt(i) !== '\r') i++;
        continue;
      }
      if (ch === '"') {
        i = GraphqlDocument.#skipString(source, i);
        continue;
      }
      if (GraphqlDocument.BRACKETS_OPEN.includes(ch) || GraphqlDocument.BRACKETS_CLOSE.includes(ch)) {
        out.push(ch);
        i++;
        continue;
      }
      if (GraphqlDocument.NAME_START.test(ch)) {
        let j = i + 1;
        while (j < n && GraphqlDocument.NAME_CONTINUE.test(source.charAt(j))) j++;
        out.push(source.slice(i, j));
        i = j;
        continue;
      }
      if (ch === '-' || (ch >= '0' && ch <= '9')) {
        let j = i + 1;
        while (j < n && /[0-9.eE+\-_A-Za-z]/.test(source.charAt(j))) j++;
        i = j;
        continue;
      }
      i++;
    }
    return out;
  }

  static #skipString(source: string, start: number): number {
    const n = source.length;
    if (source.startsWith('"""', start)) {
      let i = start + 3;
      while (i < n && !source.startsWith('"""', i)) i += source.startsWith('\\"""', i) ? 4 : 1;
      return Math.min(n, i + 3);
    }
    let i = start + 1;
    while (i < n) {
      const ch = source.charAt(i);
      if (ch === '"' || ch === '\n' || ch === '\r') return i + 1;
      i += ch === '\\' ? 2 : 1;
    }
    return n;
  }
}
