const IRREGULAR_SINGULARS: Record<string, string> = {
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
};

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
}

export const LINE_BREAK_SOURCE = '\\r\\n|[\\r\\n\\t]';
export const NEWLINE_SOURCE = '\\r\\n?';
export const CONTROL_SOURCE = '[\\x00-\\x1f\\x7f-\\x9f]';
export const BLOCK_CONTROL_SOURCE = '[\\x00-\\x09\\x0b-\\x1f\\x7f-\\x9f]';
export const TEXT_CONTROL_SOURCE = '[\\x00-\\x08\\x0b-\\x1f\\x7f-\\x9f]';

export function controlEscape(ch: string): string {
  return '\\x' + ch.charCodeAt(0).toString(16).padStart(2, '0');
}

export function printable(input: string, options: PrintableOptions = {}): string {
  const mode = options.lineBreaks ?? 'space';
  const text =
    mode === 'space' ? input.replace(new RegExp(LINE_BREAK_SOURCE, 'g'), ' ') : mode === 'normalize' ? input.replace(new RegExp(NEWLINE_SOURCE, 'g'), '\n') : input;
  return toAscii(text.replace(new RegExp(mode === 'space' ? CONTROL_SOURCE : BLOCK_CONTROL_SOURCE, 'g'), controlEscape), 'escape');
}

export const JSON_RAW_CONTROL_SOURCE = '[\\x7f-\\x9f]';

export function escapeJsonControls(json: string): string {
  return json.replace(new RegExp(JSON_RAW_CONTROL_SOURCE, 'g'), (ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0'));
}

export function jsString(input: string): string {
  return toAscii(escapeJsonControls(JSON.stringify(input)), 'escape');
}

export function isIdentifier(input: string): boolean {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input) && !RESERVED_WORDS.has(input);
}

export function propertyKey(input: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(input) ? input : jsString(input);
}

export const RESERVED_WORDS: ReadonlySet<string> = new Set([
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

export function redact(value: string, keep = 4): string {
  if (value.length <= keep) return '<redacted>';
  return value.slice(0, keep) + '...';
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
