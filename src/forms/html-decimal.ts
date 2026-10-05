import { HtmlMicrosyntax } from './html-microsyntax.js';

export class HtmlDecimal {
  static readonly ZERO = new HtmlDecimal(0n, 0);
  static readonly ONE = new HtmlDecimal(1n, 0);
  static readonly PARTS = /^(-?)(\d*)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/;

  readonly units: bigint;
  readonly exponent: number;

  constructor(units: bigint, exponent: number) {
    let u = units;
    let e = u === 0n ? 0 : exponent;
    while (u !== 0n && u % 10n === 0n) {
      u /= 10n;
      e += 1;
    }
    this.units = u;
    this.exponent = e;
  }

  static parse(value: string | undefined): HtmlDecimal | undefined {
    if (!HtmlMicrosyntax.isValidFloat(value)) return undefined;
    if (Number(value) === 0) return HtmlDecimal.ZERO;
    const match = HtmlDecimal.PARTS.exec(value);
    if (!match) return undefined;
    const fraction = match[3] ?? '';
    const digits = `${match[2] ?? ''}${fraction}`.replace(/^0+(?=\d)/, '') || '0';
    const units = BigInt(digits) * (match[1] === '-' ? -1n : 1n);
    return new HtmlDecimal(units, Number(match[4] ?? '0') - fraction.length);
  }

  static of(value: number): HtmlDecimal {
    const parsed = HtmlDecimal.parse(Number.isFinite(value) ? String(value) : undefined);
    if (!parsed) throw new RangeError(`Not a finite number: ${value}`);
    return parsed;
  }

  get sign(): -1 | 0 | 1 {
    return this.units === 0n ? 0 : this.units < 0n ? -1 : 1;
  }

  isInteger(): boolean {
    return this.exponent >= 0;
  }

  add(other: HtmlDecimal): HtmlDecimal {
    const [a, b, e] = this.#align(other);
    return new HtmlDecimal(a + b, e);
  }

  sub(other: HtmlDecimal): HtmlDecimal {
    const [a, b, e] = this.#align(other);
    return new HtmlDecimal(a - b, e);
  }

  times(factor: bigint): HtmlDecimal {
    return new HtmlDecimal(this.units * factor, this.exponent);
  }

  half(): HtmlDecimal {
    return new HtmlDecimal(this.units * 5n, this.exponent - 1);
  }

  compare(other: HtmlDecimal): -1 | 0 | 1 {
    const [a, b] = this.#align(other);
    return a === b ? 0 : a < b ? -1 : 1;
  }

  lessThan(other: HtmlDecimal): boolean {
    return this.compare(other) < 0;
  }

  greaterThan(other: HtmlDecimal): boolean {
    return this.compare(other) > 0;
  }

  roundedQuotient(divisor: HtmlDecimal): bigint {
    let [a, b] = this.#align(divisor);
    if (b === 0n) throw new RangeError('Division by zero');
    if (b < 0n) {
      a = -a;
      b = -b;
    }
    return HtmlDecimal.#floorDiv(2n * a + b, 2n * b);
  }

  isMultipleOf(divisor: HtmlDecimal): boolean {
    const [a, b] = this.#align(divisor);
    return b !== 0n && a % b === 0n;
  }

  toNumber(): number {
    return Number(this.toString()) + 0;
  }

  toString(): string {
    if (this.units === 0n) return '0';
    const negative = this.units < 0n;
    const digits = (negative ? -this.units : this.units).toString();
    const magnitude = digits.length + this.exponent;
    if (magnitude > 21 || magnitude < -5) return String(Number(`${negative ? '-' : ''}${digits}e${this.exponent}`));
    let body: string;
    if (this.exponent >= 0) body = digits + '0'.repeat(this.exponent);
    else if (magnitude > 0) body = `${digits.slice(0, magnitude)}.${digits.slice(magnitude)}`;
    else body = `0.${'0'.repeat(-magnitude)}${digits}`;
    return (negative ? '-' : '') + body;
  }

  #align(other: HtmlDecimal): [bigint, bigint, number] {
    const exponent = Math.min(this.exponent, other.exponent);
    return [
      this.units * 10n ** BigInt(this.exponent - exponent),
      other.units * 10n ** BigInt(other.exponent - exponent),
      exponent,
    ];
  }

  static #floorDiv(numerator: bigint, denominator: bigint): bigint {
    const quotient = numerator / denominator;
    return numerator % denominator !== 0n && numerator < 0n !== denominator < 0n ? quotient - 1n : quotient;
  }
}
