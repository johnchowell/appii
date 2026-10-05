import { Json } from '../shared/index.js';
import { OpenApiComponents } from './openapi-components.js';
import type { OpenApiObject } from './openapi-operation-builder.js';
import { OpenApiSchemaAdapter } from './openapi-schema-adapter.js';

export interface MergeInfo {
  operationId: string;
  summary: string;
  operationNames: string[];
  components: OpenApiComponents;
}

export class OpenApiOperationMerger {
  static readonly UNION_EXTENSIONS: readonly string[] = ['x-appii-csrf'];

  merge(operations: readonly OpenApiObject[], info: MergeInfo): OpenApiObject {
    const first = operations[0];
    if (!first) throw new RangeError('Cannot merge an empty list of operations');
    if (operations.length === 1) return first;
    const out: OpenApiObject = {
      operationId: info.operationId,
      summary: info.summary,
      description: `GraphQL operations sent to the same URL: ${info.operationNames.join(', ')}.`,
      tags: OpenApiOperationMerger.#distinct(operations.flatMap((op) => OpenApiOperationMerger.#list(op.tags))),
    };
    const parameters = this.parameters(operations);
    if (parameters.length > 0) out.parameters = parameters;
    const body = this.requestBody(operations, info);
    if (body) out.requestBody = body;
    out.responses = this.responses(operations);
    out.security = this.security(operations);
    for (const key of OpenApiOperationMerger.UNION_EXTENSIONS) {
      const values = OpenApiOperationMerger.#distinct(operations.flatMap((op) => OpenApiOperationMerger.#list(op[key])));
      if (values.length > 0) out[key] = values;
    }
    out['x-appii-graphql-operations'] = [...info.operationNames];
    out['x-appii-endpoints'] = operations.map((op) => op['x-appii-endpoint']).filter((value) => value !== undefined);
    return out;
  }

  parameters(operations: readonly OpenApiObject[]): OpenApiObject[] {
    const merged = new Map<string, OpenApiObject>();
    const counts = new Map<string, number>();
    for (const op of operations) {
      for (const raw of OpenApiOperationMerger.#list(op.parameters)) {
        if (!Json.isPlainObject(raw)) continue;
        const key = `${String(raw.in)}:${String(raw.name)}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
        const existing = merged.get(key);
        if (!existing) merged.set(key, Json.clone(raw));
        else existing.required = existing.required === true && raw.required === true;
      }
    }
    for (const [key, parameter] of merged) if (parameter.in !== 'path' && (counts.get(key) ?? 0) < operations.length) parameter.required = false;
    return [...merged.values()];
  }

  requestBody(operations: readonly OpenApiObject[], info: MergeInfo): OpenApiObject | undefined {
    const bodies = operations.map((op) => (Json.isPlainObject(op.requestBody) ? op.requestBody : undefined));
    if (bodies.every((body) => body === undefined)) return undefined;
    const content: OpenApiObject = {};
    const groups = new Map<string, { schemas: unknown[]; names: string[]; examples: OpenApiObject }>();
    bodies.forEach((body, i) => {
      if (!body || !Json.isPlainObject(body.content)) return;
      for (const [media, raw] of Object.entries(body.content)) {
        if (!Json.isPlainObject(raw)) continue;
        const group = groups.get(media) ?? { schemas: [], names: [], examples: {} };
        groups.set(media, group);
        if (raw.schema !== undefined) {
          group.schemas.push(raw.schema);
          group.names.push(info.operationNames[i] ?? `operation${i + 1}`);
        }
        OpenApiOperationMerger.#mergeExamples(group.examples, raw.examples);
      }
    });
    for (const [media, group] of groups) {
      const object: OpenApiObject = {};
      const schema = this.#union(group.schemas, group.names, info.components);
      if (schema) object.schema = schema;
      if (Object.keys(group.examples).length > 0) object.examples = group.examples;
      content[media] = object;
    }
    return { required: bodies.every((body) => body?.required === true), content };
  }

  responses(operations: readonly OpenApiObject[]): OpenApiObject {
    const out: OpenApiObject = {};
    const schemas = new Map<string, unknown[]>();
    for (const op of operations) {
      if (!Json.isPlainObject(op.responses)) continue;
      for (const [status, raw] of Object.entries(op.responses)) {
        if (!Json.isPlainObject(raw)) continue;
        const existing = out[status];
        if (!Json.isPlainObject(existing)) {
          out[status] = Json.clone(raw);
          for (const [media, mediaObject] of Object.entries(Json.isPlainObject(raw.content) ? raw.content : {})) {
            if (Json.isPlainObject(mediaObject) && mediaObject.schema !== undefined) schemas.set(`${status} ${media}`, [mediaObject.schema]);
          }
          continue;
        }
        if (Json.isPlainObject(raw.headers)) {
          const headers: OpenApiObject = Json.isPlainObject(existing.headers) ? existing.headers : {};
          for (const [name, header] of Object.entries(raw.headers)) Json.setOwn(headers, name, Json.clone(header));
          existing.headers = headers;
        }
        if (!Json.isPlainObject(raw.content)) continue;
        const content: OpenApiObject = Json.isPlainObject(existing.content) ? existing.content : {};
        existing.content = content;
        for (const [media, mediaObject] of Object.entries(raw.content)) {
          if (!Json.isPlainObject(mediaObject)) continue;
          const current = content[media];
          const target: OpenApiObject = Json.isPlainObject(current) ? current : {};
          content[media] = target;
          if (mediaObject.schema !== undefined) {
            const list = schemas.get(`${status} ${media}`) ?? [];
            list.push(mediaObject.schema);
            schemas.set(`${status} ${media}`, list);
          }
          const examples: OpenApiObject = Json.isPlainObject(target.examples) ? target.examples : {};
          OpenApiOperationMerger.#mergeExamples(examples, mediaObject.examples);
          if (Object.keys(examples).length > 0) target.examples = examples;
        }
      }
    }
    for (const [key, list] of schemas) {
      const space = key.indexOf(' ');
      const status = key.slice(0, space);
      const media = key.slice(space + 1);
      const response = out[status];
      if (!Json.isPlainObject(response) || !Json.isPlainObject(response.content)) continue;
      const target = response.content[media];
      if (!Json.isPlainObject(target)) continue;
      const distinct = OpenApiOperationMerger.#distinct(list);
      target.schema = distinct.length === 1 ? distinct[0] : { anyOf: distinct };
    }
    return out;
  }

  security(operations: readonly OpenApiObject[]): unknown[] {
    const lists = operations.map((op) => OpenApiOperationMerger.#list(op.security));
    if (lists.every((list) => list.length === 0)) return [];
    const out = OpenApiOperationMerger.#distinct(lists.flat());
    if (lists.some((list) => list.length === 0)) out.push({});
    return OpenApiOperationMerger.#distinct(out);
  }

  #union(schemas: readonly unknown[], names: readonly string[], components: OpenApiComponents): unknown {
    const distinct = OpenApiOperationMerger.#distinct(schemas);
    if (distinct.length === 0) return undefined;
    if (distinct.length === 1) return distinct[0];
    const refs = schemas.map((schema) => OpenApiComponents.refName(schema));
    const discriminable =
      distinct.length === schemas.length &&
      refs.every((ref) => ref !== undefined) &&
      schemas.every((schema) => OpenApiSchemaAdapter.discriminable(components.resolve(schema)));
    if (!discriminable) return { anyOf: distinct };
    const mapping: Record<string, unknown> = {};
    refs.forEach((ref, i) => {
      const name = names[i];
      if (ref !== undefined && name !== undefined) Json.setOwn(mapping, name, OpenApiComponents.SCHEMA_PREFIX + ref);
    });
    return { oneOf: distinct, discriminator: { propertyName: OpenApiSchemaAdapter.GRAPHQL_OPERATION_FIELD, mapping } };
  }

  static #mergeExamples(target: OpenApiObject, examples: unknown): void {
    if (!Json.isPlainObject(examples)) return;
    for (const [name, example] of Object.entries(examples)) {
      let key = name;
      for (let i = 2; Object.hasOwn(target, key); i++) key = `${name}${i}`;
      Json.setOwn(target, key, Json.clone(example));
    }
  }

  static #list(value: unknown): unknown[] {
    return Array.isArray(value) ? value : [];
  }

  static #distinct<T>(values: readonly T[]): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const value of values) {
      const key = Json.stableStringify(value, 0);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(value);
    }
    return out;
  }
}
