import { snakeCase } from './text.js';

export interface LiteralPart {
  readonly kind: 'literal';
  readonly text: string;
}

export type PlaceholderEncoding = 'component' | 'json';

export interface PlaceholderPart {
  readonly kind: 'placeholder';
  readonly name: string;
  readonly encoding?: PlaceholderEncoding;
}

export type SamplePart = LiteralPart | PlaceholderPart;

export interface SampleRenderer {
  literal(text: string): string;
  placeholder(name: string, part: PlaceholderPart): string;
}

export type SampleTextInput = SampleText | string;

export class SampleText {
  static readonly DEFAULT_NAME = 'value';
  static readonly NAME_PREFIX = '_';
  static readonly DISPLAY: SampleRenderer = Object.freeze({
    literal: (text: string): string => text,
    placeholder: (name: string): string => `{{${name}}}`,
  });

  readonly parts: readonly SamplePart[];

  private constructor(parts: readonly SamplePart[]) {
    const merged: SamplePart[] = [];
    for (const part of parts) {
      if (part.kind === 'literal' && part.text === '') continue;
      const last = merged[merged.length - 1];
      if (part.kind === 'literal' && last?.kind === 'literal') merged[merged.length - 1] = Object.freeze({ kind: 'literal', text: last.text + part.text });
      else merged.push(Object.freeze({ ...part }));
    }
    this.parts = Object.freeze(merged);
  }

  static literal(text: string): SampleText {
    return new SampleText([{ kind: 'literal', text }]);
  }

  static placeholder(name: string, encoding?: PlaceholderEncoding): SampleText {
    const part: PlaceholderPart = encoding === undefined ? { kind: 'placeholder', name: SampleText.placeholderName(name) } : { kind: 'placeholder', name: SampleText.placeholderName(name), encoding };
    return new SampleText([part]);
  }

  static placeholderName(name: string): string {
    const snake = snakeCase(name) || SampleText.DEFAULT_NAME;
    return /^[0-9]/.test(snake) ? SampleText.NAME_PREFIX + snake : snake;
  }

  static of(input: SampleTextInput): SampleText {
    return input instanceof SampleText ? input : SampleText.literal(input);
  }

  static concat(...items: readonly SampleTextInput[]): SampleText {
    return new SampleText(items.flatMap((item) => SampleText.of(item).parts));
  }

  static join(items: readonly SampleTextInput[], separator: string): SampleText {
    return SampleText.concat(...items.flatMap((item, i) => (i === 0 ? [item] : [separator, item])));
  }

  get isLiteral(): boolean {
    return this.parts.every((part) => part.kind === 'literal');
  }

  placeholders(): string[] {
    const names: string[] = [];
    for (const part of this.parts) if (part.kind === 'placeholder' && !names.includes(part.name)) names.push(part.name);
    return names;
  }

  map(rename: (name: string) => SampleTextInput): SampleText {
    return SampleText.concat(
      ...this.parts.map((part) => {
        if (part.kind === 'literal') return SampleText.literal(part.text);
        const next = SampleText.of(rename(part.name));
        return part.encoding === undefined ? next : next.encoded(part.encoding);
      }),
    );
  }

  encoded(encoding: PlaceholderEncoding): SampleText {
    return new SampleText(this.parts.map((part): SamplePart => (part.kind === 'placeholder' && part.encoding === undefined ? { ...part, encoding } : part)));
  }

  mapLiterals(transform: (text: string) => string): SampleText {
    return new SampleText(this.parts.map((part): SamplePart => (part.kind === 'literal' ? { kind: 'literal', text: transform(part.text) } : part)));
  }

  render(renderer: SampleRenderer): string {
    return this.parts.map((part) => (part.kind === 'literal' ? renderer.literal(part.text) : renderer.placeholder(part.name, part))).join('');
  }

  toString(): string {
    return this.render(SampleText.DISPLAY);
  }
}
