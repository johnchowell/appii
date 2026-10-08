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
  static readonly SEND_LOCAL = 'appii_bearer_send';
  static readonly BODY_TEMPLATE = 'appii-body.XXXXXX';
  static readonly UNSUPPORTED_OUTPUTS: readonly string[] = Object.freeze(['-O', '--remote-name', '--remote-name-all', '-J', '--remote-header-name', '--output-dir']);
  static readonly CHANGING_OPTIONS: readonly string[] = Object.freeze([
    '--head', '--range', '--request', '--data', '--data-ascii', '--data-binary', '--data-raw', '--data-urlencode', '--json', '--form', '--form-string', '--get',
    '--upload-file', '--max-filesize',
  ]);
  static readonly CHANGING_SHORT = 'IrXdFGT';
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
      ...CurlBearerScript.#saveHelper(),
      `  if [[ -z "$${file}" ]]; then printf '%s\\n' '${file} is empty: set it to the file of the bearer token.' >&2; return 2; fi`,
      `  if ! (umask 077 && rm -f -- "$${file}" && printf '%s\\n' "$appii_token" > "$${file}") 2>/dev/null; then`,
      `    printf 'Cannot write the token file %s: set ${file} to a file that you can write.\\n' "$${file}" >&2`,
      '    return 2',
      '  fi',
      '  return "$appii_write"',
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

  static requestLines(endpoint: Endpoint, name: string, variable: string, login: string | undefined): string[] {
    const next = login === undefined ? `set ${variable}` : `run ${login} first or set ${variable}`;
    const missing = CurlBearerScript.#missing(endpoint, name, next);
    return [
      `  local ${variable}="\${${variable}:-}"`,
      `  local ${CurlBearerScript.SEND_LOCAL}=''`,
      `  if ! ${CurlBearerScript.GIVEN_HELPER} "$@"; then`,
      `    [[ -n "$${variable}" ]] || ${variable}="$(${CurlBearerScript.READ_HELPER})"`,
      `    if [[ -n "$${variable}" ]]; then`,
      `      ${CurlBearerScript.SEND_LOCAL}=1`,
      ...(missing === undefined ? [] : ['    else', `      ${missing}`]),
      '    fi',
      '  fi',
    ];
  }

  static headerWord(header: Samples.SampleEntry, arg: (text: SampleText) => string): string {
    return `-H @<([[ -z "$${CurlBearerScript.SEND_LOCAL}" ]] || printf '%s\\n' ${arg(SampleText.concat(`${header.name}: `, header.value))})`;
  }

  static #missing(endpoint: Endpoint, name: string, next: string): string | undefined {
    if (endpoint.auth.anonymous === 'refused') return `printf '%s\\n' ${Text.shellQuote(`${name}: no bearer token: ${next}.`)} >&2; return 2`;
    if (endpoint.auth.anonymous === 'untested') {
      return `printf '%s\\n' ${Text.shellQuote(`${name}: warning: no bearer token, so the request goes without one (anonymous access was not tested): ${next}.`)} >&2`;
    }
    return undefined;
  }

  static saveWords(name: string, paths: readonly string[]): string {
    return [CurlBearerScript.SAVE_HELPER, Curl.shellWord(name), '"$#"', ...paths.map((path) => Curl.shellWord(path)), CurlBearerScript.SEPARATOR].join(' ');
  }

  static #saveHelper(): string[] {
    const file = CurlBearerScript.FILE_VARIABLE;
    const values: string[] = [];
    const options = Curl.VALUE_OPTIONS.filter((option) => option !== '--output' && !CurlBearerScript.UNSUPPORTED_OUTPUTS.includes(option));
    for (let i = 0; i < options.length; i += Curl.VALUE_OPTIONS_PER_LINE) values.push(options.slice(i, i + Curl.VALUE_OPTIONS_PER_LINE).join('|'));
    const shortValues = Curl.VALUE_SHORT_OPTIONS.replace('o', '');
    const refuse = (word: string): string => `printf '%s: the curl option %s is not supported here: the function reads the response to save the bearer token. Use -o FILE to keep the response.\\n' "$appii_fn" ${word} >&2; return 2 ;;`;
    return [
      `${CurlBearerScript.SAVE_HELPER}() {`,
      "  local appii_fn=\"$1\" appii_count=\"$2\" appii_status=0 appii_write=0 appii_token='' appii_path appii_body appii_out='' appii_word appii_rest appii_kept appii_next appii_change",
      '  local -a appii_paths=() appii_command=() appii_given=() appii_changed=()',
      '  shift 2',
      `  while [[ $# -gt 0 && "$1" != ${CurlBearerScript.SEPARATOR} ]]; do appii_paths+=("$1"); shift; done`,
      '  shift',
      '  while [[ $# -gt appii_count ]]; do appii_command+=("$1"); shift; done',
      '  while [[ $# -gt 0 ]]; do',
      "    appii_word=\"$1\" appii_next='' appii_change=''",
      '    shift',
      '    case "$appii_word" in',
      '      -o|--output) appii_out="${1-}"; [[ $# -eq 0 ]] || shift; continue ;;',
      `      ${CurlBearerScript.UNSUPPORTED_OUTPUTS.join('|')}) ${refuse('"$appii_word"')}`,
      ...values.map((line) => `      ${line}) appii_next=1 ;;`),
      '      --*) ;;',
      '      -?*)',
      "        appii_rest=\"${appii_word#-}\" appii_kept=''",
      '        while [[ -n "$appii_rest" ]]; do',
      `          [[ "\${appii_rest:0:1}" != [${CurlBearerScript.CHANGING_SHORT}] ]] || appii_change=1`,
      '          case "$appii_rest" in',
      "            o) appii_out=\"${1-}\"; [[ $# -eq 0 ]] || shift; appii_rest='' ;;",
      "            o*) appii_out=\"${appii_rest#o}\"; appii_rest='' ;;",
      `            [OJ]*) ${refuse('"-${appii_rest:0:1}"')}`,
      `            [${shortValues}]) appii_kept+="$appii_rest"; appii_next=1; appii_rest='' ;;`,
      `            [${shortValues}]*) appii_kept+="$appii_rest"; appii_rest='' ;;`,
      '            *) appii_kept+="${appii_rest:0:1}"; appii_rest="${appii_rest:1}" ;;',
      '          esac',
      '        done',
      '        [[ -n "$appii_kept" ]] || continue',
      '        appii_word="-$appii_kept"',
      '        ;;',
      '    esac',
      `    [[ " ${CurlBearerScript.CHANGING_OPTIONS.join(' ')} " != *" $appii_word "* ]] || appii_change=1`,
      '    [[ -z "$appii_change" ]] || appii_changed+=("$appii_word")',
      '    appii_given+=("$appii_word")',
      '    if [[ -n "$appii_next" && $# -gt 0 ]]; then appii_given+=("$1"); shift; fi',
      '  done',
      `  if ! appii_body="$(umask 077 && mktemp "\${TMPDIR:-/tmp}/${CurlBearerScript.BODY_TEMPLATE}")"; then`,
      "    printf '%s: cannot create a temporary file for the response.\\n' \"$appii_fn\" >&2",
      '    return 2',
      '  fi',
      '  "${appii_command[@]}" -o "$appii_body" "${appii_given[@]+"${appii_given[@]}"}" || appii_status=$?',
      '  if [[ "$appii_status" -eq 0 ]]; then',
      '    for appii_path in "${appii_paths[@]}"; do',
      `      appii_token="$(${CurlSessionScript.SCAN_HELPER} json "$appii_path" < "$appii_body")"`,
      '      [[ -z "$appii_token" ]] || break',
      '    done',
      '  fi',
      '  if [[ -z "$appii_out" || "$appii_out" == - ]]; then',
      '    cat -- "$appii_body"',
      '  elif [[ "$appii_status" -eq 0 || -s "$appii_body" ]] && ! { cat -- "$appii_body" > "$appii_out"; } 2>/dev/null; then',
      "    printf '%s: cannot write the response to %s.\\n' \"$appii_fn\" \"$appii_out\" >&2",
      '    appii_write=23',
      '  fi',
      '  rm -f -- "$appii_body"',
      '  [[ "$appii_status" -eq 0 ]] || return "$appii_status"',
      '  if [[ -z "$appii_token" ]]; then',
      `    printf '%s: warning: the response has no bearer token in %s, so %s was not changed.\\n' "$appii_fn" "\${appii_paths[*]}" '${file}' >&2`,
      `    [[ \${#appii_changed[@]} -eq 0 ]] || printf '%s: the curl arguments %s change the request or the response.\\n' "$appii_fn" "\${appii_changed[*]}" >&2`,
      '    return "$appii_write"',
      '  fi',
    ];
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
