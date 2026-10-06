const IRREGULAR_SINGULARS: Readonly<Record<string, string>> = Object.freeze({
  people: 'person',
  children: 'child',
  men: 'man',
  women: 'woman',
  data: 'data',
  media: 'media',
  news: 'news',
  series: 'series',
  status: 'status',
  analysis: 'analysis',
  address: 'address',
  business: 'business',
  access: 'access',
  process: 'process',
  class: 'class',
});

export const SHORT_VALUE = 24;
export const SUMMARY_ITEMS = 3;
export const UNKNOWN_ERROR = 'Unknown error';

export function words(input: string): string[] {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function letterWords(input: string): string[] {
  return words(input)
    .flatMap((word) => word.split(/[0-9]+/))
    .filter(Boolean);
}

export function camelCase(input: string): string {
  const parts = words(input);
  const joined = parts.map((w, i) => (i === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1))).join('');
  return /^[0-9]/.test(joined) ? '_' + joined : joined;
}

export function pascalCase(input: string): string {
  const c = camelCase(input);
  if (c.startsWith('_')) return c;
  return c.charAt(0).toUpperCase() + c.slice(1);
}

export function kebabCase(input: string): string {
  return words(input).join('-');
}

export function snakeCase(input: string): string {
  return words(input).join('_');
}

export function singularize(word: string): string {
  const lower = word.toLowerCase();
  const irregular = IRREGULAR_SINGULARS[lower];
  if (irregular) return matchCase(word, irregular);
  if (lower.length <= 3) return word;
  if (/ies$/.test(lower)) return word.slice(0, -3) + matchCase(word.slice(-3), 'y');
  if (/(ss|us|is)$/.test(lower)) return word;
  if (/(ches|shes|xes|zes|sses)$/.test(lower)) return word.slice(0, -2);
  if (/[^aeiou]uses$/.test(lower)) return word.slice(0, -2);
  if (/oes$/.test(lower)) return word.slice(0, -2);
  if (/s$/.test(lower)) return word.slice(0, -1);
  return word;
}

function matchCase(source: string, target: string): string {
  return source === source.toUpperCase() && /[A-Z]/.test(source) ? target.toUpperCase() : target;
}

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function plural(count: number, singular: string, pluralForm = singular + 's'): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function truncate(input: string, max: number, ellipsis = '...'): string {
  if (max <= 0) return '';
  if (input.length <= max) return input;
  if (max <= ellipsis.length) return ellipsis.slice(0, max);
  return input.slice(0, max - ellipsis.length) + ellipsis;
}

export function short(value: unknown, max = SHORT_VALUE): string {
  const text = typeof value === 'string' ? value : (JSON.stringify(value) ?? String(value));
  return truncate(text, max);
}

export function summarize(items: readonly string[], max = SUMMARY_ITEMS): string {
  const head = items.slice(0, max).join('; ');
  return items.length > max ? `${head}; and ${items.length - max} more` : head;
}

export function errorMessage(err: unknown, options: { firstLine?: boolean } = {}): string {
  const text = err instanceof Error ? err.message : String(err);
  const chosen = options.firstLine === true ? (text.split('\n')[0] ?? '').trim() : text;
  return chosen.trim() === '' ? UNKNOWN_ERROR : chosen;
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export function indent(text: string, spaces = 2): string {
  const pad = ' '.repeat(spaces);
  return text
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n');
}

export const HTML_ENTITIES: Readonly<Record<string, string>> = Object.freeze({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' });
export const HTML_SPECIAL_SOURCE = '[&<>"\']';
export const HTML_CARRIAGE_RETURN = '&#13;';
export const MARKDOWN_SPECIAL_SOURCE = '[\\\\`|*_[\\]<>#~!&]';
export const MARKDOWN_LINE_BREAK_SOURCE = '\\r\\n|[\\r\\n]';

export function escapeHtml(input: string): string {
  const escaped = input
    .replace(new RegExp(HTML_SPECIAL_SOURCE, 'g'), (ch) => HTML_ENTITIES[ch] ?? ch)
    .replace(/\r/g, HTML_CARRIAGE_RETURN);
  return toAscii(escapeControls(escaped), 'html');
}

export function escapeMarkdown(input: string): string {
  const flat = input.replace(new RegExp(MARKDOWN_LINE_BREAK_SOURCE, 'g'), ' ').replace(new RegExp(MARKDOWN_SPECIAL_SOURCE, 'g'), (ch) => '\\' + ch);
  return toAscii(escapeControls(flat), 'html');
}

export function escapeControls(input: string, source: string = TEXT_CONTROL_SOURCE): string {
  return input.replace(new RegExp(source, 'g'), controlEscape);
}

export function shellQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`;
}

export function isAscii(input: string): boolean {
  for (let i = 0; i < input.length; i++) if (input.charCodeAt(i) > 0x7f) return false;
  return true;
}

export function toAscii(input: string, mode: 'escape' | 'html' | 'replace' = 'escape'): string {
  if (isAscii(input)) return input;
  let out = '';
  for (const ch of input) {
    const cp = ch.codePointAt(0)!;
    if (cp <= 0x7f) out += ch;
    else if (mode === 'html') out += `&#${cp};`;
    else if (mode === 'replace') out += '?';
    else if (cp <= 0xffff) out += '\\u' + cp.toString(16).padStart(4, '0');
    else {
      const v = cp - 0x10000;
      out += '\\u' + (0xd800 + (v >> 10)).toString(16) + '\\u' + (0xdc00 + (v & 0x3ff)).toString(16);
    }
  }
  return out;
}

export type LineBreaks = 'space' | 'normalize' | 'lf';

export interface PrintableOptions {
  lineBreaks?: LineBreaks;
  unicode?: boolean;
}

export const LINE_BREAK_SOURCE = '\\r\\n|[\\r\\n\\t]';
export const NEWLINE_SOURCE = '\\r\\n?';
export const CONTROL_SOURCE = '[\\x00-\\x1f\\x7f-\\x9f]';
export const BLOCK_CONTROL_SOURCE = '[\\x00-\\x09\\x0b-\\x1f\\x7f-\\x9f]';
export const TEXT_CONTROL_SOURCE = '[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]';

export function controlEscape(ch: string): string {
  return '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
}

export const UNSAFE_UNICODE_SOURCE = '[\\p{Cf}\\p{Zl}\\p{Zp}\\p{Co}\\p{Cn}\\p{Cs}]';
export const ZERO_WIDTH: RegExp = /^[\p{Mn}\p{Me}]$/u;
export const WIDE: RegExp =
  /^[\u1100-\u115f\u231a\u231b\u2329\u232a\u23e9-\u23ec\u23f0\u23f3\u25fd\u25fe\u2614\u2615\u2648-\u2653\u267f\u2693\u26a1\u26aa\u26ab\u26bd\u26be\u26c4\u26c5\u26ce\u26d4\u26ea\u26f2\u26f3\u26f5\u26fa\u26fd\u2705\u270a\u270b\u2728\u274c\u274e\u2753-\u2755\u2757\u2795-\u2797\u27b0\u27bf\u2b1b\u2b1c\u2b50\u2b55\u2e80-\u303e\u3041-\u33ff\u3400-\u4dbf\u4e00-\u9fff\ua000-\ua4cf\ua960-\ua97f\uac00-\ud7a3\uf900-\ufaff\ufe10-\ufe19\ufe30-\ufe6f\uff00-\uff60\uffe0-\uffe6\u{16fe0}-\u{16fe4}\u{17000}-\u{18cff}\u{1b000}-\u{1b2ff}\u{1f004}\u{1f0cf}\u{1f18e}\u{1f191}-\u{1f19a}\u{1f200}-\u{1f251}\u{1f300}-\u{1f64f}\u{1f680}-\u{1f6ff}\u{1f7e0}-\u{1f7eb}\u{1f90c}-\u{1f9ff}\u{1fa70}-\u{1faff}\u{20000}-\u{2fffd}\u{30000}-\u{3fffd}]$/u;

export function printable(input: string, options: PrintableOptions = {}): string {
  const mode = options.lineBreaks ?? 'space';
  const text =
    mode === 'space' ? input.replace(new RegExp(LINE_BREAK_SOURCE, 'g'), ' ') : mode === 'normalize' ? input.replace(new RegExp(NEWLINE_SOURCE, 'g'), '\n') : input;
  const controlled = text.replace(new RegExp(mode === 'space' ? CONTROL_SOURCE : BLOCK_CONTROL_SOURCE, 'g'), controlEscape);
  if (options.unicode !== true) return toAscii(controlled, 'escape');
  return controlled.replace(new RegExp(UNSAFE_UNICODE_SOURCE, 'gu'), (ch) => toAscii(ch, 'escape'));
}

export function charWidth(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp < 0x300) return 1;
  if (ZERO_WIDTH.test(ch)) return 0;
  return WIDE.test(ch) ? 2 : 1;
}

export function displayWidth(input: string): number {
  if (isAscii(input)) return input.length;
  let width = 0;
  for (const ch of input) width += charWidth(ch);
  return width;
}

export function sliceWidth(input: string, max: number): string {
  if (isAscii(input)) return input.slice(0, Math.max(0, max));
  let out = '';
  let width = 0;
  for (const ch of input) {
    const w = charWidth(ch);
    if (width + w > max) break;
    out += ch;
    width += w;
  }
  return out;
}

export const JSON_RAW_CONTROL_SOURCE = '[\\x7f-\\x9f]';

export function escapeJsonControls(json: string): string {
  return json.replace(new RegExp(JSON_RAW_CONTROL_SOURCE, 'g'), (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function jsString(input: string): string {
  return toAscii(escapeJsonControls(JSON.stringify(input)), 'escape');
}

export function isIdentifier(input: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input) && !RESERVED_WORDS.includes(input);
}

export function propertyKey(input: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input) ? input : jsString(input);
}

export const RESERVED_WORDS: readonly string[] = Object.freeze([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum', 'export',
  'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null', 'return', 'super',
  'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield', 'let', 'static',
  'implements', 'interface', 'package', 'private', 'protected', 'public', 'await', 'any', 'boolean', 'number',
  'string', 'symbol', 'unknown', 'never', 'object', 'undefined',
]);

export function uniqueName(base: string, taken: Set<string>, separator = ''): string {
  if (!taken.has(base)) {
    taken.add(base);
    return base;
  }
  for (let i = 2; ; i++) {
    const candidate = `${base}${separator}${i}`;
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
}

export const MASK = '<redacted>';
export const MASK_PREFIX_LENGTH = 4;
export const MASK_PREFIX_MIN_LENGTH = 24;
export const MASKED_PREFIX: RegExp = /^[\s\S]{4}\.\.\. \([0-9]+ characters\)$/;

export function redact(value: string, secret = true): string {
  if (value === '') return '';
  const length = ` (${plural(value.length, 'character')})`;
  if (secret || value.length < MASK_PREFIX_MIN_LENGTH) return MASK + length;
  return value.slice(0, MASK_PREFIX_LENGTH) + '...' + length;
}

export function isMasked(value: string): boolean {
  return value.includes(MASK) || MASKED_PREFIX.test(value);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v >= 10 ? 0 : 1)} ${units[i]}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s >= 10 ? 0 : 1)} s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  if (m < 60) return `${m} min ${rem} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export const MIN_PREFIX_LENGTH = 2;

export function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  const at = (i: number, j: number): number => d[i]?.[j] ?? Number.POSITIVE_INFINITY;
  for (let i = 1; i < rows; i++) {
    const row = d[i];
    if (!row) continue;
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, at(i - 2, j - 2) + 1);
      row[j] = best;
    }
  }
  return at(a.length, b.length);
}

export function closest(input: string, candidates: readonly string[]): string | undefined {
  const needle = input.toLowerCase();
  if (needle === '') return undefined;
  const exact = candidates.find((candidate) => candidate.toLowerCase() === needle);
  if (exact !== undefined) return exact;
  if (needle.length >= MIN_PREFIX_LENGTH) {
    const prefixed = candidates.filter((candidate) => candidate.toLowerCase().startsWith(needle));
    if (prefixed.length === 1) return prefixed[0];
  }
  const limit = needle.length <= 3 ? 1 : 2;
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const distance = editDistance(needle, candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return bestDistance <= limit ? best : undefined;
}

export function singularizePhrase(phrase: string): string {
  const match = /^(.*[-_. ])([^-_. ]+)$/.exec(phrase);
  return match ? (match[1] ?? '') + singularize(match[2] ?? '') : singularize(phrase);
}
