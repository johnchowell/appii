import type { FormField, JsonSchema } from '../model/index.js';
import { Http, Schema } from '../shared/index.js';
import { ControlRules } from './control-rules.js';
import { HtmlDecimal } from './html-decimal.js';
import { HtmlMicrosyntax } from './html-microsyntax.js';
import { StepRange } from './step-range.js';
import { ValueSanitizer } from './value-sanitizer.js';

export interface EntrySlot {
  order: number;
  schema: JsonSchema;
  min: number;
  max: number;
  list: boolean;
  choice: boolean;
  unique: boolean;
  required: boolean;
  defaults?: unknown[];
  type: string;
  label?: string;
  description?: string;
}

export interface SlotContext {
  multipart: boolean;
  validate: boolean;
  tokens: ReadonlySet<string>;
  charset?: string;
  openChoices?: ReadonlyMap<string, readonly string[]>;
}

export interface NamedSlot {
  name: string;
  slot: EntrySlot;
}

export interface CompiledPattern {
  html?: string;
  json?: string;
}

export interface EntrySlotFactoryDeps {
  sanitizer?: ValueSanitizer;
}

export class EntrySlotFactory {
  static readonly EMAIL_ADDRESS =
    "[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*";
  static readonly TIME = '(?:[01]\\d|2[0-3]):[0-5]\\d(?::[0-5]\\d(?:\\.\\d{1,3})?)?';
  static readonly DATE = '\\d{4,}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])';
  static readonly GRAMMARS: Readonly<Record<string, string>> = {
    email: EntrySlotFactory.EMAIL_ADDRESS,
    'email-list': `${EntrySlotFactory.EMAIL_ADDRESS}(?:,${EntrySlotFactory.EMAIL_ADDRESS})*`,
    time: EntrySlotFactory.TIME,
    month: '\\d{4,}-(?:0[1-9]|1[0-2])',
    week: '\\d{4,}-W(?:0[1-9]|[1-4]\\d|5[0-3])',
    'datetime-local': `${EntrySlotFactory.DATE}T${EntrySlotFactory.TIME}`,
    date: EntrySlotFactory.DATE,
    color: '#[0-9a-f]{6}',
  };
  static readonly SANITIZED_TYPES: ReadonlySet<string> = new Set(['date', 'month', 'week', 'time', 'datetime-local', 'color']);
  static readonly NEVER_EMPTY_TYPES: ReadonlySet<string> = new Set(['color']);
  static readonly PATTERNS: Readonly<Record<string, string>> = Object.fromEntries(
    Object.entries(EntrySlotFactory.GRAMMARS).map(([type, grammar]) => [type, EntrySlotFactory.anchored(type, [], grammar)]),
  );
  static readonly UTF16_UNITS_PER_CODE_POINT = 2;
  static readonly WIRE_CHARACTERS_PER_NEWLINE = 2;
  static readonly DIRECTIONS: readonly string[] = ['ltr', 'rtl'];
  static readonly COORDINATES: readonly string[] = ['x', 'y'];
  static readonly MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9a-z-]+\/[!#$%&'*+.^_`|~0-9a-z-]+$/;
  static readonly NO_DEFAULT_TYPES: ReadonlySet<string> = new Set(['password', 'file']);
  static readonly OPEN_CHOICES = Schema.DYNAMIC_OPTIONS;

  readonly #sanitizer: ValueSanitizer;

  constructor(deps: EntrySlotFactoryDeps = {}) {
    this.#sanitizer = deps.sanitizer ?? new ValueSanitizer();
  }

  static create(): EntrySlotFactory {
    return new EntrySlotFactory({ sanitizer: new ValueSanitizer() });
  }

  static anchored(type: string, conditions: readonly string[], body: string): string {
    const optional = EntrySlotFactory.NEVER_EMPTY_TYPES.has(type) ? '' : '?';
    if (conditions.length === 0) return `^(?:${body})${optional}$`;
    const lookaheads = conditions.map((condition) => `(?=${condition})`).join('');
    return `^(?:${lookaheads}(?:${body}))${optional}$`;
  }

  static pattern(raw: string | undefined): CompiledPattern {
    if (raw === undefined) return {};
    const anchored = `^(?:${raw})$`;
    try {
      new RegExp(raw, 'v');
      new RegExp(anchored, 'v');
    } catch {
      return {};
    }
    try {
      new RegExp(anchored, 'u');
      return { html: raw, json: anchored };
    } catch {
      return { html: raw };
    }
  }

  static mediaType(accept: string | undefined): string | undefined {
    if (accept === undefined) return undefined;
    const tokens = accept
      .split(',')
      .map((token) => HtmlMicrosyntax.asciiLower(HtmlMicrosyntax.trim(token)))
      .filter((token) => token !== '');
    if (tokens.length !== 1) return undefined;
    const essence = Http.mimeEssence(tokens[0]);
    return EntrySlotFactory.MEDIA_TYPE.test(essence) && !essence.includes('*') ? essence : undefined;
  }

  barred(field: FormField): boolean {
    return field.type === 'hidden' || field.readOnly;
  }

  slots(members: readonly FormField[], context: SlotContext): EntrySlot[] {
    const radios = members.filter((member) => member.type === 'radio');
    const out: EntrySlot[] = [];
    for (const member of members) {
      if (ControlRules.isSubmitType(member.type) || ControlRules.INERT_TYPES.has(member.type)) continue;
      if (member.type === 'radio') {
        if (member === radios[0]) out.push(this.#radio(radios, context));
        continue;
      }
      out.push(this.#slot(member, context));
    }
    return out;
  }

  submitter(field: FormField): NamedSlot[] {
    if (field.type === 'image') {
      const prefix = field.name ? `${field.name}.` : '';
      return EntrySlotFactory.COORDINATES.map((axis) => ({
        name: prefix + axis,
        slot: this.#create(field, {
          schema: {
            type: 'integer',
            'x-html-type': 'image',
            description: `${axis} coordinate of the activation point on the image button`,
          },
          min: 1,
          max: 1,
          required: true,
        }),
      }));
    }
    if (field.name === '') return [];
    const value = field.kind === 'input' && !field.hasValueAttribute ? ControlRules.DEFAULT_SUBMIT_VALUE : field.value;
    return [
      {
        name: field.name,
        slot: this.#create(field, {
          schema: { type: 'string', const: value, 'x-html-type': 'submit' },
          min: 1,
          max: 1,
          required: true,
          defaults: [value],
        }),
      },
    ];
  }

  dirname(field: FormField): NamedSlot | undefined {
    if (!field.dirName || field.name === '') return undefined;
    return {
      name: field.dirName,
      slot: {
        order: field.order + 0.5,
        schema: { type: 'string', enum: [...EntrySlotFactory.DIRECTIONS], 'x-html-dirname-for': field.name },
        min: 1,
        max: 1,
        list: false,
        choice: false,
        unique: false,
        required: false,
        type: 'dirname',
        description: `Text direction of the ${field.name} field`,
      },
    };
  }

  #slot(field: FormField, context: SlotContext): EntrySlot {
    const checks = context.validate && !this.barred(field);
    switch (field.type) {
      case 'checkbox':
        return this.#create(field, {
          schema: this.#annotate(field, { type: 'string', const: field.value }),
          min: 0,
          max: 1,
          choice: true,
          required: checks && field.required,
          defaults: field.checked ? [field.value] : [],
        });
      case 'select-one':
      case 'select-multiple':
        return this.#select(field, checks, context.openChoices?.get(field.name));
      case 'file':
        return this.#file(field, context, checks);
      case 'hidden':
        return this.#hidden(field, context);
      case 'number':
      case 'range':
        return this.#number(field, checks);
      default:
        return this.#text(field, context, checks);
    }
  }

  #text(field: FormField, context: SlotContext, checks: boolean): EntrySlot {
    const schema: JsonSchema = { type: 'string' };
    const type = field.type;
    const emailList = type === 'email' && field.multiple;
    const required = checks && field.required;
    const pattern = EntrySlotFactory.pattern(field.pattern);
    const grammar = EntrySlotFactory.GRAMMARS[emailList ? 'email-list' : type];
    const body = grammar !== undefined && (checks || EntrySlotFactory.SANITIZED_TYPES.has(type)) ? grammar : undefined;
    const author = pattern.json !== undefined && checks && !emailList ? pattern.html : undefined;
    const shortest = checks && field.minLength !== undefined ? Math.ceil(field.minLength / EntrySlotFactory.UTF16_UNITS_PER_CODE_POINT) : 0;
    const conditions: string[] = [];
    if (author !== undefined && body !== undefined) conditions.push(`(?:${author})$`);
    if (shortest > 1 && !required) conditions.push(`[\\s\\S]{${shortest}}`);
    const main = body ?? (author !== undefined ? author : conditions.length > 0 ? '[\\s\\S]*' : undefined);
    if (main !== undefined) schema.pattern = EntrySlotFactory.anchored(type, conditions, main);
    if (required) schema.minLength = Math.max(shortest, 1);
    if (field.maxLength !== undefined && !this.barred(field)) {
      schema.maxLength = type === 'textarea' ? field.maxLength * EntrySlotFactory.WIRE_CHARACTERS_PER_NEWLINE : field.maxLength;
    }
    if (pattern.html !== undefined) schema['x-html-pattern'] = pattern.html;
    if (field.minLength !== undefined) schema['x-html-minlength'] = field.minLength;
    if (field.maxLength !== undefined) schema['x-html-maxlength'] = field.maxLength;
    if (emailList) schema['x-html-multiple'] = true;
    this.#rangeAnnotations(field, schema);
    let value = field.value;
    if (type === 'color' && !HtmlMicrosyntax.isSimpleColor(value)) value = this.#sanitizer.sanitize({ type, value });
    const secret = EntrySlotFactory.NO_DEFAULT_TYPES.has(type) || context.tokens.has(field.name);
    return this.#create(field, {
      schema: this.#annotate(field, schema),
      min: 1,
      max: 1,
      required: checks && field.required,
      ...(secret || value === '' ? {} : { defaults: [value] }),
    });
  }

  #number(field: FormField, checks: boolean): EntrySlot {
    const isRange = field.type === 'range';
    const range = StepRange.of({
      type: field.type,
      ...(field.min === undefined ? {} : { min: field.min }),
      ...(field.max === undefined ? {} : { max: field.max }),
      ...(field.step === undefined ? {} : { step: field.step }),
      ...(field.hasValueAttribute && HtmlMicrosyntax.isValidFloat(field.value) ? { value: field.value } : {}),
    });
    const enforce = isRange || checks;
    const integral = enforce && range.integral;
    const numeric = integral ? 'integer' : 'number';
    const empty = !isRange && !(checks && field.required);
    const schema: JsonSchema = empty ? { type: [numeric, 'string'], maxLength: 0 } : { type: numeric };
    if (enforce && range.minimum) schema.minimum = range.minimum.toNumber();
    if (enforce && range.maximum) schema.maximum = range.maximum.toNumber();
    if (enforce && range.step && range.aligned && !(integral && range.step.compare(HtmlDecimal.ONE) === 0)) {
      schema.multipleOf = range.step.toNumber();
    }
    this.#rangeAnnotations(field, schema);
    let value = field.value;
    if (isRange && !HtmlMicrosyntax.isValidFloat(value)) {
      value = this.#sanitizer.range({
        type: 'range',
        ...(field.min === undefined ? {} : { min: field.min }),
        ...(field.max === undefined ? {} : { max: field.max }),
        ...(field.step === undefined ? {} : { step: field.step }),
      });
    }
    const decimal = HtmlDecimal.parse(value);
    const usable = decimal !== undefined && (!integral || decimal.isInteger()) ? decimal : undefined;
    return this.#create(field, {
      schema: this.#annotate(field, schema),
      min: 1,
      max: 1,
      required: checks && !isRange && field.required,
      ...(usable ? { defaults: [usable.toNumber()] } : {}),
    });
  }

  #select(field: FormField, checks: boolean, observed: readonly string[] | undefined): EntrySlot {
    const options = field.options ?? [];
    const multiple = field.type === 'select-multiple';
    const first = options[0];
    const placeholder = !multiple && field.placeholder !== undefined && first?.value === '' ? first : undefined;
    const excluded = checks && field.required && placeholder !== undefined ? placeholder : undefined;
    const allowed = options.filter((option) => !option.disabled && option !== excluded);
    const submitted = options.filter((option) => option.selected && !option.disabled);
    const valid = submitted.every((option) => option !== excluded);
    const defaults = valid ? { defaults: submitted.map((option) => option.value) } : {};
    const required = checks && field.required;
    if (observed !== undefined) {
      const schema: JsonSchema = { type: 'string', [EntrySlotFactory.OPEN_CHOICES]: true };
      if (excluded) schema.minLength = 1;
      const examples = observed.filter((value) => value !== excluded?.value);
      if (examples.length > 0) schema.examples = examples;
      if (placeholder) schema['x-html-placeholder'] = placeholder.label;
      return this.#create(field, {
        schema: this.#annotate(field, schema),
        min: multiple ? 0 : submitted.length > 0 ? 1 : 0,
        max: multiple ? Number.POSITIVE_INFINITY : 1,
        list: multiple,
        unique: multiple,
        required,
        ...defaults,
      });
    }
    const { values, labels } = EntrySlotFactory.#choices(allowed.map((option) => ({ value: option.value, label: option.label })));
    const schema: JsonSchema = { type: 'string', enum: values };
    if (labels) schema['x-html-labels'] = labels;
    if (placeholder) schema['x-html-placeholder'] = placeholder.label;
    return this.#create(field, {
      schema: this.#annotate(field, schema),
      min: multiple ? 0 : submitted.length > 0 ? 1 : 0,
      max: multiple ? allowed.length : Math.min(allowed.length, 1),
      list: multiple,
      unique: multiple && values.length === allowed.length,
      required,
      ...defaults,
    });
  }

  #file(field: FormField, context: SlotContext, checks: boolean): EntrySlot {
    const schema: JsonSchema = { type: 'string' };
    const mediaType = EntrySlotFactory.mediaType(field.accept);
    if (context.multipart) {
      schema.format = 'binary';
      if (mediaType) schema.contentMediaType = mediaType;
    } else if (checks && field.required) schema.minLength = 1;
    if (field.accept !== undefined) schema['x-html-accept'] = field.accept;
    return this.#create(field, {
      schema: this.#annotate(field, schema),
      min: 1,
      max: field.multiple ? Number.POSITIVE_INFINITY : 1,
      list: field.multiple,
      required: checks && field.required,
    });
  }

  #hidden(field: FormField, context: SlotContext): EntrySlot {
    if (HtmlMicrosyntax.asciiLower(field.name) === ControlRules.CHARSET_FIELD) {
      const charset = context.charset ?? ControlRules.CHARSET;
      return this.#create(field, {
        schema: this.#annotate(field, { type: 'string', const: charset }),
        min: 1,
        max: 1,
        required: false,
        defaults: [charset],
      });
    }
    if (context.tokens.has(field.name)) {
      const schema: JsonSchema = { type: 'string', readOnly: true, 'x-appii-token': true };
      if (field.value !== '') schema['x-appii-token-example'] = field.value;
      return this.#create(field, { schema: this.#annotate(field, schema), min: 1, max: 1, required: false });
    }
    return this.#create(field, {
      schema: this.#annotate(field, { type: 'string' }),
      min: 1,
      max: 1,
      required: false,
      defaults: [field.value],
    });
  }

  #radio(radios: readonly FormField[], context: SlotContext): EntrySlot {
    const { values, labels } = EntrySlotFactory.#choices(radios.map((radio) => ({ value: radio.value, label: radio.label ?? '' })));
    const schema: JsonSchema = { type: 'string', enum: values, 'x-html-type': 'radio' };
    if (labels) schema['x-html-labels'] = labels;
    const htmlRequired = radios.some((radio) => radio.required);
    if (htmlRequired) schema['x-html-required'] = true;
    const checked = radios.find((radio) => radio.checked);
    const titles = new Set(radios.map((radio) => radio.title ?? ''));
    const title = titles.size === 1 ? radios[0]?.title : undefined;
    const slot: EntrySlot = {
      order: radios[0]?.order ?? 0,
      schema,
      min: 0,
      max: values.length > 0 ? 1 : 0,
      list: false,
      choice: false,
      unique: false,
      required: context.validate && htmlRequired,
      defaults: checked ? [checked.value] : [],
      type: 'radio',
    };
    if (title) slot.description = title;
    return slot;
  }

  #rangeAnnotations(field: FormField, schema: JsonSchema): void {
    if (field.min !== undefined) schema['x-html-min'] = field.min;
    if (field.max !== undefined) schema['x-html-max'] = field.max;
    if (field.step !== undefined) schema['x-html-step'] = field.step;
  }

  #annotate(field: FormField, schema: JsonSchema): JsonSchema {
    schema['x-html-type'] = field.type;
    if (field.required) schema['x-html-required'] = true;
    if (field.readOnly) {
      schema.readOnly = true;
      schema['x-html-readonly'] = true;
    }
    if (field.placeholder !== undefined && field.kind !== 'select') schema['x-html-placeholder'] = field.placeholder;
    if (field.autocomplete !== undefined) schema['x-html-autocomplete'] = field.autocomplete;
    return schema;
  }

  #create(
    field: FormField,
    parts: { schema: JsonSchema; min: number; max: number; required: boolean; list?: boolean; choice?: boolean; unique?: boolean; defaults?: unknown[] },
  ): EntrySlot {
    const slot: EntrySlot = {
      order: field.order,
      schema: parts.schema,
      min: parts.min,
      max: parts.max,
      list: parts.list ?? false,
      choice: parts.choice ?? false,
      unique: parts.unique ?? false,
      required: parts.required,
      type: field.type,
    };
    if (parts.defaults) slot.defaults = parts.defaults;
    if (field.label) slot.label = field.label;
    if (field.title && field.title !== field.label) slot.description = field.title;
    return slot;
  }

  static #choices(entries: readonly { value: string; label: string }[]): { values: string[]; labels?: string[] } {
    const seen = new Map<string, string>();
    for (const entry of entries) if (!seen.has(entry.value)) seen.set(entry.value, entry.label);
    const values = [...seen.keys()];
    const labels = [...seen.values()];
    return labels.some((label, i) => label !== '' && label !== values[i]) ? { values, labels } : { values };
  }
}
