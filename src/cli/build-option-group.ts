import type { ParseArgsOptionsConfig } from 'node:util';
import { ModelBuilder } from '../build/index.js';
import type { BuildOptions } from '../build/index.js';
import { Text } from '../shared/index.js';
import type { CliContext } from './cli-context.js';
import type { OptionDocs, OptionGroup } from './option-group.js';
import { OptionReader } from './option-reader.js';
import type { OptionValues } from './option-reader.js';
import { UsageError } from './usage-error.js';

export class BuildOptionGroup implements OptionGroup<BuildOptions> {
  readonly options: ParseArgsOptionsConfig = {
    name: { type: 'string' },
    origin: { type: 'string', multiple: true },
    'all-origins': { type: 'boolean' },
    'include-static': { type: 'boolean' },
    documents: { type: 'boolean' },
    redact: { type: 'boolean' },
  };

  readonly docs: OptionDocs = {
    name: { value: 'name', description: 'API name (default: the host of the primary origin)' },
    origin: { value: 'url', description: 'Keep only endpoints of this origin; repeat for more (default: the first-party origins)' },
    'all-origins': { description: 'Keep endpoints of every origin, third-party ones included' },
    'include-static': { description: 'Keep static assets such as scripts, styles, images and fonts' },
    documents: { flag: '--no-documents', description: 'Leave out HTML page loads (form submissions and sign-outs stay)' },
    redact: { flag: '--no-redact', description: 'Keep secret values (cookies, tokens, passwords) in examples' },
  };

  read(values: OptionValues, _ctx?: CliContext): BuildOptions {
    const out: BuildOptions = {
      includeDocuments: OptionReader.boolean(values, 'documents') ?? true,
      redact: OptionReader.boolean(values, 'redact') ?? true,
    };
    const name = OptionReader.string(values, 'name');
    const origins = OptionReader.strings(values, 'origin').map((origin) => BuildOptionGroup.#origin(origin));
    const allOrigins = OptionReader.boolean(values, 'all-origins');
    const includeStatic = OptionReader.boolean(values, 'include-static');
    if (origins.length > 0 && allOrigins === true) throw new UsageError('--origin and --all-origins cannot be combined');
    if (name !== undefined) out.name = name;
    if (origins.length > 0) out.origins = origins;
    if (allOrigins !== undefined) out.allOrigins = allOrigins;
    if (includeStatic !== undefined) out.includeStatic = includeStatic;
    return out;
  }

  static #origin(value: string): string {
    try {
      return ModelBuilder.normalizeOrigin(value);
    } catch (err) {
      throw new UsageError(`--origin: ${Text.errorMessage(err)}`);
    }
  }
}
