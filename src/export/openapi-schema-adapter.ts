import type { JsonSchema, ParamInfo } from '../model/index.js';
import { Json, Schema } from '../shared/index.js';
import { Helpers } from './helpers.js';

export class OpenApiSchemaAdapter {
  static readonly REQUEST_STRIPPED: readonly string[] = ['readOnly'];
  static readonly NESTED_LISTS: readonly string[] = ['oneOf', 'anyOf', 'allOf', 'prefixItems'];
  static readonly NESTED_SINGLE: readonly string[] = ['items', 'additionalProperties', 'contains', 'not'];
  static readonly GRAPHQL_OPERATION_FIELD = 'operationName';

  request(schema: JsonSchema, form: boolean): JsonSchema {
    const copy = Json.clone(schema);
    if (form) OpenApiSchemaAdapter.#strip(copy, OpenApiSchemaAdapter.REQUEST_STRIPPED);
    return copy;
  }

  response(schema: JsonSchema): JsonSchema {
    return Json.clone(schema);
  }

  param(param: ParamInfo): JsonSchema {
    const schema = Json.clone(param.schema);
    if (!Array.isArray(schema.examples)) {
      const examples = Helpers.examples(param.examples, param.schema);
      if (examples.length > 0) schema.examples = examples;
    }
    return schema;
  }

  graphql(schema: JsonSchema, operationName: string | undefined): JsonSchema {
    const field = OpenApiSchemaAdapter.GRAPHQL_OPERATION_FIELD;
    const property = Schema.properties(schema)[field];
    if (operationName === undefined || !property || !Json.isPlainObject(schema.properties)) return schema;
    const properties: Record<string, unknown> = { ...schema.properties };
    properties[field] = { ...property, type: 'string', const: operationName };
    return { ...schema, properties };
  }

  static discriminable(schema: JsonSchema | undefined): boolean {
    const field = OpenApiSchemaAdapter.GRAPHQL_OPERATION_FIELD;
    return Schema.properties(schema)[field] !== undefined && Schema.requiredSet(schema).has(field);
  }

  static #strip(node: JsonSchema, keys: readonly string[]): void {
    for (const key of keys) delete node[key];
    const properties = node.properties;
    if (Json.isPlainObject(properties)) for (const child of Object.values(properties)) if (Json.isPlainObject(child)) OpenApiSchemaAdapter.#strip(child, keys);
    for (const key of OpenApiSchemaAdapter.NESTED_SINGLE) {
      const child = node[key];
      if (Json.isPlainObject(child)) OpenApiSchemaAdapter.#strip(child, keys);
    }
    for (const key of OpenApiSchemaAdapter.NESTED_LISTS) {
      const list = node[key];
      if (Array.isArray(list)) for (const child of list) if (Json.isPlainObject(child)) OpenApiSchemaAdapter.#strip(child, keys);
    }
  }
}
