import type { BodyKind, Capture, Endpoint, EndpointForm, FormDescriptor, FormEnctype, FormField, FormSubmitter, JsonSchema, ParamInfo, Exchange } from '../model/index.js';
import { FormExtractor, FormSchemaBuilder, LoginFormDetector, SubmissionRules, TokenDetector } from '../forms/index.js';
import type { FormTarget } from '../forms/index.js';
import { Json, Schema, Text } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import { ChoiceEvidence } from './choice-evidence.js';
import { EndpointFactory } from './endpoint-factory.js';
import { EndpointMatcher } from './endpoint-matcher.js';
import { FormCollector } from './form-collector.js';
import { FormInventory } from './form-inventory.js';
import { FormSchemaCombiner } from './form-schema-combiner.js';
import { Helpers } from './helpers.js';
import { HtmlPages } from './html-pages.js';
import { ObservedSubmissions } from './observed-submissions.js';
import type { ObservedSubmission } from './observed-submissions.js';
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
  body?: BodyParser;
  choices?: ChoiceEvidence;
  inventory?: FormInventory;
}

export interface FormLinkerOptions {
  redact?: boolean;
  maxExamples?: number;
}

export interface FormLinkResult {
  endpoints: Endpoint[];
  forms: FormDescriptor[];
  targets: ReadonlyMap<FormDescriptor, readonly Endpoint[]>;
}

interface Submission {
  readonly form: FormDescriptor;
  readonly submitter?: FormField;
  readonly target: FormTarget;
  readonly url: URL;
  readonly observed: readonly ObservedSubmission[];
  readonly by?: FormSubmitter;
}

interface ObservedCache {
  readonly exchanges: number;
  readonly observed: ObservedSubmissions;
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
  static readonly NAVIGATION = 'document';
  static readonly QUERY_METHOD = 'GET';
  static readonly SECRET_TYPES: ReadonlySet<string> = new Set(['password']);
  static readonly ANNOTATION_KEYS: readonly string[] = ['title', 'description'];
  static readonly ANNOTATION_PREFIX = 'x-html-';
  static readonly SCRIPT: FormSubmitter = 'script';

  readonly #schemas: FormSchemaBuilder;
  readonly #paths: PathTemplater;
  readonly #collector: FormCollector;
  readonly #params: ParamInferrer;
  readonly #redactor: Redactor;
  readonly #combiner: FormSchemaCombiner;
  readonly #body: BodyParser;
  readonly #choices: ChoiceEvidence;
  readonly #inventory: FormInventory;
  readonly #observed = new WeakMap<Capture, ObservedCache>();

  constructor(deps: FormLinkerDeps) {
    this.#schemas = deps.schemas;
    this.#paths = deps.paths ?? new PathTemplater();
    this.#collector = deps.collector ?? new FormCollector({ documents: new PageDocuments({ pages: new HtmlPages(), extractor: deps.extractor }) });
    this.#redactor = deps.redactor ?? Redactor.create();
    this.#params = deps.params ?? new ParamInferrer({ schemas: deps.inferrer, redactor: this.#redactor }, { maxExamples: FormLinker.DEFAULT_MAX_EXAMPLES });
    this.#combiner = deps.combiner ?? new FormSchemaCombiner();
    this.#body = deps.body ?? new BodyParser();
    this.#choices = deps.choices ?? new ChoiceEvidence();
    this.#inventory = deps.inventory ?? new FormInventory();
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
      body: BodyParser.create(),
      choices: new ChoiceEvidence(),
      inventory: new FormInventory(),
    });
  }

  static fieldNames(form: FormDescriptor): string[] {
    return SubmissionRules.fieldNames(form).sort(Text.compare);
  }

  targets(capture: Capture): Map<string, PathEvidence> {
    const out = new Map<string, { forms: Set<string>; names: Set<string> }>();
    for (const submission of this.#submissions(this.#collector.collect(capture), this.#observedIn(capture))) {
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

  submissionEncoding(capture: Capture): (exchange: Exchange) => string | undefined {
    const documents = this.encodings(capture);
    const forms = new Map<string, string>();
    for (const submission of this.#submissions(this.#collector.collect(capture), this.#observedIn(capture))) {
      const key = ObservedSubmissions.key(submission.form.pageUrl, submission.target.method, submission.url);
      if (!forms.has(key)) forms.set(key, submission.form.charset);
    }
    return (exchange) => {
      if (exchange.resourceType !== FormLinker.NAVIGATION || exchange.pageUrl === undefined) return undefined;
      const url = Helpers.httpUrl(exchange.request.url);
      const form = url ? forms.get(ObservedSubmissions.key(exchange.pageUrl, exchange.request.method, url)) : undefined;
      return form ?? documents.get(HtmlPages.documentKey(exchange.pageUrl));
    };
  }

  secretFields(capture: Capture): Set<string> {
    return FormLinker.secretNames(this.#collector.collect(capture));
  }

  passwordFields(capture: Capture): Set<string> {
    const names = new Set<string>();
    for (const form of this.#collector.collect(capture)) for (const field of form.fields) if (FormLinker.SECRET_TYPES.has(field.type) && field.name !== '') names.add(field.name);
    return names;
  }

  loginPages(capture: Capture): Set<string> {
    const pages = new Set<string>();
    for (const form of this.#collector.collect(capture)) {
      if (!LoginFormDetector.isLogin(form)) continue;
      const url = Helpers.httpUrl(form.pageUrl);
      if (url) pages.add(url.origin + url.pathname);
    }
    return pages;
  }

  identifierFields(capture: Capture): Set<string> {
    const names = new Set<string>();
    for (const form of this.#collector.collect(capture)) {
      const identifier = LoginFormDetector.detect(form)?.identifier;
      if (identifier !== undefined) names.add(identifier);
    }
    return names;
  }

  personalFields(capture: Capture): Set<string> {
    return FormLinker.personalNames(this.#collector.collect(capture));
  }

  submitted(capture: Capture): (exchange: Exchange) => boolean {
    const exchanges = new Set<string>();
    for (const submission of this.#submissions(this.#collector.collect(capture), this.#observedIn(capture))) {
      if (!FormLinker.#carries(submission)) continue;
      for (const observed of submission.observed) exchanges.add(observed.exchange.id);
    }
    return (exchange) => exchanges.has(exchange.id);
  }

  link(endpoints: Endpoint[], capture: Capture): FormLinkResult {
    const forms = this.#collector.collect(capture);
    const observed = this.#observedIn(capture);
    const matcher = new EndpointMatcher(endpoints, { paths: this.#paths });
    const links = new Map<string, Link>();
    const created: Endpoint[] = [];
    const sent = new Map<FormDescriptor, Endpoint[]>();
    const contributing = new Set<FormDescriptor>();
    const native = new Map<FormDescriptor, Endpoint[]>();
    const scripted = new Set<FormDescriptor>();
    const record = (form: FormDescriptor, endpoint: Endpoint): void => {
      const list = sent.get(form) ?? [];
      if (!list.includes(endpoint)) list.push(endpoint);
      sent.set(form, list);
    };
    const submissions = this.#submissions(forms, observed);
    const open = this.#choices.open(submissions);
    for (const submission of submissions) {
      const existing = FormLinker.#find(endpoints, submission.target.method, submission.url, matcher);
      if (existing) {
        if (!FormLinker.#contributes(submission, existing)) {
          FormLinker.#entry(native, submission.form, () => []).push(existing);
          continue;
        }
        record(submission.form, existing);
        FormLinker.#entry(links, existing.key, () => ({ endpoint: existing, submissions: [] })).submissions.push(submission);
        contributing.add(submission.form);
        continue;
      }
      if (!FormLinker.#carries(submission) || !FormLinker.#native(submission, observed) || FormLinker.#pageOnly(submission, observed)) continue;
      const path = submission.url.pathname;
      const template = this.#paths.template([path]).get(path) ?? { template: path, params: [] };
      const key = EndpointFactory.key(submission.target.method, submission.url.origin, template.template);
      const link = FormLinker.#entry(links, key, () => {
        const endpoint = EndpointFactory.blank({ method: submission.target.method, origin: submission.url.origin, path: template.template, kind: 'form' });
        created.push(endpoint);
        return { endpoint, template, submissions: [] };
      });
      link.submissions.push(submission);
      record(submission.form, link.endpoint);
      contributing.add(submission.form);
    }
    const submitted = new Set(submissions.map((submission) => submission.form));
    for (const form of forms) {
      if (submitted.has(form)) continue;
      const fallback = this.#submission(form, undefined, observed);
      const endpoint = fallback ? FormLinker.#find(endpoints, fallback.target.method, fallback.url, matcher) : undefined;
      if (!fallback || !endpoint || !FormLinker.#contributes(fallback, endpoint)) continue;
      record(form, endpoint);
      FormLinker.#entry(links, endpoint.key, () => ({ endpoint, submissions: [] })).submissions.push(fallback);
    }
    for (const form of FormLinker.#scriptOnly(submissions, contributing)) {
      for (const script of observed.scripted(form)) {
        const url = Helpers.httpUrl(script.request.url);
        const endpoint = url ? FormLinker.#find(endpoints, script.request.method, url, matcher) : undefined;
        if (!url || !endpoint) continue;
        record(form, endpoint);
        scripted.add(form);
        FormLinker.#entry(links, endpoint.key, () => ({ endpoint, submissions: [] })).submissions.push({ form, target: this.#schemas.target(form, null), url, observed: [], by: FormLinker.SCRIPT });
      }
    }
    for (const [form, targets] of native) {
      if (!scripted.has(form)) for (const endpoint of targets) record(form, endpoint);
    }
    for (const link of links.values()) this.#apply(link, open);
    const all = [...endpoints, ...created];
    const sources = new Set(all.flatMap((endpoint) => (endpoint.form ? [JSON.stringify([endpoint.form.pageUrl, endpoint.form.selector])] : [])));
    const merged = this.#inventory.merge(
      forms.map((form) => ({ form: this.#redactor.form(form), endpoints: sent.get(form) ?? [] })),
      { url: (value) => this.#redactor.url(value), preferred: (form) => sources.has(JSON.stringify([form.pageUrl, form.selector])) },
    );
    return { endpoints: all, forms: merged.map((entry) => entry.form), targets: new Map(merged.map((entry) => [entry.form, entry.endpoints])) };
  }

  static endpointIds(result: FormLinkResult, forms: readonly FormDescriptor[], kept: readonly Endpoint[]): FormDescriptor[] {
    const order = new Map(kept.map((endpoint, index) => [endpoint, index]));
    return forms.map((form) => {
      const linked = (result.targets.get(form) ?? []).filter((endpoint) => order.has(endpoint));
      linked.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      return { ...form, endpoints: Helpers.distinct(linked.map((endpoint) => endpoint.id)) };
    });
  }

  #observedIn(capture: Capture): ObservedSubmissions {
    const cached = this.#observed.get(capture);
    if (cached && cached.exchanges === capture.exchanges.length) return cached.observed;
    const observed = new ObservedSubmissions(capture, { body: this.#body });
    this.#observed.set(capture, { exchanges: capture.exchanges.length, observed });
    return observed;
  }

  #submissions(forms: readonly FormDescriptor[], observed: ObservedSubmissions): Submission[] {
    const out: Submission[] = [];
    for (const form of forms) {
      const paths = SubmissionRules.paths(form);
      for (const submitter of paths) {
        const submission = this.#submission(form, submitter, observed);
        if (submission) out.push(submission);
      }
      const scripted = this.#scripted(form, paths, observed);
      if (scripted) out.push(scripted);
    }
    return out;
  }

  #submission(form: FormDescriptor, submitter: FormField | undefined, observed: ObservedSubmissions): Submission | undefined {
    const target = this.#schemas.target(form, submitter ?? null);
    if (target.method === 'DIALOG') return undefined;
    const url = Helpers.httpUrl(target.url);
    if (!url) return undefined;
    const seen = observed.submissions(form, target);
    return submitter ? { form, submitter, target, url, observed: seen } : { form, target, url, observed: seen };
  }

  #scripted(form: FormDescriptor, paths: readonly (FormField | undefined)[], observed: ObservedSubmissions): Submission | undefined {
    const fallback = this.#submission(form, undefined, observed);
    if (!fallback || !FormLinker.#carries(fallback)) return undefined;
    const names = form.submitters.flatMap((submitter) => SubmissionRules.submitterNames(submitter));
    const lacking = fallback.observed.filter((seen) => !names.some((name) => seen.entries.has(name)));
    if (lacking.length === 0) return undefined;
    const explained = paths.some((submitter) => {
      if (!submitter) return true;
      const target = this.#schemas.target(form, submitter);
      return SubmissionRules.submitterNames(submitter).length === 0 && target.method === fallback.target.method && target.url === fallback.target.url;
    });
    return explained ? undefined : { ...fallback, observed: lacking };
  }

  static #carries(submission: Submission): boolean {
    return submission.target.method !== FormLinker.QUERY_METHOD || SubmissionRules.contributes(submission.form, submission.submitter);
  }

  static #contributes(submission: Submission, endpoint: Endpoint): boolean {
    if (submission.target.method !== FormLinker.QUERY_METHOD) return true;
    if (!FormLinker.#carries(submission)) return false;
    if (submission.observed.length > 0) return true;
    const names = new Set([...SubmissionRules.fieldNames(submission.form), ...SubmissionRules.submitterNames(submission.submitter)]);
    return endpoint.queryParams.some((param) => names.has(param.name));
  }

  static #scriptOnly(submissions: readonly Submission[], contributing: ReadonlySet<FormDescriptor>): FormDescriptor[] {
    const forms = Helpers.distinct(submissions.map((submission) => submission.form)).filter((form) => !contributing.has(form));
    return forms.filter((form) =>
      submissions.every((submission) => submission.form !== form || (submission.observed.length === 0 && !SubmissionRules.explicitTarget(form, submission.submitter))),
    );
  }

  static #pageOnly(submission: Submission, observed: ObservedSubmissions): boolean {
    if (submission.target.method !== FormLinker.QUERY_METHOD || submission.observed.length > 0) return false;
    return !SubmissionRules.explicitTarget(submission.form, submission.submitter) || observed.loadedPage(submission.url);
  }

  static #native(submission: Submission, observed: ObservedSubmissions): boolean {
    if (submission.observed.length > 0 || SubmissionRules.explicitTarget(submission.form, submission.submitter)) return true;
    return observed.serverDocument(submission.form.pageUrl);
  }

  #apply(link: Link, open: ReadonlyMap<FormDescriptor, ReadonlyMap<string, readonly string[]>>): void {
    const { endpoint, submissions } = link;
    const first = submissions[0];
    if (!first) return;
    const built = submissions.map((submission) => {
      const openChoices = open.get(submission.form);
      return this.#schemas.build(submission.form, submission.submitter ?? null, openChoices ? { openChoices } : {});
    });
    const primary = built[0]!;
    const secrets = FormLinker.#secretNames(submissions);
    const schema = this.#redactor.schema(this.#combiner.combine(built.map((result) => result.schema)), secrets);
    if (!endpoint.form) endpoint.form = FormLinker.#endpointForm(this.#redactor.form(first.form), primary.mimeType, first.by);
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
    const props = Object.entries(Schema.properties(schema));
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
    FormLinker.#annotateNode(out, new Map(Object.entries(Schema.properties(form))));
    return out;
  }

  static #annotateNode(node: JsonSchema, formProps: ReadonlyMap<string, JsonSchema>): void {
    const items = Schema.items(node);
    if (items) FormLinker.#annotateNode(items, formProps);
    for (const [name, property] of Object.entries(Schema.properties(node))) {
      const source = formProps.get(name);
      if (source && Schema.primaryType(source) === Schema.primaryType(property)) {
        for (const [key, value] of Object.entries(source)) {
          if ((key.startsWith(FormLinker.ANNOTATION_PREFIX) || FormLinker.ANNOTATION_KEYS.includes(key)) && !Object.hasOwn(property, key)) Json.setOwn(property, key, Json.clone(value));
        }
      }
      FormLinker.#annotateNode(property, formProps);
    }
  }

  static secretNames(forms: readonly Pick<FormDescriptor, 'fields' | 'tokenFields'>[]): Set<string> {
    const names = new Set<string>();
    for (const form of forms) {
      for (const field of form.fields) if (FormLinker.SECRET_TYPES.has(field.type) && field.name !== '') names.add(field.name);
      for (const name of form.tokenFields) names.add(name);
    }
    return names;
  }

  static personalNames(forms: readonly Pick<FormDescriptor, 'fields'>[]): Set<string> {
    const names = new Set<string>();
    for (const form of forms) for (const name of LoginFormDetector.detect(form)?.personal ?? []) names.add(name);
    return names;
  }

  static formSecrets(forms: readonly Pick<FormDescriptor, 'fields' | 'tokenFields'>[]): Set<string> {
    return new Set([...FormLinker.secretNames(forms), ...FormLinker.personalNames(forms)]);
  }

  static endpointSecrets(endpoint: Pick<Endpoint, 'id' | 'form'>, forms: readonly FormDescriptor[]): Set<string> {
    const linked = forms.filter((form) => form.endpoints?.includes(endpoint.id) === true);
    return FormLinker.formSecrets(endpoint.form ? [...linked, endpoint.form] : linked);
  }

  static #secretNames(submissions: readonly Submission[]): Set<string> {
    return FormLinker.formSecrets(submissions.map((submission) => submission.form));
  }

  static #find(endpoints: readonly Endpoint[], method: string, url: URL, matcher: EndpointMatcher): Endpoint | undefined {
    let best: Endpoint | undefined;
    let bestParams = Number.POSITIVE_INFINITY;
    for (const endpoint of endpoints) {
      if (endpoint.method !== method.toUpperCase() || endpoint.origin !== url.origin) continue;
      if (endpoint.kind === 'graphql' || endpoint.operationName !== undefined) continue;
      if (!matcher.accepts(endpoint, url.pathname, { byExamples: true })) continue;
      const params = EndpointMatcher.paramCount(endpoint.path);
      if (params < bestParams) {
        best = endpoint;
        bestParams = params;
      }
    }
    return best;
  }

  static #entry<K, V>(map: Map<K, V>, key: K, create: () => V): V {
    let value = map.get(key);
    if (value === undefined) {
      value = create();
      map.set(key, value);
    }
    return value;
  }

  static #endpointForm(form: FormDescriptor, enctype: FormEnctype, by: FormSubmitter | undefined): EndpointForm {
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
      ...(by === FormLinker.SCRIPT ? { submittedBy: by } : {}),
    };
  }
}
