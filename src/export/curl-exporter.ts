import type { ApiModel, Endpoint } from '../model/index.js';
import { Curl, EndpointIndex, Meta, SampleText, Samples, ShellScript, Text } from '../shared/index.js';
import { BaseExporter } from './exporter.js';
import type { ExportFormat, ExportOptions } from './exporter.js';
import { Helpers } from './helpers.js';

export interface CurlPathArgument {
  readonly name: string;
  readonly variable: string;
  readonly fallback: string;
}

export class CurlExporter extends BaseExporter {
  static readonly BASE_NAME = 'base_url';
  static readonly COOKIE_NAME = 'cookie';
  static readonly ALIAS_SUFFIX = '_value';
  static readonly COOKIE_HELPER = 'appii_cookie';
  static readonly VALUE_LOCAL = 'appii_value';
  static readonly DEFAULT_PREFIX = 'appii_default_';
  static readonly FUNCTION_SUFFIX = 'Endpoint';
  static readonly REDACTED_VALUE: RegExp = /^(?:<redacted>|[\s\S]{4}\.\.\.)$/;
  static readonly RESERVED_FUNCTIONS: ReadonlySet<string> = new Set([
    'list', 'usage', 'main', 'help', 'appii_cookie', 'appii_pct', 'appii_json', 'curl', 'cat', 'printf', 'od', 'bash', 'sh', 'alias', 'bg',
    'bind', 'break', 'builtin', 'caller', 'case', 'cd', 'command', 'compgen', 'complete', 'compopt', 'continue', 'coproc', 'declare',
    'dirs', 'disown', 'do', 'done', 'echo', 'elif', 'else', 'enable', 'esac', 'eval', 'exec', 'exit', 'export', 'false', 'fc', 'fg',
    'fi', 'for', 'function', 'getopts', 'hash', 'history', 'if', 'in', 'jobs', 'kill', 'let', 'local', 'logout', 'mapfile', 'popd',
    'pushd', 'pwd', 'read', 'readarray', 'readonly', 'return', 'select', 'set', 'shift', 'shopt', 'source', 'suspend', 'test', 'then',
    'time', 'times', 'trap', 'true', 'type', 'typeset', 'ulimit', 'umask', 'unalias', 'unset', 'until', 'wait', 'while',
  ]);
  static readonly USAGE = 'Usage: bash endpoints.sh [ENDPOINT [PATH_VALUES...] [CURL_ARGS...]]';

  readonly format: ExportFormat = 'curl';
  readonly extension = 'sh';
  readonly mimeType = 'application/x-sh';
  readonly description = 'Bash script with one curl function per endpoint, a list command and a dispatcher';

  functionNames(endpoints: readonly Endpoint[]): Map<Endpoint, string> {
    const taken = new Set<string>(CurlExporter.RESERVED_FUNCTIONS);
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
      if (CurlExporter.REDACTED_VALUE.test(cookie.valueExample) || Samples.isRedacted(cookie.valueExample)) continue;
      pairs.set(cookie.name, cookie.valueExample);
    }
    return [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  sample(endpoint: Endpoint, origin: string, rename: (name: string) => string): Samples.RequestSample {
    const site = Samples.renamePlaceholders(Samples.requestSample(endpoint, { baseUrl: '', cookie: false, pathVariables: true }), rename);
    const base = SampleText.placeholder(origin);
    return { ...site, base, url: SampleText.concat(base, site.url), cookie: SampleText.placeholder(CurlExporter.COOKIE_NAME) };
  }

  pathArguments(sample: Samples.RequestSample, rename: (name: string) => string): CurlPathArgument[] {
    return sample.pathParams.map((param) => {
      const placeholder = rename(SampleText.placeholderName(param.name));
      return { name: placeholder.toUpperCase(), variable: Curl.variableName(placeholder), fallback: param.value.isLiteral ? param.value.toString() : '' };
    });
  }

  script(model: ApiModel, endpoints: Endpoint[], options: ExportOptions = {}): string {
    const opts = Helpers.normalizeOptions(options);
    const index = EndpointIndex.of(model);
    const origins = this.originVariables(model, endpoints);
    const reserved = new Set<string>([...origins.values(), CurlExporter.COOKIE_NAME]);
    const rename = CurlExporter.#renamer(reserved);
    const names = this.functionNames(endpoints);
    const functions: string[] = [];
    const globals = new Set<string>();
    const argumentsOf = new Map<Endpoint, CurlPathArgument[]>();
    for (const endpoint of endpoints) {
      const sample = this.sample(endpoint, origins.get(endpoint.origin) ?? CurlExporter.BASE_NAME, rename);
      const args = this.pathArguments(sample, rename);
      argumentsOf.set(endpoint, args);
      const locals = new Set(args.map((arg) => arg.variable));
      for (const variable of Curl.placeholderNames(sample)) if (!locals.has(variable) && ![...reserved].some((name) => Curl.variableName(name) === variable)) globals.add(variable);
      functions.push(this.#function(endpoint, names.get(endpoint) ?? endpoint.name, sample, args, rename));
    }
    const lines: string[] = [
      '#!/usr/bin/env bash',
      `# ${Text.printable(Helpers.title(model, opts))}: ${Text.plural(endpoints.length, 'endpoint')}, generated by ${Meta.APP_NAME} ${Meta.appVersion()}.`,
      `# ${CurlExporter.USAGE}  (run without arguments to list the endpoints)`,
      'set -euo pipefail',
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
    for (const variable of [...globals].sort()) lines.push(`: "\${${variable}:=}"`);
    lines.push('', ...CurlExporter.#cookieHelper(), '', ...Curl.HELPER_FUNCTIONS, '');
    for (const fn of functions) lines.push(fn, '');
    lines.push(...this.#list(model, endpoints, index, names, argumentsOf), '');
    lines.push(...CurlExporter.#usage(), '');
    lines.push(...this.#main(endpoints, index, names), '');
    lines.push('if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then', '  main "$@"', 'fi');
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

  #function(endpoint: Endpoint, name: string, sample: Samples.RequestSample, args: readonly CurlPathArgument[], rename: (name: string) => string): string {
    const lines = [`${name}() {`];
    if (args.length > 0) lines.push(`  local ${CurlExporter.VALUE_LOCAL}`);
    for (const arg of args) {
      const value = CurlExporter.VALUE_LOCAL;
      lines.push(`  ${value}=${Text.shellQuote(arg.fallback)}`);
      lines.push(`  [[ -z "\${${arg.variable}:-}" ]] || ${value}="$${arg.variable}"`);
      lines.push(`  if [[ $# -gt 0 && "$1" != -* ]]; then ${value}="$1"; shift; fi`);
      if (arg.fallback === '') {
        const message = `${name}: no value for ${arg.name}. Give it as an argument or set ${arg.variable}.`;
        lines.push(`  if [[ -z "$${value}" ]]; then printf '%s\\n' ${Text.shellQuote(message)} >&2; return 2; fi`);
      }
      lines.push(`  local ${arg.variable}="$${value}"`);
    }
    const placeholders = Curl.placeholderNames(sample);
    const linked = new Set<string>();
    for (const token of endpoint.auth.csrf) {
      if (token.source !== 'cookie' || !token.sourceName) continue;
      const variable = Curl.variableName(rename(SampleText.placeholderName(token.sourceName)));
      if (!placeholders.includes(variable) || linked.has(variable)) continue;
      linked.add(variable);
      lines.push(`  local ${variable}="\${${variable}:-$(${CurlExporter.COOKIE_HELPER} ${Text.shellQuote(token.sourceName)})}"`);
    }
    const command = Curl.curlCommand(sample, { variables: 'script', extraArgs: ['"$@"'] });
    lines.push(ShellScript.indent(command, 2), '}');
    return ShellScript.ascii(lines.join('\n'));
  }

  #list(model: ApiModel, endpoints: readonly Endpoint[], index: EndpointIndex, names: ReadonlyMap<Endpoint, string>, args: ReadonlyMap<Endpoint, readonly CurlPathArgument[]>): string[] {
    const rows = endpoints.map((endpoint) => [
      String(index.numberOf(endpoint)),
      endpoint.method,
      Text.printable(endpoint.origin === model.primaryOrigin ? endpoint.path : endpoint.origin + endpoint.path),
      names.get(endpoint) ?? endpoint.name,
      (args.get(endpoint) ?? []).map((arg) => `[${arg.name}]`).join(' '),
    ]);
    const header = ['#', 'METHOD', 'PATH', 'FUNCTION', 'ARGUMENTS'];
    const widths = header.map((title, i) => Math.max(title.length, ...rows.map((row) => (row[i] ?? '').length)));
    const format = (row: string[]): string =>
      row
        .map((cell, i) => (i === 0 ? cell.padStart(widths[0] ?? 0) : i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0)))
        .join('  ')
        .trimEnd();
    return ['list() {', "  cat <<'APPII_LIST'", format(header), ...rows.map(format), 'APPII_LIST', '}'];
  }

  #main(endpoints: readonly Endpoint[], index: EndpointIndex, names: ReadonlyMap<Endpoint, string>): string[] {
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
    for (const endpoint of endpoints) {
      const name = names.get(endpoint) ?? endpoint.name;
      lines.push(`    ${name}|${index.numberOf(endpoint)}) ${name} "$@" ;;`);
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

  static #cookieHelper(): string[] {
    return [
      `${CurlExporter.COOKIE_HELPER}() {`,
      '  local wanted="$1" pair name',
      '  local -a pairs=()',
      `  IFS=';' read -r -a pairs <<< "$${Curl.variableName(CurlExporter.COOKIE_NAME)}" || true`,
      '  for pair in "${pairs[@]+"${pairs[@]}"}"; do',
      '    pair="${pair#"${pair%%[![:space:]]*}"}"',
      '    name="${pair%%=*}"',
      '    if [[ "$pair" == *=* && "$name" == "$wanted" ]]; then',
      "      printf '%s' \"${pair#*=}\"",
      '      return 0',
      '    fi',
      '  done',
      '  return 0',
      '}',
    ];
  }

  static #usage(): string[] {
    return [
      'usage() {',
      "  cat <<'APPII_USAGE'",
      CurlExporter.USAGE,
      '',
      'ENDPOINT is a function name or an endpoint number from the list. The list',
      'shows the path parameters of each endpoint in the ARGUMENTS column. Give',
      'their values in this order after ENDPOINT. If you do not give a value, the',
      'script uses the APPII_<NAME> variable or the captured example. A value that',
      "starts with '-' must go in the variable. All other arguments go to curl",
      '(for example -i or -v).',
      '',
      'Environment:',
      `  ${Curl.variableName(CurlExporter.BASE_NAME)}   base URL of the API (default: the captured origin)`,
      `  ${Curl.variableName(CurlExporter.COOKIE_NAME)}     Cookie header value sent with every request`,
      '  APPII_<NAME>     value of the placeholder or path parameter NAME, for',
      '                   example a CSRF token',
      '',
      'The script can also be sourced to call the endpoint functions directly.',
      'APPII_USAGE',
      '}',
    ];
  }
}
