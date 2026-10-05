import { access, chmod, lstat, mkdir, readFile, readlink, rename, rm, stat, writeFile } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppiiError } from './errors.js';
import { JsonStreamParser } from './json-stream.js';
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

export type FileData = string | Uint8Array | Iterable<string>;

export interface WriteTarget {
  readonly path: string;
  readonly existing: Stats | undefined;
  readonly inPlace: boolean;
}

export const MAX_SYMLINKS = 40;
export const DEFAULT_FILE_MODE = 0o644;
export const PERMISSION_BITS = 0o7777;

export async function writeTarget(path: string): Promise<WriteTarget> {
  const target = await followLinks(resolve(path));
  const existing = await stat(target).catch(() => undefined);
  if (existing === undefined || existing.isFile()) return { path: target, existing, inPlace: false };
  if (existing.isDirectory()) throw new AppiiError('IO', `Cannot write ${path}: it is a directory`);
  if (existing.isCharacterDevice() || existing.isFIFO()) return { path: target, existing, inPlace: true };
  throw new AppiiError('IO', `Cannot write ${path}: it is a ${existing.isBlockDevice() ? 'block device' : 'socket'}`);
}

export async function writeFileAtomic(path: string, data: FileData, opts: { mode?: number } = {}): Promise<void> {
  const target = await writeTarget(path);
  if (target.inPlace) {
    try {
      await writeFile(target.path, data);
    } catch (err) {
      throw new AppiiError('IO', `Cannot write ${path}: ${errorMessage(err)}`, { cause: err });
    }
    return;
  }
  const existingMode = target.existing === undefined ? undefined : target.existing.mode & PERMISSION_BITS;
  const mode = existingMode === undefined ? (opts.mode ?? DEFAULT_FILE_MODE) : opts.mode === undefined ? existingMode : existingMode & opts.mode;
  const tmp = tempPath(target.path);
  try {
    await ensureDir(dirname(target.path));
    await writeFile(tmp, data, { mode });
    if (existingMode !== undefined) await chmod(tmp, mode);
    await rename(tmp, target.path);
  } catch (err) {
    await rm(tmp, { force: true });
    throw new AppiiError('IO', `Cannot write ${path}: ${errorMessage(err)}`, { cause: err });
  }
}

export async function assertWritable(path: string): Promise<void> {
  const target = await writeTarget(path);
  if (target.inPlace) {
    await access(target.path, constants.W_OK).catch((err: unknown) => {
      throw new AppiiError('IO', `Cannot write ${path}: ${errorMessage(err)}`, { cause: err });
    });
    return;
  }
  const dir = await nearestDirectory(path, dirname(target.path));
  const probe = tempPath(join(dir, basename(target.path)));
  try {
    await writeFile(probe, '', { mode: 0o600, flag: 'wx' });
  } catch (err) {
    throw new AppiiError('IO', `Cannot write ${path}: ${errorMessage(err)}`, { cause: err });
  } finally {
    await rm(probe, { force: true }).catch(() => undefined);
  }
}

export async function sameFile(a: string, b: string): Promise<boolean> {
  if (resolve(a) === resolve(b)) return true;
  const [left, right] = await Promise.all([followLinks(resolve(a)), followLinks(resolve(b))]);
  if (left === right) return true;
  const [first, second] = await Promise.all([stat(left).catch(() => undefined), stat(right).catch(() => undefined)]);
  return first !== undefined && second !== undefined && first.dev === second.dev && first.ino === second.ino;
}

async function followLinks(path: string): Promise<string> {
  let current = path;
  for (let hops = 0; hops < MAX_SYMLINKS; hops++) {
    const info = await lstat(current).catch(() => undefined);
    if (info === undefined || !info.isSymbolicLink()) return join(await realDirectory(dirname(current)), basename(current));
    current = resolve(dirname(current), await readlink(current));
  }
  throw new AppiiError('IO', `Cannot write ${path}: too many levels of symbolic links`);
}

async function realDirectory(dir: string): Promise<string> {
  const parent = dirname(dir);
  if (parent === dir) return dir;
  const info = await lstat(dir).catch(() => undefined);
  if (info === undefined) return join(await realDirectory(parent), basename(dir));
  if (info.isSymbolicLink()) return realDirectory(resolve(parent, await readlink(dir)));
  return join(await realDirectory(parent), basename(dir));
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

export const STREAM_JSON_ABOVE = 256 * 1024 * 1024;
export const STREAM_CHUNK_BYTES = 1024 * 1024;

export interface ReadJsonOptions {
  streamAbove?: number;
}

export async function readJson(path: string, options: ReadJsonOptions = {}): Promise<unknown> {
  const size = await stat(path).then(
    (info) => (info.isFile() ? info.size : 0),
    () => 0,
  );
  if (size > (options.streamAbove ?? STREAM_JSON_ABOVE)) return streamJson(path);
  const text = await readText(path);
  try {
    return JSON.parse(stripBom(text));
  } catch (err) {
    throw new AppiiError('BAD_INPUT', `${path} is not valid JSON: ${errorMessage(err)}`, { cause: err });
  }
}

async function streamJson(path: string): Promise<unknown> {
  const parser = new JsonStreamParser();
  const decoder = new TextDecoder('utf-8');
  try {
    for await (const chunk of createReadStream(path, { highWaterMark: STREAM_CHUNK_BYTES })) parser.write(decoder.decode(chunk as Buffer, { stream: true }));
    parser.write(decoder.decode());
    return parser.end();
  } catch (err) {
    if (err instanceof SyntaxError) throw new AppiiError('BAD_INPUT', `${path} is not valid JSON: ${errorMessage(err)}`, { cause: err });
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new AppiiError('NOT_FOUND', `File not found: ${path}`, { cause: err });
    throw new AppiiError('IO', `Cannot read ${path}: ${errorMessage(err)}`, { cause: err });
  }
}

export async function writeJson(path: string, value: unknown, opts: { mode?: number; indent?: number } = {}): Promise<void> {
  await writeFileAtomic(path, JSON.stringify(value, null, opts.indent ?? 2) + '\n', opts.mode === undefined ? {} : { mode: opts.mode });
}
