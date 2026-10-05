import type { ApiModel, Capture, Endpoint, WebSocketCapture } from '../model/index.js';
import { CookieParser } from '../capture/index.js';
import { FormExtractor, FormSchemaBuilder, TokenDetector } from '../forms/index.js';
import { AppiiError, Json, Text } from '../shared/index.js';
import { AuthDetector } from './auth-detector.js';
import { BodyParser } from './body-parser.js';
import { BodyShaper } from './body-shaper.js';
import { CookieClassifier } from './cookie-classifier.js';
import { CookieInventory } from './cookie-inventory.js';
import { EndpointFactory } from './endpoint-factory.js';
import { EndpointGrouper } from './endpoint-grouper.js';
import { EndpointNamer } from './endpoint-namer.js';
import { ExchangeSignature } from './exchange-signature.js';
import { FormCollector } from './form-collector.js';
import { FormLinker } from './form-linker.js';
import { HeaderPolicy } from './header-policy.js';
import { Helpers } from './helpers.js';
import { HtmlPages } from './html-pages.js';
import { OriginSelector } from './origin-selector.js';
import { ParamInferrer } from './param-inferrer.js';
import { PathTemplater } from './path-templater.js';
import { Redactor } from './redactor.js';
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
}

export class ModelBuilder {
  static readonly DEFAULT_MAX_EXAMPLES = 3;
  static readonly WEBSOCKET_EXAMPLE_LENGTH = 200;
  static readonly WEBSOCKET_SCHEMES: Readonly<Record<string, string>> = { 'ws:': 'http:', 'wss:': 'https:' };
  static readonly DEFAULT_NAME = 'api';

  readonly #parts: ModelBuilderParts;
  readonly #redactor: Redactor;
  readonly #options: Readonly<BuildOptions>;
  readonly #origins: readonly string[] | undefined;
  readonly #maxExamples: number;

  constructor(parts: ModelBuilderParts, options: BuildOptions = {}) {
    this.#maxExamples = ModelBuilder.#checkMaxExamples(options.maxExamples);
    if (options.now !== undefined && Number.isNaN(options.now.getTime())) throw new AppiiError('BAD_INPUT', 'Build option now must be a valid date');
    this.#origins = options.origins === undefined ? undefined : Helpers.distinct(options.origins.map((origin) => ModelBuilder.normalizeOrigin(origin))).sort(Helpers.compare);
    this.#parts = parts;
    this.#redactor = parts.redactor ?? new Redactor(options.redact ?? true);
    this.#options = { ...options };
  }

  static create(options: BuildOptions = {}): ModelBuilder {
    const maxExamples = ModelBuilder.#checkMaxExamples(options.maxExamples);
    const body = new BodyParser();
    const schemas = new SchemaInferrer();
    const paths = new PathTemplater();
    const redactor = new Redactor(options.redact ?? true);
    const headers = new HeaderPolicy();
    const tokens = new TokenDetector();
    const extractor = new FormExtractor({ tokens });
    const pages = new HtmlPages({ body });
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
      },
      { includeStatic: options.includeStatic ?? false, includeDocuments: options.includeDocuments ?? true, maxExamples },
    );
    const auth = new AuthDetector({
      extractor,
      tokens,
      body,
      headers,
      sources: (capture) => new CsrfSourceResolver(capture, { extractor, tokens, body, pages, headers }),
    });
    const cookies = new CookieInventory({ classifier: new CookieClassifier(), parser: new CookieParser(), redactor, body });
    const forms = new FormLinker({
      extractor,
      schemas: new FormSchemaBuilder({ tokens }),
      inferrer: schemas,
      paths,
      collector: new FormCollector({ extractor, pages }),
      params,
      redactor,
    });
    return new ModelBuilder({ grouper, auth, cookies, forms, namer: new EndpointNamer(), redactor }, options);
  }

  static firstPartyOrigins(capture: Capture): string[] {
    return OriginSelector.firstParty(capture);
  }

  static normalizeOrigin(value: string): string {
    const url = Helpers.httpUrl(value.trim());
    if (!url) throw new AppiiError('BAD_INPUT', `Origin '${value}' must be an absolute http(s) URL such as https://example.com`, { details: { origin: value } });
    return url.origin;
  }

  build(capture: Capture): ApiModel {
    const chosen = this.#chosenOrigins(capture);
    const allowed = new Set(chosen);
    const exchanges = capture.exchanges.filter((exchange) => allowed.has(Helpers.originOf(exchange.request.url) ?? ''));
    const grouped = this.#parts.grouper.group(exchanges);
    const linked = this.#parts.forms.link(grouped, capture);
    const endpoints = linked.endpoints.filter((endpoint) => allowed.has(endpoint.origin));
    this.#parts.auth.detect(endpoints, capture);
    endpoints.sort(ModelBuilder.#compare);
    this.#parts.namer.name(endpoints);
    const domains = OriginSelector.referenceDomains(capture);
    for (const endpoint of endpoints) endpoint.firstParty = OriginSelector.isFirstParty(endpoint.origin, domains);
    const cookies = this.#parts.cookies.build(capture, endpoints, chosen);
    const primaryOrigin = OriginSelector.primary(capture, chosen);
    const forms = linked.forms.filter((form) => allowed.has(Helpers.originOf(form.pageUrl) ?? '') || allowed.has(Helpers.originOf(form.action) ?? ''));
    return {
      version: 1,
      name: this.#options.name ?? (primaryOrigin ? new URL(primaryOrigin).host : ModelBuilder.DEFAULT_NAME),
      generatedAt: (this.#options.now ?? new Date()).toISOString(),
      source: {
        ...(capture.startUrl !== undefined ? { startUrl: capture.startUrl } : {}),
        exchanges: capture.exchanges.length,
        capturedFrom: capture.startedAt,
        capturedTo: capture.endedAt,
      },
      primaryOrigin,
      origins: [...chosen],
      endpoints: endpoints.map((endpoint) => EndpointFactory.normalize(endpoint)),
      cookies,
      forms,
      websockets: this.#websockets(capture.websockets, this.#origins === undefined && this.#options.allOrigins === true ? undefined : allowed),
    };
  }

  #chosenOrigins(capture: Capture): string[] {
    if (this.#origins) return [...this.#origins];
    if (this.#options.allOrigins) return OriginSelector.origins(capture).sort(Helpers.compare);
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
    const parsed = Json.safeParse(data);
    const text = parsed.ok && typeof parsed.value === 'object' && parsed.value !== null ? JSON.stringify(this.#redactor.deep(parsed.value)) : String(this.#redactor.deep(data));
    return Text.truncate(text, ModelBuilder.WEBSOCKET_EXAMPLE_LENGTH);
  }

  static #socketAllowed(socket: WebSocketCapture, allowed: ReadonlySet<string>): boolean {
    const url = Helpers.parseUrl(socket.url);
    const http = url ? ModelBuilder.WEBSOCKET_SCHEMES[url.protocol] : undefined;
    if (url && http && allowed.has(`${http}//${url.host}`)) return true;
    return allowed.has(Helpers.originOf(socket.pageUrl) ?? '');
  }

  static #compare(a: Endpoint, b: Endpoint): number {
    return (
      Helpers.compare(a.origin, b.origin) ||
      Helpers.compare(a.path, b.path) ||
      Helpers.compare(a.method, b.method) ||
      Helpers.compare(a.operationName ?? '', b.operationName ?? '') ||
      Helpers.compare(a.key, b.key)
    );
  }

  static #checkMaxExamples(value: number | undefined): number {
    if (value === undefined) return ModelBuilder.DEFAULT_MAX_EXAMPLES;
    if (!Number.isInteger(value) || value < 0) throw new AppiiError('BAD_INPUT', `maxExamples must be a non-negative integer, got ${value}`);
    return value;
  }
}
