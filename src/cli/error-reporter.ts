import { Json, isAppiiError } from '../shared/index.js';
import { TextLayout } from '../present/index.js';
import type { CliContext } from './cli-context.js';
import { ExitCode } from './exit-code.js';
import { Helpers } from './helpers.js';
import { UsageError } from './usage-error.js';

export interface DetailList {
  key: string;
  title: string;
}

export class ErrorReporter {
  static readonly PREFIX = 'error: ';
  static readonly DEBUG_VARIABLE = 'APPII_DEBUG';
  static readonly MAX_DETAIL_LINES = 10;
  static readonly DETAIL_LISTS: readonly DetailList[] = [
    { key: 'suggestions', title: 'Did you mean:' },
    { key: 'problems', title: 'Problems:' },
  ];

  report(err: unknown, ctx: CliContext): number {
    const lines = [ErrorReporter.PREFIX + TextLayout.clean(Helpers.errorMessage(err))];
    if (isAppiiError(err)) lines.push(...ErrorReporter.details(err.details));
    if (ErrorReporter.debug(ctx) && err instanceof Error && err.stack) lines.push(TextLayout.cleanBlock(err.stack));
    ctx.err(lines.join('\n'));
    return err instanceof UsageError ? ExitCode.USAGE : ExitCode.ERROR;
  }

  static details(details: unknown): string[] {
    if (!Json.isPlainObject(details)) return [];
    const lines: string[] = [];
    for (const { key, title } of ErrorReporter.DETAIL_LISTS) {
      const value = details[key];
      if (!Array.isArray(value)) continue;
      const items = value.filter((item): item is string => typeof item === 'string' && item !== '');
      if (items.length === 0) continue;
      lines.push(title);
      for (const item of items.slice(0, ErrorReporter.MAX_DETAIL_LINES)) lines.push('  ' + TextLayout.clean(item));
      if (items.length > ErrorReporter.MAX_DETAIL_LINES) lines.push(`  ... and ${items.length - ErrorReporter.MAX_DETAIL_LINES} more`);
    }
    return lines;
  }

  static debug(ctx: CliContext): boolean {
    const value = ctx.io.env[ErrorReporter.DEBUG_VARIABLE];
    return value !== undefined && value !== '' && value !== '0';
  }
}
