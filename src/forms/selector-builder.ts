import type { HtmlDocument, HtmlElement, HtmlNode } from './html-document.js';
import { HtmlMicrosyntax } from './html-microsyntax.js';

interface SelectorIndex {
  readonly formIds: ReadonlyMap<string, number>;
  readonly formNames: ReadonlyMap<string, number>;
  readonly ids: ReadonlyMap<string, number>;
  readonly positions: ReadonlyMap<HtmlElement, number>;
}

export class SelectorBuilder {
  static readonly ROOT = ':root';

  readonly #indexes = new WeakMap<HtmlDocument, SelectorIndex>();

  static escapeIdentifier(value: string): string {
    const chars = Array.from(value);
    let out = '';
    chars.forEach((ch, index) => {
      const code = ch.codePointAt(0) ?? 0;
      const isDigit = code >= 0x30 && code <= 0x39;
      if (code === 0) out += SelectorBuilder.#codePoint(0xfffd);
      else if ((code >= 0x01 && code <= 0x1f) || code === 0x7f) out += SelectorBuilder.#codePoint(code);
      else if (index === 0 && isDigit) out += SelectorBuilder.#codePoint(code);
      else if (index === 1 && isDigit && chars[0] === '-') out += SelectorBuilder.#codePoint(code);
      else if (index === 0 && ch === '-' && chars.length === 1) out += '\\-';
      else if (code >= 0x80) out += SelectorBuilder.#codePoint(code);
      else if (ch === '-' || ch === '_' || isDigit || /[A-Za-z]/.test(ch)) out += ch;
      else out += `\\${ch}`;
    });
    return out;
  }

  static escapeString(value: string): string {
    let out = '"';
    for (const ch of value) {
      const code = ch.codePointAt(0) ?? 0;
      if (code === 0) out += SelectorBuilder.#codePoint(0xfffd);
      else if ((code >= 0x01 && code <= 0x1f) || code === 0x7f || code >= 0x80) out += SelectorBuilder.#codePoint(code);
      else if (ch === '"' || ch === '\\') out += `\\${ch}`;
      else out += ch;
    }
    return `${out}"`;
  }

  form(doc: HtmlDocument, form: HtmlElement): string {
    const live = doc.liveSelector(form);
    if (live !== undefined) return live;
    const index = this.#index(doc);
    const id = doc.attr(form, 'id');
    if (id && index.formIds.get(HtmlMicrosyntax.asciiLower(id)) === 1) return `form#${SelectorBuilder.escapeIdentifier(id)}`;
    const name = doc.attr(form, 'name');
    if (name && index.formNames.get(name) === 1) return `form[name=${SelectorBuilder.escapeString(name)}]`;
    return this.path(doc, form);
  }

  path(doc: HtmlDocument, element: HtmlElement): string {
    const index = this.#index(doc);
    const steps: string[] = [];
    for (let current: HtmlElement | null = element; current; ) {
      const parent = doc.parentElement(current);
      if (!parent) {
        steps.unshift(SelectorBuilder.ROOT);
        break;
      }
      const id = doc.attr(current, 'id');
      if (current !== element && id && index.ids.get(HtmlMicrosyntax.asciiLower(id)) === 1) {
        steps.unshift(`#${SelectorBuilder.escapeIdentifier(id)}`);
        break;
      }
      const position = index.positions.get(current) ?? 0;
      steps.unshift(`${SelectorBuilder.escapeIdentifier(current.name)}:nth-child(${position})`);
      current = parent;
    }
    return steps.join(' > ');
  }

  #index(doc: HtmlDocument): SelectorIndex {
    const cached = this.#indexes.get(doc);
    if (cached) return cached;
    const formIds = new Map<string, number>();
    const formNames = new Map<string, number>();
    const ids = new Map<string, number>();
    const positions = new Map<HtmlElement, number>();
    const parents: HtmlNode[] = [doc.root];
    for (const element of doc.allElements) {
      parents.push(element);
      const id = doc.attr(element, 'id');
      if (id) SelectorBuilder.#count(ids, HtmlMicrosyntax.asciiLower(id));
      if (!doc.isHtml(element, 'form')) continue;
      if (id) SelectorBuilder.#count(formIds, HtmlMicrosyntax.asciiLower(id));
      const name = doc.attr(element, 'name');
      if (name) SelectorBuilder.#count(formNames, name);
    }
    for (const parent of parents) doc.children(parent).forEach((child, i) => positions.set(child, i + 1));
    const index: SelectorIndex = { formIds, formNames, ids, positions };
    this.#indexes.set(doc, index);
    return index;
  }

  static #count(counts: Map<string, number>, key: string): void {
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }

  static #codePoint(code: number): string {
    return `\\${code.toString(16)} `;
  }
}
