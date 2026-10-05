import type { JsonSchema } from '../../src/model/index.js';
import { Json, Schema } from '../../src/shared/index.js';

export class SchemaCheck {
  static valid(schema: JsonSchema | boolean | undefined, value: unknown): boolean {
    return SchemaCheck.errors(schema, value).length === 0;
  }

  static errors(schema: JsonSchema | boolean | undefined, value: unknown, at = '$'): string[] {
    if (schema === undefined || schema === true) return [];
    if (schema === false) return [`${at}: not allowed`];
    const out: string[] = [];
    const types = Array.isArray(schema.type) ? schema.type : typeof schema.type === 'string' ? [schema.type] : [];
    if (types.length > 0 && !types.some((type) => SchemaCheck.#isType(type, value))) out.push(`${at}: expected ${types.join('|')}`);
    if ('const' in schema && Json.stableStringify(schema.const, 0) !== Json.stableStringify(value, 0)) out.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
    if (Array.isArray(schema.enum) && !schema.enum.some((item) => Json.stableStringify(item, 0) === Json.stableStringify(value, 0))) out.push(`${at}: not in enum`);
    if (typeof value === 'string') {
      const length = Array.from(value).length;
      if (typeof schema.minLength === 'number' && length < schema.minLength) out.push(`${at}: shorter than ${schema.minLength}`);
      if (typeof schema.maxLength === 'number' && length > schema.maxLength) out.push(`${at}: longer than ${schema.maxLength}`);
      if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) out.push(`${at}: pattern mismatch`);
    }
    if (typeof value === 'number') {
      if (typeof schema.minimum === 'number' && value < schema.minimum) out.push(`${at}: below minimum`);
      if (typeof schema.maximum === 'number' && value > schema.maximum) out.push(`${at}: above maximum`);
      if (typeof schema.multipleOf === 'number' && !SchemaCheck.#multiple(value, schema.multipleOf)) out.push(`${at}: not a multiple of ${schema.multipleOf}`);
    }
    if (Array.isArray(value)) {
      if (typeof schema.minItems === 'number' && value.length < schema.minItems) out.push(`${at}: too few items`);
      if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) out.push(`${at}: too many items`);
      const items = schema.items;
      if (items !== undefined) value.forEach((item, i) => out.push(...SchemaCheck.errors(items as JsonSchema | boolean, item, `${at}[${i}]`)));
    }
    if (Json.isPlainObject(value)) {
      for (const name of Schema.requiredSet(schema)) if (!Object.hasOwn(value, name)) out.push(`${at}: missing ${name}`);
      const properties = Json.isPlainObject(schema.properties) ? schema.properties : {};
      for (const [name, item] of Object.entries(value)) {
        if (Object.hasOwn(properties, name)) out.push(...SchemaCheck.errors(properties[name] as JsonSchema | boolean, item, `${at}.${name}`));
      }
    }
    const list = (key: string): (JsonSchema | boolean)[] => (Array.isArray(schema[key]) ? (schema[key] as (JsonSchema | boolean)[]) : []);
    for (const part of list('allOf')) out.push(...SchemaCheck.errors(part, value, at));
    const anyOf = list('anyOf');
    if (anyOf.length > 0 && !anyOf.some((part) => SchemaCheck.valid(part, value))) out.push(`${at}: no anyOf branch matches`);
    const oneOf = list('oneOf');
    if (oneOf.length > 0 && oneOf.filter((part) => SchemaCheck.valid(part, value)).length !== 1) out.push(`${at}: not exactly one oneOf branch matches`);
    if (schema.not !== undefined && SchemaCheck.valid(schema.not as JsonSchema | boolean, value)) out.push(`${at}: matches not`);
    if (schema.if !== undefined) {
      const branch = SchemaCheck.valid(schema.if as JsonSchema | boolean, value) ? schema.then : schema.else;
      if (branch !== undefined) out.push(...SchemaCheck.errors(branch as JsonSchema | boolean, value, at));
    }
    return out;
  }

  static #multiple(value: number, step: number): boolean {
    const quotient = value / step;
    return Math.abs(quotient - Math.round(quotient)) < 1e-9 * Math.max(1, Math.abs(quotient));
  }

  static #isType(type: string, value: unknown): boolean {
    switch (type) {
      case 'string':
        return typeof value === 'string';
      case 'integer':
        return typeof value === 'number' && Number.isInteger(value);
      case 'number':
        return typeof value === 'number';
      case 'boolean':
        return typeof value === 'boolean';
      case 'array':
        return Array.isArray(value);
      case 'object':
        return Json.isPlainObject(value);
      case 'null':
        return value === null;
      default:
        return true;
    }
  }
}
