export type CliSignal = 'SIGINT' | 'SIGTERM';

export interface CliSignals {
  on(signal: CliSignal, listener: () => void): void;
  off(signal: CliSignal, listener: () => void): void;
  exit(code: number): void;
}

export class ProcessSignals implements CliSignals {
  on(signal: CliSignal, listener: () => void): void {
    process.on(signal, listener);
  }

  off(signal: CliSignal, listener: () => void): void {
    process.off(signal, listener);
  }

  exit(code: number): void {
    process.exit(code);
  }
}
