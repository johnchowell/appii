type JsonContainer = Record<string, unknown> | unknown[];

type ParserMode = 'value' | 'firstValue' | 'afterValue' | 'key' | 'firstKey' | 'colon' | 'string' | 'done';

interface JsonFrame {
  readonly container: JsonContainer;
  key: string | undefined;
}

export class JsonStreamParser {
  static readonly NUMBER: RegExp = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
  static readonly LITERALS: Readonly<Record<string, boolean | null>> = Object.freeze({ true: true, false: false, null: null });
  static readonly LONGEST_ESCAPE = 6;
  static readonly PROTO_KEY = '__proto__';

  readonly #stack: JsonFrame[] = [];
  #mode: ParserMode = 'value';
  #carry = '';
  #parts: string[] = [];
  #stringIsKey = false;
  #root: unknown = undefined;
  #offset = 0;

  static parse(chunks: Iterable<string>): unknown {
    const parser = new JsonStreamParser();
    for (const chunk of chunks) parser.write(chunk);
    return parser.end();
  }

  write(chunk: string): void {
    const text = this.#carry + chunk;
    const base = this.#offset - this.#carry.length;
    this.#carry = '';
    this.#offset += chunk.length;
    this.#run(text, base, false);
  }

  end(): unknown {
    const text = this.#carry;
    this.#carry = '';
    this.#run(text, this.#offset - text.length, true);
    if (this.#mode !== 'done') throw new SyntaxError(`Unexpected end of JSON input at position ${this.#offset}`);
    return this.#root;
  }

  #run(text: string, base: number, ending: boolean): void {
    let i = 0;
    while (i < text.length) {
      if (this.#mode === 'string') {
        const close = JsonStreamParser.#closingQuote(text, i);
        if (close < 0) {
          if (ending) throw new SyntaxError(`Unterminated string in JSON at position ${base + text.length}`);
          const cut = this.#piece(text, i, base);
          this.#carry = text.slice(cut);
          return;
        }
        this.#parts.push(JsonStreamParser.#decode(text.slice(i, close), base + i));
        i = close + 1;
        const value = this.#parts.length === 1 ? (this.#parts[0] ?? '') : this.#parts.join('');
        this.#parts = [];
        if (this.#stringIsKey) {
          this.#top(base + i).key = value;
          this.#mode = 'colon';
        } else this.#deliver(value);
        continue;
      }
      const code = text.charCodeAt(i);
      if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) {
        i++;
        continue;
      }
      const ch = text.charAt(i);
      const at = base + i;
      switch (this.#mode) {
        case 'done':
          throw JsonStreamParser.#unexpected(ch, at);
        case 'colon':
          if (ch !== ':') throw JsonStreamParser.#unexpected(ch, at);
          this.#mode = 'value';
          i++;
          continue;
        case 'firstKey':
        case 'key':
          if (ch === '}' && this.#mode === 'firstKey') {
            i++;
            this.#close(false, at);
            continue;
          }
          if (ch !== '"') throw JsonStreamParser.#unexpected(ch, at);
          this.#stringIsKey = true;
          this.#mode = 'string';
          i++;
          continue;
        case 'afterValue': {
          const frame = this.#top(at);
          const array = Array.isArray(frame.container);
          if (ch === ',') this.#mode = array ? 'value' : 'key';
          else if (ch === (array ? ']' : '}')) this.#close(array, at);
          else throw JsonStreamParser.#unexpected(ch, at);
          i++;
          continue;
        }
        default: {
          if (ch === ']' && this.#mode === 'firstValue') {
            i++;
            this.#close(true, at);
            continue;
          }
          if (ch === '"') {
            this.#stringIsKey = false;
            this.#mode = 'string';
            i++;
            continue;
          }
          if (ch === '{' || ch === '[') {
            this.#stack.push({ container: ch === '{' ? {} : [], key: undefined });
            this.#mode = ch === '{' ? 'firstKey' : 'firstValue';
            i++;
            continue;
          }
          let end = i;
          while (end < text.length && /[-+.0-9a-zA-Z]/.test(text.charAt(end))) end++;
          if (end === text.length && !ending) {
            this.#carry = text.slice(i);
            return;
          }
          this.#deliver(JsonStreamParser.#scalar(text.slice(i, end), at));
          i = end;
        }
      }
    }
  }

  #piece(text: string, from: number, base: number): number {
    const limit = Math.max(from, text.length - JsonStreamParser.LONGEST_ESCAPE);
    let failure: unknown;
    for (let cut = text.length; cut >= limit; cut--) {
      try {
        if (cut > from) this.#parts.push(JsonStreamParser.#decode(text.slice(from, cut), base + from));
        return cut;
      } catch (err) {
        failure ??= err;
      }
    }
    throw failure;
  }

  #deliver(value: unknown): void {
    const frame = this.#stack[this.#stack.length - 1];
    if (frame === undefined) {
      this.#root = value;
      this.#mode = 'done';
      return;
    }
    const container = frame.container;
    if (Array.isArray(container)) container.push(value);
    else if (frame.key === JsonStreamParser.PROTO_KEY) Object.defineProperty(container, frame.key, { value, writable: true, enumerable: true, configurable: true });
    else container[frame.key ?? ''] = value;
    this.#mode = 'afterValue';
  }

  #close(array: boolean, at: number): void {
    const frame = this.#stack.pop();
    if (frame === undefined || Array.isArray(frame.container) !== array) throw new SyntaxError(`Unexpected '${array ? ']' : '}'}' in JSON at position ${at}`);
    this.#deliver(frame.container);
  }

  #top(at: number): JsonFrame {
    const frame = this.#stack[this.#stack.length - 1];
    if (frame === undefined) throw new SyntaxError(`Unexpected token in JSON at position ${at}`);
    return frame;
  }

  static #closingQuote(text: string, from: number): number {
    for (let at = text.indexOf('"', from); at >= 0; at = text.indexOf('"', at + 1)) {
      let slashes = 0;
      for (let back = at - 1; back >= from && text.charCodeAt(back) === 0x5c; back--) slashes++;
      if (slashes % 2 === 0) return at;
    }
    return -1;
  }

  static #decode(raw: string, at: number): string {
    if (!raw.includes('\\') && !/[\x00-\x1f]/.test(raw)) return raw;
    try {
      return JSON.parse(`"${raw}"`) as string;
    } catch {
      throw new SyntaxError(`Bad string in JSON near position ${at}`);
    }
  }

  static #scalar(token: string, at: number): unknown {
    if (Object.hasOwn(JsonStreamParser.LITERALS, token)) return JsonStreamParser.LITERALS[token];
    if (JsonStreamParser.NUMBER.test(token)) return Number(token);
    throw new SyntaxError(`Unexpected token '${token.slice(0, 20)}' in JSON at position ${at}`);
  }

  static #unexpected(ch: string, at: number): SyntaxError {
    return new SyntaxError(`Unexpected '${ch}' in JSON at position ${at}`);
  }
}
