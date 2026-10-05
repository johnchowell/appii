import type { RequestSample } from './samples.js';
import { formEntries, isRecord, jsonText, placeholderNames as samplePlaceholderNames } from './samples.js';
import { SampleText } from './sample-text.js';
import type { SampleTextInput } from './sample-text.js';
import { ShellScript } from './shell-script.js';
import { shellQuote } from './text.js';

export type VariableMode = 'literal' | 'shell';

export interface CurlOptions {
  variables?: VariableMode;
  cookie?: SampleText;
  multiline?: boolean;
  extraArgs?: readonly string[];
}

export const FORM_FLAG = '--data-urlencode';
export const MULTIPART_TEXT_FLAG = '--form-string';
export const MULTIPART_FILE_FLAG = '-F';
export const RAW_FLAG = '--data-raw';
export const DEFAULT_UPLOAD = 'file.bin';
export const SAFE_UPLOAD_NAME: RegExp = /^[A-Za-z0-9._+-]+$/;
export const CONTINUATION = ' \\\n  ';
export const SAFE_WORD: RegExp = /^[A-Za-z0-9_.-]+$/;
export const DOUBLE_QUOTE_SPECIAL: RegExp = /[!"$\\`]/;

export function variableName(name: string): string {
  return name.toUpperCase();
}

export function shellArg(input: SampleTextInput, variables: VariableMode = 'literal'): string {
  const text = SampleText.of(input);
  if (variables === 'literal' || text.isLiteral) return shellQuote(text.toString());
  const reference = (name: string): string => `\${${variableName(name)}}`;
  if (text.parts.every((part) => part.kind === 'placeholder' || !DOUBLE_QUOTE_SPECIAL.test(part.text))) {
    return `"${text.render({ literal: (literal) => literal, placeholder: reference })}"`;
  }
  return text.parts.map((part) => (part.kind === 'literal' ? shellQuote(part.text) : `"${reference(part.name)}"`)).join('');
}

export function shellWord(text: string): string {
  return SAFE_WORD.test(text) ? text : shellQuote(text);
}

export function placeholderNames(sample: RequestSample, extra: readonly SampleText[] = []): string[] {
  return samplePlaceholderNames(sample, extra).map(variableName).sort();
}

export function uploadPath(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? '';
  const name = base === '' || base === '.' || base === '..' ? DEFAULT_UPLOAD : base;
  return SAFE_UPLOAD_NAME.test(name) ? name : `"${name.replace(/["\\]/g, (c) => '\\' + c)}"`;
}

export function curlCommand(sample: RequestSample, opts: CurlOptions = {}): string {
  const vars = opts.variables ?? 'literal';
  const arg = (text: SampleTextInput): string => shellArg(text, vars);
  const head: string[] = ['curl', '-sS'];
  if (sample.method !== 'GET' || sample.body) head.push('-X', shellWord(sample.method));
  head.push(arg(sample.url));
  const groups: string[][] = [head];
  for (const header of sample.headers) groups.push(['-H', arg(SampleText.concat(`${header.name}: `, header.value))]);
  if (opts.cookie) groups.push(['-b', arg(opts.cookie)]);
  const body = sample.body;
  if (body?.kind === 'form' && isRecord(body.value)) {
    for (const entry of formEntries(body.value)) groups.push([FORM_FLAG, arg(SampleText.concat(`${encodeURIComponent(entry.name)}=`, entry.value))]);
  } else if (body?.kind === 'multipart' && isRecord(body.value)) {
    for (const entry of formEntries(body.value)) {
      groups.push(
        entry.file
          ? [MULTIPART_FILE_FLAG, arg(`${entry.name}=@${uploadPath(entry.value.toString())}`)]
          : [MULTIPART_TEXT_FLAG, arg(SampleText.concat(`${entry.name}=`, entry.value))],
      );
    }
  } else if (body && body.value !== undefined) {
    groups.push([RAW_FLAG, arg(body.value instanceof SampleText ? body.value : jsonText(body.value))]);
  }
  for (const extra of opts.extraArgs ?? []) groups.push([extra]);
  const parts = groups.map((group) => group.join(' '));
  return ShellScript.ascii(opts.multiline === false ? parts.join(' ') : parts.join(CONTINUATION));
}
