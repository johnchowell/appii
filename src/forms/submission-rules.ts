import type { FormDescriptor, FormField } from '../model/index.js';
import { ControlRules } from './control-rules.js';
import { EntrySlotFactory } from './entry-slot-factory.js';

export class SubmissionRules {
  static readonly IMAGE_TYPE = 'image';

  static paths(form: FormDescriptor): (FormField | undefined)[] {
    const enabled = form.submitters.filter((submitter) => !submitter.disabled);
    if (enabled.length > 0) return enabled;
    if (form.submitters.length > 0) return [undefined];
    return SubmissionRules.implicitlySubmittable(form) ? [undefined] : [];
  }

  static implicitlySubmittable(form: Pick<FormDescriptor, 'fields' | 'submitters'>): boolean {
    const [defaultButton] = form.submitters;
    if (defaultButton) return !defaultButton.disabled;
    const blockers = form.fields.filter((field) => field.kind === 'input' && ControlRules.blocksImplicitSubmission(field.type));
    return blockers.length === 1 && blockers[0]?.disabled === false;
  }

  static explicitTarget(form: Pick<FormDescriptor, 'explicitAction'>, submitter?: FormField): boolean {
    if (submitter?.formAction !== undefined) return submitter.explicitFormAction !== false;
    return form.explicitAction !== false;
  }

  static fieldNames(form: Pick<FormDescriptor, 'fields'>): string[] {
    const names = form.fields.filter((field) => !field.disabled && field.name !== '').map((field) => field.name);
    return [...new Set(names)];
  }

  static submitterNames(submitter: FormField | undefined): string[] {
    if (!submitter) return [];
    if (submitter.type !== SubmissionRules.IMAGE_TYPE) return submitter.name === '' ? [] : [submitter.name];
    const prefix = submitter.name === '' ? '' : `${submitter.name}.`;
    return EntrySlotFactory.COORDINATES.map((axis) => prefix + axis);
  }

  static acceptedNames(form: Pick<FormDescriptor, 'fields' | 'submitters'>): Set<string> {
    const names = new Set<string>();
    for (const field of form.fields) {
      if (field.name !== '') names.add(field.name);
      if (field.dirName !== undefined && field.dirName !== '') names.add(field.dirName);
    }
    for (const submitter of form.submitters) {
      for (const name of SubmissionRules.submitterNames(submitter)) names.add(name);
      if (submitter.dirName !== undefined && submitter.dirName !== '') names.add(submitter.dirName);
    }
    return names;
  }

  static contributes(form: Pick<FormDescriptor, 'fields'>, submitter: FormField | undefined): boolean {
    return SubmissionRules.fieldNames(form).length > 0 || SubmissionRules.submitterNames(submitter).length > 0;
  }
}
