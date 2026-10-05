import { AppiiError } from '../shared/index.js';

export class UsageError extends AppiiError {
  constructor(message: string, options: { details?: unknown } = {}) {
    super('BAD_INPUT', message, options);
    this.name = 'UsageError';
  }
}
