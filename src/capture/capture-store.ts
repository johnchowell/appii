import { constants } from 'node:fs';
import { open, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { AppiiError, Fs, Json, Text } from '../shared/index.js';
import type { Capture } from '../model/index.js';
import { CaptureValidator } from './capture-validator.js';
import { CookieParser } from './cookie-parser.js';
import { HarConverter } from './har-converter.js';
import type { Har } from './har-types.js';

export interface CaptureStoreDeps {
  har?: HarConverter;
  validator?: CaptureValidator;
}

export class CaptureStore {
  static readonly VERSION = CaptureValidator.VERSION;
  static readonly FILE_MODE = 0o600;
  static readonly SUMMARY_PROBLEMS = 3;
  static readonly INDENT = 2;
  static readonly READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

  readonly #har: HarConverter;
  readonly #validator: CaptureValidator;

  constructor(deps: CaptureStoreDeps = {}) {
    this.#validator = deps.validator ?? new CaptureValidator();
    this.#har = deps.har ?? new HarConverter({ validator: this.#validator });
  }

  static create(): CaptureStore {
    const validator = new CaptureValidator();
    return new CaptureStore({ validator, har: new HarConverter({ cookies: new CookieParser(), validator }) });
  }

  static isCapture(value: unknown): value is Capture {
    return new CaptureValidator().isCapture(value);
  }

  static serialize(capture: Capture): string {
    return [...CaptureStore.chunks(capture)].join('') + '\n';
  }

  static *chunks(capture: Capture): Generator<string> {
    const pad = ' '.repeat(CaptureStore.INDENT);
    let first = true;
    yield '{';
    for (const [key, value] of Object.entries(capture) as [string, unknown][]) {
      if (value === undefined) continue;
      yield `${first ? '' : ','}\n${pad}${JSON.stringify(key)}: `;
      first = false;
      if (!Array.isArray(value) || value.length === 0) {
        yield CaptureStore.#json(value, pad);
        continue;
      }
      for (let i = 0; i < value.length; i++) yield `${i === 0 ? '[' : ','}\n${pad}${pad}${CaptureStore.#json(value[i] ?? null, pad + pad)}`;
      yield `\n${pad}]`;
    }
    yield first ? '}' : '\n}';
  }

  static isHar(value: unknown): value is Har {
    return Json.isPlainObject(value) && Json.isPlainObject(value.log) && Array.isArray(value.log.entries);
  }

  async save(path: string, capture: Capture): Promise<void> {
    const problems = this.#validator.validate(capture);
    if (problems.length > 0) {
      throw new AppiiError('BAD_INPUT', `Refusing to save an invalid capture: ${Text.summarize(problems, CaptureStore.SUMMARY_PROBLEMS)}`, { details: { problems } });
    }
    const tmp = Fs.tempPath(path);
    try {
      await Fs.ensureDir(dirname(path));
      await writeFile(tmp, CaptureStore.#lines(capture), { mode: CaptureStore.FILE_MODE });
      await rename(tmp, path);
    } catch (err) {
      await rm(tmp, { force: true }).catch(() => undefined);
      throw new AppiiError('IO', `Cannot write ${path}: ${Text.errorMessage(err)}`, { cause: err, details: { capture } });
    }
  }

  static *#lines(capture: Capture): Generator<string> {
    yield* CaptureStore.chunks(capture);
    yield '\n';
  }

  static #json(value: unknown, pad: string): string {
    return Json.asciiJson(value, CaptureStore.INDENT).replace(/\n/g, `\n${pad}`);
  }

  async load(path: string): Promise<Capture> {
    const value = await Fs.readJson(path);
    if (CaptureStore.isHar(value)) {
      await CaptureStore.#inlineAttachments(value, dirname(resolve(path)));
      try {
        return this.#har.fromHar(value);
      } catch (err) {
        if (err instanceof AppiiError) throw new AppiiError(err.code, `${path}: ${err.message}`, { cause: err, details: err.details });
        throw err;
      }
    }
    if (Json.isPlainObject(value) && Array.isArray(value.endpoints) && !Array.isArray(value.exchanges)) {
      throw new AppiiError('BAD_INPUT', `${path} is an API model (api.json), not a capture or HAR file`);
    }
    if (Json.isPlainObject(value) && typeof value.version === 'number' && value.version !== CaptureStore.VERSION) {
      throw new AppiiError('BAD_INPUT', `${path} has unsupported capture version ${value.version}; this appii reads version ${CaptureStore.VERSION}`);
    }
    const problems = this.#validator.validate(value);
    if (problems.length > 0) {
      throw new AppiiError('BAD_INPUT', `${path} is not a valid capture or HAR file: ${Text.summarize(problems, CaptureStore.SUMMARY_PROBLEMS)}`, { details: { problems } });
    }
    return value as Capture;
  }

  static async #inlineAttachments(har: Har, baseDir: string): Promise<void> {
    for (const entry of har.log.entries as unknown[]) {
      if (!Json.isPlainObject(entry)) continue;
      const request = entry.request;
      const response = entry.response;
      const postData = Json.isPlainObject(request) ? request.postData : undefined;
      const content = Json.isPlainObject(response) ? response.content : undefined;
      if (Json.isPlainObject(postData)) {
        const data = await CaptureStore.#attachment(postData, baseDir);
        if (data !== undefined) {
          postData.text = data;
          postData._appiiEncoding = 'base64';
        }
      }
      if (Json.isPlainObject(content)) {
        const data = await CaptureStore.#attachment(content, baseDir);
        if (data !== undefined) {
          content.text = data;
          content.encoding = 'base64';
        }
      }
    }
  }

  static async #attachment(holder: Record<string, unknown>, baseDir: string): Promise<string | undefined> {
    if (typeof holder._file !== 'string' || typeof holder.text === 'string') return undefined;
    try {
      const base = await realpath(baseDir);
      const target = await realpath(resolve(baseDir, holder._file));
      const rel = relative(base, target);
      if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return undefined;
      const handle = await open(target, CaptureStore.READ_FLAGS);
      try {
        if (!(await handle.stat()).isFile()) return undefined;
        return (await handle.readFile()).toString('base64');
      } finally {
        await handle.close();
      }
    } catch {
      return undefined;
    }
  }
}
