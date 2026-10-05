import type { ApiModel } from '../model/index.js';
import { AppiiError } from '../shared/index.js';
import { CaptureSummaryPresenter } from './capture-summary-presenter.js';
import { CookieListPresenter } from './cookie-list-presenter.js';
import { EndpointDetailPresenter } from './endpoint-detail-presenter.js';
import type { EndpointDetailInput } from './endpoint-detail-presenter.js';
import { EndpointListPresenter } from './endpoint-list-presenter.js';
import { BasePresenter } from './presenter.js';
import type { Presenter, PresenterOptions } from './presenter.js';
import { SummaryPresenter } from './summary-presenter.js';
import { TextLayout } from './text-layout.js';

export type PresenterKind = 'summary' | 'list' | 'detail' | 'cookies';

export interface PresenterInputs {
  summary: ApiModel;
  list: ApiModel;
  detail: EndpointDetailInput;
  cookies: ApiModel;
}

export class PresenterFactory {
  static readonly KINDS: readonly PresenterKind[] = ['summary', 'list', 'detail', 'cookies'];

  readonly #options: Readonly<PresenterOptions>;

  constructor(options: PresenterOptions = {}) {
    TextLayout.checkWidth(options.width ?? BasePresenter.DEFAULT_WIDTH);
    this.#options = { ...options, ...(options.filter ? { filter: { ...options.filter } } : {}) };
  }

  get options(): Readonly<PresenterOptions> {
    return this.#options;
  }

  static isKind(value: string): value is PresenterKind {
    return (PresenterFactory.KINDS as readonly string[]).includes(value);
  }

  summary(): SummaryPresenter {
    return new SummaryPresenter(this.#options);
  }

  list(): EndpointListPresenter {
    return EndpointListPresenter.create(this.#options);
  }

  detail(): EndpointDetailPresenter {
    return EndpointDetailPresenter.create(this.#options);
  }

  cookies(): CookieListPresenter {
    return new CookieListPresenter(this.#options);
  }

  captureSummary(): CaptureSummaryPresenter {
    return new CaptureSummaryPresenter(this.#options);
  }

  create<K extends PresenterKind>(kind: K): Presenter<PresenterInputs[K]>;
  create(kind: string): Presenter<ApiModel> | Presenter<EndpointDetailInput> {
    switch (kind) {
      case 'summary':
        return this.summary();
      case 'list':
        return this.list();
      case 'detail':
        return this.detail();
      case 'cookies':
        return this.cookies();
      default:
        throw new AppiiError('BAD_INPUT', `Unknown presenter '${kind}' (expected one of ${PresenterFactory.KINDS.join(', ')})`, { details: { kind, kinds: PresenterFactory.KINDS } });
    }
  }
}
