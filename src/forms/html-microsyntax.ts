export class HtmlMicrosyntax {
  static readonly WHITESPACE_RUN = /[\t\n\f\r ]+/g;
  static readonly VALID_FLOAT = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;
  static readonly NON_NEGATIVE_INTEGER_PREFIX = /^[\t\n\f\r ]*([+-]?)(\d+)/;
  static readonly MAX_INTEGER = 2147483647;
  static readonly EMAIL =
    /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
  static readonly SIMPLE_COLOR = /^#[0-9a-fA-F]{6}$/;
  static readonly DATE = /^(\d{4,})-(\d{2})-(\d{2})$/;
  static readonly MONTH = /^(\d{4,})-(\d{2})$/;
  static readonly WEEK = /^(\d{4,})-W(\d{2})$/;
  static readonly TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?$/;
  static readonly LOCAL_DATE_TIME = /^(\d{4,}-\d{2}-\d{2})[T ](.*)$/s;

  static asciiLower(value: string): string {
    return value.replace(/[A-Z]+/g, (s) => s.toLowerCase());
  }

  static trim(value: string): string {
    return value.replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, '');
  }

  static collapse(value: string): string {
    return HtmlMicrosyntax.trim(value.replace(HtmlMicrosyntax.WHITESPACE_RUN, ' '));
  }

  static stripNewlines(value: string): string {
    return value.replace(/[\r\n]/g, '');
  }

  static normalizeNewlines(value: string): string {
    return value.replace(/\r\n?/g, '\n');
  }

  static splitWhitespace(value: string): string[] {
    return value.split(HtmlMicrosyntax.WHITESPACE_RUN).filter((token) => token !== '');
  }

  static parseNonNegativeInteger(value: string | undefined): number | undefined {
    if (value === undefined) return undefined;
    const match = HtmlMicrosyntax.NON_NEGATIVE_INTEGER_PREFIX.exec(value);
    if (!match) return undefined;
    const digits = (match[2] ?? '').replace(/^0+(?=\d)/, '');
    if (digits.length > 10) return undefined;
    const parsed = Number(digits);
    if (match[1] === '-' && parsed !== 0) return undefined;
    return parsed > HtmlMicrosyntax.MAX_INTEGER ? undefined : parsed;
  }

  static isValidFloat(value: string | undefined): value is string {
    return value !== undefined && HtmlMicrosyntax.VALID_FLOAT.test(value) && Number.isFinite(Number(value));
  }

  static parseFloat(value: string | undefined): number | undefined {
    return HtmlMicrosyntax.isValidFloat(value) ? Number(value) + 0 : undefined;
  }

  static isLeapYear(year: number): boolean {
    return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  }

  static daysInMonth(year: number, month: number): number {
    if (month === 2) return HtmlMicrosyntax.isLeapYear(year) ? 29 : 28;
    return [4, 6, 9, 11].includes(month) ? 30 : 31;
  }

  static weeksInYear(year: number): number {
    const jan1 = HtmlMicrosyntax.#weekdayOfJanuaryFirst(year);
    return jan1 === 4 || (jan1 === 3 && HtmlMicrosyntax.isLeapYear(year)) ? 53 : 52;
  }

  static isValidDate(value: string): boolean {
    const match = HtmlMicrosyntax.DATE.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= HtmlMicrosyntax.daysInMonth(year, month);
  }

  static isValidMonth(value: string): boolean {
    const match = HtmlMicrosyntax.MONTH.exec(value);
    if (!match) return false;
    const month = Number(match[2]);
    return Number(match[1]) > 0 && month >= 1 && month <= 12;
  }

  static isValidWeek(value: string): boolean {
    const match = HtmlMicrosyntax.WEEK.exec(value);
    if (!match) return false;
    const year = Number(match[1]);
    const week = Number(match[2]);
    return year > 0 && week >= 1 && week <= HtmlMicrosyntax.weeksInYear(year);
  }

  static isValidTime(value: string): boolean {
    const match = HtmlMicrosyntax.TIME.exec(value);
    if (!match) return false;
    return Number(match[1]) <= 23 && Number(match[2]) <= 59 && Number(match[3] ?? '0') <= 59;
  }

  static normalizeLocalDateTime(value: string): string | undefined {
    const match = HtmlMicrosyntax.LOCAL_DATE_TIME.exec(value);
    if (!match) return undefined;
    const date = match[1] ?? '';
    const time = match[2] ?? '';
    if (!HtmlMicrosyntax.isValidDate(date) || !HtmlMicrosyntax.isValidTime(time)) return undefined;
    const parts = HtmlMicrosyntax.TIME.exec(time);
    const hours = parts?.[1] ?? '00';
    const minutes = parts?.[2] ?? '00';
    const seconds = parts?.[3] ?? '00';
    const fraction = (parts?.[4] ?? '').replace(/0+$/, '');
    if (fraction) return `${date}T${hours}:${minutes}:${seconds}.${fraction}`;
    if (seconds !== '00') return `${date}T${hours}:${minutes}:${seconds}`;
    return `${date}T${hours}:${minutes}`;
  }

  static isSimpleColor(value: string): boolean {
    return HtmlMicrosyntax.SIMPLE_COLOR.test(value);
  }

  static isValidEmail(value: string): boolean {
    return HtmlMicrosyntax.EMAIL.test(value);
  }

  static #weekdayOfJanuaryFirst(year: number): number {
    const y = year - 1;
    return (y + Math.floor(y / 4) - Math.floor(y / 100) + Math.floor(y / 400) + 1) % 7;
  }
}
