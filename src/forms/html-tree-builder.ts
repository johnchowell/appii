import { Parser, html } from 'parse5';
import type { Token, TreeAdapter } from 'parse5';
import { adapter } from 'parse5-htmlparser2-tree-adapter';
import type { Htmlparser2TreeAdapterMap } from 'parse5-htmlparser2-tree-adapter';
import type { HtmlElement, HtmlNode } from './html-document.js';

export interface HtmlTree {
  root: HtmlNode;
  owners: ReadonlyMap<HtmlElement, HtmlElement>;
}

interface ParserState {
  parser?: Parser<Htmlparser2TreeAdapterMap>;
}

export class HtmlTreeBuilder {
  static readonly FORM_ASSOCIATED: ReadonlySet<string> = new Set(['button', 'fieldset', 'img', 'input', 'object', 'output', 'select', 'textarea']);
  static readonly LISTED: ReadonlySet<string> = new Set(['button', 'fieldset', 'input', 'object', 'output', 'select', 'textarea']);
  static readonly FORM_ATTRIBUTE = 'form';

  build(source: string): HtmlTree {
    const owners = new Map<HtmlElement, HtmlElement>();
    const state: ParserState = {};
    const treeAdapter: TreeAdapter<Htmlparser2TreeAdapterMap> = {
      ...adapter,
      createElement: (tagName, namespaceURI, attrs) => {
        const element = adapter.createElement(tagName, namespaceURI, attrs);
        const form = state.parser ? HtmlTreeBuilder.#pointer(state.parser, tagName, namespaceURI, attrs) : undefined;
        if (form) owners.set(element as unknown as HtmlElement, form as unknown as HtmlElement);
        return element;
      },
    };
    const parser = new Parser<Htmlparser2TreeAdapterMap>({ treeAdapter, scriptingEnabled: true });
    state.parser = parser;
    parser.tokenizer.write(source, true);
    return { root: parser.document as unknown as HtmlNode, owners };
  }

  static #pointer(
    parser: Parser<Htmlparser2TreeAdapterMap>,
    tagName: string,
    namespaceURI: html.NS,
    attrs: readonly Token.Attribute[],
  ): Htmlparser2TreeAdapterMap['element'] | undefined {
    const form = parser.formElement;
    if (!form || parser.openElements.tmplCount > 0) return undefined;
    if (namespaceURI !== html.NS.HTML || !HtmlTreeBuilder.FORM_ASSOCIATED.has(tagName)) return undefined;
    if (HtmlTreeBuilder.LISTED.has(tagName) && attrs.some((attr) => attr.name === HtmlTreeBuilder.FORM_ATTRIBUTE)) return undefined;
    return form;
  }
}
