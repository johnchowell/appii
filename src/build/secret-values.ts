import { Json, Samples, Text } from '../shared/index.js';

export class SecretValues {
  static readonly MIN_LENGTH = 6;
  static readonly COMMON_VALUES: ReadonlySet<string> = new Set([
    'deleted', 'undefined', 'expired', 'invalid', 'anonymous', 'default', 'enabled', 'disabled', 'loggedout', 'logged_out', 'guest',
  ]);
  static readonly REGEX_SPECIAL: RegExp = /[.*+?^${}()|[\]\\]/g;
  static readonly EMPTY: SecretValues = new SecretValues();

  readonly #values: ReadonlySet<string>;
  readonly #forms: ReadonlySet<string>;
  readonly #pattern: RegExp | undefined;

  constructor(values: Iterable<string> = []) {
    const kept = new Set<string>();
    for (const value of values) if (SecretValues.worthHiding(value)) kept.add(value);
    const forms = new Set<string>();
    for (const value of kept) for (const form of SecretValues.variants(value)) forms.add(form);
    this.#values = kept;
    this.#forms = forms;
    const sorted = [...forms].sort((a, b) => b.length - a.length || Text.compare(a, b));
    this.#pattern = sorted.length === 0 ? undefined : new RegExp(sorted.map((form) => form.replace(SecretValues.REGEX_SPECIAL, '\\$&')).join('|'), 'g');
  }

  static worthHiding(value: string): boolean {
    const trimmed = value.trim();
    return trimmed.length >= SecretValues.MIN_LENGTH && trimmed === value && !SecretValues.COMMON_VALUES.has(value.toLowerCase()) && !Samples.isRedacted(value);
  }

  static variants(value: string): string[] {
    const out = new Set<string>([value]);
    out.add(encodeURIComponent(value));
    out.add(encodeURIComponent(value).replace(/%20/g, '+'));
    out.add(JSON.stringify(value).slice(1, -1));
    out.add(Text.escapeHtml(value));
    const latin1 = Buffer.from(value, 'utf8').toString('latin1');
    if (latin1 !== value) out.add(latin1);
    return [...out];
  }

  get size(): number {
    return this.#values.size;
  }

  values(): string[] {
    return [...this.#values];
  }

  has(value: string): boolean {
    return this.#values.has(value) || this.#forms.has(value);
  }

  contains(text: string): boolean {
    return this.#pattern !== undefined && text.search(this.#pattern) >= 0;
  }

  scrub(text: string, replacement: string = Samples.REDACTED): string {
    if (!this.#pattern || text.length < SecretValues.MIN_LENGTH) return text;
    return text.replace(this.#pattern, () => replacement);
  }

  scrubDeep(value: unknown): unknown {
    if (this.#values.size === 0) return value;
    if (typeof value === 'string') return this.scrub(value);
    if (Array.isArray(value)) return value.map((item) => this.scrubDeep(item));
    if (Json.isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.scrubDeep(item)]));
    return value;
  }
}
