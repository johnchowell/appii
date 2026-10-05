import { ControlRules } from './control-rules.js';
import { HtmlDecimal } from './html-decimal.js';
import { HtmlMicrosyntax } from './html-microsyntax.js';
import { StepRange } from './step-range.js';

export interface SanitizeInput {
  type: string;
  value?: string;
  multiple?: boolean;
  min?: string;
  max?: string;
  step?: string;
}

export class ValueSanitizer {
  static readonly DEFAULT_COLOR = '#000000';

  sanitize(input: SanitizeInput): string {
    const raw = input.value;
    switch (input.type) {
      case 'text':
      case 'search':
      case 'tel':
      case 'password':
        return HtmlMicrosyntax.stripNewlines(raw ?? '');
      case 'url':
        return HtmlMicrosyntax.trim(HtmlMicrosyntax.stripNewlines(raw ?? ''));
      case 'email':
        return this.#email(raw ?? '', input.multiple === true);
      case 'number':
        return HtmlMicrosyntax.isValidFloat(raw) ? raw : '';
      case 'range':
        return this.range(input);
      case 'date':
        return raw !== undefined && HtmlMicrosyntax.isValidDate(raw) ? raw : '';
      case 'month':
        return raw !== undefined && HtmlMicrosyntax.isValidMonth(raw) ? raw : '';
      case 'week':
        return raw !== undefined && HtmlMicrosyntax.isValidWeek(raw) ? raw : '';
      case 'time':
        return raw !== undefined && HtmlMicrosyntax.isValidTime(raw) ? raw : '';
      case 'datetime-local':
        return (raw === undefined ? undefined : HtmlMicrosyntax.normalizeLocalDateTime(raw)) ?? '';
      case 'color':
        return raw !== undefined && HtmlMicrosyntax.isSimpleColor(raw) ? HtmlMicrosyntax.asciiLower(raw) : ValueSanitizer.DEFAULT_COLOR;
      case 'checkbox':
      case 'radio':
        return raw ?? ControlRules.DEFAULT_CHECKABLE_VALUE;
      case 'file':
        return '';
      default:
        return raw ?? '';
    }
  }

  range(input: SanitizeInput): string {
    const range = StepRange.of({ ...input, type: 'range' });
    const proposed = HtmlDecimal.parse(input.value) ?? range.defaultValue();
    return range.clamp(proposed).toString();
  }

  #email(value: string, multiple: boolean): string {
    const stripped = HtmlMicrosyntax.stripNewlines(value);
    if (!multiple) return HtmlMicrosyntax.trim(stripped);
    return stripped
      .split(',')
      .map((token) => HtmlMicrosyntax.trim(token))
      .join(',');
  }
}
