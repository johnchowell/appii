import type { Endpoint, EndpointForm, FormSubmitter } from '../model/index.js';

export type FormSourceEndpoint = Pick<Endpoint, 'form' | 'requestBody'>;

export class FormSource {
  static readonly SCRIPT: FormSubmitter = 'script';
  static readonly SCRIPT_SENDER = 'a script of the form, not the form itself';

  static isScript(form: Pick<EndpointForm, 'submittedBy'> | undefined): boolean {
    return form?.submittedBy === FormSource.SCRIPT;
  }

  static contentType(endpoint: FormSourceEndpoint): string | undefined {
    const form = endpoint.form;
    if (!form) return undefined;
    return FormSource.isScript(form) ? endpoint.requestBody?.mimeType : form.enctype;
  }

  static describe(endpoint: FormSourceEndpoint, code: (text: string) => string = (text) => text, place: (url: string) => string = (url) => url): string | undefined {
    const form = endpoint.form;
    if (!form) return undefined;
    const where = `${code(form.selector)} on ${place(form.pageUrl)}`;
    const type = FormSource.contentType(endpoint);
    if (FormSource.isScript(form)) return `Sent by a script of the form ${where}${type ? ` as ${type}` : ''}.`;
    return `Submitted by the form ${where} (${form.enctype}).`;
  }
}
