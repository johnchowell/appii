import type { Capture, FormDescriptor } from '../model/index.js';
import { FormExtractor } from '../forms/index.js';
import { Http, isAppiiError } from '../shared/index.js';
import { HtmlPages } from './html-pages.js';

export interface FormCollectorDeps {
  extractor: FormExtractor;
  pages?: HtmlPages;
}

export class FormCollector {
  readonly #extractor: FormExtractor;
  readonly #pages: HtmlPages;

  constructor(deps: FormCollectorDeps) {
    this.#extractor = deps.extractor;
    this.#pages = deps.pages ?? new HtmlPages();
  }

  static create(): FormCollector {
    return new FormCollector({ extractor: FormExtractor.create(), pages: HtmlPages.create() });
  }

  static key(form: FormDescriptor): string {
    const url = Http.parseUrl(form.pageUrl);
    const page = url ? url.origin + url.pathname : form.pageUrl;
    return JSON.stringify([page, form.selector, form.action, form.fields.map((field) => field.name), form.submitters.map((field) => field.name)]);
  }

  collect(capture: Capture): FormDescriptor[] {
    const seen = new Set<string>();
    const out: FormDescriptor[] = [];
    for (const page of this.#pages.collect(capture)) {
      let forms: FormDescriptor[];
      try {
        forms = this.#extractor.extract(page.html, page.url);
      } catch (err) {
        if (isAppiiError(err)) continue;
        throw err;
      }
      for (const form of forms) {
        const key = FormCollector.key(form);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(form);
      }
    }
    return out;
  }
}
