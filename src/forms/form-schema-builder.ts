import type { FormDescriptor, FormEnctype, FormField, JsonSchema } from '../model/index.js';
import { AppiiError } from '../shared/index.js';
import { ControlRules } from './control-rules.js';
import { EntryGroupComposer } from './entry-group-composer.js';
import { EntrySlotFactory } from './entry-slot-factory.js';
import type { EntrySlot, SlotContext } from './entry-slot-factory.js';
import { TokenDetector } from './token-detector.js';

export interface FormSchema {
  mimeType: FormEnctype;
  method: 'GET' | 'POST';
  action: string;
  schema: JsonSchema;
  tokenFields: string[];
}

export interface FormTarget {
  method: 'GET' | 'POST' | 'DIALOG';
  url: string;
  enctype: FormEnctype;
}

export interface FieldSchemaContext {
  multipart?: boolean;
  validate?: boolean;
}

export interface FormSchemaBuilderDeps {
  tokens?: TokenDetector;
  slots?: EntrySlotFactory;
  composer?: EntryGroupComposer;
}

export class FormSchemaBuilder {
  static readonly QUERY_ENCTYPE: FormEnctype = 'application/x-www-form-urlencoded';

  readonly #tokens: TokenDetector;
  readonly #slots: EntrySlotFactory;
  readonly #composer: EntryGroupComposer;

  constructor(deps: FormSchemaBuilderDeps = {}) {
    this.#tokens = deps.tokens ?? new TokenDetector();
    this.#slots = deps.slots ?? new EntrySlotFactory();
    this.#composer = deps.composer ?? new EntryGroupComposer();
  }

  static create(): FormSchemaBuilder {
    return new FormSchemaBuilder({ tokens: new TokenDetector(), slots: EntrySlotFactory.create(), composer: new EntryGroupComposer() });
  }

  submitter(form: FormDescriptor, submitter?: FormField): FormField | undefined {
    return submitter ?? form.submitters.find((candidate) => !candidate.disabled);
  }

  target(form: FormDescriptor, submitter?: FormField): FormTarget {
    const active = this.submitter(form, submitter);
    const method = active?.formMethod ?? form.method;
    const action = active?.formAction ?? form.action;
    const enctype = method === 'GET' ? FormSchemaBuilder.QUERY_ENCTYPE : (active?.formEnctype ?? form.enctype);
    return { method, url: FormSchemaBuilder.#requestUrl(action, method), enctype };
  }

  build(form: FormDescriptor, submitter?: FormField): FormSchema {
    const active = this.submitter(form, submitter);
    const target = this.target(form, active);
    if (target.method === 'DIALOG') {
      throw new AppiiError('UNSUPPORTED', `Form ${form.selector} uses method=dialog and does not submit a request`, {
        details: { selector: form.selector, pageUrl: form.pageUrl },
      });
    }
    const tokens = this.tokenNames(form);
    const context: SlotContext = {
      multipart: target.method === 'POST' && target.enctype === 'multipart/form-data',
      validate: !form.noValidate && active?.formNoValidate !== true,
      tokens,
    };
    const entries = this.#entries(form, active, context);
    const properties: [string, JsonSchema][] = [];
    const required: string[] = [];
    for (const [name, slots] of entries) {
      const composed = this.#composer.compose(slots);
      if (composed.empty) continue;
      properties.push([name, composed.schema]);
      if (composed.required) required.push(name);
    }
    const schema: JsonSchema = { type: 'object', properties: Object.fromEntries(properties) };
    if (required.length > 0) schema.required = required;
    if (!context.validate) schema['x-html-novalidate'] = true;
    return {
      mimeType: target.enctype,
      method: target.method,
      action: target.url,
      schema,
      tokenFields: properties.map(([name]) => name).filter((name) => tokens.has(name)),
    };
  }

  field(field: FormField, sameName: readonly FormField[], context: FieldSchemaContext = {}): JsonSchema {
    if (ControlRules.isSubmitType(field.type)) {
      const entries = this.#slots.submitter(field);
      return entries[0] ? this.#composer.compose([entries[0].slot]).schema : { type: 'string', const: field.value };
    }
    const members = [...new Set([field, ...sameName])]
      .filter((member) => member === field || (!member.disabled && member.name === field.name))
      .filter((member) => !ControlRules.isSubmitType(member.type))
      .sort((a, b) => a.order - b.order);
    const tokens = new Set(members.filter((member) => member.type === 'hidden' && this.#tokens.isTokenField(member.name)).map((member) => member.name));
    const slots = this.#slots.slots(members, {
      multipart: context.multipart ?? true,
      validate: context.validate ?? true,
      tokens,
    });
    return this.#composer.compose(slots).schema;
  }

  tokenNames(form: FormDescriptor): Set<string> {
    const names = new Set(form.tokenFields);
    for (const field of form.fields) {
      if (field.type === 'hidden' && this.#tokens.isTokenField(field.name)) names.add(field.name);
    }
    return names;
  }

  #entries(form: FormDescriptor, active: FormField | undefined, context: SlotContext): Map<string, EntrySlot[]> {
    const groups = new Map<string, FormField[]>();
    const submittable = form.fields.filter((field) => !field.disabled && field.name !== '' && !ControlRules.isSubmitType(field.type));
    for (const field of submittable) {
      const group = groups.get(field.name);
      if (group) group.push(field);
      else groups.set(field.name, [field]);
    }
    const named: { name: string; slot: EntrySlot }[] = [];
    for (const [name, members] of groups) {
      for (const slot of this.#slots.slots(members, context)) named.push({ name, slot });
    }
    for (const field of submittable) {
      const dir = this.#slots.dirname(field);
      if (dir) named.push(dir);
    }
    if (active && !active.disabled) {
      named.push(...this.#slots.submitter(active));
      const dir = this.#slots.dirname(active);
      if (dir) named.push(dir);
    }
    named.sort((a, b) => a.slot.order - b.slot.order);
    const out = new Map<string, EntrySlot[]>();
    for (const { name, slot } of named) {
      const list = out.get(name);
      if (list) list.push(slot);
      else out.set(name, [slot]);
    }
    return out;
  }

  static #requestUrl(action: string, method: FormTarget['method']): string {
    if (method === 'DIALOG') return action;
    try {
      const url = new URL(action);
      url.hash = '';
      if (method === 'GET') url.search = '';
      return url.href;
    } catch {
      return action;
    }
  }
}
