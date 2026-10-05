import { Document, isScalar, visit } from 'yaml';

export interface YamlWriterOptions {
  indent?: number;
}

export class YamlWriter {
  static readonly NON_ASCII: RegExp = /[^\x00-\x7f]/u;
  static readonly NON_ASCII_GLOBAL: RegExp = /[^\x00-\x7f]/gu;

  readonly #indent: number;

  constructor(options: YamlWriterOptions = {}) {
    this.#indent = options.indent ?? 2;
  }

  stringify(value: unknown): string {
    const doc = new Document(value, { aliasDuplicateObjects: false, schema: 'yaml-1.1' });
    visit(doc, {
      Scalar(_key, node) {
        if (isScalar(node) && typeof node.value === 'string' && YamlWriter.NON_ASCII.test(node.value)) node.type = 'QUOTE_DOUBLE';
      },
    });
    const text = doc.toString({ indent: this.#indent, lineWidth: 0, minContentWidth: 0 });
    return text.replace(YamlWriter.NON_ASCII_GLOBAL, (ch) => YamlWriter.escape(ch));
  }

  static escape(ch: string): string {
    const code = ch.codePointAt(0) ?? 0;
    return code <= 0xffff ? '\\u' + code.toString(16).padStart(4, '0') : '\\U' + code.toString(16).padStart(8, '0');
  }
}
