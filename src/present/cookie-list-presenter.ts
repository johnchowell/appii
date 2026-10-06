import type { ApiModel, CookieInfo, CookieRole } from '../model/index.js';
import { Ansi, EndpointIndex, Text } from '../shared/index.js';
import type { AnsiStyle } from '../shared/index.js';
import { BasePresenter } from './presenter.js';
import type { TableColumn } from './table-renderer.js';
import { TextLayout } from './text-layout.js';

export class CookieListPresenter extends BasePresenter<ApiModel> {
  static readonly COLUMNS: readonly TableColumn[] = [
    { header: 'NAME', flex: true, minWidth: 12 },
    { header: 'DOMAIN', flex: true, minWidth: 16, optional: true, priority: 3 },
    { header: 'PATH', flex: true, minWidth: 8, optional: true, priority: 2 },
    { header: 'ROLE' },
    { header: 'FLAGS', flex: true, minWidth: 24 },
    { header: 'EXPIRES', optional: true, priority: 4 },
    { header: 'SET BY', flex: true, minWidth: 8 },
    { header: 'USED BY', flex: true, minWidth: 10 },
    { header: 'VALUE', flex: true, minWidth: 8, optional: true, priority: 1 },
  ];
  static readonly ROLE_STYLES: Readonly<Record<CookieRole, AnsiStyle>> = {
    session: 'cyan',
    auth: 'yellow',
    csrf: 'magenta',
    preference: 'green',
    tracking: 'gray',
    unknown: 'dim',
  };
  static readonly MIN_RANGE = 3;
  static readonly LEGEND = 'SET BY and USED BY list endpoint numbers from the endpoint list.';

  static ranges(numbers: readonly number[]): string {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const parts: string[] = [];
    for (let i = 0; i < sorted.length; ) {
      let j = i;
      while (j + 1 < sorted.length && sorted[j + 1] === (sorted[j] ?? 0) + 1) j++;
      const run = sorted.slice(i, j + 1);
      parts.push(run.length >= CookieListPresenter.MIN_RANGE ? `${run[0]}-${run[run.length - 1]}` : run.join(','));
      i = j + 1;
    }
    return parts.join(',');
  }

  static roleStyle(role: string): AnsiStyle {
    return Object.hasOwn(CookieListPresenter.ROLE_STYLES, role) ? CookieListPresenter.ROLE_STYLES[role as CookieRole] : 'dim';
  }

  static flags(cookie: CookieInfo, ansi: Ansi = Ansi.plain): string {
    const flags: string[] = [];
    if (cookie.httpOnly) flags.push('HttpOnly');
    if (cookie.secure) flags.push('Secure');
    if (cookie.sameSite !== null) flags.push(`SameSite=${ansi.clean(cookie.sameSite)}`);
    if (cookie.partitionKey !== undefined) flags.push(`Partitioned=${ansi.clean(cookie.partitionKey)}`);
    return flags.join(' ');
  }

  static expires(cookie: CookieInfo, ansi: Ansi = Ansi.plain): string {
    if (cookie.session || cookie.expires === null) return 'session';
    const time = Date.parse(cookie.expires);
    return Number.isNaN(time) ? ansi.clean(cookie.expires) : new Date(time).toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  render(model: ApiModel): string {
    const cookies = this.filter.cookies(model);
    const total = model.cookies.length;
    const count = this.filter.active ? `${cookies.length} of ${Text.plural(total, 'cookie')}` : Text.plural(total, 'cookie');
    const header = [this.heading(`${model.name || 'API'}: ${count}`)];
    if (this.filter.active) header.push(this.ansi.dim(this.ansi.clean(`Filter: cookies of endpoints matching ${this.filter.describe().join(', ')}`)));
    if (cookies.length === 0) return this.compose([header, total === 0 ? 'No cookies were recorded.' : 'No cookies belong to the matching endpoints.']);
    const numbers = new Map(EndpointIndex.of(model).entries().map((entry) => [entry.endpoint.id, entry.number]));
    const rows = cookies.map((cookie) => {
      const flags = CookieListPresenter.flags(cookie, this.ansi);
      return [
        this.ansi.bold(this.ansi.clean(cookie.name)),
        this.ansi.clean(cookie.domain),
        this.ansi.clean(cookie.path),
        this.ansi.style(CookieListPresenter.roleStyle(cookie.role), this.ansi.clean(cookie.role)),
        flags === '' ? this.ansi.dim('-') : flags,
        CookieListPresenter.expires(cookie, this.ansi),
        this.#numbers(cookie.setBy, numbers),
        this.#numbers(cookie.usedBy, numbers),
        this.ansi.clean(cookie.valueExample),
      ];
    });
    const table = this.table();
    const layout = table.layout(CookieListPresenter.COLUMNS, rows);
    const notes = [CookieListPresenter.LEGEND];
    if (layout.hidden.length > 0) notes.push(`Columns hidden to fit ${this.width} characters: ${layout.hidden.map((i) => CookieListPresenter.COLUMNS[i]?.header ?? '').join(', ')}`);
    return this.compose([header, table.render(CookieListPresenter.COLUMNS, rows, layout), notes.flatMap((note) => TextLayout.wrap(note, this.width)).map((line) => this.ansi.dim(line))]);
  }

  #numbers(ids: readonly string[], numbers: ReadonlyMap<string, number>): string {
    if (ids.length === 0) return this.ansi.dim('-');
    const known: number[] = [];
    const unknown: string[] = [];
    for (const id of ids) {
      const number = numbers.get(id);
      if (number === undefined) unknown.push(this.ansi.clean(id));
      else known.push(number);
    }
    return [CookieListPresenter.ranges(known), ...unknown].filter((part) => part !== '').join(',');
  }
}
