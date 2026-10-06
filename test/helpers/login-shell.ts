import { execFile } from 'node:child_process';

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class LoginShell {
  static run(args: string[], cwd: string, env: Record<string, string> = {}): Promise<ShellResult> {
    return new Promise((resolve) => {
      const clean: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C', ...env };
      execFile('bash', args, { cwd, env: clean, timeout: 30_000, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
      });
    });
  }

  static script(steps: readonly string[]): string[] {
    return ['-c', steps.join('\n')];
  }
}
