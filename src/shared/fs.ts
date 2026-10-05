import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import type { Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppiiError } from './errors.js';
import { errorMessage, stripBom } from './text.js';

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

export function tempPath(path: string): string {
  return join(dirname(path), `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
}

export async function writeFileAtomic(path: string, data: string | Uint8Array, opts: { mode?: number } = {}): Promise<void> {
  const tmp = tempPath(path);
  try {
    await ensureDir(dirname(path));
    await writeFile(tmp, data, { mode: opts.mode ?? 0o644 });
    await rename(tmp, path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw new AppiiError('IO', `Cannot write ${path}: ${errorMessage(err)}`, { cause: err });
  }
}

export async function assertWritable(path: string): Promise<void> {
  const existing = await stat(path).catch(() => undefined);
  if (existing?.isDirectory() === true) throw new AppiiError('IO', `Cannot write ${path}: it is a directory`);
  const dir = await nearestDirectory(path, dirname(resolve(path)));
  const probe = tempPath(join(dir, basename(path)));
  try {
    await writeFile(probe, '', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    throw new AppiiError('IO', `Cannot write ${path}: ${errorMessage(err)}`, { cause: err });
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

async function nearestDirectory(path: string, start: string): Promise<string> {
  for (let current = start; ; current = dirname(current)) {
    let info: Stats;
    try {
      info = await stat(current);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if ((code === 'ENOENT' || code === 'ENOTDIR') && dirname(current) !== current) continue;
      throw new AppiiError('IO', `Cannot write ${path}: ${errorMessage(err)}`, { cause: err });
    }
    if (!info.isDirectory()) throw new AppiiError('IO', `Cannot write ${path}: ${current} is not a directory`);
    return current;
  }
}

export async function readText(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new AppiiError('NOT_FOUND', `File not found: ${path}`, { cause: err });
    throw new AppiiError('IO', `Cannot read ${path}: ${errorMessage(err)}`, { cause: err });
  }
}

export async function readJson(path: string): Promise<unknown> {
  const text = await readText(path);
  try {
    return JSON.parse(stripBom(text));
  } catch (err) {
    throw new AppiiError('BAD_INPUT', `${path} is not valid JSON: ${errorMessage(err)}`, { cause: err });
  }
}

export async function writeJson(path: string, value: unknown, opts: { mode?: number; indent?: number } = {}): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, opts.indent ?? 2) + '\n', opts.mode === undefined ? {} : { mode: opts.mode });
}
