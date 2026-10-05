import type { CliSignal } from './process-signals.js';

export class ExitCode {
  static readonly OK = 0;
  static readonly ERROR = 1;
  static readonly USAGE = 2;
  static readonly SIGNALS: Readonly<Record<CliSignal, number>> = { SIGINT: 130, SIGTERM: 143 };

  static forSignal(signal: CliSignal): number {
    return ExitCode.SIGNALS[signal];
  }
}
