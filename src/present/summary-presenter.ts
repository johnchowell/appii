import { COOKIE_ROLES, ENDPOINT_KINDS } from '../model/index.js';
import type { ApiModel, CookieRole, EndpointKind, FormDescriptor } from '../model/index.js';
import { Text } from '../shared/index.js';
import { BasePresenter } from './presenter.js';
import { TextLayout } from './text-layout.js';
import type { Definition } from './text-layout.js';

export class SummaryPresenter extends BasePresenter<ApiModel> {
  static readonly KIND_ORDER: readonly EndpointKind[] = ENDPOINT_KINDS;
  static readonly ROLE_ORDER: readonly CookieRole[] = COOKIE_ROLES;

  static tally<K extends string>(values: readonly K[], order: readonly K[]): string {
    const counts = new Map<K, number>();
    for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
    const keys = [...order.filter((key) => counts.has(key)), ...[...counts.keys()].filter((key) => !order.includes(key)).sort()];
    return keys.map((key) => `${TextLayout.clean(key)} ${counts.get(key) ?? 0}`).join(', ');
  }

  static span(from: string | undefined, to: string | undefined): string {
    if (from === undefined && to === undefined) return 'unknown';
    if (to === undefined) return `since ${TextLayout.clean(from ?? '')}`;
    if (from === undefined) return `until ${TextLayout.clean(to)}`;
    const ms = Date.parse(to) - Date.parse(from);
    const duration = Number.isFinite(ms) && ms >= 0 ? ` (${Text.formatDuration(ms)})` : '';
    return `${TextLayout.clean(from)} to ${TextLayout.clean(to)}${duration}`;
  }

  static forms(forms: readonly FormDescriptor[]): string {
    const instances = forms.reduce((sum, form) => sum + (form.instances ?? 1), 0);
    const count = instances > forms.length ? `${forms.length} distinct, ${instances} on pages` : String(forms.length);
    if (forms.length === 0 || forms.some((form) => form.endpoints === undefined)) return count;
    const linked = forms.filter((form) => (form.endpoints?.length ?? 0) > 0).length;
    return `${count} (${linked} linked to endpoints)`;
  }

  render(model: ApiModel): string {
    return this.compose([this.heading(model.name || 'API'), this.definitions(this.#source(model)), this.definitions(this.#counts(model))]);
  }

  #source(model: ApiModel): Definition[] {
    const others = model.origins.filter((origin) => origin !== model.primaryOrigin);
    const entries: Definition[] = [
      ['Primary origin', model.primaryOrigin ? TextLayout.clean(model.primaryOrigin) : 'none'],
      ['Other origins', others.length > 0 ? others.map((origin) => TextLayout.clean(origin)).join(', ') : 'none'],
    ];
    if (model.source.startUrl !== undefined) entries.push(['Start URL', TextLayout.clean(model.source.startUrl)]);
    entries.push(['Captured', SummaryPresenter.span(model.source.capturedFrom, model.source.capturedTo)]);
    if (model.source.file !== undefined) entries.push(['Source file', TextLayout.clean(model.source.file)]);
    entries.push(['Generated', TextLayout.clean(model.generatedAt)]);
    return entries;
  }

  #counts(model: ApiModel): Definition[] {
    const endpoints = model.endpoints;
    const firstParty = endpoints.filter((endpoint) => endpoint.firstParty).length;
    const hits = endpoints.reduce((sum, endpoint) => sum + endpoint.count, 0);
    const kinds = SummaryPresenter.tally(endpoints.map((endpoint) => endpoint.kind), SummaryPresenter.KIND_ORDER);
    const roles = SummaryPresenter.tally(model.cookies.map((cookie) => cookie.role), SummaryPresenter.ROLE_ORDER);
    const httpOnly = model.cookies.filter((cookie) => cookie.httpOnly).length;
    const messages = model.websockets.reduce((sum, socket) => sum + socket.messages, 0);
    return [
      ['Endpoints', endpoints.length === 0 ? '0' : `${endpoints.length} (${kinds}), ${firstParty} first-party`],
      ['Requests', `${model.source.exchanges} captured, ${hits} matched to endpoints`],
      ['Cookies', model.cookies.length === 0 ? '0' : `${model.cookies.length} (${roles}), ${httpOnly} HttpOnly`],
      ['Forms', SummaryPresenter.forms(model.forms)],
      ['WebSockets', model.websockets.length === 0 ? '0' : `${model.websockets.length} (${Text.plural(messages, 'message')})`],
    ];
  }
}
