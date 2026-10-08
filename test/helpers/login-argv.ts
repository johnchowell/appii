import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { LoginShell } from './login-shell.js';

export interface RecordedRun {
  code: number;
  stdout: string;
  stderr: string;
}

export class ArgvRecorder {
  static readonly COMMANDS: readonly string[] = Object.freeze([
    'bash', 'curl', 'od', 'cat', 'dirname', 'basename', 'rm', 'mkdir', 'mktemp', 'chmod', 'mv', 'cp', 'touch', 'sed', 'awk', 'tr', 'head', 'tail',
    'grep', 'cut', 'sort', 'date', 'sleep', 'wc', 'tee', 'env', 'ls', 'stat',
  ]);

  readonly bin: string;
  readonly logs: string;

  constructor(dir: string) {
    this.bin = join(dir, 'bin');
    this.logs = join(dir, 'argv');
  }

  static which(command: string): string | undefined {
    try {
      return execFileSync('bash', ['-c', `command -v -- ${command}`], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } }).trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async install(): Promise<void> {
    await mkdir(this.bin, { recursive: true });
    await mkdir(this.logs, { recursive: true });
    const shell = ArgvRecorder.which('bash') ?? '/bin/bash';
    for (const command of ArgvRecorder.COMMANDS) {
      const real = ArgvRecorder.which(command);
      if (real === undefined || !real.startsWith('/')) continue;
      const stub = join(this.bin, command);
      await writeFile(stub, `#!${shell}\nprintf '%s\\0' "$0" "$@" > "$APPII_ARGV_LOG/$$-$RANDOM$RANDOM"\nexec ${JSON.stringify(real)} "$@"\n`);
      await chmod(stub, 0o755);
    }
  }

  env(extra: Record<string, string> = {}): Record<string, string> {
    return { PATH: this.bin, HOME: process.env.HOME ?? '/tmp', LANG: 'C', APPII_ARGV_LOG: this.logs, ...extra };
  }

  run(args: readonly string[], cwd: string, env: Record<string, string> = {}, input?: string): Promise<RecordedRun> {
    return LoginShell.run(args, cwd, this.env(env), input, join(this.bin, 'bash'));
  }

  async processes(): Promise<string[][]> {
    const out: string[][] = [];
    for (const name of (await readdir(this.logs)).sort()) {
      const text = await readFile(join(this.logs, name), 'utf8');
      out.push(text.split('\0').slice(0, -1));
    }
    return out;
  }

  async clear(): Promise<void> {
    await rm(this.logs, { recursive: true, force: true });
    await mkdir(this.logs, { recursive: true });
  }

  async carrying(values: readonly string[]): Promise<string[][]> {
    return (await this.processes()).filter((argv) => argv.some((arg) => values.some((value) => arg.includes(value))));
  }

  async commands(): Promise<string[]> {
    return [...new Set((await this.processes()).map((argv) => (argv[0] ?? '').split('/').pop() ?? ''))].sort();
  }
}
