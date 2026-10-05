import type { Capture, FormDescriptor } from '../model/index.js';
import { FormExtractor, HtmlDocument } from '../forms/index.js';
import { isAppiiError } from '../shared/index.js';
import { HtmlPages } from './html-pages.js';
import type { HtmlPage } from './html-pages.js';

export interface PageDocument {
  readonly page: HtmlPage;
  readonly doc: HtmlDocument;
  readonly forms: readonly FormDescriptor[];
}

export interface PageDocumentsDeps {
  pages: HtmlPages;
  extractor: FormExtractor;
}

interface CacheEntry {
  readonly pages: number;
  readonly exchanges: number;
  readonly documents: readonly PageDocument[];
}

export class PageDocuments {
  readonly #pages: HtmlPages;
  readonly #extractor: FormExtractor;
  readonly #cache = new WeakMap<Capture, CacheEntry>();

  constructor(deps: PageDocumentsDeps) {
    this.#pages = deps.pages;
    this.#extractor = deps.extractor;
  }

  static create(): PageDocuments {
    return new PageDocuments({ pages: HtmlPages.create(), extractor: FormExtractor.create() });
  }

  encodings(capture: Capture): Map<string, string> {
    return new Map(this.of(capture).map(({ page, doc }): [string, string] => [HtmlPages.documentKey(page.url), doc.encoding]));
  }

  of(capture: Capture): readonly PageDocument[] {
    const cached = this.#cache.get(capture);
    if (cached && cached.pages === capture.pages.length && cached.exchanges === capture.exchanges.length) return cached.documents;
    const documents: PageDocument[] = [];
    for (const page of this.#pages.collect(capture)) {
      let doc: HtmlDocument;
      try {
        doc = HtmlDocument.parse(page.html, page.url, { encoding: page.encoding });
      } catch (err) {
        if (isAppiiError(err)) continue;
        throw err;
      }
      documents.push({ page, doc, forms: this.#extractor.extractDocument(doc) });
    }
    this.#cache.set(capture, { pages: capture.pages.length, exchanges: capture.exchanges.length, documents });
    return documents;
  }
}
