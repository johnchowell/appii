import type {
  BodyKind,
  Capture,
  Endpoint,
  EndpointForm,
  FormDescriptor,
  FormEnctype,
  FormField,
  JsonSchema,
  ParamInfo,
} from '../model/index.js';
import { FormExtractor, FormSchemaBuilder, TokenDetector } from '../forms/index.js';
import type { FormTarget } from '../forms/index.js';
import { EndpointIndex, Json, Schema } from '../shared/index.js';
import { EndpointFactory } from './endpoint-factory.js';
import { EndpointMatcher } from './endpoint-matcher.js';
import { FormCollector } from './form-collector.js';
import { Helpers } from './helpers.js';
import { ParamInferrer } from './param-inferrer.js';
import { PathTemplater } from './path-templater.js';
import type { PathTemplate } from './path-templater.js';
import { Redactor } from './redactor.js';
import { SchemaInferrer } from './schema-inferrer.js';

export interface FormLinkerDeps {
  extractor: FormExtractor;
  schemas: FormSchemaBuilder;
  inferrer: SchemaInferrer;
  paths?: PathTemplater;
  collector?: FormCollector;
  params?: ParamInferrer;
  redactor?: Redactor;
}

export interface FormLinkerOptions {
  redact?: boolean;
  maxExamples?: number;
}

export interface FormLinkResult {
  endpoints: Endpoint[];
  forms: FormDescriptor[];
}

interface Submission {
  readonly form: FormDescriptor;
  readonly submitter?: FormField;
  readonly target: FormTarget;
  readonly url: URL;
}

interface Link {
  readonly endpoint: Endpoint;
  readonly template?: PathTemplate;
  readonly submissions: Submission[];
}

export class FormLinker {
  static readonly DEFAULT_MAX_EXAMPLES = 3;
  static readonly SUBMIT_TYPE = 'submit';
  static readonly LINKED_KINDS: ReadonlySet<string> = new Set(['document', 'other']);
  static readonly ENCTYPE_KINDS: Readonly<Record<FormEnctype, BodyKind>> = {
    'application/x-www-form-urlencoded': 'form',
    'multipart/form-data': 'multipart',
    'text/plain': 'text',
  };

  readonly #schemas: FormSchemaBuilder;
  readonly #paths: PathTemplater;
  readonly #collector: FormCollector;
  readonly #params: ParamInferrer;
  readonly #redactor: Redactor;

  constructor(deps: FormLinkerDeps) {
    this.#schemas = deps.schemas;
    this.#paths = deps.paths ?? new PathTemplater();
    this.#collector = deps.collector ?? new FormCollector({ extractor: deps.extractor });
    this.#redactor = deps.redactor ?? new Redactor();
    this.#params = deps.params ?? new ParamInferrer({ schemas: deps.inferrer, redactor: this.#redactor }, { maxExamples: FormLinker.DEFAULT_MAX_EXAMPLES });
  }

  static create(options: FormLinkerOptions = {}): FormLinker {
    const tokens = new TokenDetector();
    const inferrer = SchemaInferrer.create();
    const redactor = new Redactor(options.redact ?? true);
    return new FormLinker({
      extractor: new FormExtractor({ tokens }),
      schemas: new FormSchemaBuilder({ tokens }),
      inferrer,
      redactor,
      params: new ParamInferrer({ schemas: inferrer, redactor }, { maxExamples: options.maxExamples ?? FormLinker.DEFAULT_MAX_EXAMPLES }),
    });
  }

  link(endpoints: Endpoint[], capture: Capture): FormLinkResult {
    const forms = this.#collector.collect(capture);
    const links = new Map<string, Link>();
    const created: Endpoint[] = [];
    for (const submission of this.#submissions(forms)) {
      const existing = FormLinker.#find(endpoints, submission);
      if (existing) {
        FormLinker.#entry(links, existing.key, () => ({ endpoint: existing, submissions: [] })).submissions.push(submission);
        continue;
      }
      const path = submission.url.pathname;
      const template = this.#paths.template([path]).get(path) ?? { template: path, params: [] };
      const key = EndpointFactory.key(submission.target.method, submission.url.origin, template.template);
      const link = FormLinker.#entry(links, key, () => {
        const endpoint = EndpointFactory.blank({ method: submission.target.method, origin: submission.url.origin, path: template.template, kind: 'form' });
        created.push(endpoint);
        return { endpoint, template, submissions: [] };
      });
      link.submissions.push(submission);
    }
    for (const link of links.values()) this.#apply(link);
    return { endpoints: [...endpoints, ...created], forms: forms.map((form) => this.#redactor.form(form)) };
  }

  #submissions(forms: readonly FormDescriptor[]): Submission[] {
    const out: Submission[] = [];
    for (const form of forms) {
      const enabled = form.submitters.filter((submitter) => !submitter.disabled);
      const options: (FormField | undefined)[] = enabled.length > 0 ? enabled : [undefined];
      for (const submitter of options) {
        const target = this.#schemas.target(form, submitter);
        if (target.method === 'DIALOG') continue;
        const url = Helpers.httpUrl(target.url);
        if (!url) continue;
        out.push(submitter ? { form, submitter, target, url } : { form, target, url });
      }
    }
    return out;
  }

  #apply(link: Link): void {
    const { endpoint, submissions } = link;
    const first = submissions[0];
    if (!first) return;
    const built = submissions.map((submission) => this.#schemas.build(submission.form, submission.submitter));
    const primary = built[0]!;
    const schema = this.#redactor.schema(FormLinker.#combine(built.map((result) => result.schema)));
    if (!endpoint.form) endpoint.form = FormLinker.#endpointForm(this.#redactor.form(first.form), primary.mimeType);
    if (link.template) endpoint.pathParams = this.#params.path(link.template, submissions.map((submission) => submission.url.pathname));
    if (endpoint.method === 'GET') {
      FormLinker.#mergeQuery(endpoint, schema);
    } else {
      FormLinker.#mergeBody(endpoint, schema, primary.mimeType);
      this.#mergeActionQuery(endpoint, submissions, link.template !== undefined);
    }
    if (FormLinker.LINKED_KINDS.has(endpoint.kind)) endpoint.kind = 'form';
  }

  #mergeActionQuery(endpoint: Endpoint, submissions: readonly Submission[], created: boolean): void {
    const params = this.#params.query(submissions.map((submission) => submission.url));
    if (created) {
      endpoint.queryParams = params;
      return;
    }
    const known = new Set(endpoint.queryParams.map((param) => param.name));
    for (const param of params) if (!known.has(param.name)) endpoint.queryParams.push({ ...param, required: false });
  }

  static #find(endpoints: readonly Endpoint[], submission: Submission): Endpoint | undefined {
    let best: Endpoint | undefined;
    let bestParams = Number.POSITIVE_INFINITY;
    for (const endpoint of endpoints) {
      if (endpoint.method !== submission.target.method || endpoint.origin !== submission.url.origin) continue;
      if (endpoint.kind === 'graphql' || endpoint.operationName !== undefined) continue;
      if (EndpointIndex.matchPath(endpoint.path, submission.url.pathname) === undefined) continue;
      const params = EndpointMatcher.paramCount(endpoint.path);
      if (params < bestParams) {
        best = endpoint;
        bestParams = params;
      }
    }
    return best;
  }

  static #entry(links: Map<string, Link>, key: string, create: () => Link): Link {
    let link = links.get(key);
    if (!link) {
      link = create();
      links.set(key, link);
    }
    return link;
  }

  static #combine(schemas: readonly JsonSchema[]): JsonSchema {
    const [primary, ...rest] = schemas;
    if (!primary) return { type: 'object', properties: {} };
    const out = Json.clone(primary);
    const props = new Map(Helpers.properties(out));
    for (const other of rest) {
      for (const [name, schema] of Helpers.properties(other)) {
        const existing = props.get(name);
        if (!existing) props.set(name, Json.clone(schema));
        else props.set(name, FormLinker.#alternatives(existing, schema));
      }
    }
    out.properties = Object.fromEntries(props);
    return out;
  }

  static #alternatives(existing: JsonSchema, other: JsonSchema): JsonSchema {
    const submitter = (schema: JsonSchema): boolean => schema['x-html-type'] === FormLinker.SUBMIT_TYPE;
    if (!submitter(existing) || !submitter(other) || existing.type !== other.type) return existing;
    const values = (schema: JsonSchema): unknown[] | undefined => ('const' in schema ? [schema.const] : Array.isArray(schema.enum) ? schema.enum : undefined);
    const a = values(existing);
    const b = values(other);
    if (!a || !b || ('const' in existing && 'const' in other && Object.is(existing.const, other.const))) return existing;
    const labels = (schema: JsonSchema, count: number): string[] => {
      if (Array.isArray(schema['x-html-labels'])) return schema['x-html-labels'].map(String);
      return Array.from({ length: count }, () => (typeof schema.title === 'string' ? schema.title : ''));
    };
    const enumValues: unknown[] = [];
    const enumLabels: string[] = [];
    const la = labels(existing, a.length);
    const lb = labels(other, b.length);
    [...a, ...b].forEach((value, i) => {
      if (enumValues.some((known) => Object.is(known, value))) return;
      enumValues.push(value);
      enumLabels.push((i < a.length ? la[i] : lb[i - a.length]) ?? '');
    });
    const { const: _const, title: _title, default: _default, ...rest } = existing;
    const merged: JsonSchema = { ...rest, enum: enumValues };
    if (enumLabels.some((label, i) => label !== '' && label !== enumValues[i])) merged['x-html-labels'] = enumLabels;
    else delete merged['x-html-labels'];
    return merged;
  }

  static #endpointForm(form: FormDescriptor, enctype: FormEnctype): EndpointForm {
    return {
      pageUrl: form.pageUrl,
      selector: form.selector,
      action: form.action,
      method: form.method,
      enctype,
      fields: Json.clone(form.fields),
      submitters: Json.clone(form.submitters),
      tokenFields: [...form.tokenFields],
    };
  }

  static #mergeQuery(endpoint: Endpoint, schema: JsonSchema): void {
    const props = Helpers.properties(schema);
    const required = Schema.requiredSet(schema);
    const existing = new Map(endpoint.queryParams.map((param) => [param.name, param]));
    const names = new Set(props.map(([name]) => name));
    const params: ParamInfo[] = props.map(([name, property]) => ({
      name,
      in: 'query',
      required: required.has(name),
      schema: property,
      examples: existing.get(name)?.examples ?? [],
    }));
    for (const param of endpoint.queryParams) if (!names.has(param.name)) params.push(param);
    endpoint.queryParams = params;
  }

  static #mergeBody(endpoint: Endpoint, schema: JsonSchema, mimeType: FormEnctype): void {
    const observed = endpoint.requestBody;
    if (!observed) {
      endpoint.requestBody = { mimeType, kind: FormLinker.ENCTYPE_KINDS[mimeType], schema, examples: [] };
      return;
    }
    endpoint.requestBody = {
      mimeType: observed.mimeType,
      kind: observed.kind,
      schema: FormLinker.#overlay(schema, observed.schema),
      examples: observed.examples,
    };
  }

  static #overlay(form: JsonSchema, observed: JsonSchema | undefined): JsonSchema {
    const observedProps = Helpers.properties(observed);
    if (!observed || Schema.primaryType(observed) !== 'object' || observedProps.length === 0) return form;
    const formProps = Helpers.properties(form);
    const formNames = new Set(formProps.map(([name]) => name));
    const extra = observedProps.filter(([name]) => !formNames.has(name)).map(([name, schema]): [string, JsonSchema] => [name, Json.clone(schema)]);
    const required = [...Schema.requiredSet(form), ...[...Schema.requiredSet(observed)].filter((name) => !formNames.has(name))];
    const { properties: _properties, required: _required, ...rest } = form;
    const out: JsonSchema = { type: 'object', ...rest, properties: Object.fromEntries([...formProps, ...extra]) };
    if (required.length > 0) out.required = required;
    return out;
  }
}
