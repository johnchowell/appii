import { SecretValues } from '../build/index.js';
import type { LoginField, LoginOutcome } from '../capture/index.js';
import { TextLayout } from '../present/index.js';
import { Http, Samples } from '../shared/index.js';
import type { CliContext } from './cli-context.js';

export class LoginReport {
  static readonly LABEL = 'Login';
  static readonly WARNING_PREFIX = 'warning: ';
  static readonly HIDDEN = Samples.REDACTED;
  static readonly PAIR_SEPARATOR = '&';
  static readonly SEGMENT_SEPARATOR = '/';

  readonly #values: ReadonlySet<string>;
  readonly #secrets: SecretValues;

  constructor(fields: readonly LoginField[] = []) {
    const values = fields.map((field) => field.value).filter((value) => value !== '');
    this.#values = new Set(values);
    this.#secrets = new SecretValues(values);
  }

  static create(fields: readonly LoginField[] = []): LoginReport {
    return new LoginReport(fields);
  }

  get empty(): boolean {
    return this.#values.size === 0;
  }

  text(text: string): string {
    return this.#secrets.scrub(text, LoginReport.HIDDEN);
  }

  url(value: string): string {
    if (this.empty) return value;
    const parsed = Http.parseUrl(value);
    if (parsed === undefined) return this.text(value);
    const path = parsed.pathname
      .split(LoginReport.SEGMENT_SEPARATOR)
      .map((segment) => (this.#hides(Http.decodeComponent(segment)) ? LoginReport.HIDDEN : segment))
      .join(LoginReport.SEGMENT_SEPARATOR);
    const search = parsed.search.length > 1 ? `?${this.#pairs(parsed.search.slice(1))}` : parsed.search;
    const hash = parsed.hash.length > 1 ? `#${this.#pairs(parsed.hash.slice(1))}` : parsed.hash;
    return this.text(`${parsed.protocol}//${parsed.host}${path}${search}${hash}`);
  }

  warnings(outcome: LoginOutcome): string[] {
    return outcome.warnings.map((warning) => LoginReport.WARNING_PREFIX + this.text(warning));
  }

  sentence(outcome: LoginOutcome): string {
    const how = outcome.trigger === 'button' ? 'by clicking its submit button' : 'by pressing Enter in its last filled field';
    const submission = outcome.submission;
    const answer =
      submission === undefined
        ? 'no request carried it'
        : `${submission.method} ${this.url(submission.url)} ${submission.status === undefined ? 'got no response' : `answered ${submission.status}`}`;
    return `submitted the form on ${this.url(outcome.pageUrl)} (${outcome.fields.join(', ')}) ${how}; ${answer}; now on ${this.url(outcome.finalUrl)}`;
  }

  render(outcome: LoginOutcome, ctx: CliContext): string {
    return TextLayout.definitions([[LoginReport.LABEL, ctx.ansi.clean(this.sentence(outcome))]], ctx.width, { label: (label) => ctx.ansi.dim(label) }).join('\n');
  }

  #pairs(text: string): string {
    return text
      .split(LoginReport.PAIR_SEPARATOR)
      .map((pair) => {
        const eq = pair.indexOf('=');
        const raw = eq < 0 ? pair : pair.slice(eq + 1);
        if (!this.#hides(Http.decodeComponent(raw.replace(/\+/g, ' ')))) return pair;
        return eq < 0 ? LoginReport.HIDDEN : `${pair.slice(0, eq + 1)}${LoginReport.HIDDEN}`;
      })
      .join(LoginReport.PAIR_SEPARATOR);
  }

  #hides(value: string): boolean {
    return value !== '' && (this.#values.has(value) || this.#secrets.contains(value));
  }
}
