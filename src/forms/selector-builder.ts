import type { HtmlDocument, HtmlElement } from './html-document.js';
import { HtmlMicrosyntax } from './html-microsyntax.js';

export class SelectorBuilder {
  static readonly ROOT = ':root';

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
    const forms = doc.allElements.filter((element) => doc.isHtml(element, 'form'));
    const id = doc.attr(form, 'id');
    if (id) {
      const key = HtmlMicrosyntax.asciiLower(id);
      const sameId = forms.filter((candidate) => HtmlMicrosyntax.asciiLower(doc.attr(candidate, 'id') ?? '') === key);
      if (sameId.length === 1) return `form#${SelectorBuilder.escapeIdentifier(id)}`;
    }
    const name = doc.attr(form, 'name');
    if (name) {
      const sameName = forms.filter((candidate) => doc.attr(candidate, 'name') === name);
      if (sameName.length === 1) return `form[name=${SelectorBuilder.escapeString(name)}]`;
    }
    return this.path(doc, form);
  }

  path(doc: HtmlDocument, element: HtmlElement): string {
    const idCounts = this.#idCounts(doc);
    const steps: string[] = [];
    for (let current: HtmlElement | null = element; current; ) {
      const parent = doc.parentElement(current);
      if (!parent) {
        steps.unshift(SelectorBuilder.ROOT);
        break;
      }
      const id = doc.attr(current, 'id');
      if (current !== element && id && idCounts.get(HtmlMicrosyntax.asciiLower(id)) === 1) {
        steps.unshift(`#${SelectorBuilder.escapeIdentifier(id)}`);
        break;
      }
      const position = doc.children(parent).indexOf(current) + 1;
      steps.unshift(`${SelectorBuilder.escapeIdentifier(current.name)}:nth-child(${position})`);
      current = parent;
    }
    return steps.join(' > ');
  }

  #idCounts(doc: HtmlDocument): Map<string, number> {
    const counts = new Map<string, number>();
    for (const element of doc.allElements) {
      const id = doc.attr(element, 'id');
      if (!id) continue;
      const key = HtmlMicrosyntax.asciiLower(id);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  }

  static #codePoint(code: number): string {
    return `\\${code.toString(16)} `;
  }
}
