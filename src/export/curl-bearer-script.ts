import type { ApiModel, Endpoint } from '../model/index.js';
import { Curl, Samples, SampleText, Text } from '../shared/index.js';
import { CurlSessionScript } from './curl-session-script.js';
import { LoginGuide } from './login-guide.js';

export interface CurlBearerPlan {
  readonly sample: Samples.RequestSample;
  readonly header?: Samples.SampleEntry;
}

export class CurlBearerScript {
  static readonly FILE_VARIABLE = 'APPII_TOKEN_FILE';
  static readonly FILE_DEFAULT = 'appii_default_token_file';
  static readonly FILE_SUFFIX = '-token.txt';
  static readonly READ_HELPER = 'appii_bearer_read';
  static readonly SAVE_HELPER = 'appii_bearer_save';
  static readonly FORGET_HELPER = 'appii_bearer_forget';
  static readonly GIVEN_HELPER = 'appii_bearer_given';
  static readonly HELPERS: readonly string[] = Object.freeze(['appii_bearer_read', 'appii_bearer_save', 'appii_bearer_forget', 'appii_bearer_given']);
  static readonly ARGS_LOCAL = 'appii_bearer_args';
  static readonly ARGS_WORD = '"${appii_bearer_args[@]+"${appii_bearer_args[@]}"}"';
  static readonly AUTHORIZATION = 'authorization';
  static readonly AUTHORIZATION_PATTERN = '[Aa][Uu][Tt][Hh][Oo][Rr][Ii][Zz][Aa][Tt][Ii][Oo][Nn]';
  static readonly SEPARATOR = '--';
  static readonly TOKEN_VARIABLE = Curl.variableName(Samples.BEARER_TOKEN);

  static used(model: ApiModel, endpoints: readonly Endpoint[]): boolean {
    return endpoints.some((endpoint) => endpoint.auth.bearer) || CurlBearerScript.issuing(model);
  }

  static issuing(model: ApiModel): boolean {
    return model.endpoints.some((endpoint) => LoginGuide.tokens(endpoint).length > 0);
  }

  static file(model: ApiModel): string {
    return CurlSessionScript.jarFile(model).slice(0, -CurlSessionScript.JAR_SUFFIX.length) + CurlBearerScript.FILE_SUFFIX;
  }

  static variable(rename: (name: string) => string): string {
    return Curl.variableName(rename(Samples.BEARER_TOKEN));
  }

  static plan(sample: Samples.RequestSample, rename: (name: string) => string): CurlBearerPlan {
    const placeholder = rename(Samples.BEARER_TOKEN);
    const header = sample.headers.find((entry) => entry.name.toLowerCase() === CurlBearerScript.AUTHORIZATION && entry.value.placeholders().includes(placeholder));
    if (header === undefined) return { sample };
    return { sample: { ...sample, headers: sample.headers.filter((entry) => entry !== header) }, header };
  }

  static fileLines(model: ApiModel): string[] {
    const variable = CurlBearerScript.FILE_VARIABLE;
    return [
      `${CurlBearerScript.FILE_DEFAULT}="$(dirname -- "$${CurlSessionScript.JAR_VARIABLE}")"/${Text.shellQuote(CurlBearerScript.file(model))}`,
      `${variable}="\${${variable}:-$${CurlBearerScript.FILE_DEFAULT}}"`,
    ];
  }

  static helpers(): string[] {
    const file = CurlBearerScript.FILE_VARIABLE;
    return [
      `${CurlBearerScript.READ_HELPER}() {`,
      "  local appii_line=''",
      `  [[ -n "$${file}" && -r "$${file}" ]] || return 0`,
      `  IFS= read -r appii_line < "$${file}" || true`,
      "  printf '%s' \"${appii_line%$'\\r'}\"",
      '}',
      '',
      `${CurlBearerScript.SAVE_HELPER}() {`,
      "  local appii_fn=\"$1\" appii_body appii_status=0 appii_token='' appii_path",
      '  local -a appii_paths=()',
      '  shift',
      `  while [[ $# -gt 0 && "$1" != ${CurlBearerScript.SEPARATOR} ]]; do appii_paths+=("$1"); shift; done`,
      '  shift',
      '  appii_body="$("$@"; appii_status=$?; printf x; exit "$appii_status")" || appii_status=$?',
      '  appii_body="${appii_body%x}"',
      "  printf '%s' \"$appii_body\"",
      '  [[ "$appii_status" -eq 0 ]] || return "$appii_status"',
      '  for appii_path in "${appii_paths[@]}"; do',
      `    appii_token="$(printf '%s' "$appii_body" | ${CurlSessionScript.SCAN_HELPER} json "$appii_path")"`,
      '    [[ -z "$appii_token" ]] || break',
      '  done',
      '  if [[ -z "$appii_token" ]]; then',
      `    printf '%s: warning: the response has no bearer token in %s, so %s was not changed.\\n' "$appii_fn" "\${appii_paths[*]}" '${file}' >&2`,
      '    return 0',
      '  fi',
      `  if [[ -z "$${file}" ]]; then printf '%s\\n' '${file} is empty: set it to the file of the bearer token.' >&2; return 2; fi`,
      `  if ! (umask 077 && rm -f -- "$${file}" && printf '%s\\n' "$appii_token" > "$${file}") 2>/dev/null; then`,
      `    printf 'Cannot write the token file %s: set ${file} to a file that you can write.\\n' "$${file}" >&2`,
      '    return 2',
      '  fi',
      '}',
      '',
      `${CurlBearerScript.FORGET_HELPER}() {`,
      '  local appii_status=0',
      '  "$@" || appii_status=$?',
      `  [[ "$appii_status" -ne 0 || -z "$${file}" ]] || rm -f -- "$${file}"`,
      '  return "$appii_status"',
      '}',
      '',
      `${CurlBearerScript.GIVEN_HELPER}() {`,
      '  local appii_word appii_value',
      '  while [[ $# -gt 0 ]]; do',
      '    appii_word="$1"',
      '    shift',
      '    case "$appii_word" in',
      '      -H|--header) appii_value="${1-}"; [[ $# -eq 0 ]] || shift ;;',
      '      -H?*) appii_value="${appii_word#-H}" ;;',
      '      --oauth2-bearer) return 0 ;;',
      '      *) continue ;;',
      '    esac',
      `    case "\${appii_value%%:*}" in ${CurlBearerScript.AUTHORIZATION_PATTERN}) return 0 ;; esac`,
      '  done',
      '  return 1',
      '}',
    ];
  }

  static requestLines(endpoint: Endpoint, name: string, header: Samples.SampleEntry, variable: string, login: string | undefined, arg: (text: SampleText) => string): string[] {
    const next = login === undefined ? `set ${variable}` : `run ${login} first or set ${variable}`;
    const words = `-H ${arg(SampleText.concat(`${header.name}: `, header.value))}`;
    const missing = CurlBearerScript.#missing(endpoint, name, next);
    return [
      `  local ${variable}="\${${variable}:-}"`,
      `  local -a ${CurlBearerScript.ARGS_LOCAL}=()`,
      `  if ! ${CurlBearerScript.GIVEN_HELPER} "$@"; then`,
      `    [[ -n "$${variable}" ]] || ${variable}="$(${CurlBearerScript.READ_HELPER})"`,
      `    if [[ -n "$${variable}" ]]; then`,
      `      ${CurlBearerScript.ARGS_LOCAL}=(${words})`,
      ...(missing === undefined ? [] : ['    else', `      ${missing}`]),
      '    fi',
      '  fi',
    ];
  }

  static #missing(endpoint: Endpoint, name: string, next: string): string | undefined {
    if (endpoint.auth.anonymous === 'refused') return `printf '%s\\n' ${Text.shellQuote(`${name}: no bearer token: ${next}.`)} >&2; return 2`;
    if (endpoint.auth.anonymous === 'untested') {
      return `printf '%s\\n' ${Text.shellQuote(`${name}: warning: no bearer token, so the request goes without one (anonymous access was not tested): ${next}.`)} >&2`;
    }
    return undefined;
  }

  static saveWords(name: string, paths: readonly string[]): string {
    return [CurlBearerScript.SAVE_HELPER, Curl.shellWord(name), ...paths.map((path) => Curl.shellWord(path)), CurlBearerScript.SEPARATOR].join(' ');
  }

  static usage(): string[] {
    return [
      `A function that sends a bearer token takes it from ${CurlBearerScript.TOKEN_VARIABLE} or,`,
      `when that is empty, from the token file ${CurlBearerScript.FILE_VARIABLE}, which the login`,
      'function writes when its response holds the token. Without a token, a',
      'function whose endpoint refused anonymous requests stops and sends',
      'nothing, and the others send the request without the authorization',
      'header. An authorization header given as a curl argument (-H) is sent',
      'instead. The logout function deletes the token file. Delete the token',
      'file too to start a new session.',
    ];
  }

  static environment(model: ApiModel): string[] {
    return [
      `  ${CurlBearerScript.TOKEN_VARIABLE} bearer token for the functions that send one`,
      `                   (default: the token in ${CurlBearerScript.FILE_VARIABLE})`,
      `  ${CurlBearerScript.FILE_VARIABLE} file where the login function keeps the bearer token,`,
      '                   readable only by you (default:',
      `                   ${CurlBearerScript.file(model)} next to the cookie jar)`,
    ];
  }
}
