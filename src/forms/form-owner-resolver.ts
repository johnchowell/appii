import type { HtmlDocument, HtmlElement } from './html-document.js';

export class FormOwnerResolver {
  static readonly FORM_ATTRIBUTE = 'form';

  owner(doc: HtmlDocument, control: HtmlElement): HtmlElement | null {
    const live = doc.liveOwner(control);
    if (live !== undefined) return live;
    const formId = doc.attr(control, FormOwnerResolver.FORM_ATTRIBUTE);
    if (formId !== undefined) {
      const target = formId === '' ? undefined : doc.byId(formId, control);
      return target && doc.isHtml(target, 'form') ? target : null;
    }
    return doc.parserOwner(control) ?? doc.closest(control, 'form') ?? null;
  }

  group(doc: HtmlDocument, controls: readonly HtmlElement[]): Map<HtmlElement, HtmlElement[]> {
    const out = new Map<HtmlElement, HtmlElement[]>();
    for (const control of controls) {
      const owner = this.owner(doc, control);
      if (!owner) continue;
      const list = out.get(owner);
      if (list) list.push(control);
      else out.set(owner, [control]);
    }
    return out;
  }
}
