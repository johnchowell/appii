import { ControlRules } from './control-rules.js';
import type { HtmlDocument, HtmlElement } from './html-document.js';
import { HtmlMicrosyntax } from './html-microsyntax.js';

export type LabelAssociations = ReadonlyMap<HtmlElement, readonly HtmlElement[]>;

export class LabelResolver {
  static readonly LABELABLE: ReadonlySet<string> = new Set(['button', 'input', 'meter', 'output', 'progress', 'select', 'textarea']);
  static readonly HIDDEN_TEXT: ReadonlySet<string> = new Set(['script', 'style', 'template', 'noscript', 'datalist']);

  isLabelable(doc: HtmlDocument, element: HtmlElement): boolean {
    if (!doc.isHtml(element) || !LabelResolver.LABELABLE.has(element.name)) return false;
    return element.name !== 'input' || ControlRules.inputType(doc.attr(element, 'type')) !== 'hidden';
  }

  labeledControl(doc: HtmlDocument, label: HtmlElement): HtmlElement | undefined {
    const target = doc.attr(label, 'for');
    if (target !== undefined) {
      const element = target === '' ? undefined : doc.byId(target, label);
      return element && this.isLabelable(doc, element) ? element : undefined;
    }
    return doc.descendants(label).find((element) => this.isLabelable(doc, element));
  }

  associations(doc: HtmlDocument): Map<HtmlElement, HtmlElement[]> {
    const out = new Map<HtmlElement, HtmlElement[]>();
    for (const label of doc.elements) {
      if (!doc.isHtml(label, 'label')) continue;
      const control = this.labeledControl(doc, label);
      if (!control) continue;
      const list = out.get(control);
      if (list) list.push(label);
      else out.set(control, [label]);
    }
    return out;
  }

  resolve(doc: HtmlDocument, control: HtmlElement, associations: LabelAssociations): string | undefined {
    const fromLabels = (associations.get(control) ?? [])
      .map((label) => this.labelText(doc, label))
      .filter((text) => text !== '')
      .join(' ');
    if (fromLabels) return fromLabels;
    const ariaLabel = HtmlMicrosyntax.collapse(doc.attr(control, 'aria-label') ?? '');
    if (ariaLabel) return ariaLabel;
    const labelledBy = HtmlMicrosyntax.splitWhitespace(doc.attr(control, 'aria-labelledby') ?? '')
      .map((id) => doc.byId(id, control))
      .filter((element): element is HtmlElement => element !== undefined)
      .map((element) => this.visibleText(doc, element))
      .filter((text) => text !== '')
      .join(' ');
    if (labelledBy) return labelledBy;
    const own = this.buttonText(doc, control);
    if (own) return own;
    const title = HtmlMicrosyntax.collapse(doc.attr(control, 'title') ?? '');
    return title || undefined;
  }

  labelText(doc: HtmlDocument, label: HtmlElement): string {
    return HtmlMicrosyntax.collapse(
      doc.text(label, (element) => LabelResolver.HIDDEN_TEXT.has(element.name) || this.isLabelable(doc, element)),
    );
  }

  visibleText(doc: HtmlDocument, element: HtmlElement): string {
    return HtmlMicrosyntax.collapse(doc.text(element, (child) => LabelResolver.HIDDEN_TEXT.has(child.name)));
  }

  buttonText(doc: HtmlDocument, control: HtmlElement): string | undefined {
    if (doc.isHtml(control, 'button')) return this.visibleText(doc, control) || undefined;
    if (!doc.isHtml(control, 'input')) return undefined;
    const type = ControlRules.inputType(doc.attr(control, 'type'));
    if (type === 'submit') {
      const value = doc.attr(control, 'value');
      return value === undefined ? ControlRules.DEFAULT_SUBMIT_VALUE : HtmlMicrosyntax.collapse(value) || undefined;
    }
    if (type === 'image') return HtmlMicrosyntax.collapse(doc.attr(control, 'alt') ?? doc.attr(control, 'value') ?? '') || undefined;
    return undefined;
  }
}
