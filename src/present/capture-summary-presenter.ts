import type { Capture, ResourceType } from '../model/index.js';
import { Http, Text } from '../shared/index.js';
import { BasePresenter } from './presenter.js';
import { SummaryPresenter } from './summary-presenter.js';
import type { Definition } from './text-layout.js';

export interface CaptureSummaryInput {
  capture: Capture;
  file?: string;
  written?: string;
  next?: string;
}

export class CaptureSummaryPresenter extends BasePresenter<CaptureSummaryInput> {
  static readonly API_TYPES: ReadonlySet<ResourceType> = new Set<ResourceType>(['fetch', 'xhr']);
  static readonly OPAQUE_ORIGIN = 'null';

  static origins(capture: Capture): string[] {
    const origins = new Set<string>();
    for (const exchange of capture.exchanges) {
      let origin: string;
      try {
        origin = Http.originOf(exchange.request.url);
      } catch {
        continue;
      }
      if (origin !== CaptureSummaryPresenter.OPAQUE_ORIGIN) origins.add(origin);
    }
    return [...origins].sort();
  }

  render(input: CaptureSummaryInput): string {
    const title = input.file !== undefined ? `Capture saved to ${input.file}` : input.written !== undefined ? `Capture written to ${input.written}` : 'Capture';
    return this.compose([
      this.heading(title),
      this.definitions(this.#facts(input.capture)),
      input.next === undefined ? undefined : this.definitions([['Next', this.ansi.clean(input.next)]]),
    ]);
  }

  #facts(capture: Capture): Definition[] {
    const exchanges = capture.exchanges;
    const documents = exchanges.filter((exchange) => exchange.resourceType === 'document').length;
    const api = exchanges.filter((exchange) => CaptureSummaryPresenter.API_TYPES.has(exchange.resourceType)).length;
    const failed = exchanges.filter((exchange) => exchange.response === undefined).length;
    const origins = CaptureSummaryPresenter.origins(capture).length;
    const pageUrls = new Set(capture.pages.map((page) => page.url)).size;
    const httpOnly = capture.cookies.filter((cookie) => cookie.httpOnly).length;
    const localKeys = capture.storage.reduce((sum, entry) => sum + Object.keys(entry.localStorage).length, 0);
    const sessionKeys = capture.storage.reduce((sum, entry) => sum + Object.keys(entry.sessionStorage).length, 0);
    const messages = capture.websockets.reduce((sum, socket) => sum + socket.messages.length, 0);
    const breakdown = [Text.plural(documents, 'page'), `${api} fetch/XHR`, `${exchanges.length - documents - api} other`];
    if (failed > 0) breakdown.push(`${failed} failed`);
    const facts: Definition[] = [];
    if (capture.startUrl !== undefined) facts.push(['Start URL', this.ansi.clean(capture.startUrl)]);
    facts.push(
      ['Recorded', SummaryPresenter.span(capture.startedAt, capture.endedAt, this.ansi)],
      ['Requests', exchanges.length === 0 ? '0' : `${exchanges.length} (${breakdown.join(', ')}) to ${Text.plural(origins, 'origin')}`],
      ['Pages', capture.pages.length === 0 ? '0 snapshots' : `${Text.plural(capture.pages.length, 'snapshot')} of ${Text.plural(pageUrls, 'URL')}`],
      ['Cookies', capture.cookies.length === 0 ? '0' : `${capture.cookies.length} (${httpOnly} HttpOnly)`],
      [
        'Storage',
        capture.storage.length === 0
          ? 'none'
          : `${Text.plural(localKeys, 'localStorage key')} and ${Text.plural(sessionKeys, 'sessionStorage key')} on ${Text.plural(capture.storage.length, 'origin')}`,
      ],
      ['WebSockets', capture.websockets.length === 0 ? '0' : `${capture.websockets.length} (${Text.plural(messages, 'message')})`],
    );
    return facts;
  }
}
