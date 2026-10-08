import { createHash } from 'node:crypto';
import { CharsetEncoder } from './charset.js';
import type { FormEntry, RequestSample, SampleBody } from './samples.js';
import { BINARY_MIME, formEntries, isRecord, jsonText, placeholderNames as samplePlaceholderNames } from './samples.js';
import { SampleText } from './sample-text.js';
import type { PlaceholderEncoding, PlaceholderPart, SampleTextInput } from './sample-text.js';
import { ShellScript } from './shell-script.js';
import { shellQuote } from './text.js';

export type VariableMode = 'literal' | 'plain' | 'shell' | 'script';

export interface CurlOptions {
  variables?: VariableMode;
  variable?: (name: string) => string;
  cookie?: SampleText;
  jar?: string;
  explain?: boolean;
  multiline?: boolean;
  extraArgs?: readonly string[];
}

export type RawChunk = { readonly kind: 'text'; readonly text: SampleText; readonly charset?: string } | { readonly kind: 'file'; readonly path: SampleText };

export interface RawBody {
  readonly contentType?: string;
  readonly chunks: readonly RawChunk[];
}

export const VARIABLE_PREFIX = 'APPII_';
export const FORM_FLAG = '--data-urlencode';
export const MULTIPART_TEXT_FLAG = '--form-string';
export const MULTIPART_FILE_FLAG = '-F';
export const RAW_FLAG = '--data-raw';
export const BINARY_FLAG = '--data-binary';
export const HEAD_FLAG = '--head';
export const USER_FLAG = '-u';
export const COMPRESSED_FLAG = '--compressed';
export const VARIABLES_LABEL = 'Variables:';
export const HEAD_METHOD = 'HEAD';
export const GET_METHOD = 'GET';
export const DEFAULT_UPLOAD = 'file.bin';
export const EMPTY_UPLOAD = '/dev/null';
export const SAFE_UPLOAD_NAME: RegExp = /^[A-Za-z0-9._+-]+$/;
export const CONTINUATION = ' \\\n  ';
export const SAFE_WORD: RegExp = /^[A-Za-z0-9_.-]+$/;
export const DOUBLE_QUOTE_SPECIAL: RegExp = /[!"$\\`]/;
export const ENCODING_HELPERS: Readonly<Record<PlaceholderEncoding, string>> = Object.freeze({ component: 'appii_pct', form: 'appii_form', json: 'appii_json', filename: 'appii_filename' });
export const COPY_BYTE = `printf -v byte '%b' "\\\\x$byte"`;
export const PERCENT_BYTE = `printf -v byte '%%%02X' "0x$byte"`;
export const ENCODER_CASES: Readonly<Record<PlaceholderEncoding, readonly string[]>> = Object.freeze({
  component: [`2d|2e|3[0-9]|4[1-9a-f]|5[0-9a]|5f|6[1-9a-f]|7[0-9a]|7e) ${COPY_BYTE} ;;`, `*) ${PERCENT_BYTE} ;;`],
  form: ["20) byte='+' ;;", `2a|2d|2e|3[0-9]|4[1-9a-f]|5[0-9a]|5f|6[1-9a-f]|7[0-9a]) ${COPY_BYTE} ;;`, `*) ${PERCENT_BYTE} ;;`],
  json: [`22) byte='\\"' ;;`, `5c) byte='\\\\' ;;`, `[01][0-9a-f]|7f) printf -v byte '\\\\u%04x' "0x$byte" ;;`, `*) ${COPY_BYTE} ;;`],
  filename: ["22) byte='%22' ;;", "0d) byte='%0D' ;;", "0a) byte='%0A' ;;", `*) ${COPY_BYTE} ;;`],
});
export const NAME_LOCAL = 'appii_name';
export const ENCODER_INPUTS: Readonly<Record<PlaceholderEncoding, readonly string[]>> = Object.freeze({
  component: [],
  form: [],
  json: [],
  filename: [`local ${NAME_LOCAL}="\${!1-}"`, `${NAME_LOCAL}="\${${NAME_LOCAL}##*[\\\\/]}"`, `case "$${NAME_LOCAL}" in ''|.|..) ${NAME_LOCAL}=${shellQuote(DEFAULT_UPLOAD)} ;; esac`],
});
export const ENCODER_VALUES: Readonly<Record<PlaceholderEncoding, string>> = Object.freeze({ component: '"${!1-}"', form: '"${!1-}"', json: '"${!1-}"', filename: `"$${NAME_LOCAL}"` });
export const BOUNDARY_PREFIX = '----appiiFormBoundary';
export const BOUNDARY_LENGTH = 16;
export const MULTIPART_CONTENT_TYPE = 'multipart/form-data; boundary=';
export const MULTIPART_ESCAPES: Readonly<Record<string, string>> = Object.freeze({ '"': '%22', '\r': '%0D', '\n': '%0A' });
export const MULTIPART_ESCAPE_SOURCE = '["\\r\\n]';
export const RAW_NAME: RegExp = /[="\r\n\0]/;
export const NUL = '\0';
export const NON_ASCII: RegExp = /[^\x00-\x7f]/;
export const PRINTF_PLACEHOLDER = '%s';
export const PERCENT = 0x25;
export const BACKSLASH = 0x5c;
export const SINGLE_QUOTE = 0x27;
export const FIRST_PRINTABLE = 0x20;
export const LAST_PRINTABLE = 0x7e;
export const ARGUMENT_HELPER = 'appii_curl_args';
export const REQUIRED_OPERATOR = ':?';
export const GUARD_COMMAND = ':';
export const GUARD_JOIN = '&&';
export const VALUE_OPTIONS: readonly string[] = Object.freeze([
  '--abstract-unix-socket', '--alt-svc', '--aws-sigv4', '--cacert', '--capath', '--cert', '--cert-type', '--ciphers', '--config', '--connect-timeout',
  '--connect-to', '--continue-at', '--cookie', '--cookie-jar', '--create-file-mode', '--crlfile', '--curves', '--data', '--data-ascii', '--data-binary',
  '--data-raw', '--data-urlencode', '--delegation', '--dns-interface', '--dns-ipv4-addr', '--dns-ipv6-addr', '--dns-servers', '--doh-url', '--dump-header',
  '--ech', '--egd-file', '--engine', '--etag-compare', '--etag-save', '--expect100-timeout', '--form', '--form-string', '--ftp-account',
  '--ftp-alternative-to-user', '--ftp-method', '--ftp-port', '--ftp-ssl-ccc-mode', '--happy-eyeballs-timeout-ms', '--haproxy-clientip', '--header',
  '--hostpubmd5', '--hostpubsha256', '--hsts', '--interface', '--ip-tos', '--ipfs-gateway', '--json', '--keepalive-cnt', '--keepalive-time', '--key',
  '--key-type', '--knownhosts', '--krb', '--libcurl', '--limit-rate', '--local-port', '--login-options', '--mail-auth', '--mail-from', '--mail-rcpt',
  '--max-filesize', '--max-redirs', '--max-time', '--netrc-file', '--noproxy', '--oauth2-bearer', '--output', '--output-dir', '--parallel-max', '--pass',
  '--pinnedpubkey', '--preproxy', '--proto', '--proto-default', '--proto-redir', '--proxy', '--proxy-cacert', '--proxy-capath', '--proxy-cert',
  '--proxy-cert-type', '--proxy-ciphers', '--proxy-crlfile', '--proxy-header', '--proxy-key', '--proxy-key-type', '--proxy-pass', '--proxy-pinnedpubkey',
  '--proxy-service-name', '--proxy-tls13-ciphers', '--proxy-tlsauthtype', '--proxy-tlspassword', '--proxy-tlsuser', '--proxy-user', '--proxy1.0',
  '--pubkey', '--quote', '--random-file', '--range', '--rate', '--referer', '--request', '--request-target', '--resolve', '--retry', '--retry-delay',
  '--retry-max-time', '--sasl-authzid', '--service-name', '--sigalgs', '--socks4', '--socks4a', '--socks5', '--socks5-gssapi-service', '--socks5-hostname',
  '--speed-limit', '--speed-time', '--ssl-sessions', '--stderr', '--telnet-option', '--tftp-blksize', '--time-cond', '--tls-max', '--tls13-ciphers',
  '--tlsauthtype', '--tlspassword', '--tlsuser', '--trace', '--trace-ascii', '--trace-config', '--unix-socket', '--upload-file', '--upload-flags',
  '--url-query', '--user', '--user-agent', '--variable', '--vlan-priority', '--write-out',
]);
export const VALUE_SHORT_OPTIONS = 'AbcCdDeEFHKmoPQrtTuUwxXyYz';
export const TRANSFER_OPTIONS: readonly string[] = Object.freeze(['--url', '--next']);
export const NEXT_SHORT_OPTION = ':';
export const VALUE_OPTIONS_PER_LINE = 6;
export const HEADER_FILE_FLAG = '-H';
export const HEADER_LINES = "printf '%s\\n'";
export const COOKIE_PAIR_SEPARATOR = '; ';
export const COOKIE_HEADER = 'Cookie: ';
export const CONDITIONAL_COOKIE_NAME: RegExp = /^[A-Za-z0-9!#%&'*+.^_|~-]+$/;
export const CONDITIONAL_SAFE: RegExp = /^[^!"$\\`}]*$/;
export const FILE_COMMAND = 'cat --';
export const FIELD_FILE = '@';
export const CONFIG_FLAG = '-K';
export const CONFIG_HELPER = 'appii_config';
export const CONFIG_USER = 'user';
export const CONFIG_COOKIE = 'cookie';
export const CONFIG_VALUE = 'appii_value';
export const CONFIG_ESCAPES: readonly (readonly [string, string])[] = Object.freeze([
  ['\\\\', '\\\\\\\\'],
  ['\\"', '\\\\\\"'],
  ["$'\\n'", '\\\\n'],
  ["$'\\r'", '\\\\r'],
] as const);

export const HELPER_FUNCTIONS: readonly string[] = Object.freeze([
  ...encoderHelper('component'),
  '',
  ...encoderHelper('form'),
  '',
  ...encoderHelper('json'),
  '',
  ...encoderHelper('filename'),
  '',
  ...configHelper(),
  '',
  ...argumentHelper(),
]);

export function configHelper(): string[] {
  return [
    `${CONFIG_HELPER}() {`,
    '  [[ -n "${2-}" ]] || return 0',
    `  local ${CONFIG_VALUE}="$2"`,
    ...CONFIG_ESCAPES.map(([from, to]) => `  ${CONFIG_VALUE}=\${${CONFIG_VALUE}//${from}/${to}}`),
    `  printf '%s = "%s"\\n' "$1" "$${CONFIG_VALUE}"`,
    '}',
  ];
}

export function configFile(entries: readonly (readonly [string, string])[], vars: VariableMode): string {
  const calls = entries.map(([option, word]) => `${CONFIG_HELPER} ${option} ${word}`);
  const definition = vars === 'script' ? [] : [ShellScript.oneLine(configHelper())];
  return `<(${[...definition, ...calls].join(ShellScript.STATEMENT_SEPARATOR)})`;
}

export function encoderHelper(encoding: PlaceholderEncoding): string[] {
  return [
    `${ENCODING_HELPERS[encoding]}() {`,
    ...ENCODER_INPUTS[encoding].map((line) => `  ${line}`),
    `  printf '%s' ${ENCODER_VALUES[encoding]} | od -An -v -tx1 | while read -r line; do`,
    '    for byte in $line; do',
    '      case $byte in',
    ...ENCODER_CASES[encoding].map((line) => `        ${line}`),
    '      esac',
    `      printf '%s' "$byte"`,
    '    done',
    '  done',
    '}',
  ];
}

export function encoderDefinition(encoding: PlaceholderEncoding): string {
  return ShellScript.oneLine(encoderHelper(encoding));
}

export function argumentHelper(): string[] {
  const arms: string[] = [];
  for (let i = 0; i < VALUE_OPTIONS.length; i += VALUE_OPTIONS_PER_LINE) arms.push(`      ${VALUE_OPTIONS.slice(i, i + VALUE_OPTIONS_PER_LINE).join('|')}) [[ $# -eq 0 ]] || shift ;;`);
  const refuse = (message: string): string => `printf '%s: ${message} %s\\n' "$appii_fn" "$appii_word" "$appii_hint" >&2; return 2 ;;`;
  return [
    `${ARGUMENT_HELPER}() {`,
    '  local appii_fn="$1" appii_hint="$2" appii_word appii_rest',
    '  shift 2',
    '  while [[ $# -gt 0 ]]; do',
    '    appii_word="$1"',
    '    shift',
    '    case "$appii_word" in',
    `      --) ${refuse('unexpected argument %s. A value that starts with a dash goes in its APPII_<NAME> variable.')}`,
    `      ${TRANSFER_OPTIONS.join('|')}) ${refuse('curl option %s is not supported, because it makes curl send another request.')}`,
    ...arms,
    '      --*) ;;',
    '      -?*)',
    '        appii_rest="${appii_word#-}"',
    '        while [[ -n "$appii_rest" ]]; do',
    '          case "$appii_rest" in',
    `            ${NEXT_SHORT_OPTION}*) ${refuse('curl option %s is not supported, because it makes curl send another request.')}`,
    `            [${VALUE_SHORT_OPTIONS}]*) [[ \${#appii_rest} -gt 1 || $# -eq 0 ]] || shift; break ;;`,
    '          esac',
    '          appii_rest="${appii_rest#?}"',
    '        done',
    '        ;;',
    `      *) ${refuse('unexpected argument %s.')}`,
    '    esac',
    '  done',
    '}',
  ];
}

export function variableName(name: string): string {
  return VARIABLE_PREFIX + name.toUpperCase();
}

export function variableReference(name: string, part: PlaceholderPart, variables: VariableMode, variable: (name: string) => string = variableName, explain: (variable: string) => boolean = () => false): string {
  const helper = variables === 'script' && part.encoding !== undefined ? ENCODING_HELPERS[part.encoding] : undefined;
  if (helper !== undefined) return `$(${helper} ${variable(name)})`;
  if (variables !== 'shell' || !guarded(part)) return `\${${variable(name)}}`;
  const message = part.required === undefined && part.missing !== undefined && explain(variable(name)) ? ShellScript.expansionWord(part.missing) : '';
  return `\${${variable(name)}${REQUIRED_OPERATOR}${message}}`;
}

export function guarded(part: PlaceholderPart): boolean {
  return part.required !== undefined || part.missing !== undefined;
}

export function firstUse(enabled: boolean): (variable: string) => boolean {
  const seen = new Set<string>();
  return (variable: string): boolean => {
    if (!enabled || seen.has(variable)) return false;
    seen.add(variable);
    return true;
  };
}

export function shellArg(input: SampleTextInput, variables: VariableMode = 'literal', variable: (name: string) => string = variableName, explain: (variable: string) => boolean = () => false): string {
  const text = SampleText.of(input);
  if (variables === 'literal' || text.isLiteral) return shellQuote(text.toString());
  const reference = (name: string, part: PlaceholderPart): string => variableReference(name, part, variables, variable, explain);
  if (text.parts.every((part) => part.kind === 'placeholder' || !DOUBLE_QUOTE_SPECIAL.test(part.text))) {
    return `"${text.render({ literal: (literal) => literal, placeholder: reference })}"`;
  }
  return text.parts.map((part) => (part.kind === 'literal' ? shellQuote(part.text) : `"${reference(part.name, part)}"`)).join('');
}

export function shellWord(text: string): string {
  return SAFE_WORD.test(text) ? text : shellQuote(text);
}

export function placeholderNames(sample: RequestSample, extra: readonly SampleText[] = []): string[] {
  return samplePlaceholderNames(sample, extra).map(variableName).sort();
}

export function uploadName(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  return base === '' || base === '.' || base === '..' ? DEFAULT_UPLOAD : base;
}

export function uploadPath(filename: string): string {
  const name = uploadName(filename);
  return SAFE_UPLOAD_NAME.test(name) ? name : `"${name.replace(/["\\]/g, (c) => '\\' + c)}"`;
}

export function multipartName(name: string): string {
  return name.replace(new RegExp(MULTIPART_ESCAPE_SOURCE, 'g'), (ch) => MULTIPART_ESCAPES[ch] ?? ch);
}

export function boundary(body: SampleText): string {
  const hash = createHash('sha256').update(body.toString()).digest('base64url').replace(/[^A-Za-z0-9]/g, '');
  return BOUNDARY_PREFIX + hash.slice(0, BOUNDARY_LENGTH);
}

export function rawBody(body: SampleBody | undefined): RawBody | undefined {
  if (!body || body.value === undefined) return undefined;
  const encoder = CharsetEncoder.for(body.charset);
  const literals = (text: SampleText): string[] => text.parts.flatMap((part) => (part.kind === 'literal' ? [part.text] : []));
  const needsBytes = (text: string): boolean => text.includes(NUL) || (!encoder.utf8 && NON_ASCII.test(text));
  if (body.kind === 'multipart' && isRecord(body.value)) {
    const entries = formEntries(body.value);
    const raw = entries.some((entry) => RAW_NAME.test(entry.name) || needsBytes(entry.name) || (!entry.file && literals(entry.value).some(needsBytes)) || (entry.file && needsBytes(entry.value.toString())));
    return raw ? multipartBody(entries, body.charset) : undefined;
  }
  if (!(body.value instanceof SampleText)) return undefined;
  return literals(body.value).some(needsBytes) ? { chunks: [{ kind: 'text', text: body.value, ...(body.charset === undefined ? {} : { charset: body.charset }) }] } : undefined;
}

export function curlCommand(sample: RequestSample, opts: CurlOptions = {}): string {
  const vars = opts.variables ?? 'literal';
  const variable = opts.variable ?? variableName;
  const explain = firstUse(opts.explain === true);
  const arg = (text: SampleTextInput): string => shellArg(text, vars, variable, explain);
  const piped = vars === 'shell' || vars === 'script';
  const fields = vars === 'shell' ? variableFields(sample.body) : undefined;
  const raw = rawBody(sample.body) ?? (piped && fields === undefined ? variableBody(sample.body) : undefined);
  const lines = sample.headers.map((header) => SampleText.concat(`${header.name}: `, header.value));
  const variableLines = piped ? lines.filter((line) => !line.isLiteral) : [];
  const cookie = opts.cookie ?? sample.cookie;
  const configured = piped ? [sample.user, cookie].filter((text): text is SampleText => text !== undefined && !text.isLiteral) : [];
  const guards = vars === 'shell' ? guardWords([...variableLines, ...configured, ...rawTexts(raw), ...(fields ?? []).map((entry) => entry.value)], variable, explain) : [];
  const head: string[] = ['curl', '-sS'];
  if (sample.method === HEAD_METHOD) head.push(HEAD_FLAG);
  else if (sample.method !== GET_METHOD || sample.body) head.push('-X', shellWord(sample.method));
  head.push(arg(sample.url));
  const groups: string[][] = [head];
  for (const line of lines) if (!variableLines.includes(line)) groups.push(['-H', arg(line)]);
  const cookieHeader = vars === 'shell' && cookie !== undefined && configured.includes(cookie);
  const headerWords = variableLines.map((line) => headerWord(line, vars, variable));
  if (cookie && cookieHeader) headerWords.push(cookieWord(cookie, variable, COOKIE_HEADER) ?? shellArg(SampleText.concat(COOKIE_HEADER, cookie).unguarded(), vars, variable));
  if (headerWords.length > 0) groups.push([HEADER_FILE_FLAG, headerFile(headerWords)]);
  if (raw?.contentType !== undefined) groups.push(['-H', arg(`Content-Type: ${raw.contentType}`)]);
  const config: [string, string][] = [];
  const word = (text: SampleText): string => (vars === 'shell' ? shellArg(text.unguarded(), vars, variable) : arg(text));
  if (sample.user && configured.includes(sample.user)) config.push([CONFIG_USER, word(sample.user)]);
  else if (sample.user) groups.push([USER_FLAG, arg(sample.user)]);
  if (cookie && configured.includes(cookie)) {
    if (!cookieHeader) config.push([CONFIG_COOKIE, word(cookie)]);
  } else if (cookie) groups.push(['-b', arg(cookie)]);
  if (config.length > 0) groups.push([CONFIG_FLAG, configFile(config, vars)]);
  if (opts.jar !== undefined) groups.push(['-b', opts.jar, '-c', opts.jar]);
  if (raw) groups.push([BINARY_FLAG, `@<(${printfCommands(raw, vars, variable)})`]);
  else if (fields) groups.push(...fieldGroups(fields, sample.body?.charset, arg, variable));
  else groups.push(...bodyGroups(sample.body, arg));
  groups.push([COMPRESSED_FLAG]);
  for (const extra of opts.extraArgs ?? []) groups.push([extra]);
  const parts = groups.map((group) => group.join(' '));
  const command = opts.multiline === false ? parts.join(' ') : parts.join(CONTINUATION);
  return ShellScript.ascii(guards.length > 0 ? `${GUARD_COMMAND} ${guards.join(' ')} ${GUARD_JOIN} ${command}` : command);
}

export function variableBody(body: SampleBody | undefined): RawBody | undefined {
  if (!body || body.value === undefined) return undefined;
  const charset = body.charset === undefined ? {} : { charset: body.charset };
  if ((body.kind === 'form' || body.kind === 'multipart') && isRecord(body.value)) {
    const entries = formEntries(body.value);
    if (entries.every((entry) => entry.value.isLiteral)) return undefined;
    if (body.kind === 'multipart') return multipartBody(entries, body.charset);
    const encoder = CharsetEncoder.for(body.charset);
    const encode = (text: string): string => encoder.formComponent(text);
    const pairs = entries.map((entry) => SampleText.concat(`${encode(entry.name)}=`, entry.value.mapLiterals(encode).encoded('form')));
    return { chunks: [{ kind: 'text', text: SampleText.join(pairs, '&'), ...charset }] };
  }
  const text = bodyText(body);
  return text === undefined || text.isLiteral ? undefined : { chunks: [{ kind: 'text', text, ...charset }] };
}

export function variableFields(body: SampleBody | undefined): FormEntry[] | undefined {
  if (body?.kind !== 'form' || !isRecord(body.value)) return undefined;
  const entries = formEntries(body.value);
  return entries.every((entry) => entry.value.isLiteral) ? undefined : entries;
}

export function fieldGroups(entries: readonly FormEntry[], charset: string | undefined, arg: (text: SampleTextInput) => string, variable: (name: string) => string): string[][] {
  const encoder = CharsetEncoder.for(charset);
  const encode = (text: string): string => encoder.formComponent(text);
  return entries.map((entry) => {
    const name = encode(entry.name);
    if (entry.value.isLiteral) return [RAW_FLAG, arg(`${name}=${encode(entry.value.toString())}`)];
    return [FORM_FLAG, `${shellQuote(`${name}${FIELD_FILE}`)}<(printf '%s' ${shellArg(entry.value.unguarded(), 'shell', variable)})`];
  });
}

export function headerWord(line: SampleText, vars: VariableMode, variable: (name: string) => string): string {
  return conditionalWord(line, variable) ?? shellArg(line.unguarded(), vars, variable);
}

export function headerFile(words: readonly string[]): string {
  return `@<(${HEADER_LINES} ${words.join(' ')})`;
}

export function conditionalWord(text: SampleText, variable: (name: string) => string): string | undefined {
  const last = text.parts[text.parts.length - 1];
  const prefix = text.parts.slice(0, -1);
  if (last?.kind !== 'placeholder' || guarded(last) || last.encoding !== undefined) return undefined;
  if (!prefix.every((part) => part.kind === 'literal' && CONDITIONAL_SAFE.test(part.text) && [...part.text].every((ch) => ShellScript.isLiteralSafe(ch) && ch !== '\n'))) return undefined;
  const name = variable(last.name);
  return `"\${${name}:+${prefix.map((part) => (part.kind === 'literal' ? part.text : '')).join('')}$${name}}"`;
}

export function cookieWord(cookie: SampleText, variable: (name: string) => string, prefix = ''): string | undefined {
  const pairs = cookie.split(COOKIE_PAIR_SEPARATOR).map((pair) => ({ pair, conditional: conditionalPair(pair, variable) }));
  if (pairs.every((item) => item.conditional === undefined)) return undefined;
  if (!pairs.every((item) => item.pair.parts.every((part) => part.kind === 'placeholder' || CONDITIONAL_SAFE.test(part.text)))) return undefined;
  const fixed = (pair: SampleText): string => pair.unguarded().render({ literal: (text) => text, placeholder: (name, part) => variableReference(name, part, 'shell', variable) });
  const anchor = pairs.findIndex((item) => item.conditional === undefined);
  if (anchor < 0) return `"${prefix}${conditionalPairs(pairs.flatMap((item) => (item.conditional === undefined ? [] : [item.conditional])))}"`;
  const words = pairs.map((item, i) => {
    if (item.conditional === undefined) return i === anchor ? fixed(item.pair) : `${COOKIE_PAIR_SEPARATOR}${fixed(item.pair)}`;
    const { name, value } = item.conditional;
    return i < anchor ? `\${${value}:+${name}=$${value}${COOKIE_PAIR_SEPARATOR}}` : `\${${value}:+${COOKIE_PAIR_SEPARATOR}${name}=$${value}}`;
  });
  return `"${prefix}${words.join('')}"`;
}

interface ConditionalPair {
  readonly name: string;
  readonly value: string;
}

function conditionalPair(pair: SampleText, variable: (name: string) => string): ConditionalPair | undefined {
  const [first, second, ...rest] = pair.parts;
  if (rest.length > 0 || first?.kind !== 'literal' || second?.kind !== 'placeholder' || guarded(second) || second.encoding !== undefined) return undefined;
  const name = first.text.endsWith('=') ? first.text.slice(0, -1) : '';
  return CONDITIONAL_COOKIE_NAME.test(name) ? { name, value: variable(second.name) } : undefined;
}

function conditionalPairs(pairs: readonly ConditionalPair[]): string {
  const [first, second, ...rest] = pairs;
  if (first === undefined) return '';
  const { name, value } = first;
  if (second === undefined) return `\${${value}:+${name}=$${value}}`;
  if (rest.length === 0) return `\${${value}:+${name}=$${value}}\${${second.value}:+\${${value}:+${COOKIE_PAIR_SEPARATOR}}${second.name}=$${second.value}}`;
  const later = [second, ...rest].map((pair) => `\${${pair.value}:+${COOKIE_PAIR_SEPARATOR}${pair.name}=$${pair.value}}`).join('');
  return `\${${value}:+${name}=}\${${value}:-${conditionalPairs([second, ...rest])}}\${${value}:+${later}}`;
}

function guardWords(texts: readonly SampleText[], variable: (name: string) => string, explain: (variable: string) => boolean): string[] {
  const guards = new Map<string, string>();
  for (const text of texts) {
    for (const part of text.parts) {
      if (part.kind !== 'placeholder' || !guarded(part) || guards.has(variable(part.name))) continue;
      guards.set(variable(part.name), `"${variableReference(part.name, { ...part, encoding: undefined }, 'shell', variable, explain)}"`);
    }
  }
  return [...guards.values()];
}

function rawTexts(raw: RawBody | undefined): SampleText[] {
  return (raw?.chunks ?? []).flatMap((chunk) => (chunk.kind === 'text' ? [chunk.text] : [chunk.path]));
}

export function bodyText(body: SampleBody | undefined): SampleText | undefined {
  if (!body || body.value === undefined) return undefined;
  if ((body.kind === 'form' || body.kind === 'multipart') && isRecord(body.value)) return undefined;
  return body.value instanceof SampleText ? body.value : jsonText(body.value);
}

function bodyGroups(body: SampleBody | undefined, arg: (text: SampleTextInput) => string): string[][] {
  if (!body || body.value === undefined) return [];
  if (body.kind === 'form' && isRecord(body.value)) {
    const encoder = CharsetEncoder.for(body.charset);
    const encode = (text: string): string => encoder.formComponent(text);
    return formEntries(body.value).map((entry) => {
      const name = encode(entry.name);
      if (entry.value.isLiteral) return [RAW_FLAG, arg(`${name}=${encode(entry.value.toString())}`)];
      return [FORM_FLAG, arg(SampleText.concat(`${name}=`, entry.value))];
    });
  }
  if (body.kind === 'multipart' && isRecord(body.value)) {
    return formEntries(body.value).map((entry) => (entry.file ? [MULTIPART_FILE_FLAG, arg(fileField(entry))] : [MULTIPART_TEXT_FLAG, arg(SampleText.concat(`${entry.name}=`, entry.value))]));
  }
  const text = bodyText(body);
  return text ? [[RAW_FLAG, arg(text)]] : [];
}

function fileField(entry: FormEntry): SampleTextInput {
  if (!entry.value.isLiteral) return SampleText.concat(`${entry.name}=@`, entry.value);
  const filename = entry.value.toString();
  if (filename !== '') return `${entry.name}=@${uploadPath(filename)}`;
  const type = entry.contentType?.isLiteral === true && entry.contentType.toString() !== '' ? entry.contentType.toString() : BINARY_MIME;
  return `${entry.name}=@${EMPTY_UPLOAD};filename=;type=${type}`;
}

function multipartBody(entries: readonly FormEntry[], charset: string | undefined): RawBody {
  const text = (value: SampleTextInput): RawChunk => ({ kind: 'text', text: SampleText.of(value), ...(charset === undefined ? {} : { charset }) });
  const parts: { head: SampleText; value: RawChunk | undefined }[] = entries.map((entry) => {
    const disposition = `Content-Disposition: form-data; name="${multipartName(entry.name)}"`;
    if (!entry.file) return { head: SampleText.literal(`${disposition}\r\n\r\n`), value: text(entry.value) };
    const type = entry.contentType?.isLiteral === true && entry.contentType.toString() !== '' ? entry.contentType.toString() : BINARY_MIME;
    const tail = `"\r\nContent-Type: ${type}\r\n\r\n`;
    if (!entry.value.isLiteral) return { head: SampleText.concat(`${disposition}; filename="`, entry.value.unguarded().encoded('filename'), tail), value: { kind: 'file', path: entry.value } };
    const filename = entry.value.toString();
    return { head: SampleText.literal(`${disposition}; filename="${multipartName(filename)}${tail}`), value: filename === '' ? undefined : { kind: 'file', path: SampleText.literal(uploadName(filename)) } };
  });
  const mark = boundary(SampleText.concat(...parts.flatMap((part) => [part.head, part.value?.kind === 'text' ? part.value.text : ''])));
  const chunks: RawChunk[] = [];
  for (const part of parts) {
    chunks.push(text(SampleText.concat(`--${mark}\r\n`, part.head)));
    if (part.value) chunks.push(part.value);
    chunks.push(text('\r\n'));
  }
  chunks.push(text(`--${mark}--\r\n`));
  return { contentType: MULTIPART_CONTENT_TYPE + mark, chunks };
}

function printfCommands(raw: RawBody, vars: VariableMode, variable: (name: string) => string): string {
  const commands: string[] = [];
  const encodings = new Set<PlaceholderEncoding>();
  let format = '';
  let args: string[] = [];
  const flush = (): void => {
    if (format === '') return;
    commands.push(['printf', '--', shellQuote(format), ...args].join(' '));
    format = '';
    args = [];
  };
  for (const chunk of raw.chunks) {
    if (chunk.kind === 'file') {
      flush();
      commands.push(`${FILE_COMMAND} ${chunk.path.isLiteral ? shellQuote(chunk.path.toString()) : shellArg(chunk.path.unguarded(), vars === 'literal' ? 'literal' : 'shell', variable)}`);
      continue;
    }
    const encoder = CharsetEncoder.for(chunk.charset);
    for (const part of chunk.text.parts) {
      if (part.kind === 'literal') format += printfFormat(encoder.encode(part.text));
      else if (vars === 'literal') format += printfFormat(new TextEncoder().encode(SampleText.DISPLAY.placeholder(part.name, part)));
      else if (part.encoding !== undefined) {
        flush();
        commands.push(`${ENCODING_HELPERS[part.encoding]} ${variable(part.name)}`);
        encodings.add(part.encoding);
      } else {
        format += PRINTF_PLACEHOLDER;
        args.push(`"\${${variable(part.name)}}"`);
      }
    }
  }
  flush();
  const helpers = vars === 'shell' ? [...encodings].map((encoding) => encoderDefinition(encoding)) : [];
  return [...helpers, ...commands].join('; ');
}

function printfFormat(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    if (byte === PERCENT) out += '%%';
    else if (byte === BACKSLASH) out += '\\\\';
    else if (byte >= FIRST_PRINTABLE && byte <= LAST_PRINTABLE && byte !== SINGLE_QUOTE) out += String.fromCharCode(byte);
    else out += '\\' + byte.toString(8).padStart(3, '0');
  }
  return out;
}
