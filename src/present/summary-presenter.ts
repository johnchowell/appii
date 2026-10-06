import { COOKIE_ROLES, ENDPOINT_KINDS } from '../model/index.js';
import type { ApiModel, CookieRole, EndpointKind, FormDescriptor, SkippedRequests, SkipReason } from '../model/index.js';
import { Ansi, Text } from '../shared/index.js';
import { BasePresenter } from './presenter.js';
import type { Definition } from './text-layout.js';

export class SummaryPresenter extends BasePresenter<ApiModel> {
  static readonly KIND_ORDER: readonly EndpointKind[] = ENDPOINT_KINDS;
  static readonly ROLE_ORDER: readonly CookieRole[] = COOKIE_ROLES;
  static readonly SKIP_LABELS: Readonly<Record<SkipReason, readonly [string, string]>> = Object.freeze({
    'other-origin': ['request to another origin', 'requests to other origins'],
    static: ['static asset', 'static assets'],
    document: ['page load', 'page loads'],
    preflight: ['CORS preflight', 'CORS preflights'],
    websocket: ['WebSocket handshake', 'WebSocket handshakes'],
    'service-worker': ['service worker response', 'service worker responses'],
    cache: ['answer from the browser cache', 'answers from the browser cache'],
    'not-http': ['non-HTTP request', 'non-HTTP requests'],
  });

  static tally<K extends string>(values: readonly K[], order: readonly K[], ansi: Ansi = Ansi.plain): string {
    const counts = new Map<K, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    const keys = [...order.filter((key) => counts.has(key)), ...[...counts.keys()].filter((key) => !order.includes(key)).sort()];
    return keys.map((key) => `${ansi.clean(key)} ${counts.get(key) ?? 0}`).join(', ');
  }

  static span(from: string | undefined, to: string | undefined, ansi: Ansi = Ansi.plain): string {
    if (from === undefined && to === undefined) return 'unknown';
    if (to === undefined) return `since ${ansi.clean(from ?? '')}`;
    if (from === undefined) return `until ${ansi.clean(to)}`;
    const ms = Date.parse(to) - Date.parse(from);
    const duration = Number.isFinite(ms) && ms >= 0 ? ` (${Text.formatDuration(ms)})` : '';
    return `${ansi.clean(from)} to ${ansi.clean(to)}${duration}`;
  }

  static forms(forms: readonly FormDescriptor[]): string {
    const instances = forms.reduce((sum, form) => sum + (form.instances ?? 1), 0);
    const count = instances > forms.length ? `${forms.length} distinct, ${instances} on pages` : String(forms.length);
    if (forms.length === 0 || forms.some((form) => form.endpoints === undefined)) return count;
    const linked = forms.filter((form) => (form.endpoints?.length ?? 0) > 0).length;
    return `${count} (${linked} linked to endpoints)`;
  }

  static skipped(entries: readonly SkippedRequests[], ansi: Ansi = Ansi.plain): string {
    return entries
      .map((entry) => {
        const [singular, plural] = SummaryPresenter.SKIP_LABELS[entry.reason];
        const examples = entry.examples.map((example) => ansi.clean(example)).join(', ');
        const lead = entry.count > entry.examples.length ? 'e.g. ' : '';
        return `${entry.count} ${entry.count === 1 ? singular : plural}${examples === '' ? '' : ` (${lead}${examples})`}`;
      })
      .join('; ');
  }

  render(model: ApiModel): string {
    return this.compose([this.heading(model.name || 'API'), this.definitions(this.#source(model)), this.definitions(this.#counts(model))]);
  }

  #source(model: ApiModel): Definition[] {
    const others = model.origins.filter((origin) => origin !== model.primaryOrigin);
    const entries: Definition[] = [
      ['Primary origin', model.primaryOrigin ? this.ansi.clean(model.primaryOrigin) : 'none'],
      ['Other origins', others.length > 0 ? others.map((origin) => this.ansi.clean(origin)).join(', ') : 'none'],
    ];
    if (model.source.startUrl !== undefined) entries.push(['Start URL', this.ansi.clean(model.source.startUrl)]);
    entries.push(['Captured', SummaryPresenter.span(model.source.capturedFrom, model.source.capturedTo, this.ansi)]);
    if (model.source.file !== undefined) entries.push(['Source file', this.ansi.clean(model.source.file)]);
    entries.push(['Generated', this.ansi.clean(model.generatedAt)]);
    return entries;
  }

  #counts(model: ApiModel): Definition[] {
    const endpoints = model.endpoints;
    const firstParty = endpoints.filter((endpoint) => endpoint.firstParty).length;
    const hits = endpoints.reduce((sum, endpoint) => sum + endpoint.count, 0);
    const kinds = SummaryPresenter.tally(endpoints.map((endpoint) => endpoint.kind), SummaryPresenter.KIND_ORDER, this.ansi);
    const roles = SummaryPresenter.tally(model.cookies.map((cookie) => cookie.role), SummaryPresenter.ROLE_ORDER, this.ansi);
    const httpOnly = model.cookies.filter((cookie) => cookie.httpOnly).length;
    const messages = model.websockets.reduce((sum, socket) => sum + socket.messages, 0);
    return [
      ['Endpoints', endpoints.length === 0 ? '0' : `${endpoints.length} (${kinds}), ${firstParty} first-party`],
      ['Requests', `${model.source.exchanges} captured, ${hits} matched to endpoints`],
      ...(model.source.skipped !== undefined && model.source.skipped.length > 0 ? [['Skipped', SummaryPresenter.skipped(model.source.skipped, this.ansi)] as Definition] : []),
      ['Cookies', model.cookies.length === 0 ? '0' : `${model.cookies.length} (${roles}), ${httpOnly} HttpOnly`],
      ['Forms', SummaryPresenter.forms(model.forms)],
      ['WebSockets', model.websockets.length === 0 ? '0' : `${model.websockets.length} (${Text.plural(messages, 'message')})`],
    ];
  }
}
