import type { Endpoint, EndpointKind, EndpointResponse, EndpointSample, Exchange, Header, ResourceType, SkipReason } from '../model/index.js';
import { CookieParser } from '../capture/index.js';
import { TokenDetector } from '../forms/index.js';
import { Http, Text } from '../shared/index.js';
import { BodyParser } from './body-parser.js';
import type { ParsedBody } from './body-parser.js';
import { BodyShaper } from './body-shaper.js';
import { EndpointFactory } from './endpoint-factory.js';
import { ExchangeSignature } from './exchange-signature.js';
import type { Signature } from './exchange-signature.js';
import { HeaderPolicy } from './header-policy.js';
import { Helpers } from './helpers.js';
import { HtmlPages } from './html-pages.js';
import { ParamInferrer } from './param-inferrer.js';
import { PathEvidenceCollector } from './path-evidence-collector.js';
import { PathTemplater } from './path-templater.js';
import type { PathEvidence, PathTemplate } from './path-templater.js';
import { Redactor } from './redactor.js';
import { SchemaInferrer } from './schema-inferrer.js';

export interface EndpointGrouperOptions {
  includeStatic: boolean;
  includeDocuments: boolean;
  maxExamples: number;
}

export interface EndpointGrouperCreateOptions extends Partial<EndpointGrouperOptions> {
  redact?: boolean;
}

export interface EndpointGrouperDeps {
  body: BodyParser;
  schemas: SchemaInferrer;
  paths: PathTemplater;
  redactor: Redactor;
  headers?: HeaderPolicy;
  signatures?: ExchangeSignature;
  params?: ParamInferrer;
  shaper?: BodyShaper;
  evidence?: PathEvidenceCollector;
}

export interface GroupContext {
  forms?: ReadonlyMap<string, PathEvidence>;
  encoding?: (exchange: Exchange) => string | undefined;
  submitted?: (exchange: Exchange) => boolean;
}

interface Member {
  readonly exchange: Exchange;
  readonly signature: Signature;
  readonly encoding: string | undefined;
  readonly scripted: ReadonlySet<string> | undefined;
  readonly response: ParsedBody | undefined;
}

interface Bucket {
  readonly signature: Signature;
  readonly template: PathTemplate;
  readonly members: Member[];
}

export class EndpointGrouper {
  static readonly STATIC_TYPES: ReadonlySet<ResourceType> = new Set(['image', 'font', 'stylesheet', 'script', 'media', 'manifest']);
  static readonly SCRIPT_TYPES: ReadonlySet<ResourceType> = new Set(['fetch', 'xhr', 'eventsource']);
  static readonly SKIPPED_TYPES: ReadonlySet<ResourceType> = new Set(['websocket']);
  static readonly STATIC_EXTENSIONS: ReadonlySet<string> = new Set([
    'js', 'mjs', 'cjs', 'css', 'map', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'tif', 'tiff',
    'woff', 'woff2', 'ttf', 'otf', 'eot', 'mp4', 'webm', 'ogg', 'ogv', 'mp3', 'wav', 'flac', 'm4a', 'aac', 'wasm', 'webmanifest',
  ]);
  static readonly STATIC_MIME_PATTERNS: readonly RegExp[] = [
    /^image\//,
    /^font\//,
    /^audio\//,
    /^video\//,
    /^text\/css$/,
    /^(?:text|application)\/(?:x-)?(?:java|ecma)script$/,
    /^application\/wasm$/,
    /^application\/manifest\+json$/,
    /^application\/(?:x-)?font-/,
    /^application\/vnd\.ms-fontobject$/,
  ];
  static readonly REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
  static readonly KIND_PRIORITY: readonly EndpointKind[] = ['graphql', 'form', 'json', 'document', 'other'];
  static readonly NO_BODY_STATUSES: ReadonlySet<number> = new Set([204, 205, 304]);
  static readonly MAX_REDIRECT_TARGETS = 3;

  readonly #body: BodyParser;
  readonly #paths: PathTemplater;
  readonly #redactor: Redactor;
  readonly #headers: HeaderPolicy;
  readonly #signatures: ExchangeSignature;
  readonly #params: ParamInferrer;
  readonly #shaper: BodyShaper;
  readonly #evidence: PathEvidenceCollector;
  readonly #options: Readonly<EndpointGrouperOptions>;

  constructor(deps: EndpointGrouperDeps, options: EndpointGrouperOptions) {
    this.#body = deps.body;
    this.#paths = deps.paths;
    this.#redactor = deps.redactor;
    this.#headers = deps.headers ?? new HeaderPolicy();
    this.#signatures = deps.signatures ?? new ExchangeSignature({ body: deps.body });
    this.#params = deps.params ?? new ParamInferrer({ schemas: deps.schemas, redactor: deps.redactor, headers: this.#headers }, options);
    this.#shaper = deps.shaper ?? new BodyShaper({ schemas: deps.schemas, redactor: deps.redactor }, options);
    this.#evidence = deps.evidence ?? new PathEvidenceCollector();
    this.#options = { ...options };
  }

  static readonly DEFAULT_OPTIONS: Readonly<EndpointGrouperOptions> = { includeStatic: false, includeDocuments: true, maxExamples: 3 };

  static create(options: EndpointGrouperCreateOptions = {}): EndpointGrouper {
    const { redact, ...rest } = options;
    const tokens = new TokenDetector();
    return new EndpointGrouper(
      {
        body: BodyParser.create(),
        schemas: SchemaInferrer.create(),
        paths: PathTemplater.create(),
        redactor: new Redactor(redact ?? true, { tokens }),
        headers: new HeaderPolicy({ tokens }),
        evidence: PathEvidenceCollector.create(),
      },
      { ...EndpointGrouper.DEFAULT_OPTIONS, ...rest },
    );
  }

  static extension(pathname: string): string {
    const decoded = Http.decodeComponent(pathname.slice(pathname.lastIndexOf('/') + 1));
    const cut = decoded.search(/[?#]/);
    const last = cut < 0 ? decoded : decoded.slice(0, cut);
    const dot = last.lastIndexOf('.');
    return dot <= 0 ? '' : last.slice(dot + 1).toLowerCase();
  }

  isStaticAsset(e: Exchange): boolean {
    if (EndpointGrouper.STATIC_TYPES.has(e.resourceType)) return true;
    if (!Http.isSafeMethod(e.request.method)) return false;
    const url = Http.parseUrl(e.request.url);
    if (url && EndpointGrouper.STATIC_EXTENSIONS.has(EndpointGrouper.extension(url.pathname))) return true;
    if (EndpointGrouper.SCRIPT_TYPES.has(e.resourceType)) return false;
    const mime = Http.mimeEssence(e.response ? Http.getHeader(e.response.headers, 'content-type') : undefined);
    return mime !== '' && EndpointGrouper.STATIC_MIME_PATTERNS.some((pattern) => pattern.test(mime));
  }

  isDocument(e: Exchange): boolean {
    if (e.resourceType !== 'document' || e.request.method !== 'GET') return false;
    const response = e.response;
    if (!response || EndpointGrouper.REDIRECT_STATUSES.has(response.status)) return true;
    const mime = Http.mimeEssence(Http.getHeader(response.headers, 'content-type'));
    return mime === '' || BodyParser.HTML_MIMES.has(mime);
  }

  isPreflight(e: Exchange): boolean {
    return e.request.method === 'OPTIONS' && Http.getHeader(e.request.headers, 'access-control-request-method') !== undefined;
  }

  group(exchanges: Exchange[], context: GroupContext = {}): Endpoint[] {
    const members: Member[] = [];
    const scripted = this.#headers.scriptHeaders(exchanges);
    for (const exchange of exchanges) {
      if (!this.#include(exchange, context)) continue;
      const encoding = context.encoding?.(exchange);
      const signature = this.#signatures.of(exchange, encoding);
      if (signature) members.push({ exchange, signature, encoding, scripted: scripted.get(exchange), response: this.#parseResponse(exchange) });
    }
    const templates = this.#templates(members, context.forms ?? new Map());
    const buckets = new Map<string, Bucket>();
    for (const member of members) {
      const { signature } = member;
      const template = templates.get(signature.origin)?.get(signature.path);
      if (!template) continue;
      const key = EndpointFactory.key(signature.method, signature.origin, template.template, signature.operationName);
      const bucket = buckets.get(key);
      if (bucket) bucket.members.push(member);
      else buckets.set(key, { signature, template, members: [member] });
    }
    return [...buckets.values()].map((bucket) => this.#endpoint(bucket));
  }


  #include(e: Exchange, context: GroupContext): boolean {
    return this.skipReason(e, context) === undefined;
  }

  skipReason(e: Exchange, context: GroupContext = {}): SkipReason | undefined {
    if (!Helpers.httpUrl(e.request.url)) return 'not-http';
    if (Http.isWorkerResponse(e)) return 'service-worker';
    if (EndpointGrouper.SKIPPED_TYPES.has(e.resourceType)) return 'websocket';
    if (this.isPreflight(e)) return 'preflight';
    if (!this.#options.includeStatic && this.isStaticAsset(e)) return 'static';
    if (!this.#options.includeDocuments && this.isDocument(e) && context.submitted?.(e) !== true) return 'document';
    return undefined;
  }

  #templates(members: readonly Member[], forms: ReadonlyMap<string, PathEvidence>): Map<string, Map<string, PathTemplate>> {
    const paths = new Map<string, string[]>();
    for (const { signature } of members) {
      const list = paths.get(signature.origin);
      if (list) list.push(signature.path);
      else paths.set(signature.origin, [signature.path]);
    }
    const evidence = this.#evidence.collect(members, forms);
    return new Map([...paths].map(([origin, list]) => [origin, this.#paths.template(list, evidence.get(origin) ?? new Map())]));
  }

  #endpoint(bucket: Bucket): Endpoint {
    const { signature, template, members } = bucket;
    const responses = members.map((member) => member.response);
    const kinds = new Set(members.map((member, i) => this.#kind(member, responses[i])));
    const kind = EndpointGrouper.KIND_PRIORITY.find((candidate) => kinds.has(candidate)) ?? 'other';
    const endpoint = EndpointFactory.blank({
      method: signature.method,
      origin: signature.origin,
      path: template.template,
      ...(signature.operationName ? { operationName: signature.operationName } : {}),
      kind,
    });
    const served = members.filter((member) => Http.reachedServer(member.exchange));
    endpoint.pathParams = this.#params.path(template, members.map((member) => member.signature.path));
    endpoint.queryParams = this.#params.query(
      members.map((member) => member.signature.url),
      members.map((member) => member.encoding),
    );
    endpoint.headerParams = this.#params.headers(served.map((member) => ({ headers: member.exchange.request.headers, ...(member.scripted ? { scripted: member.scripted } : {}) })));
    const [requestBody, ...otherRequestBodies] = this.#shaper.shapes(members.map((member) => member.signature.request));
    if (requestBody) endpoint.requestBody = requestBody;
    if (otherRequestBodies.length > 0) endpoint.otherRequestBodies = otherRequestBodies;
    endpoint.responses = this.#responses(members, responses);
    endpoint.resourceTypes = Helpers.distinct(members.map((member) => member.exchange.resourceType));
    endpoint.samples = this.#samples(served.length > 0 ? served : members);
    endpoint.count = served.length;
    return endpoint;
  }

  isBodyUncaptured(e: Exchange): boolean {
    const response = e.response;
    if (!response || response.body !== undefined || e.request.method === 'HEAD') return false;
    if (response.status < 200 || EndpointGrouper.NO_BODY_STATUSES.has(response.status)) return false;
    if (Http.mimeEssence(Http.getHeader(response.headers, 'content-type')) === '') return false;
    const length = Http.getHeader(response.headers, 'content-length');
    return length === undefined || !/^[0-9]+$/.test(length.trim()) || Number(length.trim()) > 0;
  }

  #parseResponse(exchange: Exchange): ParsedBody | undefined {
    const response = exchange.response;
    if (!response) return undefined;
    const parsed = this.#body.response(response);
    if (parsed.kind !== 'empty' || !this.isBodyUncaptured(exchange)) return parsed;
    return { kind: BodyParser.kindOf(parsed.mimeType), mimeType: parsed.mimeType };
  }

  #kind(member: Member, response: ParsedBody | undefined): EndpointKind {
    const { signature, exchange } = member;
    if (signature.graphql) return 'graphql';
    if (signature.request.kind === 'form' || signature.request.kind === 'multipart') return 'form';
    if (signature.request.kind === 'json') return 'json';
    if (this.isDocument(exchange)) return 'document';
    if (response?.kind === 'json' || response?.kind === 'graphql') return 'json';
    return 'other';
  }

  #responses(members: readonly Member[], parsed: readonly (ParsedBody | undefined)[]): EndpointResponse[] {
    const byStatus = new Map<number, { count: number; bodies: ParsedBody[]; headers: Set<string>; targets: Set<string> }>();
    members.forEach(({ exchange }, i) => {
      const response = exchange.response;
      const body = parsed[i];
      if (!response || !body) return;
      let entry = byStatus.get(response.status);
      if (!entry) {
        entry = { count: 0, bodies: [], headers: new Set(), targets: new Set() };
        byStatus.set(response.status, entry);
      }
      if (Http.reachedServer(exchange)) entry.count++;
      entry.bodies.push(body);
      for (const name of this.#notableHeaders(response.headers)) entry.headers.add(name);
      const target = this.#redirectTarget(exchange);
      if (target !== undefined) entry.targets.add(target);
    });
    return [...byStatus]
      .sort(([a], [b]) => a - b)
      .map(([status, entry]) => {
        const body = this.#shaper.shape(entry.bodies, true);
        const targets = [...entry.targets].sort(Text.compare).slice(0, EndpointGrouper.MAX_REDIRECT_TARGETS);
        return { status, count: entry.count, ...(body ? { body } : {}), headers: [...entry.headers].sort(Text.compare), ...(targets.length > 0 ? { redirectTo: targets } : {}) };
      });
  }

  #redirectTarget(exchange: Exchange): string | undefined {
    const response = exchange.response;
    if (!response || !EndpointGrouper.REDIRECT_STATUSES.has(response.status)) return undefined;
    const location = Http.getHeader(response.headers, 'location');
    const target = location === undefined ? undefined : Http.parseUrl(location.trim(), exchange.request.url);
    if (!target || !Helpers.httpUrl(target.href)) return undefined;
    target.hash = '';
    return this.#redactor.url(target.href);
  }

  #notableHeaders(headers: readonly Header[]): string[] {
    const out: string[] = [];
    for (const header of headers) {
      const name = header.name.toLowerCase();
      if (name === 'set-cookie') {
        for (const line of header.value.split('\n')) {
          if (line.trim() === '') continue;
          const cookie = CookieParser.tokenize(line);
          out.push(cookie && cookie.name !== '' ? `set-cookie: ${cookie.name}` : 'set-cookie');
        }
      } else if (this.#headers.isNotableResponse(name)) {
        out.push(name);
      }
    }
    return out;
  }

  #samples(members: readonly Member[]): EndpointSample[] {
    const max = this.#options.maxExamples;
    if (max <= 0) return [];
    const chosen = new Set<number>();
    const statuses = new Set<string>();
    members.forEach(({ exchange }, i) => {
      const status = exchange.response ? String(exchange.response.status) : 'failed';
      if (chosen.size >= max || statuses.has(status)) return;
      statuses.add(status);
      chosen.add(i);
    });
    for (let i = 0; i < members.length && chosen.size < max; i++) chosen.add(i);
    return [...chosen]
      .sort((a, b) => a - b)
      .map((i) => {
        const { exchange } = members[i]!;
        return {
          exchangeId: exchange.id,
          url: this.#redactor.url(exchange.request.url),
          ...(exchange.pageUrl !== undefined ? { pageUrl: this.#redactor.url(exchange.pageUrl) } : {}),
          ...(exchange.response ? { status: exchange.response.status } : {}),
          startedAt: exchange.startedAt,
        };
      });
  }
}
