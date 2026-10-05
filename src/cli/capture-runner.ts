import { BrowserLauncher, CaptureSession, CookieParser, TrafficRecorder } from '../capture/index.js';
import type { CaptureSessionOptions } from '../capture/index.js';
import { AppiiError, Text, isAppiiError } from '../shared/index.js';
import type { Capture, Exchange } from '../model/index.js';
import { CaptureProgress } from './capture-progress.js';
import type { CliContext } from './cli-context.js';
import { CliBrowserLauncher } from './cli-browser-launcher.js';
import { ExitCode } from './exit-code.js';
import type { CliSignal } from './process-signals.js';

export interface RecordingSession {
  run(): Promise<Capture>;
  stop(): void;
}

export type RecordingSessionFactory = (options: CaptureSessionOptions) => RecordingSession;

export interface CaptureRunnerDeps {
  sessions?: RecordingSessionFactory;
}

export class CaptureRunner {
  static readonly SIGNALS: readonly CliSignal[] = ['SIGINT', 'SIGTERM'];
  static readonly HEADED = 'Recording. Browse the site, then close the window or press Ctrl+C.';
  static readonly STOPPING = 'Stopping and saving what was recorded. Press Ctrl+C again to quit without saving.';
  static readonly HEADED_HINT = 'To record without a browser window, add --headless.';

  readonly #sessions: RecordingSessionFactory;

  constructor(deps: CaptureRunnerDeps = {}) {
    this.#sessions = deps.sessions ?? CaptureRunner.session;
  }

  static create(): CaptureRunner {
    return new CaptureRunner({ sessions: CaptureRunner.session });
  }

  static session(options: CaptureSessionOptions): CaptureSession {
    return new CaptureSession(options, {
      launcher: new CliBrowserLauncher(options),
      recorder: new TrafficRecorder(options.recorder),
      cookies: new CookieParser(),
    });
  }

  static headless(options: CaptureSessionOptions): boolean {
    return options.headless ?? true;
  }

  static instructions(options: CaptureSessionOptions): string {
    if (!CaptureRunner.headless(options)) return CaptureRunner.HEADED;
    if (options.durationMs !== undefined) return `Recording headless for ${Text.formatDuration(options.durationMs)}. Press Ctrl+C to stop early.`;
    if (options.script !== undefined) return 'Recording headless while the capture script runs. Press Ctrl+C to stop early.';
    return 'Recording headless until the network is idle. Press Ctrl+C to stop early.';
  }

  async record(options: CaptureSessionOptions, ctx: CliContext): Promise<Capture> {
    const progress = new CaptureProgress(ctx);
    const onExchange = options.onExchange;
    const onReady = options.onReady;
    let interrupted = false;
    const session = this.#sessions({
      ...options,
      onExchange: (exchange: Exchange) => {
        progress.record(exchange);
        onExchange?.(exchange);
      },
      onReady: () => {
        if (!interrupted) ctx.err(CaptureRunner.instructions(options));
        onReady?.();
      },
    });
    const traps = CaptureRunner.SIGNALS.map((signal) => {
      const listener = (): void => {
        if (interrupted) {
          ctx.signals.exit(ExitCode.forSignal(signal));
          return;
        }
        interrupted = true;
        progress.finish();
        ctx.err(CaptureRunner.STOPPING);
        session.stop();
      };
      ctx.signals.on(signal, listener);
      return { signal, listener };
    });
    try {
      return await session.run();
    } catch (err) {
      throw CaptureRunner.#explain(err, options);
    } finally {
      for (const { signal, listener } of traps) ctx.signals.off(signal, listener);
      progress.finish();
    }
  }

  static #explain(err: unknown, options: CaptureSessionOptions): unknown {
    if (!isAppiiError(err) || err.message !== BrowserLauncher.NO_DISPLAY_MESSAGE || CaptureRunner.headless(options)) return err;
    return new AppiiError('BROWSER', `${err.message}. ${CaptureRunner.HEADED_HINT}`, { cause: err, ...(err.details === undefined ? {} : { details: err.details }) });
  }
}
