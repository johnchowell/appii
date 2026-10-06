import type { Endpoint, FormDescriptor, FormField } from '../model/index.js';
import { FormSchemaBuilder } from '../forms/index.js';

export interface InventoryEntry {
  readonly form: FormDescriptor;
  readonly endpoints: readonly Endpoint[];
}

export interface InventoryOptions {
  readonly url: (value: string) => string;
  readonly preferred: (form: FormDescriptor) => boolean;
}

export class FormInventory {
  static readonly VALUE_TYPES: ReadonlySet<string> = new Set(['checkbox', 'radio']);

  static signature(form: FormDescriptor, endpoints: readonly Endpoint[]): string {
    const target = endpoints.length > 0 ? endpoints.map((endpoint) => endpoint.key) : form.explicitAction === false ? null : FormSchemaBuilder.requestUrl(form.action, form.method);
    return JSON.stringify([
      form.method,
      form.enctype,
      form.charset,
      form.acceptCharset ?? null,
      form.noValidate,
      form.target ?? null,
      target,
      form.fields.map((field) => FormInventory.#field(field)),
      form.submitters.map((field) => FormInventory.#submitter(field)),
      form.tokenFields,
    ]);
  }

  merge(entries: readonly InventoryEntry[], options: InventoryOptions): InventoryEntry[] {
    const groups = new Map<string, InventoryEntry[]>();
    for (const entry of entries) {
      const key = FormInventory.signature(entry.form, entry.endpoints);
      groups.set(key, [...(groups.get(key) ?? []), entry]);
    }
    return [...groups.values()].map((group) => {
      const chosen = group.find((entry) => options.preferred(entry.form)) ?? group[0]!;
      if (group.length === 1) return chosen;
      const pages = [...new Set(group.map((entry) => options.url(entry.form.pageUrl)))];
      return { form: { ...chosen.form, instances: group.length, pages }, endpoints: chosen.endpoints };
    });
  }

  static #field(field: FormField): unknown[] {
    return [
      field.name,
      field.kind,
      field.type,
      FormInventory.VALUE_TYPES.has(field.type) ? field.value : null,
      field.disabled,
      field.readOnly,
      field.required,
      field.multiple,
      field.pattern ?? null,
      field.min ?? null,
      field.max ?? null,
      field.step ?? null,
      field.minLength ?? null,
      field.maxLength ?? null,
      field.accept ?? null,
      field.dirName ?? null,
      (field.options ?? []).map((option) => [option.value, option.label, option.disabled]),
    ];
  }

  static #submitter(field: FormField): unknown[] {
    return [
      field.name,
      field.type,
      field.value,
      field.disabled,
      field.explicitFormAction === false ? null : (field.formAction ?? null),
      field.formMethod ?? null,
      field.formEnctype ?? null,
      field.formNoValidate ?? false,
    ];
  }
}
