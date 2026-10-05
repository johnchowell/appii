import type { JsonSchema, ParamInfo } from '../model/index.js';
import { Json, PatternAudit, Schema } from '../shared/index.js';

export interface FieldRule {
  name: string;
  type: string;
  label?: string;
  hint?: string;
  required?: boolean;
  list?: boolean;
  itemRequired?: boolean;
  unique?: boolean;
  maxItems?: number;
  contains?: string[];
  options?: string[];
  constant?: string;
  pattern?: string;
  unsafePattern?: boolean;
  minLength?: number;
  maxLength?: number;
  min?: string;
  max?: string;
  step?: string;
  base?: string;
  multiple?: boolean;
}

export interface FieldEntry {
  name: string;
  type: string;
  constant?: string;
}

export interface CompiledForm {
  rules: FieldRule[];
  fields: FieldEntry[];
  defaults: Record<string, unknown>;
}

export interface FormCondition {
  name: string;
  values?: string[];
}

export interface CompiledVariant extends CompiledForm {
  when: FormCondition;
  noValidate: boolean;
}

export interface CompiledSchema extends CompiledForm {
  variants: CompiledVariant[];
}

export interface FormRuleCompilerDeps {
  patterns?: PatternAudit;
}

export class FormRuleCompiler {
  static readonly BARRED_TYPES: ReadonlySet<string> = new Set(['hidden', 'submit', 'image', 'reset', 'button']);
  static readonly CHOICE_TYPES: ReadonlySet<string> = new Set(['checkbox', 'radio', 'select-one', 'select-multiple']);
  static readonly RANGE_TYPES: ReadonlySet<string> = new Set(['number', 'range', 'date', 'month', 'week', 'time', 'datetime-local']);
  static readonly CONSTANT_DEFAULT_TYPES: ReadonlySet<string> = new Set(['submit', 'hidden']);
  static readonly DEFAULT_TYPE = 'text';
  static readonly NOVALIDATE = 'x-html-novalidate';
  static readonly FIELDS = 'x-appii-fields';

  readonly #patterns: PatternAudit;

  constructor(deps: FormRuleCompilerDeps = {}) {
    this.#patterns = deps.patterns ?? new PatternAudit();
  }

  static create(): FormRuleCompiler {
    return new FormRuleCompiler({ patterns: new PatternAudit() });
  }

  compileSchema(schema: JsonSchema | undefined): CompiledSchema {
    const properties = Schema.properties(schema);
    const variants: CompiledVariant[] = [];
    for (const branch of Schema.branches(schema)) {
      const variant = this.#variant(properties, branch.when, branch.then);
      if (variant) variants.push(variant);
    }
    return { ...this.compile(Object.entries(properties)), variants };
  }

  #variant(top: Record<string, JsonSchema>, when: JsonSchema, then: JsonSchema): CompiledVariant | undefined {
    const [name] = [...Schema.requiredSet(when)];
    if (name === undefined) return undefined;
    const condition: FormCondition = { name };
    const values = FormRuleCompiler.#values(Schema.properties(when)[name]);
    if (values !== undefined) condition.values = values;
    const own = Json.isPlainObject(then.properties) ? then.properties : {};
    const listed = then[FormRuleCompiler.FIELDS];
    const names = Array.isArray(listed) ? listed.filter((item): item is string => typeof item === 'string') : Object.keys(top);
    const entries: [string, JsonSchema][] = [];
    for (const field of names) {
      const restated = Object.hasOwn(own, field) ? own[field] : undefined;
      if (restated === false) continue;
      const schema = Json.isPlainObject(restated) ? restated : Object.hasOwn(top, field) ? top[field] : undefined;
      if (schema) entries.push([field, schema]);
    }
    return { when: condition, noValidate: then[FormRuleCompiler.NOVALIDATE] === true, ...this.compile(entries) };
  }

  static #values(schema: JsonSchema | undefined): string[] | undefined {
    if (!schema) return undefined;
    const raw = 'const' in schema ? [schema.const] : Array.isArray(schema.enum) ? schema.enum : undefined;
    if (raw === undefined) return undefined;
    return raw.filter((value) => typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean').map(String);
  }

  compileParams(params: readonly ParamInfo[]): CompiledForm {
    return this.compile(params.map((param) => [param.name, param.schema]));
  }

  compile(properties: readonly (readonly [string, JsonSchema])[]): CompiledForm {
    const rules: FieldRule[] = [];
    const fields: FieldEntry[] = [];
    const defaults: [string, unknown][] = [];
    for (const [name, schema] of properties) {
      const rule = this.rule(name, schema);
      if (rule) rules.push(rule);
      fields.push(this.entry(name, schema));
      const value = this.defaultValue(schema);
      if (value !== undefined) defaults.push([name, value]);
    }
    return { rules, fields, defaults: Object.fromEntries(defaults) };
  }

  static htmlType(schema: JsonSchema): string {
    const own = schema['x-html-type'];
    if (typeof own === 'string' && own !== '') return own;
    const items = Schema.items(schema);
    const inner = items?.['x-html-type'];
    return typeof inner === 'string' && inner !== '' ? inner : FormRuleCompiler.DEFAULT_TYPE;
  }

  static isBarred(schema: JsonSchema): boolean {
    if (schema.readOnly === true || schema['x-html-readonly'] === true || Schema.isTokenSchema(schema)) return true;
    if (schema['x-html-dirname-for'] !== undefined) return true;
    return FormRuleCompiler.BARRED_TYPES.has(FormRuleCompiler.htmlType(schema));
  }

  isAutoFilled(schema: JsonSchema): boolean {
    return Schema.isTokenSchema(schema) || schema.readOnly === true || this.defaultValue(schema) !== undefined;
  }

  defaultValue(schema: JsonSchema): unknown {
    if (Schema.isTokenSchema(schema)) return undefined;
    if ('default' in schema) return Json.clone(schema.default);
    const type = FormRuleCompiler.htmlType(schema);
    if ('const' in schema && FormRuleCompiler.CONSTANT_DEFAULT_TYPES.has(type)) return Json.clone(schema.const);
    if (type === 'submit' && Array.isArray(schema.enum) && schema.enum.length > 0) return Json.clone(schema.enum[0]);
    if (type === 'image' && Schema.primaryType(schema) === 'integer') return 0;
    return undefined;
  }

  entry(name: string, schema: JsonSchema): FieldEntry {
    const entry: FieldEntry = { name, type: FormRuleCompiler.htmlType(schema) };
    const element = Schema.primaryType(schema) === 'array' ? (Schema.items(schema) ?? {}) : schema;
    if (typeof element.const === 'string') entry.constant = element.const;
    return entry;
  }

  rule(name: string, schema: JsonSchema): FieldRule | undefined {
    if (FormRuleCompiler.isBarred(schema)) return undefined;
    const array = Schema.primaryType(schema) === 'array';
    const element = array ? (Schema.items(schema) ?? {}) : schema;
    const type = FormRuleCompiler.htmlType(schema);
    const rule: FieldRule = { name, type };
    const label = typeof schema.title === 'string' ? schema.title : typeof element.title === 'string' ? element.title : undefined;
    if (label) rule.label = label;
    const hint = typeof schema.description === 'string' ? schema.description : typeof element.description === 'string' ? element.description : undefined;
    if (hint) rule.hint = hint;
    this.#constraints(rule, element, type);
    if (!array) {
      if (schema['x-html-required'] === true) rule.required = true;
      return rule;
    }
    rule.list = true;
    const choice = FormRuleCompiler.CHOICE_TYPES.has(type);
    const contains = FormRuleCompiler.#contains(schema);
    if (contains.length > 0) rule.contains = contains;
    if (schema['x-html-required'] === true && contains.length === 0) rule.required = true;
    if (!choice && element['x-html-required'] === true) rule.itemRequired = true;
    if (schema.uniqueItems === true) rule.unique = true;
    if (choice && typeof schema.maxItems === 'number') rule.maxItems = schema.maxItems;
    return rule;
  }

  #constraints(rule: FieldRule, schema: JsonSchema, type: string): void {
    if (Array.isArray(schema.enum)) rule.options = schema.enum.filter((value): value is string => typeof value === 'string');
    if (typeof schema.const === 'string') rule.constant = schema.const;
    const pattern = schema['x-html-pattern'];
    if (typeof pattern === 'string') {
      rule.pattern = pattern;
      if (this.#patterns.unsafe(pattern)) rule.unsafePattern = true;
    }
    const minLength = schema['x-html-minlength'];
    if (typeof minLength === 'number') rule.minLength = minLength;
    const maxLength = schema['x-html-maxlength'];
    if (typeof maxLength === 'number') rule.maxLength = maxLength;
    for (const key of ['min', 'max', 'step'] as const) {
      const value = schema[`x-html-${key}`];
      if (typeof value === 'string') rule[key] = value;
    }
    if (schema['x-html-multiple'] === true) rule.multiple = true;
    if (FormRuleCompiler.RANGE_TYPES.has(type) && schema.default !== undefined && (typeof schema.default === 'string' || typeof schema.default === 'number')) {
      rule.base = String(schema.default);
    }
  }

  static #contains(schema: JsonSchema): string[] {
    const out: string[] = [];
    const add = (node: unknown): void => {
      const contains = Schema.asSchema(Schema.asSchema(node)?.contains);
      if (!contains) return;
      if (typeof contains.const === 'string') out.push(contains.const);
      else if (Array.isArray(contains.enum) && contains.enum.length === 1 && typeof contains.enum[0] === 'string') out.push(contains.enum[0]);
    };
    add(schema);
    if (Array.isArray(schema.allOf)) schema.allOf.forEach(add);
    return out;
  }
}
