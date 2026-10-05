import { Token, Tokenizer, TokenizerMode } from 'parse5';
import type { TokenHandler } from 'parse5';

export interface ScannedAttribute {
  readonly name: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

export interface ScannedTag {
  readonly name: string;
  readonly attrs: readonly ScannedAttribute[];
  readonly start: number;
  readonly end: number;
}

export interface HtmlScan {
  readonly tags: readonly ScannedTag[];
  readonly complete: number;
}

type ForeignSpace = 'svg' | 'math';

interface ForeignFrame {
  readonly name: string;
  readonly space: ForeignSpace;
  readonly integration: boolean;
}

interface PendingToken {
  readonly currentToken: Token.Token | null;
}

type TextMode = (typeof TokenizerMode)[keyof typeof TokenizerMode];

export class HtmlTagScanner {
  static readonly SVG = 'svg';
  static readonly MATH = 'math';
  static readonly FONT = 'font';
  static readonly ANNOTATION_XML = 'annotation-xml';
  static readonly ENCODING = 'encoding';
  static readonly RAW_TEXT_MODES: Readonly<Record<string, TextMode>> = Object.freeze({
    script: TokenizerMode.SCRIPT_DATA,
    style: TokenizerMode.RAWTEXT,
    xmp: TokenizerMode.RAWTEXT,
    iframe: TokenizerMode.RAWTEXT,
    noembed: TokenizerMode.RAWTEXT,
    noframes: TokenizerMode.RAWTEXT,
    textarea: TokenizerMode.RCDATA,
    title: TokenizerMode.RCDATA,
    plaintext: TokenizerMode.PLAINTEXT,
  });
  static readonly BREAKOUT_TAGS: readonly string[] = Object.freeze([
    'b', 'big', 'blockquote', 'body', 'br', 'center', 'code', 'dd', 'div', 'dl', 'dt', 'em', 'embed', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'head', 'hr', 'i', 'img', 'li', 'listing', 'menu', 'meta', 'nobr', 'ol', 'p', 'pre', 'ruby', 's', 'small', 'span', 'strong', 'strike',
    'sub', 'sup', 'table', 'tt', 'u', 'ul', 'var',
  ]);
  static readonly BREAKOUT_END_TAGS: readonly string[] = Object.freeze(['br', 'p']);
  static readonly FONT_BREAKOUT_ATTRIBUTES: readonly string[] = Object.freeze(['color', 'face', 'size']);
  static readonly SVG_INTEGRATION_POINTS: readonly string[] = Object.freeze(['foreignobject', 'desc', 'title']);
  static readonly MATH_TEXT_INTEGRATION_POINTS: readonly string[] = Object.freeze(['mi', 'mo', 'mn', 'ms', 'mtext']);
  static readonly HTML_ANNOTATION_ENCODINGS: readonly string[] = Object.freeze(['text/html', 'application/xhtml+xml']);

  scan(source: string, names?: readonly string[]): HtmlScan {
    const tags: ScannedTag[] = [];
    const frames: ForeignFrame[] = [];
    let complete = source.length;
    const ignore = (): void => undefined;
    const handler: TokenHandler = {
      onStartTag: (token) => {
        if (names === undefined || names.includes(token.tagName)) tags.push(HtmlTagScanner.#tag(token));
        const mode = HtmlTagScanner.#startTag(frames, token);
        if (mode !== undefined) tokenizer.state = mode;
      },
      onEndTag: (token) => HtmlTagScanner.#endTag(frames, token.tagName),
      onEof: () => {
        const pending = (tokenizer as unknown as PendingToken).currentToken;
        if (pending && HtmlTagScanner.#isTag(pending) && pending.location) complete = pending.location.startOffset;
      },
      onComment: ignore,
      onDoctype: ignore,
      onCharacter: ignore,
      onNullCharacter: ignore,
      onWhitespaceCharacter: ignore,
    };
    const tokenizer = new Tokenizer({ sourceCodeLocationInfo: true }, handler);
    tokenizer.write(source, true);
    return { tags, complete };
  }

  static #tag(token: Token.TagToken): ScannedTag {
    const location = token.location;
    const attrs = token.attrs.flatMap((attr): ScannedAttribute[] => {
      const at = location?.attrs?.[attr.name];
      return at ? [{ name: attr.name, value: attr.value, start: at.startOffset, end: at.endOffset }] : [];
    });
    return { name: token.tagName, attrs, start: location?.startOffset ?? 0, end: location?.endOffset ?? 0 };
  }

  static #startTag(frames: ForeignFrame[], token: Token.TagToken): TextMode | undefined {
    const name = token.tagName;
    if (HtmlTagScanner.#foreign(frames)) {
      if (!HtmlTagScanner.#breaksOut(token)) {
        if (!token.selfClosing) frames.push(HtmlTagScanner.#frame(frames, token));
        return undefined;
      }
      HtmlTagScanner.#leaveForeign(frames);
    }
    if (name === HtmlTagScanner.SVG || name === HtmlTagScanner.MATH) {
      if (!token.selfClosing) frames.push({ name, space: name, integration: false });
      return undefined;
    }
    return HtmlTagScanner.RAW_TEXT_MODES[name];
  }

  static #endTag(frames: ForeignFrame[], name: string): void {
    const top = frames[frames.length - 1];
    if (!top) return;
    if (top.integration) {
      if (top.name === name) frames.pop();
      return;
    }
    if (HtmlTagScanner.BREAKOUT_END_TAGS.includes(name)) {
      HtmlTagScanner.#leaveForeign(frames);
      return;
    }
    for (let i = frames.length - 1; i >= 0; i--) {
      const frame = frames[i];
      if (!frame || frame.integration) return;
      if (frame.name === name) {
        frames.length = i;
        return;
      }
    }
  }

  static #frame(frames: readonly ForeignFrame[], token: Token.TagToken): ForeignFrame {
    const parent = frames[frames.length - 1];
    const name = token.tagName;
    const svgInMath = parent?.space === HtmlTagScanner.MATH && parent.name === HtmlTagScanner.ANNOTATION_XML && name === HtmlTagScanner.SVG;
    const space: ForeignSpace = svgInMath ? HtmlTagScanner.SVG : (parent?.space ?? HtmlTagScanner.SVG);
    return { name, space, integration: HtmlTagScanner.#integration(space, token) };
  }

  static #integration(space: ForeignSpace, token: Token.TagToken): boolean {
    const name = token.tagName;
    if (space === HtmlTagScanner.SVG) return HtmlTagScanner.SVG_INTEGRATION_POINTS.includes(name);
    if (HtmlTagScanner.MATH_TEXT_INTEGRATION_POINTS.includes(name)) return true;
    if (name !== HtmlTagScanner.ANNOTATION_XML) return false;
    const encoding = token.attrs.find((attr) => attr.name === HtmlTagScanner.ENCODING)?.value.toLowerCase();
    return encoding !== undefined && HtmlTagScanner.HTML_ANNOTATION_ENCODINGS.includes(encoding);
  }

  static #breaksOut(token: Token.TagToken): boolean {
    if (HtmlTagScanner.BREAKOUT_TAGS.includes(token.tagName)) return true;
    return token.tagName === HtmlTagScanner.FONT && token.attrs.some((attr) => HtmlTagScanner.FONT_BREAKOUT_ATTRIBUTES.includes(attr.name));
  }

  static #foreign(frames: readonly ForeignFrame[]): boolean {
    const top = frames[frames.length - 1];
    return top !== undefined && !top.integration;
  }

  static #leaveForeign(frames: ForeignFrame[]): void {
    while (HtmlTagScanner.#foreign(frames)) frames.pop();
  }

  static #isTag(token: Token.Token): token is Token.TagToken {
    return token.type === Token.TokenType.START_TAG || token.type === Token.TokenType.END_TAG;
  }
}
