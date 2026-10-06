import type { FormDescriptor, FormField } from '../model/index.js';
import { ControlRules } from './control-rules.js';

export interface LoginFields {
  readonly password: string;
  readonly identifier?: string;
  readonly personal: readonly string[];
}

export class LoginFormDetector {
  static readonly PASSWORD_TYPE = 'password';
  static readonly NEW_PASSWORD = 'new-password';
  static readonly WEBAUTHN = 'webauthn';
  static readonly EMAIL_TYPE = 'email';
  static readonly INPUT_KIND = 'input';
  static readonly TEXTAREA_KIND = 'textarea';
  static readonly IDENTIFIER_FIELDS: ReadonlySet<string> = new Set(['username', 'email']);
  static readonly IDENTIFIER_TYPES: ReadonlySet<string> = new Set([...ControlRules.TEXT_TYPES].filter((type) => type !== LoginFormDetector.PASSWORD_TYPE));
  static readonly WHITESPACE: RegExp = /[\t\n\f\r ]+/;

  static autofillField(autocomplete: string | undefined): string | undefined {
    const tokens = (autocomplete ?? '')
      .toLowerCase()
      .split(LoginFormDetector.WHITESPACE)
      .filter((token) => token !== '');
    if (tokens[tokens.length - 1] === LoginFormDetector.WEBAUTHN) tokens.pop();
    return tokens[tokens.length - 1];
  }

  static isPassword(field: FormField): boolean {
    return field.kind === LoginFormDetector.INPUT_KIND && field.type === LoginFormDetector.PASSWORD_TYPE;
  }

  static isTextControl(field: FormField): boolean {
    return field.kind === LoginFormDetector.INPUT_KIND && LoginFormDetector.IDENTIFIER_TYPES.has(field.type);
  }

  static detect(form: Pick<FormDescriptor, 'fields'>): LoginFields | undefined {
    const passwords = form.fields.filter((field) => LoginFormDetector.isPassword(field));
    const [password] = passwords;
    if (passwords.length !== 1 || password === undefined || password.name === '') return undefined;
    if (LoginFormDetector.autofillField(password.autocomplete) === LoginFormDetector.NEW_PASSWORD) return undefined;
    const entries = form.fields.filter((field) => field !== password && field.name !== '' && !field.disabled);
    const texts = entries.filter((field) => LoginFormDetector.isTextControl(field));
    const before = texts.filter((field) => field.order < password.order);
    const identifier =
      texts.find((field) => LoginFormDetector.IDENTIFIER_FIELDS.has(LoginFormDetector.autofillField(field.autocomplete) ?? '')) ??
      texts.find((field) => field.type === LoginFormDetector.EMAIL_TYPE) ??
      (before.length === 1 ? before[0] : undefined);
    const personal = entries.filter((field) => LoginFormDetector.isTextControl(field) || field.kind === LoginFormDetector.TEXTAREA_KIND).map((field) => field.name);
    const names = [...new Set([...(identifier ? [identifier.name] : []), ...personal, password.name])];
    return identifier ? { password: password.name, identifier: identifier.name, personal: names } : { password: password.name, personal: names };
  }

  static isLogin(form: Pick<FormDescriptor, 'fields'>): boolean {
    return LoginFormDetector.detect(form) !== undefined;
  }

  static hasPassword(form: Pick<FormDescriptor, 'fields'>): boolean {
    return form.fields.some((field) => LoginFormDetector.isPassword(field));
  }
}
