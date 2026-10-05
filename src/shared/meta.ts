import { createRequire } from 'node:module';

export const APP_NAME = 'appii';

let cached: string | undefined;

export function appVersion(): string {
  if (cached !== undefined) return cached;
  try {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: unknown };
    cached = typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    cached = '0.0.0';
  }
  return cached;
}

export function creator(): { name: string; version: string } {
  return { name: APP_NAME, version: appVersion() };
}
