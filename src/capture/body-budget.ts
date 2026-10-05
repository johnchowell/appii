import { Http } from '../shared/index.js';
import type { BodyData } from '../model/index.js';

export interface BodyBudgetOptions {
  maxBodyBytes: number;
  maxTotalBodyBytes: number;
}

export class BodyBudget {
  readonly maxBodyBytes: number;
  readonly maxTotalBodyBytes: number;
  #used = 0;

  constructor(options: BodyBudgetOptions) {
    this.maxBodyBytes = options.maxBodyBytes;
    this.maxTotalBodyBytes = options.maxTotalBodyBytes;
  }

  static unread(mimeType: string, size: number): BodyData {
    return { mimeType, encoding: 'base64', data: '', size, truncated: true };
  }

  get used(): number {
    return this.#used;
  }

  of(bytes: Uint8Array | null | undefined, contentType: string | undefined, contentEncoding: string | undefined, text = false): BodyData | undefined {
    if (!bytes || bytes.length === 0) return undefined;
    const kept = Math.min(bytes.length, this.maxBodyBytes);
    if (this.#used + kept > this.maxTotalBodyBytes) return BodyBudget.unread(contentType ?? '', bytes.length);
    this.#used += kept;
    return Http.toBodyData(bytes, contentType ?? '', { maxBytes: this.maxBodyBytes, contentEncoding, text });
  }

  reset(): void {
    this.#used = 0;
  }
}
