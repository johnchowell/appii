import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, basename } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppiiError } from './errors.js';

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function writeFileAtomic(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): Promise<void> {
  const dir = dirname(path);
  await ensureDir(dir);
  const tmp = join(dir, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, data, { mode: opts.mode ?? 0o644 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw new AppiiError('IO', `Cannot write ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new AppiiError('NOT_FOUND', `File not found: ${path}`, { cause: err });
    throw new AppiiError('IO', `Cannot read ${path}: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new AppiiError('BAD_INPUT', `${path} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
}

export async function writeJson(path: string, value: unknown, opts: { mode?: number; indent?: number } = {}): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, opts.indent ?? 2) + '\n', opts.mode === undefined ? {} : { mode: opts.mode });
}
