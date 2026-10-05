import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import type { ApiModel, Endpoint } from '../model/index.js';
import { Fs, Http, Meta, NamedReferences, Text } from '../shared/index.js';
import { BaseExporter } from './exporter.js';
import type { ExportFormat, ExportOptions } from './exporter.js';
import { Helpers } from './helpers.js';
import { TsClientRuntime } from './ts-client-runtime.js';
import { TsEndpointWriter } from './ts-endpoint-writer.js';
import type { TsEndpointContext } from './ts-endpoint-writer.js';
import { TsLiteralWriter } from './ts-literal-writer.js';

export interface TypeScriptExporterDeps {
  endpoints?: TsEndpointWriter;
  literals?: TsLiteralWriter;
}

export class TypeScriptExporter extends BaseExporter {
  static readonly CLIENT_SUFFIX = 'Client';
  static readonly FALLBACK_PREFIX = 'Api';
  static readonly FILE_SUFFIX = '-client.ts';
  static readonly FALLBACK_NAME = 'api';
  static readonly NAME_MAX_BYTES = 255;
  static readonly HASH_LENGTH = 8;
  static readonly LITERAL_CONTROLS = '[\\x00-\\x09\\x0b-\\x1f\\x7f]';

  readonly format: ExportFormat = 'typescript';
  readonly extension = 'ts';
  readonly mimeType = 'text/typescript';
  readonly description = 'Typed TypeScript client with cookie, CSRF and form validation handling';

  readonly #endpoints: TsEndpointWriter;
  readonly #literals: TsLiteralWriter;

  static create(): TypeScriptExporter {
    return new TypeScriptExporter({ endpoints: TsEndpointWriter.create(), literals: new TsLiteralWriter() });
  }

  constructor(deps: TypeScriptExporterDeps = {}) {
    super();
    this.#endpoints = deps.endpoints ?? TsEndpointWriter.create();
    this.#literals = deps.literals ?? new TsLiteralWriter();
  }

  static clientName(model: ApiModel): string {
    const pascal = Text.pascalCase(model.name);
    const base = pascal === '' ? TypeScriptExporter.FALLBACK_PREFIX : pascal.startsWith('_') ? TypeScriptExporter.FALLBACK_PREFIX + pascal.replace(/^_+/, '') : pascal;
    return base + TypeScriptExporter.CLIENT_SUFFIX;
  }

  static fileName(model: ApiModel): string {
    const base = Text.kebabCase(model.name) || TypeScriptExporter.FALLBACK_NAME;
    const overhead = basename(Fs.tempPath('x')).length - 1;
    const limit = TypeScriptExporter.NAME_MAX_BYTES - overhead - Buffer.byteLength(TypeScriptExporter.FILE_SUFFIX);
    if (Buffer.byteLength(base) <= limit) return base + TypeScriptExporter.FILE_SUFFIX;
    const hash = createHash('sha256').update(base).digest('hex').slice(0, TypeScriptExporter.HASH_LENGTH);
    const room = limit - hash.length - 1;
    let cut = '';
    let bytes = 0;
    for (const ch of base) {
      const size = Buffer.byteLength(ch);
      if (bytes + size > room) break;
      cut += ch;
      bytes += size;
    }
    return `${cut.replace(/-+$/, '')}-${hash}${TypeScriptExporter.FILE_SUFFIX}`;
  }

  static sites(model: ApiModel, endpoints: readonly Endpoint[], options: ExportOptions = {}): Record<string, string> {
    const urls: string[] = [model.primaryOrigin, ...model.origins, options.baseUrl ?? ''];
    for (const endpoint of endpoints) {
      urls.push(endpoint.origin, ...endpoint.samples.flatMap((sample) => [sample.url, sample.pageUrl ?? '']));
      if (endpoint.form) urls.push(endpoint.form.pageUrl, endpoint.form.action);
      for (const token of endpoint.auth.csrf) urls.push(token.sourceUrl ?? '');
    }
    for (const form of model.forms) urls.push(form.pageUrl, form.action);
    const hosts = urls.map((url) => Http.parseUrl(url)?.hostname ?? '');
    for (const cookie of model.cookies) hosts.push(cookie.domain.replace(/^\./, ''));
    const out: [string, string][] = [];
    for (const raw of hosts) {
      const host = raw.toLowerCase();
      if (host === '' || Http.isIpAddress(host) || out.some(([known]) => known === host)) continue;
      out.push([host, Http.registrableDomain(host)]);
    }
    return Object.fromEntries(out.sort(([a], [b]) => Text.compare(a, b)));
  }

  static indexes(endpoints: readonly Endpoint[]): Record<string, string> {
    const out = new Map<string, string>();
    for (const endpoint of endpoints) {
      const index = endpoint.form === undefined ? undefined : TsEndpointWriter.index(endpoint.form.charset);
      if (index !== undefined) out.set(index[0], index[1]);
    }
    return Object.fromEntries([...out].sort(([a], [b]) => Text.compare(a, b)));
  }

  source(model: ApiModel, endpoints: Endpoint[], options: ExportOptions = {}): string {
    const opts = Helpers.normalizeOptions(options);
    const taken = new Set<string>(TsClientRuntime.IDENTIFIERS);
    const client = Text.uniqueName(TypeScriptExporter.clientName(model), taken);
    const members = new Set<string>(TsClientRuntime.CLIENT_MEMBERS);
    const methods = new Map(endpoints.map((endpoint) => [endpoint.id, this.#endpoints.methodName(endpoint, members)]));
    const ctx: TsEndpointContext = { model, taken, methods, endpoints, sources: this.#endpoints.tokenSources(endpoints) };
    const codes = endpoints.map((endpoint) => this.#endpoints.write(endpoint, ctx));
    const primary = model.primaryOrigin || endpoints[0]?.origin || '';
    const base = primary === '' ? (opts.baseUrl ?? '') : Helpers.originBase(model, primary, opts);
    const parts = [
      `// Generated by ${Meta.APP_NAME} ${Meta.appVersion()} (${Text.plural(endpoints.length, 'endpoint')}). Do not edit by hand.`,
      TsClientRuntime.source(),
      [
        `const PRIMARY_ORIGIN = ${Text.jsString(primary)};`,
        `const DEFAULT_BASE_URL = ${Text.jsString(base)};`,
        `const REGISTRABLE_DOMAINS: Record<string, string> = ${this.#literals.write(TypeScriptExporter.sites(model, endpoints, opts))};`,
        `const SINGLE_BYTE_INDEXES: Record<string, string> = ${this.#literals.write(TypeScriptExporter.indexes(endpoints))};`,
        `const NAMED_REFERENCES: readonly string[] = ${this.#literals.write(NamedReferences.DATA)};`,
      ].join('\n'),
      ...codes.flatMap((code) => code.declarations),
      ...codes.map((code) => code.spec),
      ...codes.flatMap((code) => (code.validator === undefined ? [] : [code.validator])),
      [
        `export class ${client} extends BaseApiClient {`,
        '  constructor(options: ClientOptions = {}) {',
        '    super(options, PRIMARY_ORIGIN, DEFAULT_BASE_URL);',
        '  }',
        ...codes.flatMap((code) => ['', code.member]),
        '}',
      ].join('\n'),
    ];
    return Text.escapeControls(parts.join('\n\n') + '\n', TypeScriptExporter.LITERAL_CONTROLS);
  }

  protected render(model: ApiModel, endpoints: Endpoint[], options: ExportOptions): string {
    return this.source(model, endpoints, options);
  }

  protected override filename(model: ApiModel): string {
    return TypeScriptExporter.fileName(model);
  }
}
