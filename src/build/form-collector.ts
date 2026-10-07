import type { Capture, FormDescriptor } from '../model/index.js';
import { Http, Json } from '../shared/index.js';
import { PageDocuments } from './page-documents.js';
import type { PageDocument } from './page-documents.js';

export interface FormCollectorDeps {
  documents: PageDocuments;
}

export class FormCollector {
  readonly #documents: PageDocuments;

  constructor(deps: FormCollectorDeps) {
    this.#documents = deps.documents;
  }

  static create(): FormCollector {
    return new FormCollector({ documents: PageDocuments.create() });
  }

  static key(form: FormDescriptor): string {
    const url = Http.parseUrl(form.pageUrl);
    const page = url ? url.origin + url.pathname : form.pageUrl;
    return JSON.stringify([page, form.selector, form.action, form.fields.map((field) => field.name), form.submitters.map((field) => field.name)]);
  }

  encodings(capture: Capture): Map<string, string> {
    return this.#documents.encodings(capture);
  }

  pages(capture: Capture): readonly PageDocument[] {
    return this.#documents.all(capture);
  }

  collect(capture: Capture): FormDescriptor[] {
    const seen = new Set<string>();
    const out: FormDescriptor[] = [];
    for (const { forms } of this.#documents.of(capture)) {
      for (const form of forms) {
        const key = FormCollector.key(form);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(Json.clone(form));
      }
    }
    return out;
  }
}
