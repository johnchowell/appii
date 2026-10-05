import type { FormDescriptor, FormField } from '../model/index.js';
import { ControlReader } from './control-reader.js';
import { ControlRules } from './control-rules.js';
import { FormOwnerResolver } from './form-owner-resolver.js';
import { HtmlDocument } from './html-document.js';
import type { HtmlElement } from './html-document.js';
import { LabelResolver } from './label-resolver.js';
import type { LabelAssociations } from './label-resolver.js';
import { SelectorBuilder } from './selector-builder.js';
import { TokenDetector } from './token-detector.js';

export interface FormExtractorDeps {
  tokens?: TokenDetector;
  owners?: FormOwnerResolver;
  controls?: ControlReader;
  labels?: LabelResolver;
  selectors?: SelectorBuilder;
}

export interface FormExtractorOptions {
  revealPasswords?: boolean;
}

export class FormExtractor {
  readonly #tokens: TokenDetector;
  readonly #owners: FormOwnerResolver;
  readonly #controls: ControlReader;
  readonly #labels: LabelResolver;
  readonly #selectors: SelectorBuilder;

  constructor(deps: FormExtractorDeps = {}, options: FormExtractorOptions = {}) {
    this.#tokens = deps.tokens ?? new TokenDetector();
    this.#owners = deps.owners ?? new FormOwnerResolver();
    this.#controls = deps.controls ?? new ControlReader({}, options);
    this.#labels = deps.labels ?? new LabelResolver();
    this.#selectors = deps.selectors ?? new SelectorBuilder();
  }

  static create(options: FormExtractorOptions = {}): FormExtractor {
    return new FormExtractor(
      { tokens: new TokenDetector(), owners: new FormOwnerResolver(), controls: ControlReader.create(options), labels: new LabelResolver(), selectors: new SelectorBuilder() },
      options,
    );
  }

  extract(html: string, pageUrl: string): FormDescriptor[] {
    return this.extractDocument(HtmlDocument.parse(html, pageUrl));
  }

  extractDocument(doc: HtmlDocument): FormDescriptor[] {
    const controls = doc.elements.filter((element) => this.#controls.isControl(doc, element));
    const owned = this.#owners.group(doc, controls);
    const labels = this.#labels.associations(doc);
    return doc.forms().map((form, index) => this.#describe(doc, form, doc.liveFormIndex(form) ?? index, owned.get(form) ?? [], labels));
  }

  #describe(doc: HtmlDocument, form: HtmlElement, index: number, controls: readonly HtmlElement[], labels: LabelAssociations): FormDescriptor {
    const fields: FormField[] = [];
    const submitters: FormField[] = [];
    controls.forEach((control, order) => {
      const role = this.#controls.role(doc, control);
      if (role === 'inert' || this.#controls.inDatalist(doc, control)) return;
      const label = this.#labels.resolve(doc, control, labels);
      const field = this.#controls.read(doc, control, label === undefined ? { order } : { order, label });
      (role === 'submitter' ? submitters : fields).push(field);
    });
    FormExtractor.#settleRadioGroups(fields);
    const descriptor: FormDescriptor = {
      index,
      selector: this.#selectors.form(doc, form),
      pageUrl: doc.url,
      action: doc.actionUrl(doc.attr(form, 'action')),
      method: ControlRules.method(doc.attr(form, 'method')),
      enctype: ControlRules.enctype(doc.attr(form, 'enctype')),
      noValidate: doc.has(form, 'novalidate'),
      fields,
      submitters,
      tokenFields: this.#tokenFields(fields),
    };
    const id = doc.attr(form, 'id');
    const name = doc.attr(form, 'name');
    const acceptCharset = doc.attr(form, 'accept-charset');
    const target = doc.attr(form, 'target');
    if (id) descriptor.id = id;
    if (name) descriptor.name = name;
    if (acceptCharset !== undefined) descriptor.acceptCharset = acceptCharset;
    if (target !== undefined) descriptor.target = target;
    return descriptor;
  }

  #tokenFields(fields: readonly FormField[]): string[] {
    const names = fields
      .filter((field) => field.type === 'hidden' && !field.disabled && this.#tokens.isHiddenTokenField(field.name))
      .map((field) => field.name);
    return [...new Set(names)];
  }

  static #settleRadioGroups(fields: readonly FormField[]): void {
    const seen = new Set<string>();
    for (let i = fields.length - 1; i >= 0; i--) {
      const field = fields[i];
      if (!field || field.type !== 'radio' || !field.checked || field.name === '') continue;
      if (seen.has(field.name)) field.checked = false;
      else seen.add(field.name);
    }
  }
}
