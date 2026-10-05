import {
  BODY_KINDS,
  COOKIE_ROLES,
  CSRF_LOCATIONS,
  ENDPOINT_KINDS,
  FIELD_KINDS,
  FORM_ENCTYPES,
  FORM_METHODS,
  MODEL_VERSION,
  PARAM_LOCATIONS,
  RESOURCE_TYPES,
  SAME_SITE_VALUES,
  TOKEN_SOURCES,
} from '../model/index.js';
import type { ApiModel } from '../model/index.js';
import { CaptureStore } from '../capture/index.js';
import { Json } from '../shared/index.js';

type Fields = Record<string, unknown>;

interface FieldRule {
  optional?: boolean;
  nullable?: boolean;
}

export class ModelValidator {
  static readonly VERSION = MODEL_VERSION;
  static readonly MAX_PROBLEMS = 25;
  static readonly ENDPOINT_KINDS: ReadonlySet<string> = new Set(ENDPOINT_KINDS);
  static readonly BODY_KINDS: ReadonlySet<string> = new Set(BODY_KINDS);
  static readonly PARAM_LOCATIONS: ReadonlySet<string> = new Set(PARAM_LOCATIONS);
  static readonly CSRF_LOCATIONS: ReadonlySet<string> = new Set(CSRF_LOCATIONS);
  static readonly TOKEN_SOURCES: ReadonlySet<string> = new Set(TOKEN_SOURCES);
  static readonly COOKIE_ROLES: ReadonlySet<string> = new Set(COOKIE_ROLES);
  static readonly SAME_SITE: ReadonlySet<string> = new Set(SAME_SITE_VALUES);
  static readonly FORM_METHODS: ReadonlySet<string> = new Set(FORM_METHODS);
  static readonly FORM_ENCTYPES: ReadonlySet<string> = new Set(FORM_ENCTYPES);
  static readonly FIELD_KINDS: ReadonlySet<string> = new Set(FIELD_KINDS);
  static readonly RESOURCE_TYPES: ReadonlySet<string> = new Set(RESOURCE_TYPES);

  static looksLikeModel(value: unknown): boolean {
    return CaptureStore.isModel(value);
  }

  isModel(value: unknown): value is ApiModel {
    return this.validate(value).length === 0;
  }

  validate(value: unknown): string[] {
    const problems: string[] = [];
    const root = this.#object(problems, value, '(root)');
    if (!root) return problems;
    if (root.version !== ModelValidator.VERSION) problems.push(`version: expected ${ModelValidator.VERSION}, got ${JSON.stringify(root.version) ?? 'nothing'}`);
    this.#string(problems, root, 'name', '');
    this.#string(problems, root, 'generatedAt', '');
    this.#string(problems, root, 'primaryOrigin', '');
    this.#strings(problems, root, 'origins', '');
    const source = this.#object(problems, root.source, 'source');
    if (source) {
      this.#number(problems, source, 'exchanges', 'source.');
      for (const key of ['startUrl', 'file', 'capturedFrom', 'capturedTo']) this.#string(problems, source, key, 'source.', { optional: true });
    }
    this.#array(problems, root, 'endpoints', '', (item, path) => this.#endpoint(problems, item, path));
    this.#array(problems, root, 'cookies', '', (item, path) => this.#cookie(problems, item, path));
    this.#array(problems, root, 'forms', '', (item, path) => this.#form(problems, item, path));
    this.#array(problems, root, 'websockets', '', (item, path) => {
      const socket = this.#object(problems, item, path);
      if (!socket) return;
      this.#string(problems, socket, 'url', path + '.');
      this.#number(problems, socket, 'messages', path + '.');
      this.#strings(problems, socket, 'examples', path + '.');
    });
    return problems.slice(0, ModelValidator.MAX_PROBLEMS);
  }

  #endpoint(problems: string[], value: unknown, path: string): void {
    const endpoint = this.#object(problems, value, path);
    if (!endpoint) return;
    const at = path + '.';
    for (const key of ['id', 'name', 'key', 'method', 'origin', 'path']) this.#string(problems, endpoint, key, at);
    this.#string(problems, endpoint, 'operationName', at, { optional: true });
    this.#oneOf(problems, endpoint, 'kind', ModelValidator.ENDPOINT_KINDS, at);
    this.#boolean(problems, endpoint, 'firstParty', at);
    this.#number(problems, endpoint, 'count', at);
    for (const key of ['pathParams', 'queryParams', 'headerParams']) this.#array(problems, endpoint, key, at, (item, p) => this.#param(problems, item, p));
    if (endpoint.requestBody !== undefined) this.#body(problems, endpoint.requestBody, at + 'requestBody');
    this.#array(problems, endpoint, 'responses', at, (item, p) => {
      const response = this.#object(problems, item, p);
      if (!response) return;
      this.#number(problems, response, 'status', p + '.');
      this.#number(problems, response, 'count', p + '.');
      this.#strings(problems, response, 'headers', p + '.');
      if (response.body !== undefined) this.#body(problems, response.body, p + '.body');
    });
    const auth = this.#object(problems, endpoint.auth, at + 'auth');
    if (auth) {
      this.#strings(problems, auth, 'cookies', at + 'auth.');
      this.#strings(problems, auth, 'headers', at + 'auth.');
      this.#boolean(problems, auth, 'bearer', at + 'auth.');
      this.#boolean(problems, auth, 'anonymous', at + 'auth.', { optional: true });
      this.#array(problems, auth, 'csrf', at + 'auth.', (item, p) => {
        const token = this.#object(problems, item, p);
        if (!token) return;
        this.#oneOf(problems, token, 'location', ModelValidator.CSRF_LOCATIONS, p + '.');
        this.#string(problems, token, 'name', p + '.');
        this.#oneOf(problems, token, 'source', ModelValidator.TOKEN_SOURCES, p + '.');
        this.#string(problems, token, 'sourceName', p + '.', { optional: true });
        this.#string(problems, token, 'sourceUrl', p + '.', { optional: true });
        this.#string(problems, token, 'sourceMethod', p + '.', { optional: true });
      });
    }
    if (endpoint.form !== undefined) {
      const form = this.#object(problems, endpoint.form, at + 'form');
      if (form) {
        this.#string(problems, form, 'pageUrl', at + 'form.');
        this.#string(problems, form, 'selector', at + 'form.');
        this.#string(problems, form, 'action', at + 'form.');
        this.#oneOf(problems, form, 'method', ModelValidator.FORM_METHODS, at + 'form.');
        this.#oneOf(problems, form, 'enctype', ModelValidator.FORM_ENCTYPES, at + 'form.');
        this.#string(problems, form, 'charset', at + 'form.');
        this.#fields(problems, form, at + 'form.');
      }
    }
    this.#array(problems, endpoint, 'resourceTypes', at, (item, p) => {
      if (typeof item !== 'string' || !ModelValidator.RESOURCE_TYPES.has(item)) problems.push(`${p}: expected a resource type`);
    });
    this.#array(problems, endpoint, 'samples', at, (item, p) => {
      const sample = this.#object(problems, item, p);
      if (!sample) return;
      for (const key of ['exchangeId', 'url', 'startedAt']) this.#string(problems, sample, key, p + '.');
      this.#string(problems, sample, 'pageUrl', p + '.', { optional: true });
      this.#number(problems, sample, 'status', p + '.', { optional: true });
    });
  }

  #param(problems: string[], value: unknown, path: string): void {
    const param = this.#object(problems, value, path);
    if (!param) return;
    this.#string(problems, param, 'name', path + '.');
    this.#oneOf(problems, param, 'in', ModelValidator.PARAM_LOCATIONS, path + '.');
    this.#boolean(problems, param, 'required', path + '.');
    this.#object(problems, param.schema, path + '.schema');
    this.#strings(problems, param, 'examples', path + '.');
  }

  #body(problems: string[], value: unknown, path: string): void {
    const body = this.#object(problems, value, path);
    if (!body) return;
    this.#string(problems, body, 'mimeType', path + '.');
    this.#oneOf(problems, body, 'kind', ModelValidator.BODY_KINDS, path + '.');
    if (body.schema !== undefined) this.#object(problems, body.schema, path + '.schema');
    if (!Array.isArray(body.examples)) problems.push(`${path}.examples: expected an array`);
  }

  #cookie(problems: string[], value: unknown, path: string): void {
    const cookie = this.#object(problems, value, path);
    if (!cookie) return;
    const at = path + '.';
    for (const key of ['name', 'domain', 'path', 'valueExample']) this.#string(problems, cookie, key, at);
    for (const key of ['httpOnly', 'secure', 'session']) this.#boolean(problems, cookie, key, at);
    this.#oneOf(problems, cookie, 'sameSite', ModelValidator.SAME_SITE, at, { nullable: true });
    this.#string(problems, cookie, 'partitionKey', at, { optional: true });
    this.#string(problems, cookie, 'expires', at, { nullable: true });
    this.#oneOf(problems, cookie, 'role', ModelValidator.COOKIE_ROLES, at);
    this.#strings(problems, cookie, 'setBy', at);
    this.#strings(problems, cookie, 'usedBy', at);
  }

  #form(problems: string[], value: unknown, path: string): void {
    const form = this.#object(problems, value, path);
    if (!form) return;
    const at = path + '.';
    this.#number(problems, form, 'index', at);
    for (const key of ['selector', 'pageUrl', 'action', 'charset']) this.#string(problems, form, key, at);
    for (const key of ['id', 'name', 'acceptCharset', 'target']) this.#string(problems, form, key, at, { optional: true });
    this.#oneOf(problems, form, 'method', ModelValidator.FORM_METHODS, at);
    this.#oneOf(problems, form, 'enctype', ModelValidator.FORM_ENCTYPES, at);
    this.#boolean(problems, form, 'noValidate', at);
    this.#fields(problems, form, at);
    this.#strings(problems, form, 'endpoints', at, { optional: true });
  }

  #fields(problems: string[], holder: Fields, at: string): void {
    for (const key of ['fields', 'submitters']) this.#array(problems, holder, key, at, (item, p) => this.#field(problems, item, p));
    this.#strings(problems, holder, 'tokenFields', at);
  }

  #field(problems: string[], value: unknown, path: string): void {
    const field = this.#object(problems, value, path);
    if (!field) return;
    const at = path + '.';
    for (const key of ['name', 'type', 'value']) this.#string(problems, field, key, at);
    this.#number(problems, field, 'order', at);
    this.#oneOf(problems, field, 'kind', ModelValidator.FIELD_KINDS, at);
    for (const key of ['hasValueAttribute', 'checked', 'disabled', 'readOnly', 'required', 'multiple']) this.#boolean(problems, field, key, at);
    this.#array(
      problems,
      field,
      'options',
      at,
      (item, p) => {
        const option = this.#object(problems, item, p);
        if (!option) return;
        this.#string(problems, option, 'value', p + '.');
        this.#string(problems, option, 'label', p + '.');
        this.#boolean(problems, option, 'selected', p + '.');
        this.#boolean(problems, option, 'disabled', p + '.');
      },
      { optional: true },
    );
  }

  #object(problems: string[], value: unknown, path: string): Fields | undefined {
    if (Json.isPlainObject(value)) return value;
    problems.push(`${path}: expected an object`);
    return undefined;
  }

  #missing(holder: Fields, key: string, rule: FieldRule): boolean {
    const value = holder[key];
    return (value === undefined && rule.optional === true) || (value === null && rule.nullable === true);
  }

  #string(problems: string[], holder: Fields, key: string, at: string, rule: FieldRule = {}): void {
    if (this.#missing(holder, key, rule)) return;
    if (typeof holder[key] !== 'string') problems.push(`${at}${key}: expected a string`);
  }

  #number(problems: string[], holder: Fields, key: string, at: string, rule: FieldRule = {}): void {
    if (this.#missing(holder, key, rule)) return;
    const value = holder[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) problems.push(`${at}${key}: expected a number`);
  }

  #boolean(problems: string[], holder: Fields, key: string, at: string, rule: FieldRule = {}): void {
    if (this.#missing(holder, key, rule)) return;
    if (typeof holder[key] !== 'boolean') problems.push(`${at}${key}: expected true or false`);
  }

  #oneOf(problems: string[], holder: Fields, key: string, allowed: ReadonlySet<string>, at: string, rule: FieldRule = {}): void {
    if (this.#missing(holder, key, rule)) return;
    const value = holder[key];
    if (typeof value !== 'string' || !allowed.has(value)) problems.push(`${at}${key}: expected one of ${[...allowed].join(', ')}`);
  }

  #strings(problems: string[], holder: Fields, key: string, at: string, rule: FieldRule = {}): void {
    if (this.#missing(holder, key, rule)) return;
    const value = holder[key];
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) problems.push(`${at}${key}: expected an array of strings`);
  }

  #array(problems: string[], holder: Fields, key: string, at: string, each: (item: unknown, path: string) => void, rule: FieldRule = {}): void {
    if (this.#missing(holder, key, rule)) return;
    const value = holder[key];
    if (!Array.isArray(value)) {
      problems.push(`${at}${key}: expected an array`);
      return;
    }
    for (let i = 0; i < value.length && problems.length < ModelValidator.MAX_PROBLEMS; i++) each(value[i], `${at}${key}[${i}]`);
  }
}
