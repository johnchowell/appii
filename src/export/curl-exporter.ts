import type { ApiModel, CsrfToken, Endpoint } from '../model/index.js';
import { CharsetEncoder, Credentials, Curl, EndpointIndex, Http, Meta, RequestBodies, SampleText, Samples, ShellScript, Text } from '../shared/index.js';
import { CurlSessionScript } from './curl-session-script.js';
import { BaseExporter } from './exporter.js';
import type { ExportFormat, ExportOptions } from './exporter.js';
import { Helpers } from './helpers.js';
import { LoginGuide } from './login-guide.js';

export interface CurlPathArgument {
  readonly name: string;
  readonly variable: string;
  readonly fallback: string;
}

export interface CurlQueryArgument {
  readonly name: string;
  readonly key: string;
  readonly word: string;
  readonly variable: string;
  readonly fallback?: SampleText;
}

export interface CurlBodyArgument {
  readonly name: string;
  readonly word: string;
  readonly variable: string;
  readonly fallback: SampleText;
  readonly raw: boolean;
}

export interface CurlFileArgument {
  readonly name: string;
  readonly variable: string;
  readonly fallback: string;
}

export interface CurlArguments {
  readonly path: readonly CurlPathArgument[];
  readonly query: readonly CurlQueryArgument[];
  readonly body: readonly CurlBodyArgument[];
  readonly files: readonly CurlFileArgument[];
}

export interface CurlBodyField {
  readonly name: string;
  readonly value: SampleText;
  readonly raw: boolean;
}

export type CurlValueArgument = CurlQueryArgument | CurlBodyArgument;

export interface CurlTarget {
  readonly endpoint: Endpoint;
  readonly source: Endpoint;
  readonly mediaType?: string;
}

export interface CurlFunctionContext {
  readonly model: ApiModel;
  readonly origins: ReadonlyMap<string, string>;
  readonly guide: LoginGuide;
  readonly functions: ReadonlyMap<string, string>;
  readonly rename: (name: string) => string;
}

export class CurlExporter extends BaseExporter {
  static readonly BASE_NAME = 'base_url';
  static readonly COOKIE_NAME = 'cookie';
  static readonly QUERY_NAME = 'query_string';
  static readonly QUERY_LOCAL = 'appii_query';
  static readonly ALIAS_SUFFIX = '_value';
  static readonly COOKIE_HELPER = CurlSessionScript.COOKIE_HELPER;
  static readonly JAR_WORD = `"$${CurlSessionScript.JAR_VARIABLE}"`;
  static readonly VALUE_LOCAL = 'appii_value';
  static readonly DEFAULT_PREFIX = 'appii_default_';
  static readonly FUNCTION_SUFFIX = 'Endpoint';
  static readonly VARIANT_SUFFIX = 'Body';
  static readonly QUERY_WORD_PREFIX = 'query.';
  static readonly BODY_WORD_PREFIX = 'body.';
  static readonly ARGUMENT_BODY_KINDS: ReadonlySet<string> = new Set(['form', 'multipart']);
  static readonly JSON_BODY_KIND = 'json';
  static readonly MULTIPART_KIND = 'multipart';
  static readonly FILE_SUFFIX = ' file';
  static readonly RESERVED_FUNCTIONS: ReadonlySet<string> = new Set([
    'list', 'usage', 'main', 'help', ...CurlSessionScript.HELPERS, 'appii_pct', 'appii_json', 'appii_form', 'appii_curl_args', 'curl', 'cat', 'printf', 'od', 'awk', 'pwd', 'bash', 'sh', 'alias', 'bg',
    'bind', 'break', 'builtin', 'caller', 'case', 'cd', 'command', 'compgen', 'complete', 'compopt', 'continue', 'coproc', 'declare',
    'dirs', 'disown', 'do', 'done', 'echo', 'elif', 'else', 'enable', 'esac', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg',
    'fi', 'for', 'function', 'getopts', 'hash', 'history', 'if', 'in', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd',
    'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'select', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'then',
    'time', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'until', 'wait', 'while',
  ]);
  static readonly USAGE = 'Usage: bash endpoints.sh [ENDPOINT [PATH_VALUES...] [NAME=VALUE...] [CURL_ARGS...]]';
  static readonly ASSIGNABLE_NAME: RegExp = /^[^=\s-][^=\s]*$/;

  readonly format: ExportFormat = 'curl';
  readonly extension = 'sh';
  readonly mimeType = 'application/x-sh';
  readonly description = 'Bash script with one curl function per endpoint, a list command and a dispatcher';

  static targets(endpoints: readonly Endpoint[]): CurlTarget[] {
    return endpoints.flatMap((endpoint): CurlTarget[] => [
      { endpoint, source: endpoint },
      ...RequestBodies.variants(endpoint).map((variant) => ({ endpoint: variant.endpoint, source: endpoint, mediaType: variant.mediaType })),
    ]);
  }

  functionNames(endpoints: readonly Endpoint[]): Map<Endpoint, string> {
    return CurlExporter.#functionNames(endpoints, new Set<string>(CurlExporter.RESERVED_FUNCTIONS));
  }

  targetNames(targets: readonly CurlTarget[]): Map<CurlTarget, string> {
    const taken = new Set<string>(CurlExporter.RESERVED_FUNCTIONS);
    const primary = CurlExporter.#functionNames(targets.filter((target) => target.mediaType === undefined).map((target) => target.endpoint), taken);
    return new Map(
      targets.map((target): [CurlTarget, string] => {
        const base = primary.get(target.source) ?? target.source.name;
        if (target.mediaType === undefined) return [target, base];
        return [target, Text.uniqueName(base + (Text.pascalCase(target.endpoint.requestBody?.kind ?? '') || CurlExporter.VARIANT_SUFFIX), taken, '_')];
      }),
    );
  }

  static #functionNames(endpoints: readonly Endpoint[], taken: Set<string>): Map<Endpoint, string> {
    const out = new Map<Endpoint, string>();
    for (const endpoint of endpoints) {
      let base = endpoint.name.replace(/[^A-Za-z0-9_]/g, '_');
      if (base === '' || /^[0-9]/.test(base)) base = `endpoint_${base}`;
      if (CurlExporter.RESERVED_FUNCTIONS.has(base)) base += CurlExporter.FUNCTION_SUFFIX;
      out.set(endpoint, Text.uniqueName(base, taken, '_'));
    }
    return out;
  }

  originVariables(model: ApiModel, endpoints: readonly Endpoint[]): Map<string, string> {
    const out = new Map<string, string>();
    const taken = new Set<string>([CurlExporter.BASE_NAME, CurlExporter.COOKIE_NAME]);
    Helpers.origins(model, endpoints).forEach((origin, i) => {
      if (i === 0) {
        out.set(origin, CurlExporter.BASE_NAME);
        return;
      }
      let host = origin;
      try {
        host = new URL(origin).host;
      } catch {
        host = origin;
      }
      out.set(origin, Text.uniqueName(SampleText.placeholderName(`${CurlExporter.BASE_NAME} ${host}`), taken, '_'));
    });
    return out;
  }

  defaultCookie(model: ApiModel, endpoints: readonly Endpoint[]): string {
    const pairs = new Map<string, string>();
    for (const cookie of EndpointIndex.subset(model, endpoints).cookies) {
      if (pairs.has(cookie.name) || cookie.name === '') continue;
      if (Text.isMasked(cookie.valueExample) || Samples.isRedacted(cookie.valueExample)) continue;
      pairs.set(cookie.name, cookie.valueExample);
    }
    return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  sample(endpoint: Endpoint, origin: string, rename: (name: string) => string): Samples.RequestSample {
    const site = Samples.renamePlaceholders(Samples.requestSample(endpoint, { baseUrl: '', cookie: false, pathVariables: true }), rename);
    const base = SampleText.placeholder(origin);
    const target = CurlExporter.queryVariables(endpoint, site) ? SampleText.concat(site.path, SampleText.placeholder(CurlExporter.QUERY_NAME)) : site.url;
    return { ...site, base, url: SampleText.concat(base, target), cookie: SampleText.placeholder(CurlExporter.COOKIE_NAME) };
  }

  static queryVariables(endpoint: Endpoint, sample: Samples.RequestSample): boolean {
    if (sample.query.length === 0 && endpoint.queryParams.length === 0) return false;
    const submission = Samples.formSubmission(endpoint);
    return submission?.method !== 'GET' || CharsetEncoder.for(submission.form.charset).utf8;
  }

  pathArguments(sample: Samples.RequestSample, rename: (name: string) => string): CurlPathArgument[] {
    return sample.pathParams.map((param) => {
      const placeholder = rename(SampleText.placeholderName(param.name));
      return { name: placeholder.toUpperCase(), variable: Curl.variableName(placeholder), fallback: param.value.isLiteral ? param.value.toString() : '' };
    });
  }

  queryArguments(endpoint: Endpoint, sample: Samples.RequestSample, rename: (name: string) => string, path: readonly CurlPathArgument[] = []): CurlQueryArgument[] {
    if (!CurlExporter.queryVariables(endpoint, sample)) return [];
    const component = Samples.queryComponent(Samples.formSubmission(endpoint));
    const taken = new Set<string>(path.map((arg) => arg.variable));
    const out: CurlQueryArgument[] = [];
    const add = (name: string, fallback: SampleText | undefined): void => {
      if (out.some((arg) => arg.name === name)) return;
      const variable = Text.uniqueName(Curl.variableName(rename(SampleText.placeholderName(name))), taken, '_');
      out.push(fallback === undefined ? { name, key: component(name), word: name, variable } : { name, key: component(name), word: name, variable, fallback });
    };
    for (const entry of sample.query) add(entry.name, entry.value);
    for (const param of endpoint.queryParams) add(param.name, undefined);
    return out;
  }

  static bodyFields(body: Samples.SampleBody | undefined): CurlBodyField[] {
    if (!body || !Samples.isRecord(body.value) || !CharsetEncoder.for(body.charset).utf8 || Curl.rawBody(body) !== undefined) return [];
    const storable = (value: SampleText): boolean => value.parts.every((part) => part.kind === 'placeholder' || !part.text.includes(Curl.NUL));
    if (CurlExporter.ARGUMENT_BODY_KINDS.has(body.kind)) {
      const entries = Samples.formEntries(body.value);
      const count = (name: string): number => entries.filter((entry) => entry.name === name).length;
      return entries.filter((entry) => !entry.file && count(entry.name) === 1 && storable(entry.value)).map((entry) => ({ name: entry.name, value: entry.value, raw: false }));
    }
    if (body.kind !== CurlExporter.JSON_BODY_KIND) return [];
    return Object.entries(body.value).flatMap(([name, item]): CurlBodyField[] => {
      if (item instanceof SampleText) return storable(item) ? [{ name, value: item, raw: false }] : [];
      if (item === null || typeof item === 'number' || typeof item === 'boolean') return [{ name, value: SampleText.literal(JSON.stringify(item)), raw: true }];
      return [];
    });
  }

  bodyArguments(sample: Samples.RequestSample, rename: (name: string) => string, taken: Iterable<string> = []): CurlBodyArgument[] {
    const fields = CurlExporter.bodyFields(sample.body);
    if (fields.length === 0) return [];
    const used = new Set<string>(taken);
    const outside = [sample.url, ...sample.headers.map((header) => header.value), ...(sample.cookie ? [sample.cookie] : []), ...(sample.user ? [sample.user] : [])];
    for (const text of [...outside, ...fields.map((field) => field.value)]) for (const name of text.placeholders()) used.add(Curl.variableName(name));
    return fields.map((field) => {
      const wanted = Curl.variableName(rename(SampleText.placeholderName(field.name)));
      const variable = CurlExporter.#ownVariable(field.value) === wanted ? wanted : Text.uniqueName(wanted, used, '_');
      return { name: field.name, word: field.name, variable, fallback: field.value, raw: field.raw };
    });
  }

  static withBody(sample: Samples.RequestSample, args: readonly CurlBodyArgument[]): Samples.RequestSample {
    const body = sample.body;
    if (!body || !Samples.isRecord(body.value) || args.length === 0) return sample;
    const byName = new Map(args.map((arg) => [arg.name, arg]));
    const reference = (arg: CurlBodyArgument): SampleText => SampleText.placeholder(arg.variable.slice(Curl.VARIABLE_PREFIX.length).toLowerCase());
    if (body.kind === CurlExporter.JSON_BODY_KIND) {
      const members = Object.entries(body.value).map(([name, item]) => {
        const arg = byName.get(name);
        const value = arg === undefined ? Samples.jsonText(item) : arg.raw ? reference(arg) : Samples.jsonText(reference(arg));
        return SampleText.concat(Samples.jsonText(SampleText.literal(name)), ':', value);
      });
      return { ...sample, body: { ...body, value: SampleText.concat('{', SampleText.join(members, ','), '}') } };
    }
    const value = Object.fromEntries(Object.entries(body.value).map(([name, item]) => {
      const arg = byName.get(name);
      return [name, arg === undefined ? item : reference(arg)];
    }));
    return { ...sample, body: { ...body, value } };
  }

  arguments(endpoint: Endpoint, sample: Samples.RequestSample, rename: (name: string) => string): CurlArguments {
    const path = this.pathArguments(sample, rename);
    const query = this.queryArguments(endpoint, sample, rename, path);
    const body = this.bodyArguments(sample, rename, [...path, ...query].map((arg) => arg.variable));
    const files = this.fileArguments(sample, rename, [...path, ...query, ...body].map((arg) => arg.variable));
    const shared = new Set(query.filter((arg) => body.some((field) => field.name === arg.name)).map((arg) => arg.name));
    return {
      path,
      query: query.map((arg) => (shared.has(arg.name) ? { ...arg, word: CurlExporter.QUERY_WORD_PREFIX + arg.name } : arg)),
      body: body.map((arg) => (shared.has(arg.name) ? { ...arg, word: CurlExporter.BODY_WORD_PREFIX + arg.name } : arg)),
      files,
    };
  }

  static #uploads(body: Samples.SampleBody | undefined): boolean {
    return body !== undefined && body.kind === CurlExporter.MULTIPART_KIND && Samples.isRecord(body.value) && Curl.rawBody(body) === undefined;
  }

  static #upload(value: Samples.SampleValue): value is Samples.SampleRecord & { readonly filename: SampleText } {
    return Samples.isFileValue(value) && value.filename.isLiteral && value.filename.toString() !== '';
  }

  fileArguments(sample: Samples.RequestSample, rename: (name: string) => string, taken: Iterable<string> = []): CurlFileArgument[] {
    const body = sample.body;
    if (!CurlExporter.#uploads(body) || !Samples.isRecord(body?.value)) return [];
    const used = new Set<string>(taken);
    for (const name of Samples.placeholderNames(sample)) used.add(Curl.variableName(name));
    const out: CurlFileArgument[] = [];
    for (const [name, item] of Object.entries(body.value)) {
      for (const each of Array.isArray(item) ? (item as readonly Samples.SampleValue[]) : [item]) {
        if (!CurlExporter.#upload(each)) continue;
        const variable = Text.uniqueName(Curl.variableName(rename(SampleText.placeholderName(`${name}${CurlExporter.FILE_SUFFIX}`))), used, '_');
        out.push({ name, variable, fallback: Curl.uploadName(each.filename.toString()) });
      }
    }
    return out;
  }

  static withFiles(sample: Samples.RequestSample, files: readonly CurlFileArgument[]): Samples.RequestSample {
    const body = sample.body;
    if (files.length === 0 || !CurlExporter.#uploads(body) || !body || !Samples.isRecord(body.value)) return sample;
    let next = 0;
    const swap = (item: Samples.SampleValue): Samples.SampleValue => {
      if (!CurlExporter.#upload(item)) return item;
      const file = files[next++];
      return file === undefined ? item : { ...item, filename: SampleText.placeholder(file.variable.slice(Curl.VARIABLE_PREFIX.length).toLowerCase()) };
    };
    const value = Object.fromEntries(Object.entries(body.value).map(([name, item]) => [name, Array.isArray(item) ? (item as readonly Samples.SampleValue[]).map(swap) : swap(item)]));
    return { ...sample, body: { ...body, value } };
  }

  script(model: ApiModel, endpoints: Endpoint[], options: ExportOptions = {}): string {
    const opts = Helpers.normalizeOptions(options);
    const index = EndpointIndex.of(model);
    const origins = this.originVariables(model, endpoints);
    const reserved = new Set<string>([...origins.values(), CurlExporter.COOKIE_NAME, CurlExporter.QUERY_NAME]);
    const rename = CurlExporter.#renamer(reserved);
    const targets = CurlExporter.targets(endpoints);
    const names = this.targetNames(targets);
    const functionNames = new Map(targets.flatMap((target): [string, string][] => (target.mediaType === undefined ? [[target.endpoint.id, names.get(target) ?? target.endpoint.name]] : [])));
    const context: CurlFunctionContext = { model, origins, guide: new LoginGuide(model), functions: functionNames, rename };
    const functions: string[] = [];
    const globals = new Set<string>();
    const argumentsOf = new Map<CurlTarget, CurlArguments>();
    for (const target of targets) {
      const endpoint = target.endpoint;
      const base = this.sample(endpoint, origins.get(endpoint.origin) ?? CurlExporter.BASE_NAME, rename);
      const args = this.arguments(endpoint, base, rename);
      const sample = CurlExporter.withFiles(CurlExporter.withBody(base, args.body), args.files);
      argumentsOf.set(target, args);
      const locals = new Set([...args.path, ...args.query, ...args.body, ...args.files].map((arg) => arg.variable));
      for (const variable of Curl.placeholderNames(sample, CurlExporter.#fallbacks(args))) {
        if (!locals.has(variable) && ![...reserved].some((name) => Curl.variableName(name) === variable)) globals.add(variable);
      }
      functions.push(this.#function(target, names.get(target) ?? endpoint.name, sample, args, context));
    }
    const lines: string[] = [
      '#!/usr/bin/env bash',
      `# ${Text.printable(Helpers.title(model, opts))}: ${Text.plural(endpoints.length, 'endpoint')}, generated by ${Meta.APP_NAME} ${Meta.appVersion()}.`,
      `# ${CurlExporter.USAGE}  (run without arguments to list the endpoints)`,
      '',
    ];
    for (const [origin, name] of origins) {
      const variable = Curl.variableName(name);
      lines.push(ShellScript.ascii(`${CurlExporter.DEFAULT_PREFIX}${name}=${Text.shellQuote(Helpers.originBase(model, origin, opts))}`));
      lines.push(`${variable}="\${${variable}:-$${CurlExporter.DEFAULT_PREFIX}${name}}"`);
    }
    if (origins.size === 0) lines.push(`${Curl.variableName(CurlExporter.BASE_NAME)}="\${${Curl.variableName(CurlExporter.BASE_NAME)}:-}"`);
    const cookie = Curl.variableName(CurlExporter.COOKIE_NAME);
    lines.push(ShellScript.ascii(`${CurlExporter.DEFAULT_PREFIX}${CurlExporter.COOKIE_NAME}=${Text.shellQuote(this.defaultCookie(model, endpoints))}`));
    lines.push(`${cookie}="\${${cookie}-$${CurlExporter.DEFAULT_PREFIX}${CurlExporter.COOKIE_NAME}}"`);
    lines.push(...CurlSessionScript.jarLines(model));
    for (const variable of [...globals].sort()) lines.push(`: "\${${variable}:=}"`);
    lines.push('', ...CurlSessionScript.helpers(cookie), '', ...Curl.HELPER_FUNCTIONS, '');
    for (const fn of functions) lines.push(fn, '');
    lines.push(...this.#list(model, targets, index, names, argumentsOf), '');
    lines.push(...CurlExporter.#usage(CurlSessionScript.jarFile(model)), '');
    lines.push(...this.#main(targets, index, names), '');
    lines.push('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then', '  set -euo pipefail', '  main "$@"', 'fi');
    return lines.join('\n') + '\n';
  }

  protected render(model: ApiModel, endpoints: Endpoint[], options: ExportOptions): string {
    return this.script(model, endpoints, options);
  }

  protected override filename(_model: ApiModel): string {
    return 'endpoints.sh';
  }

  static #renamer(reserved: ReadonlySet<string>): (name: string) => string {
    const aliases = new Map<string, string>();
    const taken = new Set<string>(reserved);
    return (name: string): string => {
      if (!reserved.has(name)) return name;
      const known = aliases.get(name);
      if (known !== undefined) return known;
      const alias = Text.uniqueName(name + CurlExporter.ALIAS_SUFFIX, taken, '_');
      aliases.set(name, alias);
      return alias;
    };
  }

  #function(target: CurlTarget, name: string, sample: Samples.RequestSample, args: CurlArguments, ctx: CurlFunctionContext): string {
    const endpoint = target.endpoint;
    const rename = ctx.rename;
    const value = CurlExporter.VALUE_LOCAL;
    const variable = (placeholder: string): string => (placeholder === CurlExporter.QUERY_NAME ? CurlExporter.QUERY_LOCAL : Curl.variableName(placeholder));
    const values: CurlValueArgument[] = [...args.query, ...args.body];
    const assignable = values.filter((arg) => CurlExporter.ASSIGNABLE_NAME.test(arg.word));
    const patterns = assignable.map((arg) => `${Curl.shellWord(arg.word)}=*`);
    const refusals = Credentials.refusals(endpoint);
    const lines = refusals.length === 0 ? [] : [`# ${name}: without credentials the server answered ${refusals.join(' and ')}; the credential it expects was not captured. Add it as a curl argument (-H or -b).`];
    lines.push(...this.#roleComments(target, name, args, ctx));
    lines.push(`${name}() {`);
    if (args.path.length > 0 || args.files.length > 0 || values.some((arg) => CurlExporter.#ownDefault(arg))) lines.push(`  local ${value}`);
    for (const arg of args.path) {
      lines.push(`  ${value}=${Text.shellQuote(arg.fallback)}`);
      lines.push(`  [[ -z "\${${arg.variable}:-}" ]] || ${value}="$${arg.variable}"`);
      if (patterns.length === 0) lines.push(`  if [[ $# -gt 0 && "$1" != -* ]]; then ${value}="$1"; shift; fi`);
      else lines.push(`  if [[ $# -gt 0 ]]; then case "$1" in -*|${patterns.join('|')}) ;; *) ${value}="$1"; shift ;; esac; fi`);
      if (arg.fallback === '') {
        const message = `${name}: no value for ${arg.name}. Give it as an argument or set ${arg.variable}.`;
        lines.push(`  if [[ -z "$${value}" ]]; then printf '%s\\n' ${Text.shellQuote(message)} >&2; return 2; fi`);
      }
      lines.push(`  local ${arg.variable}="$${value}"`);
    }
    const placeholders = Curl.placeholderNames(sample, CurlExporter.#fallbacks(args));
    const linked = new Set<string>();
    for (const token of endpoint.auth.csrf) {
      if (token.source !== 'cookie' || !token.sourceName) continue;
      const linkedVariable = Curl.variableName(rename(SampleText.placeholderName(token.sourceName)));
      if (!placeholders.includes(linkedVariable) || linked.has(linkedVariable)) continue;
      linked.add(linkedVariable);
      lines.push(`  local ${linkedVariable}="\${${linkedVariable}:-$(${CurlSessionScript.DECODE_HELPER} "$(${CurlExporter.COOKIE_HELPER} ${Text.shellQuote(token.sourceName)})")}"`);
    }
    for (const arg of values) {
      if (!CurlExporter.#ownDefault(arg) || arg.fallback === undefined) {
        lines.push(`  local ${arg.variable}="\${${arg.variable}:-}"`);
        continue;
      }
      lines.push(`  ${value}=${Curl.shellArg(arg.fallback, 'shell', variable)}`);
      lines.push(`  [[ -z "\${${arg.variable}:-}" ]] || ${value}="$${arg.variable}"`);
      lines.push(`  local ${arg.variable}="$${value}"`);
    }
    for (const file of args.files) {
      lines.push(`  ${value}=${Text.shellQuote(file.fallback)}`);
      lines.push(`  [[ -z "\${${file.variable}:-}" ]] || ${value}="$${file.variable}"`);
      lines.push(`  local ${file.variable}="$${value}"`);
    }
    if (assignable.length > 0) {
      lines.push('  while [[ $# -gt 0 ]]; do', '    case "$1" in');
      assignable.forEach((arg, i) => lines.push(`      ${patterns[i] ?? ''}) ${arg.variable}="\${1#*=}" ;;`));
      lines.push('      *) break ;;', '    esac', '    shift', '  done');
    }
    lines.push(`  ${Curl.ARGUMENT_HELPER} ${Text.shellQuote(name)} ${Text.shellQuote(CurlExporter.#hint(args))} "$@" || return 2`);
    lines.push(...CurlExporter.#credentialChecks(name, values));
    lines.push(...this.#tokenLines(endpoint, name, args, placeholders, linked, ctx));
    lines.push(`  ${CurlSessionScript.JAR_HELPER} || return 2`);
    if (args.query.length > 0) {
      const local = CurlExporter.QUERY_LOCAL;
      lines.push(`  local ${local}=''`);
      for (const arg of args.query) {
        const append = `${local}+=${Text.shellQuote(`&${arg.key}=`)}"$(${Curl.ENCODING_HELPERS.component} ${arg.variable})"`;
        lines.push(arg.fallback === undefined ? `  [[ -z "$${arg.variable}" ]] || ${append}` : `  ${append}`);
      }
      lines.push(`  [[ -z "$${local}" ]] || ${local}="?\${${local}#&}"`);
    }
    const command = Curl.curlCommand(sample, { variables: 'script', variable, extraArgs: ['"$@"'], jar: CurlExporter.JAR_WORD });
    lines.push(ShellScript.indent(command, 2), '}');
    return ShellScript.ascii(lines.join('\n'));
  }

  #roleComments(target: CurlTarget, name: string, args: CurlArguments, ctx: CurlFunctionContext): string[] {
    const endpoint = target.source;
    const plain = (text: string): string => text;
    if (LoginGuide.isLogout(endpoint)) return [`# ${name}: ${ctx.guide.describe(endpoint, plain) ?? 'Logout.'} The cookie jar ${CurlSessionScript.JAR_VARIABLE} keeps the new cookies.`];
    const login = LoginGuide.isLogin(endpoint) ? endpoint.login : undefined;
    if (!login) {
      const hint = ctx.guide.hint(endpoint, (issuer) => ctx.functions.get(issuer.id) ?? issuer.name);
      return hint === undefined ? [] : [`# ${name}: ${hint}`];
    }
    const inputs = [...args.query, ...args.body].filter((arg) => arg.fallback?.requirement !== undefined);
    const lines = [`# ${name}: ${ctx.guide.describe(endpoint, plain) ?? 'Login.'}`];
    if (inputs.length > 0) lines.push(`# Give ${inputs.map((arg) => `${Text.printable(arg.word)}=VALUE`).join(' and ')}, or set ${inputs.map((arg) => arg.variable).join(' and ')}.`);
    lines.push(`# The cookies it sets stay in the cookie jar ${CurlSessionScript.JAR_VARIABLE}, so the functions called after it are logged in.`);
    if (login.issues.tokens.length > 0) lines.push(`# It returns the bearer token in ${login.issues.tokens.join(', ')}: copy it into ${Curl.variableName(Samples.BEARER_TOKEN)} for the functions that need it.`);
    return lines;
  }

  static #credentialChecks(name: string, values: readonly CurlValueArgument[]): string[] {
    return values.flatMap((arg) => {
      const label = arg.fallback?.requirement;
      if (label === undefined) return [];
      const message = `${name}: no value for ${label} (${Text.printable(arg.word)}). Give ${Text.printable(arg.word)}=VALUE or set ${arg.variable}.`;
      return [`  if [[ -z "$${arg.variable}" ]]; then printf '%s\\n' ${Text.shellQuote(message)} >&2; return 2; fi`];
    });
  }

  #tokenLines(endpoint: Endpoint, name: string, args: CurlArguments, placeholders: readonly string[], linked: ReadonlySet<string>, ctx: CurlFunctionContext): string[] {
    const lines: string[] = [];
    const done = new Set<string>();
    for (const token of endpoint.auth.csrf) {
      if (token.source === 'cookie') {
        const variable = token.sourceName ? Curl.variableName(ctx.rename(SampleText.placeholderName(token.sourceName))) : undefined;
        const seed = token.sourceName ? Helpers.tokenSeed(ctx.model, token.sourceName) : undefined;
        if (variable === undefined || seed === undefined || !linked.has(variable) || done.has(variable)) continue;
        done.add(variable);
        lines.push(
          `  if [[ -z "$${variable}" ]]; then`,
          `    ${CurlSessionScript.PAGE_HELPER} ${this.#urlWord(seed, ctx)} > /dev/null || true`,
          `    ${variable}="$(${CurlSessionScript.DECODE_HELPER} "$(${CurlExporter.COOKIE_HELPER} ${Text.shellQuote(token.sourceName ?? '')})")"`,
          '  fi',
        );
        continue;
      }
      const variable = CurlExporter.#tokenVariable(token, args, ctx.rename);
      if (!placeholders.includes(variable) || done.has(variable)) continue;
      done.add(variable);
      if (![...args.query, ...args.body].some((arg) => arg.variable === variable)) lines.push(`  local ${variable}="\${${variable}:-}"`);
      const page = Helpers.tokenPage(token, endpoint);
      const method = EndpointIndex.tokenRequest(token);
      if (method !== undefined || page === undefined || !CurlSessionScript.FETCHED_SOURCES.has(token.source)) {
        const source = EndpointIndex.tokenSource(token, ctx.model.endpoints);
        const call = source === undefined ? undefined : ctx.functions.get(source.id);
        const origin = token.sourceUrl === undefined ? '' : ` comes from the response of ${method ?? 'GET'} ${Text.printable(token.sourceUrl)}${call === undefined ? '' : ` (${call})`};`;
        const message = `${name}: warning: no value for the CSRF token ${Text.printable(token.name)}. It${origin === '' ? ' was not captured;' : origin} set ${variable} to send it.`;
        lines.push(`  [[ -n "$${variable}" ]] || printf '%s\\n' ${Text.shellQuote(message)} >&2`);
        continue;
      }
      const sourceName = token.sourceName ?? token.name;
      const what = token.source === 'hidden-field' ? `the hidden field ${sourceName}` : token.source === 'meta' ? `the meta ${sourceName}` : `${sourceName} in the response`;
      const message = `${name}: warning: GET ${Text.printable(page)} gave no value for the CSRF token ${Text.printable(token.name)} (${Text.printable(what)}). Set ${variable} to send it.`;
      lines.push(
        `  if [[ -z "$${variable}" ]]; then`,
        `    ${variable}="$(${CurlSessionScript.TOKEN_HELPER} ${token.source} ${Text.shellQuote(sourceName)} ${this.#urlWord(page, ctx)})" || ${variable}=''`,
        `    [[ -n "$${variable}" ]] || printf '%s\\n' ${Text.shellQuote(message)} >&2`,
        '  fi',
      );
    }
    return lines;
  }

  static #tokenVariable(token: CsrfToken, args: CurlArguments, rename: (name: string) => string): string {
    const list = token.location === 'body' ? args.body : token.location === 'query' ? args.query : [];
    return list.find((arg) => arg.name === token.name)?.variable ?? Curl.variableName(rename(SampleText.placeholderName(token.name)));
  }

  #urlWord(url: string, ctx: CurlFunctionContext): string {
    const parsed = Http.parseUrl(url);
    const base = parsed === undefined ? undefined : ctx.origins.get(parsed.origin);
    if (parsed === undefined || base === undefined || !url.startsWith(parsed.origin)) return Text.shellQuote(url);
    return Curl.shellArg(SampleText.concat(SampleText.placeholder(base), url.slice(parsed.origin.length)), 'script');
  }

  static #ownVariable(value: SampleText): string | undefined {
    const only = value.parts.length === 1 ? value.parts[0] : undefined;
    return only?.kind === 'placeholder' ? Curl.variableName(only.name) : undefined;
  }

  static #ownDefault(arg: CurlValueArgument): boolean {
    const fallback = arg.fallback;
    return fallback !== undefined && CurlExporter.#ownVariable(fallback) !== arg.variable;
  }

  static #fallbacks(args: CurlArguments): SampleText[] {
    return [...args.query, ...args.body].flatMap((arg) => (arg.fallback === undefined ? [] : [arg.fallback]));
  }

  static #hint(args: CurlArguments): string {
    const words = CurlExporter.#argumentWords(args);
    const takes = words.length === 0 ? 'It takes no arguments' : `Arguments: ${words.join(' ')}`;
    return `${takes}. Arguments for curl start with '-'.`;
  }

  static #argumentWords(args: CurlArguments | undefined): string[] {
    if (!args) return [];
    return [...args.path.map((arg) => `[${arg.name}]`), ...[...args.query, ...args.body].map((arg) => `[${Text.printable(arg.word)}=]`)];
  }

  #list(model: ApiModel, targets: readonly CurlTarget[], index: EndpointIndex, names: ReadonlyMap<CurlTarget, string>, args: ReadonlyMap<CurlTarget, CurlArguments>): string[] {
    const rows = targets.map((target) => {
      const endpoint = target.source;
      const path = Text.printable(endpoint.origin === model.primaryOrigin ? endpoint.path : endpoint.origin + endpoint.path);
      return [
        target.mediaType === undefined ? String(index.numberOf(endpoint)) : '',
        endpoint.method,
        target.mediaType === undefined ? path : `${path} (${Text.printable(target.mediaType)})`,
        names.get(target) ?? endpoint.name,
        CurlExporter.#argumentWords(args.get(target)).join(' '),
      ];
    });
    const header = ['#', 'METHOD', 'PATH', 'FUNCTION', 'ARGUMENTS'];
    const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => (row[i] ?? '').length)));
    const format = (row: string[]): string =>
      row
        .map((cell, i) => (i === 0 ? cell.padStart(widths[0] ?? 0) : i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd();
    return ['list() {', "  cat <<'APPII_LIST'", format(header), ...rows.map(format), 'APPII_LIST', '}'];
  }

  #main(targets: readonly CurlTarget[], index: EndpointIndex, names: ReadonlyMap<CurlTarget, string>): string[] {
    const lines = [
      'main() {',
      '  if [[ $# -eq 0 ]]; then',
      '    list',
      '    return 0',
      '  fi',
      '  local command="$1"',
      '  shift',
      '  case "$command" in',
      '    -h|--help|help) usage ;;',
      '    -l|--list|list) list ;;',
    ];
    for (const target of targets) {
      const name = names.get(target) ?? target.endpoint.name;
      lines.push(target.mediaType === undefined ? `    ${name}|${index.numberOf(target.source)}) ${name} "$@" ;;` : `    ${name}) ${name} "$@" ;;`);
    }
    lines.push(
      "    *)",
      "      printf 'Unknown endpoint: %s\\n\\n' \"$command\" >&2",
      '      list >&2',
      '      return 2',
      '      ;;',
      '  esac',
      '}',
    );
    return lines;
  }

  static #usage(jar: string): string[] {
    return [
      'usage() {',
      "  cat <<'APPII_USAGE'",
      CurlExporter.USAGE,
      '',
      'ENDPOINT is a function name or an endpoint number from the list. The',
      'ARGUMENTS column of the list shows the arguments of each endpoint.',
      '',
      '[NAME] is a path parameter. Give the path values in this order after',
      'ENDPOINT. If you do not give a value, the script uses the APPII_<NAME>',
      'variable or the captured example.',
      '',
      '[name=] is a query parameter or a field of the request body. Give it as',
      'name=value after the path values, or set the APPII_<NAME> variable. The',
      'script sends the query parameters and body fields of the captured request',
      'with their captured values unless you change them, and the other query',
      'parameters only when you give them a value. A query parameter and a body',
      'field with the same name are [query.name=] and [body.name=].',
      '',
      "A path value that starts with '-' or with the name= of a parameter must go",
      "in the variable. Arguments that start with '-' go to curl (for example -i,",
      "-v or -o FILE). The script stops with an error and sends no request for any",
      "other argument, for a bare '--' and for the curl options --url and --next,",
      'which would make curl send another request.',
      '',
      'A file part of a multipart body is read from the path in the',
      'APPII_<FIELD>_FILE variable (default: the captured file name in the',
      'current directory). An endpoint that the site accepted with more than',
      'one body type has one function per type, for example postItemJson.',
      '',
      'Every function reads and writes the cookie jar file, as a browser keeps',
      'its cookies: after the login function, the functions that you call next',
      'send the session cookie that the login set. The login function takes',
      'the user name and the password as name=value arguments or from their',
      'APPII_ variables and stops when one is missing; it never has a default.',
      'A function whose request carries a CSRF token loads the page that holds',
      'the token, with the same cookie jar, unless you give the token. Delete',
      'the cookie jar file to start a new session.',
      '',
      'Environment:',
      `  ${Curl.variableName(CurlExporter.BASE_NAME)}   base URL of the API (default: the captured origin)`,
      `  ${Curl.variableName(CurlExporter.COOKIE_NAME)}     Cookie header value sent with every request`,
      `  ${CurlSessionScript.JAR_VARIABLE} cookie jar file that every function reads and writes`,
      `                   (default: ${jar} in the directory where the`,
      '                   script was started or sourced)',
      '  APPII_<NAME>     value of the placeholder, path parameter, query',
      '                   parameter or body field NAME, for example a CSRF token',
      '',
      'The script can also be sourced to call the endpoint functions directly.',
      'Sourcing does not change the options of your shell, and a function',
      'returns a non-zero status instead of ending the shell.',
      'APPII_USAGE',
      '}',
    ];
  }
}
