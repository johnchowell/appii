import type { ApiModel, Capture, Endpoint, Exchange, FormField, SkippedRequests, SkipReason, WebSocketCapture } from '../model/index.js';
import { MODEL_VERSION, SKIP_REASONS } from '../model/index.js';
import { CookieParser } from '../capture/index.js';
import { FormExtractor, FormSchemaBuilder, TokenDetector } from '../forms/index.js';
import { AppiiError, Http, Text } from '../shared/index.js';
import { AuthDetector } from './auth-detector.js';
import { BodyParser } from './body-parser.js';
import { BodyShaper } from './body-shaper.js';
import { CookieClassifier } from './cookie-classifier.js';
import { CookieInventory } from './cookie-inventory.js';
import { CredentialAnalyzer } from './credential-analyzer.js';
import { EndpointFactory } from './endpoint-factory.js';
import { EndpointGrouper } from './endpoint-grouper.js';
import type { GroupContext } from './endpoint-grouper.js';
import { EndpointNamer } from './endpoint-namer.js';
import { EndpointRoleDetector } from './endpoint-role-detector.js';
import { ExchangeSignature } from './exchange-signature.js';
import { FormCollector } from './form-collector.js';
import { FormLinker } from './form-linker.js';
import { HeaderPolicy } from './header-policy.js';
import { Helpers } from './helpers.js';
import { HtmlPages } from './html-pages.js';
import { OriginSelector } from './origin-selector.js';
import { PageDocuments } from './page-documents.js';
import { ParamInferrer } from './param-inferrer.js';
import { PathEvidenceCollector } from './path-evidence-collector.js';
import { PathTemplater } from './path-templater.js';
import { Redactor } from './redactor.js';
import { SecretCollector } from './secret-collector.js';
import { SchemaInferrer } from './schema-inferrer.js';
import { CsrfSourceResolver } from './csrf-source-resolver.js';

export interface BuildOptions {
  name?: string;
  origins?: string[];
  allOrigins?: boolean;
  includeStatic?: boolean;
  includeDocuments?: boolean;
  maxExamples?: number;
  redact?: boolean;
  now?: Date;
}

export interface ModelBuilderParts {
  grouper: EndpointGrouper;
  auth: AuthDetector;
  cookies: CookieInventory;
  forms: FormLinker;
  namer: EndpointNamer;
  redactor?: Redactor;
  secrets?: SecretCollector;
  credentials?: CredentialAnalyzer;
  roles?: EndpointRoleDetector;
}

export class ModelBuilder {
  static readonly DEFAULT_MAX_EXAMPLES = 3;
  static readonly WEBSOCKET_EXAMPLE_LENGTH = 200;
  static readonly WEBSOCKET_SCHEMES: Readonly<Record<string, string>> = { 'ws:': 'http:', 'wss:': 'https:' };
  static readonly DEFAULT_NAME = 'api';
  static readonly SKIPPED_EXAMPLES = 3;
  static readonly SKIPPED_EXAMPLE_LENGTH = 60;

  readonly #parts: ModelBuilderParts;
  readonly #redactor: Redactor;
  readonly #secrets: SecretCollector;
  readonly #credentials: CredentialAnalyzer;
  readonly #roles: EndpointRoleDetector;
  readonly #options: Readonly<BuildOptions>;
  readonly #origins: readonly string[] | undefined;
  readonly #maxExamples: number;

  constructor(parts: ModelBuilderParts, options: BuildOptions = {}) {
    this.#maxExamples = ModelBuilder.#checkMaxExamples(options.maxExamples);
    if (options.now !== undefined && Number.isNaN(options.now.getTime())) throw new AppiiError('BAD_INPUT', 'Build option now must be a valid date');
    this.#origins = options.origins === undefined ? undefined : Helpers.distinct(options.origins.map((origin) => ModelBuilder.normalizeOrigin(origin))).sort(Text.compare);
    this.#parts = parts;
    this.#redactor = parts.redactor ?? Redactor.create({ redact: options.redact ?? true });
    this.#credentials = parts.credentials ?? CredentialAnalyzer.create();
    this.#secrets = parts.secrets ?? new SecretCollector({ redactor: this.#redactor, body: BodyParser.create(), cookies: new CookieClassifier(), credentials: this.#credentials });
    this.#roles = parts.roles ?? new EndpointRoleDetector({ analyzer: this.#credentials, body: BodyParser.create(), schemas: new FormSchemaBuilder(), parser: new CookieParser() });
    this.#options = { ...options };
  }

  static create(options: BuildOptions = {}): ModelBuilder {
    const maxExamples = ModelBuilder.#checkMaxExamples(options.maxExamples);
    const body = BodyParser.create();
    const schemas = SchemaInferrer.create();
    const tokens = new TokenDetector();
    const redactor = new Redactor(options.redact ?? true, { tokens });
    const paths = PathTemplater.create((segment) => redactor.values.label(segment));
    const headers = new HeaderPolicy({ tokens });
    const extractor = new FormExtractor({ tokens });
    const documents = new PageDocuments({ pages: new HtmlPages({ body }), extractor });
    const params = new ParamInferrer({ schemas, redactor, headers }, { maxExamples });
    const grouper = new EndpointGrouper(
      {
        body,
        schemas,
        paths,
        redactor,
        headers,
        signatures: new ExchangeSignature({ body }),
        params,
        shaper: new BodyShaper({ schemas, redactor }, { maxExamples }),
        evidence: PathEvidenceCollector.create(),
      },
      { includeStatic: options.includeStatic ?? false, includeDocuments: options.includeDocuments ?? true, maxExamples },
    );
    const classifier = new CookieClassifier();
    const auth = new AuthDetector({
      cookies: classifier,
      extractor,
      tokens,
      body,
      headers,
      redactor,
      documents,
      sources: (capture) => new CsrfSourceResolver(capture, { tokens, body, documents, headers }),
    });
    const cookies = new CookieInventory({ classifier, parser: new CookieParser(), redactor, body });
    const formSchemas = new FormSchemaBuilder({ tokens });
    const forms = new FormLinker({
      extractor,
      schemas: formSchemas,
      inferrer: schemas,
      paths,
      collector: new FormCollector({ documents }),
      params,
      redactor,
    });
    const credentials = new CredentialAnalyzer({ cookies: classifier, body, headers, redactor });
    const secrets = new SecretCollector({ redactor, body, cookies: classifier, credentials });
    const roles = new EndpointRoleDetector({ analyzer: credentials, body, schemas: formSchemas, parser: new CookieParser() });
    return new ModelBuilder({ grouper, auth, cookies, forms, namer: new EndpointNamer(), redactor, secrets, credentials, roles }, options);
  }

  static firstPartyOrigins(capture: Capture): string[] {
    return OriginSelector.firstParty(capture);
  }

  static normalizeOrigin(value: string): string {
    const url = Helpers.httpUrl(value.trim());
    if (!url) throw new AppiiError('BAD_INPUT', `Origin '${value}' must be an absolute http(s) URL such as https://example.com`, { details: { origin: value } });
    return url.origin;
  }

  static #recorded(capture: Capture): Capture {
    const exchanges = Http.recorded(capture.exchanges);
    return exchanges.length === capture.exchanges.length ? capture : { ...capture, exchanges };
  }

  build(capture: Capture): ApiModel {
    const forms = this.#parts.forms;
    const recorded = ModelBuilder.#recorded(capture);
    const input = forms.credentialInput(capture);
    const evidence = this.#credentials.analyze(recorded, input);
    this.#redactor.useValues(this.#secrets.collect(recorded, forms.secretFields(capture), evidence, input));
    const chosen = this.#chosenOrigins(capture);
    const allowed = new Set(chosen);
    const exchanges = capture.exchanges.filter((exchange) => allowed.has(Helpers.originOf(exchange.request.url) ?? ''));
    const credentials = (exchange: Exchange): string[] => this.#parts.auth.credentialSet(exchange, evidence);
    const submitted = this.#parts.forms.submitted(capture);
    const signOuts = this.#roles.signOuts(recorded, { evidence, input, credentials });
    const context: GroupContext = {
      forms: this.#parts.forms.targets(capture),
      encoding: this.#parts.forms.submissionEncoding(capture),
      actions: (exchange) => submitted(exchange) || signOuts.has(exchange),
      credentials,
    };
    const grouped = this.#parts.grouper.group(exchanges, context);
    const linked = this.#parts.forms.link(grouped, capture);
    const endpoints = linked.endpoints.filter((endpoint) => allowed.has(endpoint.origin));
    this.#roles.detect(endpoints, recorded, { evidence, input, forms: linked.targets, credentials });
    this.#parts.auth.detect(endpoints, recorded, evidence);
    endpoints.sort(ModelBuilder.#compare);
    this.#parts.namer.name(endpoints);
    const domains = OriginSelector.referenceDomains(capture);
    for (const endpoint of endpoints) endpoint.firstParty = OriginSelector.isFirstParty(endpoint.origin, domains);
    const cookies = this.#parts.cookies.build(recorded, endpoints, chosen, evidence);
    const primaryOrigin = OriginSelector.primary(capture, chosen);
    const shown = linked.forms.filter((form) => allowed.has(Helpers.originOf(form.pageUrl) ?? '') || allowed.has(Helpers.originOf(form.action) ?? ''));
    const described = FormLinker.endpointIds(linked, shown, endpoints);
    return this.#redactUrls({
      version: MODEL_VERSION,
      name: this.#options.name ?? (primaryOrigin ? new URL(primaryOrigin).host : ModelBuilder.DEFAULT_NAME),
      generatedAt: (this.#options.now ?? new Date()).toISOString(),
      source: {
        ...(capture.startUrl !== undefined ? { startUrl: capture.startUrl } : {}),
        exchanges: recorded.exchanges.length,
        capturedFrom: capture.startedAt,
        capturedTo: capture.endedAt,
        ...ModelBuilder.#present('skipped', this.#skipped(recorded, allowed, context)),
      },
      primaryOrigin,
      origins: [...chosen],
      endpoints: endpoints.map((endpoint) => EndpointFactory.normalize(endpoint)),
      cookies,
      forms: described,
      websockets: this.#websockets(capture.websockets, this.#origins === undefined && this.#options.allOrigins === true ? undefined : allowed),
    });
  }

  #redactUrls(model: ApiModel): ApiModel {
    const url = (value: string): string => this.#redactor.url(value);
    const fields = (list: FormField[]): void => {
      for (const field of list) if (field.formAction !== undefined) field.formAction = url(field.formAction);
    };
    if (model.source.startUrl !== undefined) model.source.startUrl = url(model.source.startUrl);
    for (const endpoint of model.endpoints) {
      const secrets = FormLinker.endpointSecrets(endpoint, model.forms);
      for (const sample of endpoint.samples) {
        sample.url = this.#redactor.url(sample.url, secrets);
        if (sample.pageUrl !== undefined) sample.pageUrl = url(sample.pageUrl);
      }
      for (const token of endpoint.auth.csrf) if (token.sourceUrl !== undefined) token.sourceUrl = url(token.sourceUrl);
      const form = endpoint.form;
      if (form) {
        form.pageUrl = url(form.pageUrl);
        form.action = url(form.action);
        fields(form.fields);
        fields(form.submitters);
      }
    }
    for (const form of model.forms) {
      form.pageUrl = url(form.pageUrl);
      form.action = url(form.action);
      fields(form.fields);
      fields(form.submitters);
    }
    for (const socket of model.websockets) socket.url = url(socket.url);
    return model;
  }

  #skipped(capture: Capture, allowed: ReadonlySet<string>, context: GroupContext): SkippedRequests[] {
    const tally = new Map<SkipReason, SkippedRequests>();
    for (const exchange of capture.exchanges) {
      const reason: SkipReason | undefined = !allowed.has(Helpers.originOf(exchange.request.url) ?? '')
        ? Helpers.httpUrl(exchange.request.url) ? 'other-origin' : 'not-http'
        : (this.#parts.grouper.skipReason(exchange, context) ?? (Http.reachedServer(exchange) ? undefined : 'cache'));
      if (reason === undefined) continue;
      const entry = tally.get(reason) ?? { reason, count: 0, examples: [] };
      entry.count++;
      const example = this.#skippedExample(exchange, reason);
      if (entry.examples.length < ModelBuilder.SKIPPED_EXAMPLES && !entry.examples.includes(example)) entry.examples.push(example);
      tally.set(reason, entry);
    }
    return SKIP_REASONS.flatMap((reason) => {
      const entry = tally.get(reason);
      return entry ? [entry] : [];
    });
  }

  #skippedExample(exchange: Exchange, reason: SkipReason): string {
    const url = Http.parseUrl(this.#redactor.url(exchange.request.url));
    if (!url || reason === 'not-http') return url?.protocol ?? '';
    if (reason === 'other-origin') return url.origin;
    return Text.truncate(`${exchange.request.method} ${url.pathname}`, ModelBuilder.SKIPPED_EXAMPLE_LENGTH);
  }

  #chosenOrigins(capture: Capture): string[] {
    if (this.#origins) return [...this.#origins];
    if (this.#options.allOrigins) return OriginSelector.origins(capture).sort(Text.compare);
    return OriginSelector.firstParty(capture);
  }

  #websockets(sockets: readonly WebSocketCapture[], allowed: ReadonlySet<string> | undefined): ApiModel['websockets'] {
    const byUrl = new Map<string, { url: string; messages: number; examples: string[] }>();
    for (const socket of sockets) {
      if (allowed && !ModelBuilder.#socketAllowed(socket, allowed)) continue;
      let entry = byUrl.get(socket.url);
      if (!entry) {
        entry = { url: this.#redactor.url(socket.url), messages: 0, examples: [] };
        byUrl.set(socket.url, entry);
      }
      entry.messages += socket.messages.length;
      for (const message of socket.messages) {
        if (entry.examples.length >= this.#maxExamples) break;
        if (message.opcode !== 'text') continue;
        const example = this.#socketExample(message.data);
        if (!entry.examples.includes(example)) entry.examples.push(example);
      }
    }
    return [...byUrl.values()];
  }

  #socketExample(data: string): string {
    return Text.truncate(this.#redactor.frame(data), ModelBuilder.WEBSOCKET_EXAMPLE_LENGTH);
  }

  static #socketAllowed(socket: WebSocketCapture, allowed: ReadonlySet<string>): boolean {
    const url = Http.parseUrl(socket.url);
    const http = url ? ModelBuilder.WEBSOCKET_SCHEMES[url.protocol] : undefined;
    if (url && http && allowed.has(`${http}//${url.host}`)) return true;
    return allowed.has(Helpers.originOf(socket.pageUrl) ?? '');
  }

  static #compare(a: Endpoint, b: Endpoint): number {
    return (
      Text.compare(a.origin, b.origin) ||
      Text.compare(a.path, b.path) ||
      Text.compare(a.method, b.method) ||
      Text.compare(a.operationName ?? '', b.operationName ?? '') ||
      Text.compare(a.key, b.key)
    );
  }

  static #present<K extends string, V>(key: K, list: readonly V[]): Partial<Record<K, V[]>> {
    return list.length > 0 ? ({ [key]: [...list] } as Partial<Record<K, V[]>>) : {};
  }

  static #checkMaxExamples(value: number | undefined): number {
    if (value === undefined) return ModelBuilder.DEFAULT_MAX_EXAMPLES;
    if (!Number.isInteger(value) || value < 0) throw new AppiiError('BAD_INPUT', `maxExamples must be a non-negative integer, got ${value}`);
    return value;
  }
}
