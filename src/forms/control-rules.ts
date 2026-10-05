import type { FormEnctype, FormMethod } from '../model/index.js';
import { HtmlMicrosyntax } from './html-microsyntax.js';

export type ControlAttribute = 'required' | 'readonly' | 'pattern' | 'length' | 'range' | 'placeholder' | 'multiple' | 'accept' | 'dirname';

export type ButtonType = 'submit' | 'reset' | 'button';

export class ControlRules {
  static readonly INPUT_TYPES: ReadonlySet<string> = new Set([
    'hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local',
    'number', 'range', 'color', 'checkbox', 'radio', 'file', 'submit', 'image', 'reset', 'button',
  ]);

  static readonly SUBMIT_TYPES: ReadonlySet<string> = new Set(['submit', 'image']);

  static readonly INERT_TYPES: ReadonlySet<string> = new Set(['reset', 'button']);

  static readonly TEXT_TYPES: ReadonlySet<string> = new Set(['text', 'search', 'tel', 'url', 'email', 'password']);

  static readonly TEMPORAL_TYPES: ReadonlySet<string> = new Set(['date', 'month', 'week', 'time', 'datetime-local']);

  static readonly ATTRIBUTES: Readonly<Record<ControlAttribute, ReadonlySet<string>>> = {
    required: new Set([
      'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number',
      'checkbox', 'radio', 'file', 'select-one', 'select-multiple', 'textarea',
    ]),
    readonly: new Set([
      'text', 'search', 'tel', 'url', 'email', 'password', 'date', 'month', 'week', 'time', 'datetime-local', 'number', 'textarea',
    ]),
    pattern: new Set(['text', 'search', 'tel', 'url', 'email', 'password']),
    length: new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'textarea']),
    range: new Set(['date', 'month', 'week', 'time', 'datetime-local', 'number', 'range']),
    placeholder: new Set(['text', 'search', 'tel', 'url', 'email', 'password', 'number', 'textarea']),
    multiple: new Set(['email', 'file', 'select-multiple']),
    accept: new Set(['file']),
    dirname: new Set(['hidden', 'text', 'search', 'tel', 'url', 'email', 'password', 'submit', 'reset', 'button', 'textarea']),
  };

  static readonly METHODS: ReadonlyMap<string, FormMethod> = new Map([
    ['get', 'GET'],
    ['post', 'POST'],
    ['dialog', 'DIALOG'],
  ]);

  static readonly ENCTYPES: ReadonlyMap<string, FormEnctype> = new Map([
    ['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded'],
    ['multipart/form-data', 'multipart/form-data'],
    ['text/plain', 'text/plain'],
  ]);

  static readonly BUTTON_TYPES: ReadonlyMap<string, ButtonType> = new Map([
    ['submit', 'submit'],
    ['reset', 'reset'],
    ['button', 'button'],
  ]);

  static readonly DEFAULT_METHOD: FormMethod = 'GET';
  static readonly DEFAULT_ENCTYPE: FormEnctype = 'application/x-www-form-urlencoded';
  static readonly DEFAULT_SUBMIT_VALUE = 'Submit';
  static readonly DEFAULT_CHECKABLE_VALUE = 'on';
  static readonly CHARSET_FIELD = '_charset_';
  static readonly CHARSET = 'UTF-8';

  static inputType(raw: string | undefined): string {
    if (raw === undefined) return 'text';
    const type = HtmlMicrosyntax.asciiLower(raw);
    return ControlRules.INPUT_TYPES.has(type) ? type : 'text';
  }

  static buttonType(raw: string | undefined, hasCommandFor: boolean): ButtonType {
    const known = raw === undefined ? undefined : ControlRules.BUTTON_TYPES.get(HtmlMicrosyntax.asciiLower(raw));
    if (known) return known;
    return hasCommandFor ? 'button' : 'submit';
  }

  static method(raw: string | undefined): FormMethod {
    return (raw === undefined ? undefined : ControlRules.METHODS.get(HtmlMicrosyntax.asciiLower(raw))) ?? ControlRules.DEFAULT_METHOD;
  }

  static enctype(raw: string | undefined): FormEnctype {
    return (raw === undefined ? undefined : ControlRules.ENCTYPES.get(HtmlMicrosyntax.asciiLower(raw))) ?? ControlRules.DEFAULT_ENCTYPE;
  }

  static applies(attribute: ControlAttribute, type: string): boolean {
    return ControlRules.ATTRIBUTES[attribute].has(type);
  }

  static isSubmitType(type: string): boolean {
    return ControlRules.SUBMIT_TYPES.has(type);
  }
}
