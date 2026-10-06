import type { FormDescriptor } from '../model/index.js';
import { FormSchemaBuilder } from '../forms/index.js';
import { Text } from '../shared/index.js';
import { Helpers } from './helpers.js';
import type { ObservedSubmission } from './observed-submissions.js';

export interface ChoiceSource {
  readonly form: FormDescriptor;
  readonly observed: readonly ObservedSubmission[];
}

export class ChoiceEvidence {
  static readonly SELECT_TYPES: ReadonlySet<string> = new Set(['select-one', 'select-multiple']);

  static identity(form: FormDescriptor): string {
    const pairs = (list: FormDescriptor['fields']): string[][] => list.map((field) => [field.name, field.type]).sort((a, b) => Text.compare(a.join('\n'), b.join('\n')));
    return JSON.stringify([form.method, FormSchemaBuilder.requestUrl(form.action, form.method), form.enctype, pairs(form.fields), pairs(form.submitters)]);
  }

  static options(form: FormDescriptor, name: string): string[] {
    const values = form.fields.filter((field) => field.name === name && ChoiceEvidence.SELECT_TYPES.has(field.type)).flatMap((field) => (field.options ?? []).map((option) => option.value));
    return Helpers.distinct(values);
  }

  open(sources: readonly ChoiceSource[]): Map<FormDescriptor, Map<string, string[]>> {
    const groups = new Map<string, ChoiceSource[]>();
    for (const source of sources) {
      const key = ChoiceEvidence.identity(source.form);
      groups.set(key, [...(groups.get(key) ?? []), source]);
    }
    const out = new Map<FormDescriptor, Map<string, string[]>>();
    for (const group of groups.values()) {
      const members = Helpers.distinct(group.map((source) => source.form));
      const names = Helpers.distinct(members.flatMap((form) => form.fields.filter((field) => ChoiceEvidence.SELECT_TYPES.has(field.type) && field.name !== '').map((field) => field.name)));
      for (const name of names) {
        const lists = members.map((form) => ChoiceEvidence.options(form, name));
        const shapes = new Set(lists.map((list) => JSON.stringify([...list].sort(Text.compare))));
        if (shapes.size < 2 && !group.some((source) => ChoiceEvidence.#outside(source, name))) continue;
        const union = Helpers.distinct(lists.flat());
        for (const form of members) {
          const open = out.get(form) ?? new Map<string, string[]>();
          open.set(name, union);
          out.set(form, open);
        }
      }
    }
    return out;
  }

  static #outside(source: ChoiceSource, name: string): boolean {
    const known = new Set(ChoiceEvidence.options(source.form, name));
    return source.observed.some((observed) => (observed.entries.get(name) ?? []).some((value) => !known.has(value)));
  }
}
