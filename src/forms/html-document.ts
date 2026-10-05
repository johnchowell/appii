import { load } from 'cheerio';
import { AppiiError, Http } from '../shared/index.js';
import { HtmlMicrosyntax } from './html-microsyntax.js';

export interface HtmlNode {
  type: string;
  parent: HtmlNode | null;
  children?: HtmlNode[];
  data?: string;
}

export interface HtmlElement extends HtmlNode {
  name: string;
  attribs: Record<string, string>;
  namespace?: string;
  children: HtmlNode[];
}

export class HtmlDocument {
  static readonly HTML_NAMESPACE = 'http://www.w3.org/1999/xhtml';
  static readonly ELEMENT_TYPES: ReadonlySet<string> = new Set(['tag', 'script', 'style']);
  static readonly BLOCKED_BASE_PROTOCOLS: ReadonlySet<string> = new Set(['data:', 'javascript:']);

  readonly url: string;
  readonly baseUrl: string;
  readonly root: HtmlNode;
  readonly elements: readonly HtmlElement[];
  readonly allElements: readonly HtmlElement[];
  readonly #ids: ReadonlyMap<string, HtmlElement>;

  constructor(root: HtmlNode, url: string) {
    this.root = root;
    this.url = url;
    this.elements = HtmlDocument.#collect(root, false);
    this.allElements = HtmlDocument.#collect(root, true);
    const ids = new Map<string, HtmlElement>();
    for (const element of this.elements) {
      const id = element.attribs.id;
      if (id && !ids.has(id)) ids.set(id, element);
    }
    this.#ids = ids;
    this.baseUrl = this.#frozenBaseUrl();
  }

  static parse(html: string, pageUrl: string): HtmlDocument {
    let url: string;
    try {
      url = new URL(pageUrl).href;
    } catch (cause) {
      throw new AppiiError('BAD_INPUT', `Invalid page URL: ${pageUrl}`, { cause });
    }
    return new HtmlDocument(load(html).root()[0] as unknown as HtmlNode, url);
  }

  static isElement(node: HtmlNode | null | undefined): node is HtmlElement {
    return !!node && HtmlDocument.ELEMENT_TYPES.has(node.type) && typeof (node as HtmlElement).name === 'string';
  }

  isHtml(element: HtmlElement, ...names: string[]): boolean {
    return (element.namespace === undefined || element.namespace === HtmlDocument.HTML_NAMESPACE) && (names.length === 0 || names.includes(element.name));
  }

  attr(element: HtmlElement, name: string): string | undefined {
    return Object.hasOwn(element.attribs, name) ? element.attribs[name] : undefined;
  }

  has(element: HtmlElement, name: string): boolean {
    return Object.hasOwn(element.attribs, name);
  }

  byId(id: string): HtmlElement | undefined {
    return this.#ids.get(id);
  }

  parentElement(element: HtmlNode): HtmlElement | null {
    const parent = element.parent;
    return HtmlDocument.isElement(parent) ? parent : null;
  }

  ancestors(element: HtmlNode): HtmlElement[] {
    const out: HtmlElement[] = [];
    for (let current = this.parentElement(element); current; current = this.parentElement(current)) out.push(current);
    return out;
  }

  closest(element: HtmlNode, name: string): HtmlElement | undefined {
    return this.ancestors(element).find((ancestor) => this.isHtml(ancestor, name));
  }

  children(element: HtmlNode): HtmlElement[] {
    if (HtmlDocument.isElement(element) && this.#isTemplate(element)) return [];
    return (element.children ?? []).filter((child): child is HtmlElement => HtmlDocument.isElement(child));
  }

  descendants(element: HtmlElement, skip?: (element: HtmlElement) => boolean): HtmlElement[] {
    const out: HtmlElement[] = [];
    const stack = [...this.children(element)].reverse();
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) break;
      out.push(current);
      if (skip?.(current)) continue;
      const kids = this.children(current);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as HtmlElement);
    }
    return out;
  }

  text(element: HtmlNode, skip?: (element: HtmlElement) => boolean): string {
    let out = '';
    const stack: HtmlNode[] = [...this.#childNodes(element)].reverse();
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) break;
      if (node.type === 'text') {
        out += node.data ?? '';
        continue;
      }
      if (HtmlDocument.isElement(node) && skip?.(node)) continue;
      if (!HtmlDocument.isElement(node) && node.type !== 'cdata') continue;
      const kids = this.#childNodes(node);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as HtmlNode);
    }
    return out;
  }

  childText(element: HtmlElement): string {
    return element.children
      .filter((child) => child.type === 'text')
      .map((child) => child.data ?? '')
      .join('');
  }

  forms(): HtmlElement[] {
    return this.elements.filter((element) => this.isHtml(element, 'form'));
  }

  resolveUrl(href: string, base: string = this.baseUrl): string | undefined {
    return Http.parseUrl(href, base)?.href;
  }

  actionUrl(value: string | undefined): string {
    const trimmed = value === undefined ? '' : HtmlMicrosyntax.trim(value);
    if (trimmed === '') return this.url;
    return this.resolveUrl(trimmed) ?? trimmed;
  }

  #frozenBaseUrl(): string {
    const base = this.elements.find((element) => this.isHtml(element, 'base') && this.has(element, 'href'));
    if (!base) return this.url;
    const resolved = this.resolveUrl(this.attr(base, 'href') ?? '', this.url);
    if (!resolved) return this.url;
    return HtmlDocument.BLOCKED_BASE_PROTOCOLS.has(new URL(resolved).protocol) ? this.url : resolved;
  }

  #isTemplate(element: HtmlElement): boolean {
    return element.name === 'template' && this.isHtml(element);
  }

  #childNodes(node: HtmlNode): HtmlNode[] {
    if (HtmlDocument.isElement(node) && this.#isTemplate(node)) return [];
    return node.children ?? [];
  }

  static #collect(root: HtmlNode, intoTemplates: boolean): HtmlElement[] {
    const out: HtmlElement[] = [];
    const stack: HtmlNode[] = [...(root.children ?? [])].reverse();
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node) break;
      if (HtmlDocument.isElement(node)) {
        out.push(node);
        const isTemplate = node.name === 'template' && (node.namespace === undefined || node.namespace === HtmlDocument.HTML_NAMESPACE);
        if (isTemplate && !intoTemplates) continue;
      } else if (node.type !== 'root') continue;
      const kids = node.children ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i] as HtmlNode);
    }
    return out;
  }
}
