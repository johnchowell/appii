import { Helpers } from './helpers.js';
import { UsageError } from './usage-error.js';

export type OptionValue = string | boolean | (string | boolean)[] | undefined;

export type OptionValues = Readonly<Record<string, OptionValue>>;

export interface IntegerRange {
  min?: number;
  max?: number;
}

export interface SecondsRange {
  positive?: boolean;
}

export class OptionReader {
  static readonly INTEGER: RegExp = /^[0-9]+$/;
  static readonly DECIMAL: RegExp = /^(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)$/;
  static readonly MAX_TIMER_MS = 2 ** 31 - 1;

  static string(values: OptionValues, name: string): string | undefined {
    const value = values[name];
    const last = Array.isArray(value) ? value[value.length - 1] : value;
    if (typeof last !== 'string') return undefined;
    if (last === '') throw new UsageError(`${OptionReader.flag(name)} needs a non-empty value`);
    return last;
  }

  static strings(values: OptionValues, name: string): string[] {
    const value = values[name];
    const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
    const strings = list.filter((item): item is string => typeof item === 'string');
    if (strings.some((item) => item === '')) throw new UsageError(`${OptionReader.flag(name)} needs a non-empty value`);
    return strings;
  }

  static boolean(values: OptionValues, name: string): boolean | undefined {
    const value = values[name];
    const last = Array.isArray(value) ? value[value.length - 1] : value;
    return typeof last === 'boolean' ? last : undefined;
  }

  static list(values: OptionValues, name: string): string[] {
    return Helpers.splitList(OptionReader.strings(values, name));
  }

  static integer(values: OptionValues, name: string, range: IntegerRange = {}): number | undefined {
    const raw = OptionReader.string(values, name);
    if (raw === undefined) return undefined;
    const text = raw.trim();
    const value = Number(text);
    if (!OptionReader.INTEGER.test(text) || !Number.isSafeInteger(value)) {
      throw new UsageError(`${OptionReader.flag(name)} must be a whole number, got '${raw}'`);
    }
    if (range.min !== undefined && value < range.min) throw new UsageError(`${OptionReader.flag(name)} must be at least ${range.min}, got ${value}`);
    if (range.max !== undefined && value > range.max) throw new UsageError(`${OptionReader.flag(name)} must be at most ${range.max}, got ${value}`);
    return value;
  }

  static seconds(values: OptionValues, name: string, range: SecondsRange = {}): number | undefined {
    const raw = OptionReader.string(values, name);
    if (raw === undefined) return undefined;
    const text = raw.trim();
    if (!OptionReader.DECIMAL.test(text)) throw new UsageError(`${OptionReader.flag(name)} must be a number of seconds, got '${raw}'`);
    const ms = Math.round(Number(text) * 1000);
    if (range.positive === true && ms <= 0) throw new UsageError(`${OptionReader.flag(name)} must be more than 0 seconds, got '${raw}'`);
    if (ms > OptionReader.MAX_TIMER_MS) {
      throw new UsageError(`${OptionReader.flag(name)} must be at most ${Math.floor(OptionReader.MAX_TIMER_MS / 1000)} seconds, got '${raw}'`);
    }
    return ms;
  }

  static flag(name: string): string {
    return `--${name}`;
  }
}
