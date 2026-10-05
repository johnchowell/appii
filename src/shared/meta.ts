import { createRequire } from 'node:module';

export const APP_NAME = 'appii';
export const UNKNOWN_VERSION = '0.0.0';

function packageVersion(): string {
  try {
    const pkg = createRequire(import.meta.url)('../../package.json') as { version?: unknown };
    return typeof pkg.version === 'string' ? pkg.version : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

export const VERSION: string = packageVersion();

export function appVersion(): string {
  return VERSION;
}

export function creator(): { name: string; version: string } {
  return { name: APP_NAME, version: VERSION };
}
