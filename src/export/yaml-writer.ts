import { Document, isScalar, parse, visit } from 'yaml';

export interface YamlWriterOptions {
  indent?: number;
}

export type YamlVersion = '1.1' | '1.2';

export class YamlWriter {
  static readonly ESCAPED_GLOBAL: RegExp = /[^\x00-\x7e]/gu;
  static readonly NOT_PLAIN: RegExp = /[^\x20-\x7e]/;
  static readonly MERGE_KEY = '<<';
  static readonly VERSIONS: readonly YamlVersion[] = ['1.1', '1.2'];

  readonly #indent: number;

  constructor(options: YamlWriterOptions = {}) {
    this.#indent = options.indent ?? 2;
  }

  static needsQuotes(text: string, cache: Map<string, boolean> = new Map()): boolean {
    const known = cache.get(text);
    if (known !== undefined) return known;
    const quote = text === '' || text === YamlWriter.MERGE_KEY || YamlWriter.NOT_PLAIN.test(text) || !YamlWriter.VERSIONS.every((version) => YamlWriter.plainValue(text, version) === text);
    cache.set(text, quote);
    return quote;
  }

  static plainValue(text: string, version: YamlVersion): unknown {
    try {
      return parse(text, { version });
    } catch {
      return undefined;
    }
  }

  stringify(value: unknown): string {
    const doc = new Document(value, { aliasDuplicateObjects: false, schema: 'core' });
    const cache = new Map<string, boolean>();
    visit(doc, {
      Scalar(_key, node) {
        if (isScalar(node) && typeof node.value === 'string' && YamlWriter.needsQuotes(node.value, cache)) node.type = 'QUOTE_DOUBLE';
      },
    });
    const text = doc.toString({ indent: this.#indent, lineWidth: 0, minContentWidth: 0 });
    return text.replace(YamlWriter.ESCAPED_GLOBAL, (ch) => YamlWriter.escape(ch));
  }

  static escape(ch: string): string {
    const code = ch.codePointAt(0) ?? 0;
    return code <= 0xffff ? '\\u' + code.toString(16).padStart(4, '0') : '\\U' + code.toString(16).padStart(8, '0');
  }
}
