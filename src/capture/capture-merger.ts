import { AppiiError, Json, Meta } from '../shared/index.js';
import type { Capture, Cookie, Exchange, PageSnapshot, SourceCapture, StorageSnapshot, WebSocketCapture } from '../model/index.js';
import { CaptureStore } from './capture-store.js';
import { CookieParser } from './cookie-parser.js';

export interface CaptureInput {
  capture: Capture;
  file?: string;
}

export interface MergedCapture {
  capture: Capture;
  sources: SourceCapture[];
}

interface Ranked {
  readonly input: CaptureInput;
  readonly order: number;
}

export class CaptureMerger {
  static create(): CaptureMerger {
    return new CaptureMerger();
  }

  static source(input: CaptureInput): SourceCapture {
    const { capture, file } = input;
    return {
      ...(file === undefined ? {} : { file }),
      ...(capture.startUrl === undefined ? {} : { startUrl: capture.startUrl }),
      capturedFrom: capture.startedAt,
      capturedTo: capture.endedAt,
      exchanges: capture.exchanges.length,
    };
  }

  merge(inputs: readonly CaptureInput[]): MergedCapture {
    const first = inputs[0];
    if (first === undefined) throw new AppiiError('BAD_INPUT', 'Nothing to merge: give at least one capture or HAR file');
    const sources = inputs.map((input) => CaptureMerger.source(input));
    if (inputs.length === 1) return { capture: first.capture, sources };
    const ranked = inputs.map((input, order) => ({ input, order }));
    const chronological = [...ranked].sort((a, b) => CaptureMerger.#time(a.input.capture.startedAt) - CaptureMerger.#time(b.input.capture.startedAt) || a.order - b.order);
    const captures = chronological.map((item) => item.input.capture);
    const startUrl = captures.find((capture) => capture.startUrl !== undefined)?.startUrl;
    return {
      capture: {
        version: CaptureStore.VERSION,
        tool: Meta.creator() as Capture['tool'],
        ...(startUrl === undefined ? {} : { startUrl }),
        startedAt: CaptureMerger.#extreme(captures.map((capture) => capture.startedAt), Math.min),
        endedAt: CaptureMerger.#extreme(captures.map((capture) => capture.endedAt), Math.max),
        exchanges: CaptureMerger.#distinct(captures.flatMap((capture) => capture.exchanges), (exchange: Exchange) => exchange.id),
        websockets: CaptureMerger.#distinct(captures.flatMap((capture) => capture.websockets), (socket: WebSocketCapture) => JSON.stringify([socket.id, socket.openedAt])),
        cookies: CaptureMerger.#cookies(ranked),
        storage: CaptureMerger.#distinct(captures.flatMap((capture) => capture.storage), (entry: StorageSnapshot) => Json.asciiJson(entry)),
        pages: CaptureMerger.#distinct(captures.flatMap((capture) => capture.pages), (page: PageSnapshot) => JSON.stringify([page.url, page.capturedAt, page.html])),
      },
      sources,
    };
  }

  static #cookies(ranked: readonly Ranked[]): Cookie[] {
    const byEnd = [...ranked].sort((a, b) => CaptureMerger.#time(a.input.capture.endedAt) - CaptureMerger.#time(b.input.capture.endedAt) || a.order - b.order);
    const jar = new Map<string, Cookie>();
    for (const item of byEnd) {
      for (const cookie of item.input.capture.cookies) {
        const key = CookieParser.key(cookie);
        jar.delete(key);
        jar.set(key, cookie);
      }
    }
    return [...jar.values()];
  }

  static #distinct<T>(items: readonly T[], identity: (item: T) => string): T[] {
    const seen = new Set<string>();
    const out: T[] = [];
    for (const item of items) {
      const key = identity(item);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  static #extreme(values: readonly string[], pick: (...numbers: number[]) => number): string {
    const valid = values.filter((value) => !Number.isNaN(Date.parse(value)));
    const chosen = pick(...valid.map((value) => Date.parse(value)));
    return valid.find((value) => Date.parse(value) === chosen) ?? values[0] ?? '';
  }

  static #time(value: string): number {
    const ms = Date.parse(value);
    return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
  }
}
