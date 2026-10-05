import { AppiiError, Http } from '../shared/index.js';
import { ControlRules } from './control-rules.js';
import { HtmlMicrosyntax } from './html-microsyntax.js';
import { HtmlTreeBuilder } from './html-tree-builder.js';

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
  static readonly LIVE_FORM_INDEX = 'data-appii-form-index';
  static readonly LIVE_FORM_OWNER = 'data-appii-form-owner';
  static readonly LIVE_SELECTOR = 'data-appii-selector';
  static readonly LIVE_INDEX_PATTERN: RegExp = /^[0-9]+$/;
  static readonly META_CHARSET: RegExp = /charset[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r ;"']+))/i;
  static readonly HTTP_EQUIV_CONTENT_TYPE = 'content-type';
  static readonly PRESCAN_REPLACEMENTS: ReadonlyMap<string, string> = new Map([
    ['UTF-16BE', 'UTF-8'],
    ['UTF-16LE', 'UTF-8'],
    ['x-user-defined', 'windows-1252'],
  ]);
  static readonly SHADOW_ROOT_MODE = 'shadowrootmode';
  static readonly SHADOW_ROOT_MODES: ReadonlySet<string> = new Set(['open', 'closed']);
  static readonly SHADOW_HOST_NAMES: ReadonlySet<string> = new Set([
    'article', 'aside', 'blockquote', 'body', 'div', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'main', 'nav', 'p', 'section', 'span',
  ]);
  static readonly RESERVED_CUSTOM_NAMES: ReadonlySet<string> = new Set([
    'annotation-xml', 'color-profile', 'font-face', 'font-face-src', 'font-face-uri', 'font-face-format', 'font-face-name', 'missing-glyph',
  ]);
  static readonly CUSTOM_ELEMENT_NAME: RegExp = /^[a-z][^\x00-\x20\x41-\x5a]*-[^\x00-\x20\x41-\x5a]*$/;

  readonly url: string;
  readonly baseUrl: string;
  readonly encoding: string;
  readonly root: HtmlNode;
  readonly elements: readonly HtmlElement[];
  readonly allElements: readonly HtmlElement[];
  readonly shadowRoots: readonly HtmlNode[];
  readonly #hosts: ReadonlyMap<HtmlNode, HtmlElement>;
  readonly #shadowTemplates: ReadonlySet<HtmlElement>;
  readonly #scopes: ReadonlyMap<HtmlElement, HtmlNode>;
  readonly #ids: ReadonlyMap<HtmlNode, ReadonlyMap<string, HtmlElement>>;
  readonly #parserOwners: ReadonlyMap<HtmlElement, HtmlElement>;
  #forms: readonly HtmlElement[] | undefined;
  #liveForms: ReadonlyMap<number, HtmlElement> | undefined;

  constructor(root: HtmlNode, url: string, parserOwners: ReadonlyMap<HtmlElement, HtmlElement> = new Map(), encoding?: string) {
    this.root = root;
    this.url = url;
    this.#parserOwners = parserOwners;
    const hosts = new Map<HtmlNode, HtmlElement>();
    const shadowTemplates = new Set<HtmlElement>();
    const scopes = new Map<HtmlElement, HtmlNode>();
    this.elements = HtmlDocument.#collect(root, false, hosts, shadowTemplates, scopes);
    this.allElements = HtmlDocument.#collect(root, true, new Map(), new Set(), new Map());
    this.#hosts = hosts;
    this.#shadowTemplates = shadowTemplates;
    this.#scopes = scopes;
    this.shadowRoots = [...hosts.keys()];
    const ids = new Map<HtmlNode, Map<string, HtmlElement>>();
    for (const element of this.elements) {
      const id = element.attribs.id;
      if (!id) continue;
      const scope = scopes.get(element) ?? root;
      const scoped = ids.get(scope) ?? new Map<string, HtmlElement>();
      ids.set(scope, scoped);
      if (!scoped.has(id)) scoped.set(id, element);
    }
    this.#ids = ids;
    this.baseUrl = this.#frozenBaseUrl();
    this.encoding = (encoding === undefined ? undefined : ControlRules.encodingName(encoding)) ?? this.#metaEncoding() ?? ControlRules.UNLABELED_ENCODING;
  }

  static parse(html: string, pageUrl: string, options: { encoding?: string | undefined } = {}): HtmlDocument {
    let url: string;
    try {
      url = new URL(pageUrl).href;
    } catch (cause) {
      throw new AppiiError('BAD_INPUT', `Invalid page URL: ${pageUrl}`, { cause });
    }
    const tree = new HtmlTreeBuilder().build(html);
    return new HtmlDocument(tree.root, url, tree.owners, options.encoding);
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

  byId(id: string, context?: HtmlNode): HtmlElement | undefined {
    return this.#ids.get(context === undefined ? this.root : this.scopeOf(context))?.get(id);
  }

  scopeOf(node: HtmlNode): HtmlNode {
    if (HtmlDocument.isElement(node)) {
      const known = this.#scopes.get(node);
      if (known) return known;
    }
    let current: HtmlNode = node;
    while (current.parent) current = current.parent;
    return current;
  }

  inDocumentTree(element: HtmlElement): boolean {
    return (this.#scopes.get(element) ?? this.root) === this.root;
  }

  shadowHost(node: HtmlNode): HtmlElement | undefined {
    const parent = node.parent;
    return parent ? this.#hosts.get(parent) : undefined;
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
    return (element.children ?? []).filter((child): child is HtmlElement => HtmlDocument.isElement(child) && !this.#shadowTemplates.has(child));
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

  forms(): readonly HtmlElement[] {
    if (!this.#forms) {
      const forms = this.elements.filter((element) => this.isHtml(element, 'form'));
      this.#forms = [...forms.filter((form) => this.inDocumentTree(form)), ...forms.filter((form) => !this.inDocumentTree(form))];
    }
    return this.#forms;
  }

  parserOwner(control: HtmlElement): HtmlElement | undefined {
    return this.#parserOwners.get(control);
  }

  liveFormIndex(form: HtmlElement): number | undefined {
    const value = this.attr(form, HtmlDocument.LIVE_FORM_INDEX);
    return value !== undefined && HtmlDocument.LIVE_INDEX_PATTERN.test(value) ? Number(value) : undefined;
  }

  liveSelector(form: HtmlElement): string | undefined {
    const value = this.attr(form, HtmlDocument.LIVE_SELECTOR);
    return value === undefined || value === '' ? undefined : value;
  }

  liveOwner(control: HtmlElement): HtmlElement | null | undefined {
    const value = this.attr(control, HtmlDocument.LIVE_FORM_OWNER);
    if (value === undefined) return undefined;
    if (value === '') return null;
    if (!HtmlDocument.LIVE_INDEX_PATTERN.test(value)) return undefined;
    return this.#liveFormsByIndex().get(Number(value)) ?? null;
  }

  resolveUrl(href: string, base: string = this.baseUrl): string | undefined {
    return Http.parseUrl(href, base)?.href;
  }

  actionUrl(value: string | undefined): string {
    const trimmed = value === undefined ? '' : HtmlMicrosyntax.trim(value);
    if (trimmed === '') return this.url;
    return this.resolveUrl(trimmed) ?? trimmed;
  }

  #liveFormsByIndex(): ReadonlyMap<number, HtmlElement> {
    if (this.#liveForms) return this.#liveForms;
    const out = new Map<number, HtmlElement>();
    for (const form of this.forms()) {
      const index = this.liveFormIndex(form);
      if (index !== undefined && !out.has(index)) out.set(index, form);
    }
    this.#liveForms = out;
    return out;
  }

  #metaEncoding(): string | undefined {
    for (const element of this.elements) {
      if (!this.isHtml(element, 'meta') || !this.inDocumentTree(element)) continue;
      const charset = this.attr(element, 'charset');
      const equiv = this.attr(element, 'http-equiv');
      const content = this.attr(element, 'content');
      let label: string | undefined;
      if (charset !== undefined) label = charset;
      else if (equiv !== undefined && HtmlMicrosyntax.asciiLower(HtmlMicrosyntax.trim(equiv)) === HtmlDocument.HTTP_EQUIV_CONTENT_TYPE && content !== undefined) {
        const m = HtmlDocument.META_CHARSET.exec(content);
        label = m ? (m[1] ?? m[2] ?? m[3]) : undefined;
      }
      if (label === undefined) continue;
      const name = ControlRules.encodingName(label);
      if (name === undefined || name === ControlRules.REPLACEMENT) continue;
      return HtmlDocument.PRESCAN_REPLACEMENTS.get(name) ?? name;
    }
    return undefined;
  }

  #frozenBaseUrl(): string {
    const base = this.elements.find((element) => this.isHtml(element, 'base') && this.has(element, 'href') && this.inDocumentTree(element));
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

  static #collect(root: HtmlNode, intoTemplates: boolean, hosts: Map<HtmlNode, HtmlElement>, shadowTemplates: Set<HtmlElement>, scopes: Map<HtmlElement, HtmlNode>): HtmlElement[] {
    const out: HtmlElement[] = [];
    const stack: [HtmlNode, HtmlNode][] = [...(root.children ?? [])].reverse().map((node): [HtmlNode, HtmlNode] => [node, root]);
    while (stack.length > 0) {
      const top = stack.pop();
      if (!top) break;
      const [node, scope] = top;
      if (HtmlDocument.isElement(node)) {
        const isTemplate = node.name === 'template' && (node.namespace === undefined || node.namespace === HtmlDocument.HTML_NAMESPACE);
        const content = isTemplate && !intoTemplates ? HtmlDocument.#shadowContent(node, hosts) : undefined;
        if (content) {
          hosts.set(content, node.parent as HtmlElement);
          shadowTemplates.add(node);
          const kids = content.children ?? [];
          for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i] as HtmlNode, content]);
          continue;
        }
        out.push(node);
        scopes.set(node, scope);
        if (isTemplate && !intoTemplates) continue;
      } else if (node.type !== 'root') continue;
      const kids = node.children ?? [];
      for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i] as HtmlNode, scope]);
    }
    return out;
  }

  static #shadowContent(template: HtmlElement, hosts: ReadonlyMap<HtmlNode, HtmlElement>): HtmlNode | undefined {
    const mode = template.attribs[HtmlDocument.SHADOW_ROOT_MODE];
    if (mode === undefined || !HtmlDocument.SHADOW_ROOT_MODES.has(HtmlMicrosyntax.asciiLower(mode))) return undefined;
    const host = template.parent;
    if (!HtmlDocument.isElement(host) || !HtmlDocument.#canHostShadow(host)) return undefined;
    for (const existing of hosts.values()) if (existing === host) return undefined;
    const content = (template.children ?? []).find((child) => child.type === 'root');
    return content;
  }

  static #canHostShadow(host: HtmlElement): boolean {
    if (host.namespace !== undefined && host.namespace !== HtmlDocument.HTML_NAMESPACE) return false;
    if (HtmlDocument.SHADOW_HOST_NAMES.has(host.name)) return true;
    return HtmlDocument.CUSTOM_ELEMENT_NAME.test(host.name) && !HtmlDocument.RESERVED_CUSTOM_NAMES.has(host.name);
  }
}
