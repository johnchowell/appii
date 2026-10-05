import type { FieldKind, FormField, SelectOption } from '../model/index.js';
import { Samples } from '../shared/index.js';
import { ControlRules } from './control-rules.js';
import type { HtmlDocument, HtmlElement } from './html-document.js';
import { HtmlMicrosyntax } from './html-microsyntax.js';
import { ValueSanitizer } from './value-sanitizer.js';

export type ControlRole = 'field' | 'submitter' | 'inert';

export interface ControlContext {
  order: number;
  label?: string;
}

export interface ControlReaderDeps {
  sanitizer?: ValueSanitizer;
}

export interface ControlReaderOptions {
  revealPasswords?: boolean;
}

interface OptionEntry {
  element: HtmlElement;
  option: SelectOption;
}

export class ControlReader {
  static readonly CONTROL_TAGS: readonly FieldKind[] = ['input', 'select', 'textarea', 'button'];
  static readonly OPTION_TEXT_EXCLUDED: ReadonlySet<string> = new Set(['script']);

  readonly #sanitizer: ValueSanitizer;
  readonly #revealPasswords: boolean;

  constructor(deps: ControlReaderDeps = {}, options: ControlReaderOptions = {}) {
    this.#sanitizer = deps.sanitizer ?? new ValueSanitizer();
    this.#revealPasswords = options.revealPasswords ?? false;
  }

  static create(options: ControlReaderOptions = {}): ControlReader {
    return new ControlReader({ sanitizer: new ValueSanitizer() }, options);
  }

  isControl(doc: HtmlDocument, element: HtmlElement): boolean {
    return doc.isHtml(element, ...ControlReader.CONTROL_TAGS);
  }

  type(doc: HtmlDocument, element: HtmlElement): string {
    switch (element.name) {
      case 'input':
        return ControlRules.inputType(doc.attr(element, 'type'));
      case 'button':
        return ControlRules.buttonType(doc.attr(element, 'type'), doc.has(element, 'commandfor'));
      case 'select':
        return doc.has(element, 'multiple') ? 'select-multiple' : 'select-one';
      case 'textarea':
        return 'textarea';
      default:
        return element.name;
    }
  }

  role(doc: HtmlDocument, element: HtmlElement): ControlRole {
    if (!this.isControl(doc, element)) return 'inert';
    const type = this.type(doc, element);
    if (ControlRules.isSubmitType(type)) return 'submitter';
    if (ControlRules.INERT_TYPES.has(type)) return 'inert';
    return 'field';
  }

  disabled(doc: HtmlDocument, element: HtmlElement): boolean {
    if (doc.has(element, 'disabled')) return true;
    let child: HtmlElement = element;
    for (const ancestor of doc.ancestors(element)) {
      if (doc.isHtml(ancestor, 'fieldset') && doc.has(ancestor, 'disabled')) {
        const legend = doc.children(ancestor).find((candidate) => doc.isHtml(candidate, 'legend'));
        if (legend !== child) return true;
      }
      child = ancestor;
    }
    return false;
  }

  inDatalist(doc: HtmlDocument, element: HtmlElement): boolean {
    return doc.closest(element, 'datalist') !== undefined;
  }

  read(doc: HtmlDocument, element: HtmlElement, context: ControlContext): FormField {
    const kind = element.name as FieldKind;
    const type = this.type(doc, element);
    const attr = (name: string) => doc.attr(element, name);
    const has = (name: string) => doc.has(element, name);
    const field: FormField = {
      name: attr('name') ?? '',
      order: context.order,
      kind,
      type,
      value: '',
      hasValueAttribute: (kind === 'input' || kind === 'button') && has('value'),
      checked: (type === 'checkbox' || type === 'radio') && has('checked'),
      disabled: this.disabled(doc, element),
      readOnly: has('readonly') && ControlRules.applies('readonly', type),
      required: has('required') && ControlRules.applies('required', type),
      multiple: has('multiple') && ControlRules.applies('multiple', type),
    };
    if (ControlRules.applies('pattern', type) && has('pattern')) field.pattern = attr('pattern') ?? '';
    if (ControlRules.applies('range', type)) {
      const min = attr('min');
      const max = attr('max');
      const step = attr('step');
      if (min !== undefined) field.min = min;
      if (max !== undefined) field.max = max;
      if (step !== undefined) field.step = step;
    }
    if (ControlRules.applies('length', type)) {
      const minLength = HtmlMicrosyntax.parseNonNegativeInteger(attr('minlength'));
      const maxLength = HtmlMicrosyntax.parseNonNegativeInteger(attr('maxlength'));
      if (minLength !== undefined) field.minLength = minLength;
      if (maxLength !== undefined) field.maxLength = maxLength;
    }
    if (ControlRules.applies('accept', type) && has('accept')) field.accept = attr('accept') ?? '';
    const dirName = attr('dirname');
    if (dirName && kind !== 'button' && ControlRules.applies('dirname', type)) field.dirName = dirName;
    if (context.label !== undefined) field.label = context.label;
    const placeholder = attr('placeholder');
    if (placeholder !== undefined && ControlRules.applies('placeholder', type)) field.placeholder = placeholder;
    const title = attr('title');
    if (title) field.title = title;
    const autocomplete = attr('autocomplete');
    if (autocomplete !== undefined) field.autocomplete = autocomplete;
    const id = attr('id');
    if (id) field.id = id;
    if (kind === 'select') this.#readSelect(doc, element, field);
    else if (kind === 'textarea') field.value = HtmlMicrosyntax.normalizeNewlines(doc.childText(element));
    else if (kind === 'button') field.value = attr('value') ?? '';
    else field.value = this.#inputValue(field, attr('value'));
    if (ControlRules.isSubmitType(type)) this.#readSubmitter(doc, element, field);
    return field;
  }

  #inputValue(field: FormField, raw: string | undefined): string {
    const input: { type: string; value?: string; multiple: boolean; min?: string; max?: string; step?: string } = {
      type: field.type,
      multiple: field.multiple,
    };
    if (raw !== undefined) input.value = raw;
    if (field.min !== undefined) input.min = field.min;
    if (field.max !== undefined) input.max = field.max;
    if (field.step !== undefined) input.step = field.step;
    const value = this.#sanitizer.sanitize(input);
    return field.type === 'password' && value !== '' && !this.#revealPasswords ? Samples.REDACTED : value;
  }

  #readSubmitter(doc: HtmlDocument, element: HtmlElement, field: FormField): void {
    const action = doc.attr(element, 'formaction');
    const method = doc.attr(element, 'formmethod');
    const enctype = doc.attr(element, 'formenctype');
    if (action !== undefined) field.formAction = doc.actionUrl(action);
    if (method !== undefined) field.formMethod = ControlRules.method(method);
    if (enctype !== undefined) field.formEnctype = ControlRules.enctype(enctype);
    field.formNoValidate = doc.has(element, 'formnovalidate');
  }

  #readSelect(doc: HtmlDocument, select: HtmlElement, field: FormField): void {
    const entries = this.#options(doc, select);
    const multiple = field.type === 'select-multiple';
    if (!multiple) {
      const last = entries.findLastIndex((entry) => entry.option.selected);
      if (last >= 0) entries.forEach((entry, i) => (entry.option.selected = i === last));
      else if (this.displaySize(doc, select) === 1) {
        const first = entries.find((entry) => !entry.option.disabled);
        if (first) first.option.selected = true;
      }
    }
    field.options = entries.map((entry) => entry.option);
    field.value = entries.find((entry) => entry.option.selected)?.option.value ?? '';
    const first = entries[0];
    if (field.required && !multiple && this.displaySize(doc, select) === 1 && first && first.option.value === '' && first.element.parent === select) {
      field.placeholder = first.option.label;
    }
  }

  displaySize(doc: HtmlDocument, select: HtmlElement): number {
    const size = HtmlMicrosyntax.parseNonNegativeInteger(doc.attr(select, 'size'));
    if (size !== undefined && size >= 1) return size;
    return doc.has(select, 'multiple') ? 4 : 1;
  }

  #options(doc: HtmlDocument, select: HtmlElement): OptionEntry[] {
    const nested = (element: HtmlElement) => doc.isHtml(element, 'select', 'datalist', 'option');
    return doc
      .descendants(select, nested)
      .filter((element) => doc.isHtml(element, 'option'))
      .map((element) => {
        const text = HtmlMicrosyntax.collapse(doc.text(element, (child) => ControlReader.OPTION_TEXT_EXCLUDED.has(child.name)));
        const label = doc.attr(element, 'label');
        const parent = doc.parentElement(element);
        const groupDisabled = parent !== null && doc.isHtml(parent, 'optgroup') && doc.has(parent, 'disabled');
        return {
          element,
          option: {
            value: doc.attr(element, 'value') ?? text,
            label: label ? label : text,
            selected: doc.has(element, 'selected'),
            disabled: doc.has(element, 'disabled') || groupDisabled,
          },
        };
      });
  }
}
