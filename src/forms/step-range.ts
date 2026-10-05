import { HtmlDecimal } from './html-decimal.js';
import { HtmlMicrosyntax } from './html-microsyntax.js';

export interface StepRangeInput {
  type: string;
  min?: string;
  max?: string;
  step?: string;
  value?: string;
}

export class StepRange {
  static readonly DEFAULT_STEP = HtmlDecimal.ONE;
  static readonly RANGE_MINIMUM = HtmlDecimal.ZERO;
  static readonly RANGE_MAXIMUM = new HtmlDecimal(100n, 0);
  static readonly ANY = 'any';

  readonly minimum: HtmlDecimal | undefined;
  readonly maximum: HtmlDecimal | undefined;
  readonly step: HtmlDecimal | null;
  readonly base: HtmlDecimal;

  constructor(parts: { minimum?: HtmlDecimal; maximum?: HtmlDecimal; step: HtmlDecimal | null; base: HtmlDecimal }) {
    this.minimum = parts.minimum;
    this.maximum = parts.maximum;
    this.step = parts.step;
    this.base = parts.base;
  }

  static of(input: StepRangeInput): StepRange {
    const min = HtmlDecimal.parse(input.min);
    const max = HtmlDecimal.parse(input.max);
    const isRange = input.type === 'range';
    const minimum = isRange ? (min ?? StepRange.RANGE_MINIMUM) : min;
    let maximum = isRange ? (max ?? StepRange.RANGE_MAXIMUM) : max;
    if (isRange && minimum && maximum && maximum.lessThan(minimum)) maximum = minimum;
    const base = min ?? HtmlDecimal.parse(input.value) ?? HtmlDecimal.ZERO;
    const range: { minimum?: HtmlDecimal; maximum?: HtmlDecimal; step: HtmlDecimal | null; base: HtmlDecimal } = {
      step: StepRange.parseStep(input.step),
      base,
    };
    if (minimum) range.minimum = minimum;
    if (maximum) range.maximum = maximum;
    return new StepRange(range);
  }

  static parseStep(raw: string | undefined, fallback: HtmlDecimal = StepRange.DEFAULT_STEP): HtmlDecimal | null {
    if (raw === undefined) return fallback;
    if (HtmlMicrosyntax.asciiLower(raw) === StepRange.ANY) return null;
    const parsed = HtmlDecimal.parse(raw);
    return parsed && parsed.sign > 0 ? parsed : fallback;
  }

  get integral(): boolean {
    return this.step !== null && this.step.isInteger() && this.base.isInteger();
  }

  get aligned(): boolean {
    return this.step !== null && this.base.isMultipleOf(this.step);
  }

  defaultValue(): HtmlDecimal {
    const minimum = this.minimum ?? StepRange.RANGE_MINIMUM;
    const maximum = this.maximum ?? StepRange.RANGE_MAXIMUM;
    return minimum.add(maximum.sub(minimum).half());
  }

  clamp(value: HtmlDecimal): HtmlDecimal {
    let inRange = value;
    if (this.maximum && inRange.greaterThan(this.maximum)) inRange = this.maximum;
    if (this.minimum && inRange.lessThan(this.minimum)) inRange = this.minimum;
    if (this.step === null) return inRange;
    const rounded = this.base.add(this.step.times(inRange.sub(this.base).roundedQuotient(this.step)));
    let clamped = rounded;
    if (this.maximum && rounded.greaterThan(this.maximum)) clamped = rounded.sub(this.step);
    else if (this.minimum && rounded.lessThan(this.minimum)) clamped = rounded.add(this.step);
    if (this.minimum && clamped.lessThan(this.minimum)) return this.minimum;
    return clamped;
  }
}
