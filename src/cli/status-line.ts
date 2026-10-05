import { Ansi, Text } from '../shared/index.js';

export type StatusStream = NodeJS.WritableStream & { isTTY?: boolean };

export class StatusLine {
  static readonly CLEAR_LINE = Ansi.statusLine('');

  readonly #stream: StatusStream;
  #visible = false;

  constructor(stream: StatusStream) {
    this.#stream = stream;
  }

  get enabled(): boolean {
    return this.#stream.isTTY === true;
  }

  get visible(): boolean {
    return this.#visible;
  }

  show(text: string): void {
    if (!this.enabled) return;
    if (text === '') {
      this.clear();
      return;
    }
    this.#stream.write(Ansi.statusLine(Text.printable(text)));
    this.#visible = true;
  }

  clear(): void {
    if (!this.#visible) return;
    this.#stream.write(StatusLine.CLEAR_LINE);
    this.#visible = false;
  }
}
