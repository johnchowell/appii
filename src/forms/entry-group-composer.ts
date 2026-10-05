import type { JsonSchema } from '../model/index.js';
import { Json } from '../shared/index.js';
import type { EntrySlot } from './entry-slot-factory.js';

export interface ComposedProperty {
  schema: JsonSchema;
  required: boolean;
  empty: boolean;
}

export class EntryGroupComposer {
  compose(slots: readonly EntrySlot[]): ComposedProperty {
    const ordered = [...slots].sort((a, b) => a.order - b.order);
    const live = ordered.filter((slot) => slot.max > 0);
    const first = live[0];
    if (!first) {
      const fallback = ordered[0];
      return { schema: fallback ? this.#scalar(fallback) : {}, required: false, empty: true };
    }
    if (live.length === 1 && !first.list) return { schema: this.#scalar(first), required: first.required, empty: false };
    return { schema: this.#array(live), required: live.some((slot) => slot.required), empty: false };
  }

  #scalar(slot: EntrySlot): JsonSchema {
    const schema = EntryGroupComposer.#describe(slot.schema, slot.label, slot.description);
    const fixed = 'const' in slot.schema && slot.min >= 1;
    if (slot.defaults?.length === 1 && !fixed) schema.default = slot.defaults[0];
    return schema;
  }

  #array(slots: readonly EntrySlot[]): JsonSchema {
    const single = slots.length === 1 ? slots[0] : undefined;
    const schema: JsonSchema = { type: 'array' };
    const label = EntryGroupComposer.#shared(slots.map((slot) => slot.label));
    const description = EntryGroupComposer.#shared(slots.map((slot) => slot.description));
    const type = EntryGroupComposer.#shared(slots.map((slot) => slot.type));
    if (label) schema.title = label;
    if (description) schema.description = description;
    schema.items = this.#items(slots);
    const requiredOptional = slots.filter((slot) => slot.required && slot.min === 0);
    const minItems = slots.reduce((sum, slot) => sum + slot.min, 0) + requiredOptional.length;
    const maxItems = slots.reduce((sum, slot) => sum + slot.max, 0);
    if (minItems > 0) schema.minItems = minItems;
    if (Number.isFinite(maxItems) && !(single?.unique ?? false)) schema.maxItems = maxItems;
    if (single?.unique || this.#distinctChoices(slots)) schema.uniqueItems = true;
    if (!single && requiredOptional.length > 0) {
      const contains = requiredOptional.map((slot) => ({ contains: EntryGroupComposer.#match(slot.schema) }));
      if (contains.length === 1) Object.assign(schema, contains[0]);
      else schema.allOf = contains;
    }
    if (type) schema['x-html-type'] = type;
    if (slots.some((slot) => slot.schema['x-html-required'] === true)) schema['x-html-required'] = true;
    const defaults = slots.every((slot) => slot.defaults !== undefined) ? slots.flatMap((slot) => slot.defaults ?? []) : [];
    if (defaults.length > 0) schema.default = defaults;
    return schema;
  }

  #items(slots: readonly EntrySlot[]): JsonSchema {
    const first = slots[0];
    if (slots.length === 1 && first) return first.schema;
    if (slots.every((slot) => slot.choice)) {
      const values: unknown[] = [];
      const labels: string[] = [];
      for (const slot of slots) {
        if (values.some((value) => Object.is(value, slot.schema.const))) continue;
        values.push(slot.schema.const);
        labels.push(slot.label ?? '');
      }
      const items: JsonSchema = { type: 'string', enum: values };
      const type = EntryGroupComposer.#shared(slots.map((slot) => slot.type));
      if (type) items['x-html-type'] = type;
      if (labels.some((label, i) => label !== '' && label !== values[i])) items['x-html-labels'] = labels;
      return items;
    }
    const distinct = new Map<string, JsonSchema>();
    for (const slot of slots) {
      const key = Json.stableStringify(slot.schema, 0);
      if (!distinct.has(key)) distinct.set(key, slot.schema);
    }
    const variants = [...distinct.values()];
    return variants.length === 1 && variants[0] ? variants[0] : { anyOf: variants };
  }

  #distinctChoices(slots: readonly EntrySlot[]): boolean {
    if (slots.length < 2 || !slots.every((slot) => slot.choice)) return false;
    return new Set(slots.map((slot) => slot.schema.const)).size === slots.length;
  }

  static #match(schema: JsonSchema): JsonSchema {
    if ('const' in schema) return { const: schema.const };
    if (Array.isArray(schema.enum)) return { enum: schema.enum };
    return schema;
  }

  static #shared(values: readonly (string | undefined)[]): string | undefined {
    const distinct = new Set(values.filter((value): value is string => value !== undefined && value !== ''));
    return distinct.size === 1 && values.every((value) => value !== undefined && value !== '') ? [...distinct][0] : undefined;
  }

  static #describe(schema: JsonSchema, title: string | undefined, description: string | undefined): JsonSchema {
    const { type, ...rest } = schema;
    const out: JsonSchema = {};
    if (type !== undefined) out.type = type;
    if (title) out.title = title;
    if (description) out.description = description;
    return Object.assign(out, rest);
  }
}
