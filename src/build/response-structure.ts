import { createHash } from 'node:crypto';
import { HtmlDocument } from '../forms/index.js';
import type { HtmlNode } from '../forms/index.js';
import { Json, isAppiiError } from '../shared/index.js';
import type { ParsedBody } from './body-parser.js';

export type StructureKind = 'html' | 'json';

export interface StructureSignature {
  readonly kind: StructureKind;
  readonly digest: string;
  readonly keys: readonly string[];
}

export class ResponseStructure {
  static readonly HTML_LEVELS_BELOW_BODY = 5;
  static readonly ROOT_ELEMENTS: ReadonlySet<string> = new Set(['html', 'body']);
  static readonly SKIPPED_ELEMENTS: ReadonlySet<string> = new Set(['head', 'script', 'style', 'noscript', 'template']);
  static readonly JSON_DEPTH = 3;
  static readonly JSON_ITEMS = 50;
  static readonly JSON_OVERLAP = 0.8;
  static readonly ARRAY_STEP = '[]';
  static readonly MAP_KEY = '*';
  static readonly DIGITS = '#';
  static readonly MAP_KEY_PATTERN: RegExp = /^(?:[0-9]+|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;

  of(body: ParsedBody | undefined, url: string): StructureSignature | undefined {
    if (!body || body.value === undefined) return undefined;
    if (body.kind === 'html' && typeof body.value === 'string') return this.html(body.value, url);
    if (body.kind === 'json') return this.json(body.value);
    return undefined;
  }

  html(text: string, url: string): StructureSignature | undefined {
    let doc: HtmlDocument;
    try {
      doc = HtmlDocument.parse(text, url);
    } catch (err) {
      if (isAppiiError(err)) return undefined;
      throw err;
    }
    const paths = new Set<string>();
    ResponseStructure.#walk(doc.root, '', 0, paths);
    return paths.size === 0 ? undefined : ResponseStructure.#signature('html', paths);
  }

  json(value: unknown): StructureSignature | undefined {
    const keys = new Set<string>();
    ResponseStructure.#keys(value, '', 0, keys);
    return keys.size === 0 ? undefined : ResponseStructure.#signature('json', keys);
  }

  static alike(a: StructureSignature, b: StructureSignature): boolean {
    if (a.kind !== b.kind) return false;
    if (a.digest === b.digest) return true;
    if (a.kind === 'html') return false;
    const other = new Set(b.keys);
    const shared = a.keys.filter((key) => other.has(key)).length;
    return shared >= ResponseStructure.JSON_OVERLAP * Math.min(a.keys.length, b.keys.length);
  }

  static #signature(kind: StructureKind, items: ReadonlySet<string>): StructureSignature {
    const keys = [...items].sort();
    return { kind, digest: createHash('sha256').update(keys.join('\n')).digest('hex'), keys };
  }

  static #walk(node: HtmlNode, prefix: string, depth: number, out: Set<string>): void {
    for (const child of node.children ?? []) {
      if (!HtmlDocument.isElement(child)) continue;
      const name = child.name.toLowerCase();
      if (ResponseStructure.SKIPPED_ELEMENTS.has(name)) continue;
      const path = `${prefix}>${ResponseStructure.#label(name, child.attribs.class)}`;
      out.add(path);
      if (depth < ResponseStructure.HTML_LEVELS_BELOW_BODY + 1) ResponseStructure.#walk(child, path, depth + 1, out);
    }
  }

  static #label(name: string, classes: string | undefined): string {
    if (ResponseStructure.ROOT_ELEMENTS.has(name) || classes === undefined) return name;
    const tokens = [...new Set(classes.split(/[\t\n\f\r ]+/).filter((token) => token !== '').map((token) => token.replace(/[0-9]+/g, ResponseStructure.DIGITS)))].sort();
    return tokens.length === 0 ? name : `${name}.${tokens.join('.')}`;
  }

  static #keys(value: unknown, prefix: string, depth: number, out: Set<string>): void {
    if (Array.isArray(value)) {
      const path = `${prefix}${ResponseStructure.ARRAY_STEP}`;
      for (const item of value.slice(0, ResponseStructure.JSON_ITEMS)) ResponseStructure.#keys(item, path, depth, out);
      return;
    }
    if (!Json.isPlainObject(value)) return;
    for (const [key, child] of Object.entries(value)) {
      const path = `${prefix}.${ResponseStructure.MAP_KEY_PATTERN.test(key) ? ResponseStructure.MAP_KEY : key}`;
      out.add(path);
      if (depth + 1 < ResponseStructure.JSON_DEPTH) ResponseStructure.#keys(child, path, depth + 1, out);
    }
  }
}
