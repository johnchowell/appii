import { Json, Text } from '../shared/index.js';

export interface TsLiteralWriterOptions {
  indent?: string;
}

export class TsLiteralWriter {
  static readonly PROTO_KEY = '__proto__';

  readonly #indent: string;

  constructor(options: TsLiteralWriterOptions = {}) {
    this.#indent = options.indent ?? '  ';
  }

  write(value: unknown, depth = 0): string {
    if (value === undefined) return 'undefined';
    if (value === null) return 'null';
    if (typeof value === 'string') return Text.jsString(value);
    if (typeof value === 'number') return Number.isFinite(value) ? (Object.is(value, -0) ? '0' : String(value)) : 'null';
    if (typeof value === 'boolean') return String(value);
    if (Array.isArray(value)) {
      if (value.length === 0) return '[]';
      const pad = this.#indent.repeat(depth + 1);
      return `[\n${value.map((item) => `${pad}${this.write(item, depth + 1)}`).join(',\n')},\n${this.#indent.repeat(depth)}]`;
    }
    if (Json.isPlainObject(value)) {
      const entries = Object.entries(value).filter(([, item]) => item !== undefined);
      if (entries.length === 0) return '{}';
      const pad = this.#indent.repeat(depth + 1);
      const lines = entries.map(([key, item]) => `${pad}${TsLiteralWriter.key(key)}: ${this.write(item, depth + 1)}`);
      return `{\n${lines.join(',\n')},\n${this.#indent.repeat(depth)}}`;
    }
    return 'null';
  }

  static key(name: string): string {
    return name === TsLiteralWriter.PROTO_KEY ? `[${Text.jsString(name)}]` : Text.propertyKey(name);
  }
}
