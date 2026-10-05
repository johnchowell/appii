import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CaptureStore } from '../capture/index.js';
import { AppiiError, Fs, Json, Text, isAppiiError } from '../shared/index.js';
import type { Capture } from '../model/index.js';

export interface CaptureSaverDeps {
  store?: CaptureStore;
  probe?: (path: string) => Promise<void>;
  fallbackDir?: () => string;
  now?: () => Date;
}

export class CaptureSaver {
  static readonly FALLBACK_PREFIX = 'appii-capture-';
  static readonly FALLBACK_SUFFIX = '.json';
  static readonly UNIQUE_BYTES = 3;
  static readonly PARTIAL_CODE = 'BROWSER';

  readonly #store: CaptureStore;
  readonly #probe: (path: string) => Promise<void>;
  readonly #fallbackDir: () => string;
  readonly #now: () => Date;

  constructor(deps: CaptureSaverDeps = {}) {
    this.#store = deps.store ?? new CaptureStore();
    this.#probe = deps.probe ?? Fs.assertWritable;
    this.#fallbackDir = deps.fallbackDir ?? tmpdir;
    this.#now = deps.now ?? (() => new Date());
  }

  static create(): CaptureSaver {
    return new CaptureSaver({ store: CaptureStore.create(), probe: Fs.assertWritable, fallbackDir: tmpdir, now: () => new Date() });
  }

  async preflight(paths: readonly string[]): Promise<void> {
    for (const path of paths) await this.#probe(path);
  }

  fallbackPath(): string {
    const stamp = this.#now().toISOString().replace(/[:.]/g, '-');
    const unique = randomBytes(CaptureSaver.UNIQUE_BYTES).toString('hex');
    return join(this.#fallbackDir(), `${CaptureSaver.FALLBACK_PREFIX}${stamp}-${unique}${CaptureSaver.FALLBACK_SUFFIX}`);
  }

  async save(path: string, capture: Capture): Promise<void> {
    try {
      await this.#store.save(path, capture);
    } catch (err) {
      throw await this.#rescue(err, capture);
    }
  }

  async keepPartial(err: unknown, path: string, shown: string): Promise<unknown> {
    const partial = CaptureSaver.partial(err);
    if (!partial || !isAppiiError(err)) return err;
    await this.save(path, partial);
    const count = partial.exchanges.length;
    const kept = `${Text.plural(count, 'request')} recorded until then ${count === 1 ? 'was' : 'were'}`;
    return new AppiiError(err.code, `${err.message}. The ${kept} saved to ${shown}`, { cause: err });
  }

  static partial(err: unknown): Capture | undefined {
    if (!isAppiiError(err) || err.code !== CaptureSaver.PARTIAL_CODE || !Json.isPlainObject(err.details)) return undefined;
    const capture = err.details.capture;
    if (!Json.isPlainObject(capture) || !Array.isArray(capture.exchanges) || capture.exchanges.length === 0) return undefined;
    return capture as unknown as Capture;
  }

  async #rescue(err: unknown, capture: Capture): Promise<AppiiError> {
    const message = Text.errorMessage(err);
    const problems = isAppiiError(err) && Json.isPlainObject(err.details) && Array.isArray(err.details.problems) ? { problems: err.details.problems } : {};
    const fallback = this.fallbackPath();
    try {
      await Fs.writeFileAtomic(fallback, CaptureStore.serialize(capture), { mode: CaptureStore.FILE_MODE });
    } catch (rescue) {
      return new AppiiError('IO', `${message}; the recording could not be saved to ${fallback} either: ${Text.errorMessage(rescue)}`, { cause: err, details: problems });
    }
    return new AppiiError('IO', `${message}; the recording was saved to ${fallback}`, { cause: err, details: { ...problems, fallback } });
  }
}
