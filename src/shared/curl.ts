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

export type RawChunk = { readonly kind: 'text'; readonly text: SampleText; readonly charset?: string } | { readonly kind: 'file'; readonly path: string };

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
export const ENCODING_HELPERS: Readonly<Record<PlaceholderEncoding, string>> = Object.freeze({ component: 'appii_pct', form: 'appii_form', json: 'appii_json' });
export const COPY_BYTE = `printf -v byte '%b' "\\\\x$byte"`;
export const PERCENT_BYTE = `printf -v byte '%%%02X' "0x$byte"`;
export const ENCODER_CASES: Readonly<Record<PlaceholderEncoding, readonly string[]>> = Object.freeze({
  component: [`2d|2e|3[0-9]|4[1-9a-f]|5[0-9a]|5f|6[1-9a-f]|7[0-9a]|7e) ${COPY_BYTE} ;;`, `*) ${PERCENT_BYTE} ;;`],
  form: ["20) byte='+' ;;", `2a|2d|2e|3[0-9]|4[1-9a-f]|5[0-9a]|5f|6[1-9a-f]|7[0-9a]) ${COPY_BYTE} ;;`, `*) ${PERCENT_BYTE} ;;`],
  json: [`22) byte='\\"' ;;`, `5c) byte='\\\\' ;;`, `[01][0-9a-f]|7f) printf -v byte '\\\\u%04x' "0x$byte" ;;`, `*) ${COPY_BYTE} ;;`],
});
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

export const HELPER_FUNCTIONS: readonly string[] = Object.freeze([
  ...encoderHelper('component'),
  '',
  ...encoderHelper('form'),
  '',
  ...encoderHelper('json'),
  '',
  ...argumentHelper(),
]);

export function encoderHelper(encoding: PlaceholderEncoding): string[] {
  return [
    `${ENCODING_HELPERS[encoding]}() {`,
    "  local byte out=''",
    `  for byte in $(printf '%s' "\${!1-}" | od -An -v -tx1); do`,
    '    case $byte in',
    ...ENCODER_CASES[encoding].map((line) => `      ${line}`),
    '    esac',
    '    out+=$byte',
    '  done',
    `  printf '%s' "$out"`,
    '}',
  ];
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
  if (variables !== 'shell' || (part.required === undefined && part.missing === undefined)) return `\${${variable(name)}}`;
  const message = part.required === undefined && part.missing !== undefined && explain(variable(name)) ? ShellScript.expansionWord(part.missing) : '';
  return `\${${variable(name)}${REQUIRED_OPERATOR}${message}}`;
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
  const head: string[] = ['curl', '-sS'];
  if (sample.method === HEAD_METHOD) head.push(HEAD_FLAG);
  else if (sample.method !== GET_METHOD || sample.body) head.push('-X', shellWord(sample.method));
  head.push(arg(sample.url));
  const groups: string[][] = [head];
  const raw = rawBody(sample.body);
  for (const header of sample.headers) groups.push(['-H', arg(SampleText.concat(`${header.name}: `, header.value))]);
  if (raw?.contentType !== undefined) groups.push(['-H', arg(`Content-Type: ${raw.contentType}`)]);
  if (sample.user) groups.push([USER_FLAG, arg(sample.user)]);
  const cookie = opts.cookie ?? sample.cookie;
  if (cookie) groups.push(['-b', arg(cookie)]);
  if (opts.jar !== undefined) groups.push(['-b', opts.jar, '-c', opts.jar]);
  if (raw) groups.push([BINARY_FLAG, `@<(${printfCommands(raw, vars, variable, explain)})`]);
  else groups.push(...bodyGroups(sample.body, arg, vars));
  groups.push([COMPRESSED_FLAG]);
  for (const extra of opts.extraArgs ?? []) groups.push([extra]);
  const parts = groups.map((group) => group.join(' '));
  return ShellScript.ascii(opts.multiline === false ? parts.join(' ') : parts.join(CONTINUATION));
}

function bodyGroups(body: SampleBody | undefined, arg: (text: SampleTextInput) => string, vars: VariableMode): string[][] {
  if (!body || body.value === undefined) return [];
  if (body.kind === 'form' && isRecord(body.value)) {
    const encoder = CharsetEncoder.for(body.charset);
    const encode = (text: string): string => encoder.formComponent(text);
    return formEntries(body.value).map((entry) => {
      const name = encode(entry.name);
      if (entry.value.isLiteral) return [RAW_FLAG, arg(`${name}=${encode(entry.value.toString())}`)];
      if (vars === 'script') return [RAW_FLAG, arg(SampleText.concat(`${name}=`, entry.value.mapLiterals(encode).encoded('form')))];
      return [FORM_FLAG, arg(SampleText.concat(`${name}=`, entry.value))];
    });
  }
  if (body.kind === 'multipart' && isRecord(body.value)) {
    return formEntries(body.value).map((entry) => (entry.file ? [MULTIPART_FILE_FLAG, arg(fileField(entry))] : [MULTIPART_TEXT_FLAG, arg(SampleText.concat(`${entry.name}=`, entry.value))]));
  }
  return [[RAW_FLAG, arg(body.value instanceof SampleText ? body.value : jsonText(body.value))]];
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
  const parts: { head: string; value: RawChunk | undefined }[] = entries.map((entry) => {
    const disposition = `Content-Disposition: form-data; name="${multipartName(entry.name)}"`;
    if (!entry.file) return { head: `${disposition}\r\n\r\n`, value: text(entry.value) };
    const filename = entry.value.toString();
    const type = entry.contentType?.isLiteral === true && entry.contentType.toString() !== '' ? entry.contentType.toString() : BINARY_MIME;
    return { head: `${disposition}; filename="${multipartName(filename)}"\r\nContent-Type: ${type}\r\n\r\n`, value: filename === '' ? undefined : { kind: 'file', path: uploadName(filename) } };
  });
  const mark = boundary(SampleText.concat(...parts.flatMap((part) => [part.head, part.value?.kind === 'text' ? part.value.text : ''])));
  const chunks: RawChunk[] = [];
  for (const part of parts) {
    chunks.push(text(`--${mark}\r\n${part.head}`));
    if (part.value) chunks.push(part.value);
    chunks.push(text('\r\n'));
  }
  chunks.push(text(`--${mark}--\r\n`));
  return { contentType: MULTIPART_CONTENT_TYPE + mark, chunks };
}

function printfCommands(raw: RawBody, vars: VariableMode, variable: (name: string) => string, explain: (variable: string) => boolean): string {
  const commands: string[] = [];
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
      commands.push(`cat ${shellQuote(chunk.path)}`);
      continue;
    }
    const encoder = CharsetEncoder.for(chunk.charset);
    for (const part of chunk.text.parts) {
      if (part.kind === 'literal') format += printfFormat(encoder.encode(part.text));
      else if (vars === 'literal') format += printfFormat(new TextEncoder().encode(SampleText.DISPLAY.placeholder(part.name, part)));
      else {
        format += PRINTF_PLACEHOLDER;
        args.push(`"${variableReference(part.name, { ...part, encoding: undefined }, vars, variable, explain)}"`);
      }
    }
  }
  flush();
  return commands.join('; ');
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
