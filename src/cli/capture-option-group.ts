import type { ParseArgsOptionsConfig } from 'node:util';
import { CaptureSession, TrafficRecorder } from '../capture/index.js';
import type { CaptureSessionOptions } from '../capture/index.js';
import type { CliContext } from './cli-context.js';
import type { OptionDocs, OptionGroup } from './option-group.js';
import { OptionReader } from './option-reader.js';
import type { OptionValues } from './option-reader.js';

export class CaptureOptionGroup implements OptionGroup<CaptureSessionOptions> {
  static readonly MS_PER_SECOND = 1000;

  readonly options: ParseArgsOptionsConfig = {
    headless: { type: 'boolean' },
    duration: { type: 'string' },
    idle: { type: 'string' },
    'storage-state': { type: 'string' },
    'max-body': { type: 'string' },
  };

  readonly docs: OptionDocs = {
    headless: { description: 'Record without a browser window (default: a visible window that you browse in)' },
    duration: { value: 'sec', description: 'Stop recording after this many seconds' },
    idle: { value: 'sec', description: `Quiet network time that ends a headless capture without --duration (default: ${CaptureOptionGroup.seconds(CaptureSession.DEFAULT_IDLE_MS)})` },
    'storage-state': { value: 'file', description: 'Start with the cookies and storage of a Playwright storage state file' },
    'max-body': { value: 'bytes', description: `Largest request or response body to keep (default: ${TrafficRecorder.DEFAULT_MAX_BODY_BYTES})` },
  };

  static seconds(ms: number): string {
    return String(ms / CaptureOptionGroup.MS_PER_SECOND);
  }

  read(values: OptionValues, ctx: CliContext): CaptureSessionOptions {
    const out: CaptureSessionOptions = { headless: OptionReader.boolean(values, 'headless') ?? false };
    const durationMs = OptionReader.seconds(values, 'duration', { positive: true });
    const idleMs = OptionReader.seconds(values, 'idle');
    const storageState = OptionReader.string(values, 'storage-state');
    const maxBodyBytes = OptionReader.integer(values, 'max-body', { min: 0 });
    if (durationMs !== undefined) out.durationMs = durationMs;
    if (idleMs !== undefined) out.idleMs = idleMs;
    if (storageState !== undefined) out.storageState = ctx.resolve(storageState);
    if (maxBodyBytes !== undefined) out.recorder = { maxBodyBytes };
    return out;
  }
}
