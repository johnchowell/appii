import { execFile } from 'node:child_process';

export interface ShellResult {
  code: number;
  stdout: string;
  stderr: string;
}

export class LoginShell {
  static readonly UNREAD_INPUT = 'EPIPE';

  static run(args: readonly string[], cwd: string, env: Record<string, string> = {}, input = '', shell = 'bash'): Promise<ShellResult> {
    return new Promise((resolve, reject) => {
      const clean: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/tmp', LANG: 'C', ...env };
      const child = execFile(shell, [...args], { cwd, env: clean, timeout: 30_000, encoding: 'utf8' }, (err, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
      });
      child.stdin?.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code !== LoginShell.UNREAD_INPUT) reject(err);
      });
      child.stdin?.end(input);
    });
  }

  static script(steps: readonly string[]): string[] {
    return ['-c', steps.join('\n')];
  }
}
