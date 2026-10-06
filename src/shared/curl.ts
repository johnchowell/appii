import { createHash } from 'node:crypto';
import { CharsetEncoder } from './charset.js';
import type { FormEntry, RequestSample, SampleBody } from './samples.js';
import { BINARY_MIME, formEntries, isRecord, jsonText, placeholderNames as samplePlaceholderNames } from './samples.js';
import { SampleText } from './sample-text.js';
import type { PlaceholderEncoding, PlaceholderPart, SampleTextInput } from './sample-text.js';
import { ShellScript } from './shell-script.js';
import { shellQuote } from './text.js';

export type VariableMode = 'literal' | 'shell' | 'script';

export interface CurlOptions {
  variables?: VariableMode;
  variable?: (name: string) => string;
  cookie?: SampleText;
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
export const ENCODING_HELPERS: Readonly<Record<PlaceholderEncoding, string>> = Object.freeze({ component: 'appii_pct', json: 'appii_json' });
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

export const HELPER_FUNCTIONS: readonly string[] = Object.freeze([
  `${ENCODING_HELPERS.component}() {`,
  "  local byte out=''",
  `  for byte in $(printf '%s' "\${!1-}" | od -An -v -tx1); do`,
  '    case $byte in',
  `      2d|2e|3[0-9]|4[1-9a-f]|5[0-9a]|5f|6[1-9a-f]|7[0-9a]|7e) printf -v byte '%b' "\\\\x$byte" ;;`,
  `      *) printf -v byte '%%%02X' "0x$byte" ;;`,
  '    esac',
  '    out+=$byte',
  '  done',
  `  printf '%s' "$out"`,
  '}',
  '',
  `${ENCODING_HELPERS.json}() {`,
  "  local byte out=''",
  `  for byte in $(printf '%s' "\${!1-}" | od -An -v -tx1); do`,
  '    case $byte in',
  `      22) byte='\\"' ;;`,
  `      5c) byte='\\\\' ;;`,
  `      [01][0-9a-f]|7f) printf -v byte '\\\\u%04x' "0x$byte" ;;`,
  `      *) printf -v byte '%b' "\\\\x$byte" ;;`,
  '    esac',
  '    out+=$byte',
  '  done',
  `  printf '%s' "$out"`,
  '}',
]);

export function variableName(name: string): string {
  return VARIABLE_PREFIX + name.toUpperCase();
}

export function shellArg(input: SampleTextInput, variables: VariableMode = 'literal', variable: (name: string) => string = variableName): string {
  const text = SampleText.of(input);
  if (variables === 'literal' || text.isLiteral) return shellQuote(text.toString());
  const reference = (name: string, part: PlaceholderPart): string => {
    const helper = variables === 'script' && part.encoding !== undefined ? ENCODING_HELPERS[part.encoding] : undefined;
    return helper === undefined ? `\${${variable(name)}}` : `$(${helper} ${variable(name)})`;
  };
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
  const arg = (text: SampleTextInput): string => shellArg(text, vars, variable);
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
  if (raw) groups.push([BINARY_FLAG, `@<(${printfCommands(raw, vars, variable)})`]);
  else groups.push(...bodyGroups(sample.body, arg));
  groups.push([COMPRESSED_FLAG]);
  for (const extra of opts.extraArgs ?? []) groups.push([extra]);
  const parts = groups.map((group) => group.join(' '));
  return ShellScript.ascii(opts.multiline === false ? parts.join(' ') : parts.join(CONTINUATION));
}

function bodyGroups(body: SampleBody | undefined, arg: (text: SampleTextInput) => string): string[][] {
  if (!body || body.value === undefined) return [];
  if (body.kind === 'form' && isRecord(body.value)) {
    const encoder = CharsetEncoder.for(body.charset);
    return formEntries(body.value).map((entry) => {
      const name = encoder.formComponent(entry.name);
      return entry.value.isLiteral ? [RAW_FLAG, arg(`${name}=${encoder.formComponent(entry.value.toString())}`)] : [FORM_FLAG, arg(SampleText.concat(`${name}=`, entry.value))];
    });
  }
  if (body.kind === 'multipart' && isRecord(body.value)) {
    return formEntries(body.value).map((entry) => (entry.file ? [MULTIPART_FILE_FLAG, arg(fileField(entry))] : [MULTIPART_TEXT_FLAG, arg(SampleText.concat(`${entry.name}=`, entry.value))]));
  }
  return [[RAW_FLAG, arg(body.value instanceof SampleText ? body.value : jsonText(body.value))]];
}

function fileField(entry: FormEntry): string {
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

function printfCommands(raw: RawBody, vars: VariableMode, variable: (name: string) => string): string {
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
        args.push(`"\${${variable(part.name)}}"`);
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
