import type { BodyKind, Capture, Endpoint, EndpointForm, FormDescriptor, FormEnctype, FormField, JsonSchema, ParamInfo } from '../model/index.js';
import { FormExtractor, FormSchemaBuilder, TokenDetector } from '../forms/index.js';
import type { FormTarget } from '../forms/index.js';
import { Json, Schema } from '../shared/index.js';
import { EndpointFactory } from './endpoint-factory.js';
import { EndpointMatcher } from './endpoint-matcher.js';
import { FormCollector } from './form-collector.js';
import { FormSchemaCombiner } from './form-schema-combiner.js';
import { Helpers } from './helpers.js';
import { HtmlPages } from './html-pages.js';
import { PageDocuments } from './page-documents.js';
import { ParamInferrer } from './param-inferrer.js';
import { PathTemplater } from './path-templater.js';
import type { PathEvidence, PathTemplate } from './path-templater.js';
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
  combiner?: FormSchemaCombiner;
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
  static readonly LINKED_KINDS: ReadonlySet<string> = new Set(['document', 'other']);
  static readonly ENCTYPE_KINDS: Readonly<Record<FormEnctype, BodyKind>> = {
    'application/x-www-form-urlencoded': 'form',
    'multipart/form-data': 'multipart',
    'text/plain': 'text',
  };
  static readonly SECRET_TYPES: ReadonlySet<string> = new Set(['password']);
  static readonly ANNOTATION_KEYS: readonly string[] = ['title', 'description'];
  static readonly ANNOTATION_PREFIX = 'x-html-';

  readonly #schemas: FormSchemaBuilder;
  readonly #paths: PathTemplater;
  readonly #collector: FormCollector;
  readonly #params: ParamInferrer;
  readonly #redactor: Redactor;
  readonly #combiner: FormSchemaCombiner;

  constructor(deps: FormLinkerDeps) {
    this.#schemas = deps.schemas;
    this.#paths = deps.paths ?? new PathTemplater();
    this.#collector = deps.collector ?? new FormCollector({ documents: new PageDocuments({ pages: new HtmlPages(), extractor: deps.extractor }) });
    this.#redactor = deps.redactor ?? Redactor.create();
    this.#params = deps.params ?? new ParamInferrer({ schemas: deps.inferrer, redactor: this.#redactor }, { maxExamples: FormLinker.DEFAULT_MAX_EXAMPLES });
    this.#combiner = deps.combiner ?? new FormSchemaCombiner();
  }

  static create(options: FormLinkerOptions = {}): FormLinker {
    const tokens = new TokenDetector();
    const inferrer = SchemaInferrer.create();
    const redactor = new Redactor(options.redact ?? true, { tokens });
    return new FormLinker({
      extractor: new FormExtractor({ tokens }),
      schemas: new FormSchemaBuilder({ tokens }),
      inferrer,
      redactor,
      params: new ParamInferrer({ schemas: inferrer, redactor }, { maxExamples: options.maxExamples ?? FormLinker.DEFAULT_MAX_EXAMPLES }),
      combiner: new FormSchemaCombiner(),
    });
  }

  static fieldNames(form: FormDescriptor): string[] {
    const names = form.fields.filter((field) => !field.disabled && field.name !== '').map((field) => field.name);
    return [...new Set(names)].sort(Helpers.compare);
  }

  targets(capture: Capture): Map<string, PathEvidence> {
    const out = new Map<string, { forms: Set<string>; names: Set<string> }>();
    for (const submission of this.#submissions(this.#collector.collect(capture))) {
      const key = submission.url.origin + submission.url.pathname;
      const entry = out.get(key) ?? { forms: new Set<string>(), names: new Set<string>() };
      const names = FormLinker.fieldNames(submission.form);
      entry.forms.add(JSON.stringify(names));
      for (const name of names) entry.names.add(name);
      out.set(key, entry);
    }
    return out;
  }

  encodings(capture: Capture): Map<string, string> {
    return this.#collector.encodings(capture);
  }

  link(endpoints: Endpoint[], capture: Capture): FormLinkResult {
    const forms = this.#collector.collect(capture);
    const matcher = new EndpointMatcher(endpoints, { paths: this.#paths });
    const links = new Map<string, Link>();
    const created: Endpoint[] = [];
    for (const submission of this.#submissions(forms)) {
      const existing = FormLinker.#find(endpoints, submission, matcher);
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
    const schema = this.#redactor.schema(this.#combiner.combine(built.map((result) => result.schema)));
    const secrets = FormLinker.#secretNames(submissions);
    if (!endpoint.form) endpoint.form = FormLinker.#endpointForm(this.#redactor.form(first.form), primary.mimeType);
    if (link.template) endpoint.pathParams = this.#params.path(link.template, submissions.map((submission) => submission.url.pathname));
    if (endpoint.method === 'GET') {
      this.#mergeQuery(endpoint, schema, secrets);
    } else {
      this.#mergeBody(endpoint, schema, primary.mimeType, secrets);
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

  #mergeQuery(endpoint: Endpoint, schema: JsonSchema, secrets: ReadonlySet<string>): void {
    const props = Helpers.properties(schema);
    const required = Schema.requiredSet(schema);
    const existing = new Map(endpoint.queryParams.map((param) => [param.name, param]));
    const names = new Set(props.map(([name]) => name));
    const params: ParamInfo[] = props.map(([name, property]) => ({
      name,
      in: 'query',
      required: required.has(name),
      schema: property,
      examples: Helpers.distinct((existing.get(name)?.examples ?? []).map((example) => String(this.#redactor.named(name, example, secrets)))),
    }));
    for (const param of endpoint.queryParams) if (!names.has(param.name)) params.push(param);
    endpoint.queryParams = params;
  }

  #mergeBody(endpoint: Endpoint, schema: JsonSchema, mimeType: FormEnctype, secrets: ReadonlySet<string>): void {
    const observed = endpoint.requestBody;
    if (!observed) {
      endpoint.requestBody = { mimeType, kind: FormLinker.ENCTYPE_KINDS[mimeType], schema, examples: [] };
      return;
    }
    const encoded = observed.kind === FormLinker.ENCTYPE_KINDS[mimeType];
    const merged = encoded ? this.#combiner.overlay(schema, observed.schema) : FormLinker.#annotate(observed.schema, schema);
    endpoint.requestBody = {
      mimeType: observed.mimeType,
      kind: observed.kind,
      ...(merged ? { schema: merged } : {}),
      examples: this.#redactor.examples(observed.examples, secrets),
    };
  }

  static #annotate(observed: JsonSchema | undefined, form: JsonSchema): JsonSchema | undefined {
    if (!observed) return undefined;
    const out = Json.clone(observed);
    const formProps = new Map(Helpers.properties(form));
    for (const [name, property] of Helpers.properties(out)) {
      const source = formProps.get(name);
      if (!source || Schema.primaryType(source) !== Schema.primaryType(property)) continue;
      for (const [key, value] of Object.entries(source)) {
        if ((key.startsWith(FormLinker.ANNOTATION_PREFIX) || FormLinker.ANNOTATION_KEYS.includes(key)) && !Object.hasOwn(property, key)) Helpers.setOwn(property, key, Json.clone(value));
      }
    }
    return out;
  }

  static #secretNames(submissions: readonly Submission[]): Set<string> {
    const names = new Set<string>();
    for (const { form } of submissions) {
      for (const field of form.fields) if (FormLinker.SECRET_TYPES.has(field.type) && field.name !== '') names.add(field.name);
      for (const name of form.tokenFields) names.add(name);
    }
    return names;
  }

  static #find(endpoints: readonly Endpoint[], submission: Submission, matcher: EndpointMatcher): Endpoint | undefined {
    let best: Endpoint | undefined;
    let bestParams = Number.POSITIVE_INFINITY;
    for (const endpoint of endpoints) {
      if (endpoint.method !== submission.target.method || endpoint.origin !== submission.url.origin) continue;
      if (endpoint.kind === 'graphql' || endpoint.operationName !== undefined) continue;
      if (!matcher.accepts(endpoint, submission.url.pathname, { byExamples: true })) continue;
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

  static #endpointForm(form: FormDescriptor, enctype: FormEnctype): EndpointForm {
    return {
      pageUrl: form.pageUrl,
      selector: form.selector,
      action: form.action,
      method: form.method,
      enctype,
      charset: form.charset,
      fields: Json.clone(form.fields),
      submitters: Json.clone(form.submitters),
      tokenFields: [...form.tokenFields],
    };
  }
}
