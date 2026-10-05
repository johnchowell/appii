import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { CliContext } from './cli-context.js';

export class Helpers {
  static readonly LIST_SEPARATOR: RegExp = /,/;
  static readonly MIN_PREFIX_LENGTH = 2;
  static readonly DIRECTORY_SUFFIX: RegExp = /[\\/]$/;

  static errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  static splitList(values: readonly string[]): string[] {
    return values.flatMap((value) => value.split(Helpers.LIST_SEPARATOR)).map((part) => part.trim()).filter((part) => part !== '');
  }

  static distance(a: string, b: string): number {
    const rows = a.length + 1;
    const cols = b.length + 1;
    const d: number[][] = Array.from({ length: rows }, (_, i) => Array.from({ length: cols }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
    const at = (i: number, j: number): number => d[i]?.[j] ?? Number.POSITIVE_INFINITY;
    for (let i = 1; i < rows; i++) {
      const row = d[i];
      if (!row) continue;
      for (let j = 1; j < cols; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        let best = Math.min(at(i - 1, j) + 1, at(i, j - 1) + 1, at(i - 1, j - 1) + cost);
        if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, at(i - 2, j - 2) + 1);
        row[j] = best;
      }
    }
    return at(a.length, b.length);
  }

  static closest(input: string, candidates: readonly string[]): string | undefined {
    const needle = input.toLowerCase();
    if (needle === '') return undefined;
    const exact = candidates.find((candidate) => candidate.toLowerCase() === needle);
    if (exact !== undefined) return exact;
    if (needle.length >= Helpers.MIN_PREFIX_LENGTH) {
      const prefixed = candidates.filter((candidate) => candidate.toLowerCase().startsWith(needle));
      if (prefixed.length === 1) return prefixed[0];
    }
    const limit = needle.length <= 3 ? 1 : 2;
    let best: string | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      const distance = Helpers.distance(needle, candidate.toLowerCase());
      if (distance < bestDistance) {
        best = candidate;
        bestDistance = distance;
      }
    }
    return bestDistance <= limit ? best : undefined;
  }

  static async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  static async outputFile(ctx: CliContext, out: string | undefined, filename: string): Promise<string> {
    if (out === undefined) return ctx.resolve(filename);
    const path = ctx.resolve(out);
    return Helpers.DIRECTORY_SUFFIX.test(out) || (await Helpers.isDirectory(path)) ? join(path, filename) : path;
  }
}
