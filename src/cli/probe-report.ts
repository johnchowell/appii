import type { ProbeOutcome } from '../capture/index.js';
import { TextLayout } from '../present/index.js';
import { Http } from '../shared/index.js';
import type { CliContext } from './cli-context.js';

export class ProbeReport {
  static readonly LABEL = 'Probe';
  static readonly WARNING_PREFIX = 'warning: ';

  static create(): ProbeReport {
    return new ProbeReport();
  }

  static request(method: string, url: string, pageUrl: string): string {
    const parsed = Http.parseUrl(url);
    if (parsed === undefined) return `${method} ${url}`;
    const page = Http.parseUrl(pageUrl);
    return `${method} ${page?.origin === parsed.origin ? parsed.pathname : parsed.origin + parsed.pathname}`;
  }

  warnings(outcome: ProbeOutcome): string[] {
    return outcome.warnings.map((warning) => ProbeReport.WARNING_PREFIX + warning);
  }

  sentence(outcome: ProbeOutcome): string {
    if (!outcome.found) return `no login form on ${outcome.pageUrl}; nothing was probed`;
    const how = outcome.trigger === undefined ? 'could not submit it' : outcome.trigger === 'button' ? 'clicked its submit button' : 'pressed Enter in its password field';
    const parts = [`filled the login form on ${outcome.pageUrl} (${outcome.fields.join(', ')}) with placeholder values and ${how}`];
    const requests = [...new Set(outcome.requests.map((request) => ProbeReport.request(request.method, request.url, outcome.pageUrl)))];
    const invalid = outcome.invalid ?? [];
    if (requests.length > 0) parts.push(`the page tried to send ${requests.join(', ')}; appii stopped ${requests.length === 1 ? 'it' : 'them'} in the browser, so nothing reached the server`);
    else if (invalid.length > 0) parts.push(`not submitted: the browser's form validation refused ${invalid.map((field) => field.name).join(', ')}`);
    else if (outcome.trigger !== undefined) parts.push('the page started no request');
    if (outcome.reloaded !== undefined) parts.push(`opened ${outcome.reloaded} again`);
    return parts.join('; ');
  }

  render(outcome: ProbeOutcome, ctx: CliContext): string {
    return TextLayout.definitions([[ProbeReport.LABEL, ctx.ansi.clean(this.sentence(outcome))]], ctx.width, { label: (label) => ctx.ansi.dim(label) }).join('\n');
  }
}
