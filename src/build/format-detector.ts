export interface FormatRule {
  format: string;
  test: (value: string) => boolean;
}

export class FormatDetector {
  static readonly NON_HIERARCHICAL_SCHEMES: ReadonlySet<string> = new Set(['mailto', 'urn', 'tel', 'sms', 'data', 'geo', 'magnet']);
  static readonly URI_CHARACTERS: RegExp = /^[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]*$/;
  static readonly UUID: RegExp = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  static readonly FULL_DATE: RegExp = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;
  static readonly FULL_TIME: RegExp = /^([0-9]{2}):([0-9]{2}):([0-9]{2})(?:\.[0-9]+)?(?:[Zz]|[+-]([0-9]{2}):([0-9]{2}))$/;
  static readonly IPV4: RegExp = /^(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])(?:\.(?:25[0-5]|2[0-4][0-9]|1[0-9]{2}|[1-9]?[0-9])){3}$/;
  static readonly DOT_ATOM: RegExp = /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[A-Za-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
  static readonly QUOTED_LOCAL: RegExp = /^"(?:[\x20\x21\x23-\x5b\x5d-\x7e]|\\[\x20-\x7e])*"$/;
  static readonly HOSTNAME: RegExp = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
  static readonly DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  static readonly RULES: readonly FormatRule[] = [
    { format: 'uuid', test: (value) => FormatDetector.isUuid(value) },
    { format: 'date-time', test: (value) => FormatDetector.isDateTime(value) },
    { format: 'date', test: (value) => FormatDetector.isDate(value) },
    { format: 'time', test: (value) => FormatDetector.isTime(value) },
    { format: 'ipv4', test: (value) => FormatDetector.isIpv4(value) },
    { format: 'email', test: (value) => FormatDetector.isEmail(value) },
    { format: 'uri', test: (value) => FormatDetector.isUri(value) },
  ];

  detect(value: string): string | undefined {
    if (value === '') return undefined;
    return FormatDetector.RULES.find((rule) => rule.test(value))?.format;
  }

  matches(format: string, value: string): boolean {
    const rule = FormatDetector.RULES.find((candidate) => candidate.format === format);
    return rule !== undefined && rule.test(value);
  }

  static isUuid(value: string): boolean {
    return FormatDetector.UUID.test(value);
  }

  static isDate(value: string): boolean {
    const m = FormatDetector.FULL_DATE.exec(value);
    if (!m) return false;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (month < 1 || month > 12 || day < 1) return false;
    const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
    const days = month === 2 && leap ? 29 : (FormatDetector.DAYS_IN_MONTH[month - 1] ?? 0);
    return day <= days;
  }

  static isTime(value: string): boolean {
    const m = FormatDetector.FULL_TIME.exec(value);
    if (!m) return false;
    if (Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3]) > 60) return false;
    if (m[4] !== undefined && (Number(m[4]) > 23 || Number(m[5]) > 59)) return false;
    return true;
  }

  static isDateTime(value: string): boolean {
    if (value.length < 20) return false;
    const separator = value.charAt(10);
    if (separator !== 'T' && separator !== 't') return false;
    return FormatDetector.isDate(value.slice(0, 10)) && FormatDetector.isTime(value.slice(11));
  }

  static isIpv4(value: string): boolean {
    return FormatDetector.IPV4.test(value);
  }

  static isEmail(value: string): boolean {
    if (value.length > 254) return false;
    const at = value.lastIndexOf('@');
    if (at < 1) return false;
    const local = value.slice(0, at);
    const domain = value.slice(at + 1);
    if (local.length > 64) return false;
    if (!FormatDetector.DOT_ATOM.test(local) && !FormatDetector.QUOTED_LOCAL.test(local)) return false;
    if (domain.startsWith('[') && domain.endsWith(']')) return FormatDetector.isIpv4(domain.slice(1, -1)) || /^IPv6:[0-9A-Fa-f:.]+$/.test(domain.slice(1, -1));
    return domain.length <= 253 && FormatDetector.HOSTNAME.test(domain);
  }

  static isUri(value: string): boolean {
    if (!FormatDetector.URI_CHARACTERS.test(value)) return false;
    if (/%(?![0-9A-Fa-f]{2})/.test(value)) return false;
    const colon = value.indexOf(':');
    const scheme = value.slice(0, colon).toLowerCase();
    return value.startsWith('//', colon + 1) || FormatDetector.NON_HIERARCHICAL_SCHEMES.has(scheme);
  }
}
