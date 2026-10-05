import { ENDPOINT_KINDS } from '../../model/index.js';
import type { ApiModel, EndpointKind } from '../../model/index.js';
import { EndpointFilter, PresenterFactory } from '../../present/index.js';
import type { ListFilter } from '../../present/index.js';
import { EndpointIndex, Json, Meta } from '../../shared/index.js';
import type { CliContext } from '../cli-context.js';
import { Command } from '../command.js';
import type { CommandDeps, CommandSpec } from '../command.js';
import { ExitCode } from '../exit-code.js';
import { InputLoader } from '../input-loader.js';
import { OptionReader } from '../option-reader.js';
import type { OptionValues } from '../option-reader.js';
import { UsageError } from '../usage-error.js';

export interface ListCommandDeps extends CommandDeps {
  loader?: InputLoader;
}

export class ListCommand extends Command {
  static readonly KINDS: readonly EndpointKind[] = ENDPOINT_KINDS;

  readonly spec: CommandSpec;
  readonly #loader: InputLoader;

  constructor(deps: ListCommandDeps = {}) {
    super(deps);
    this.#loader = deps.loader ?? InputLoader.create();
    const app = Meta.APP_NAME;
    this.spec = {
      name: 'list',
      summary: 'Show the endpoints, one endpoint in detail, or the cookies',
      usage: `${app} list <api.json|capture.json|file.har> [options]`,
      options: {
        show: { type: 'string' },
        cookies: { type: 'boolean' },
        filter: { type: 'string' },
        method: { type: 'string' },
        origin: { type: 'string' },
        kind: { type: 'string', multiple: true },
        'first-party': { type: 'boolean' },
        json: { type: 'boolean' },
      },
      allowPositionals: true,
      docs: {
        show: { value: 'ref', description: 'Show one endpoint in detail: its list number, id or name' },
        cookies: { description: 'Show the cookie table instead of the endpoints' },
        filter: { value: 'text', description: 'Only endpoints whose method, path, name or id contain every word' },
        method: { value: 'methods', description: 'Only these HTTP methods, comma separated (GET,POST)' },
        origin: { value: 'url', description: 'Only endpoints of this origin or host' },
        kind: { value: 'kinds', description: `Only these kinds, comma separated: ${ListCommand.KINDS.join(', ')}` },
        'first-party': { description: 'Only first-party endpoints' },
        json: { description: 'Print JSON instead of a table (the endpoints, the --show endpoint, or the cookies)' },
      },
      examples: [`${app} list api.json`, `${app} list api.json --show 3`, `${app} list api.json --cookies`, `${app} list capture.json --method POST --kind form,json`],
    };
  }

  static create(): ListCommand {
    return new ListCommand({ loader: InputLoader.create() });
  }

  static filter(values: OptionValues): ListFilter {
    const filter: ListFilter = {};
    const text = OptionReader.string(values, 'filter');
    const method = OptionReader.string(values, 'method');
    const origin = OptionReader.string(values, 'origin');
    const kinds = OptionReader.list(values, 'kind').map((kind) => kind.toLowerCase());
    const firstParty = OptionReader.boolean(values, 'first-party');
    const unknown = kinds.find((kind) => !(ListCommand.KINDS as readonly string[]).includes(kind));
    if (unknown !== undefined) throw new UsageError(`--kind must be one of ${ListCommand.KINDS.join(', ')}; got '${unknown}'`);
    if (text !== undefined) filter.text = text;
    if (method !== undefined) filter.method = method;
    if (origin !== undefined) filter.origin = origin;
    if (kinds.length > 0) filter.kind = kinds as EndpointKind[];
    if (firstParty !== undefined) filter.firstPartyOnly = firstParty;
    return filter;
  }

  static selection(model: ApiModel, filter: ListFilter, view: { show?: string; cookies: boolean }): unknown {
    if (view.show !== undefined) return EndpointIndex.of(model).require(view.show);
    const endpoints = new EndpointFilter(filter);
    if (!view.cookies) return endpoints.apply(model);
    if (!endpoints.active) return model.cookies;
    const ids = new Set(endpoints.apply(model).map((endpoint) => endpoint.id));
    return model.cookies.filter((cookie) => cookie.setBy.some((id) => ids.has(id)) || cookie.usedBy.some((id) => ids.has(id)));
  }

  protected async execute(values: OptionValues, positionals: string[], ctx: CliContext): Promise<number> {
    const file = this.argument(positionals, 0, '<api.json|capture.json|file.har>');
    this.expectArguments(positionals, 1);
    const show = OptionReader.string(values, 'show');
    const cookies = OptionReader.boolean(values, 'cookies') === true;
    if (show !== undefined && cookies) throw new UsageError('--show and --cookies cannot be combined');
    const filter = ListCommand.filter(values);
    const { model } = await this.#loader.load(ctx.resolve(file));
    if (OptionReader.boolean(values, 'json') === true) {
      ctx.out(Json.asciiJson(ListCommand.selection(model, filter, { ...(show === undefined ? {} : { show }), cookies })));
      return ExitCode.OK;
    }
    const presenters = new PresenterFactory(ctx.presenterOptions({ filter, file }));
    if (show !== undefined) ctx.out(presenters.detail().render({ model, ref: show }));
    else if (cookies) ctx.out(presenters.cookies().render(model));
    else ctx.out(presenters.list().render(model));
    return ExitCode.OK;
  }
}
