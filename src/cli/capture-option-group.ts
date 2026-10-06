import type { ParseArgsOptionsConfig } from 'node:util';
import { CaptureSession, TrafficRecorder } from '../capture/index.js';
import type { CaptureSessionOptions, LoginField, TrafficRecorderOptions } from '../capture/index.js';
import type { CliContext } from './cli-context.js';
import type { OptionDocs, OptionGroup } from './option-group.js';
import { OptionReader } from './option-reader.js';
import type { OptionValues } from './option-reader.js';
import { UsageError } from './usage-error.js';

export class CaptureOptionGroup implements OptionGroup<CaptureSessionOptions> {
  static readonly MS_PER_SECOND = 1000;
  static readonly HEADER_FORBIDDEN: RegExp = /[\0\r\n]/;
  static readonly HTTP_WHITESPACE: RegExp = /^[\t ]+|[\t ]+$/g;
  static readonly LOGIN_VARIABLE_PREFIX = 'APPII_LOGIN_';
  static readonly LOGIN_VARIABLE_UNSAFE: RegExp = /[^A-Z0-9]/g;

  readonly options: ParseArgsOptionsConfig = {
    headless: { type: 'boolean' },
    duration: { type: 'string' },
    idle: { type: 'string' },
    'storage-state': { type: 'string' },
    'max-body': { type: 'string' },
    'max-total-body': { type: 'string' },
    'read-timeout': { type: 'string' },
    'user-agent': { type: 'string' },
    login: { type: 'string', multiple: true },
    'probe-login': { type: 'boolean' },
  };

  readonly docs: OptionDocs = {
    headless: { description: 'Record without a browser window (default: a visible window that you browse in)' },
    duration: { value: 'sec', description: 'Stop recording after this many seconds' },
    idle: { value: 'sec', description: `Quiet network time that ends a headless capture without --duration (default: ${CaptureOptionGroup.seconds(CaptureSession.DEFAULT_IDLE_MS)})` },
    'storage-state': { value: 'file', description: 'Start with the cookies and storage of a Playwright storage state file' },
    'max-body': { value: 'bytes', description: `Largest request or response body to keep (default: ${TrafficRecorder.DEFAULT_MAX_BODY_BYTES})` },
    'max-total-body': { value: 'bytes', description: `Total size of all kept bodies; later bodies are marked as truncated (default: ${TrafficRecorder.DEFAULT_MAX_TOTAL_BODY_BYTES})` },
    'read-timeout': { value: 'sec', description: `Longest wait for one body after its request ends (default: ${CaptureOptionGroup.seconds(TrafficRecorder.READ_TIMEOUT_MS)})` },
    'user-agent': { value: 'ua', description: 'User-Agent that the browser sends and reports (default: the identity of the installed Chromium)' },
    login: {
      value: 'name[=value]',
      description: `Log in after the first URL loads: fill this field of the login form, then submit the form like a user; repeat for each field. Without =value the value comes from ${CaptureOptionGroup.LOGIN_VARIABLE_PREFIX}<NAME>`,
    },
    'probe-login': {
      description:
        'Without an account: after the first URL loads, fill its login form with placeholder values, submit it, record what the page tries to send and stop it in the browser, so nothing reaches the server; then open the URL again',
    },
  };

  static seconds(ms: number): string {
    return String(ms / CaptureOptionGroup.MS_PER_SECOND);
  }

  static loginVariable(name: string): string {
    return CaptureOptionGroup.LOGIN_VARIABLE_PREFIX + name.toUpperCase().replace(CaptureOptionGroup.LOGIN_VARIABLE_UNSAFE, '_');
  }

  static loginField(spec: string, env: Readonly<Record<string, string | undefined>>): LoginField {
    const eq = spec.indexOf('=');
    const name = eq < 0 ? spec : spec.slice(0, eq);
    if (name === '') throw new UsageError(`${OptionReader.flag('login')} needs a field name, as name or name=value`);
    if (eq >= 0) return { name, value: spec.slice(eq + 1) };
    const variable = CaptureOptionGroup.loginVariable(name);
    const value = env[variable];
    if (value === undefined) throw new UsageError(`${OptionReader.flag('login')} ${name}: set the environment variable ${variable}, or give ${name}=<value>`);
    if (value === '') throw new UsageError(`${OptionReader.flag('login')} ${name}: the environment variable ${variable} is empty`);
    return { name, value };
  }

  read(values: OptionValues, ctx: CliContext): CaptureSessionOptions {
    const out: CaptureSessionOptions = { headless: OptionReader.boolean(values, 'headless') ?? false };
    const durationMs = OptionReader.seconds(values, 'duration', { positive: true });
    const idleMs = OptionReader.seconds(values, 'idle');
    const storageState = OptionReader.string(values, 'storage-state');
    const maxBodyBytes = OptionReader.integer(values, 'max-body', { min: 0 });
    const maxTotalBodyBytes = OptionReader.integer(values, 'max-total-body', { min: 0 });
    const readTimeoutMs = OptionReader.seconds(values, 'read-timeout', { positive: true });
    const userAgent = CaptureOptionGroup.#userAgent(OptionReader.string(values, 'user-agent'));
    const probeLogin = OptionReader.boolean(values, 'probe-login') ?? false;
    if (probeLogin && OptionReader.strings(values, 'login').length > 0) {
      throw new UsageError(`${OptionReader.flag('probe-login')} and ${OptionReader.flag('login')} cannot be combined: the probe fills the login form with placeholder values and stops what it sends, while ${OptionReader.flag('login')} submits your values`);
    }
    const login = OptionReader.strings(values, 'login').map((spec) => CaptureOptionGroup.loginField(spec, ctx.io.env));
    const recorder: TrafficRecorderOptions = {};
    if (maxBodyBytes !== undefined) recorder.maxBodyBytes = maxBodyBytes;
    if (maxTotalBodyBytes !== undefined) recorder.maxTotalBodyBytes = maxTotalBodyBytes;
    if (readTimeoutMs !== undefined) recorder.readTimeoutMs = readTimeoutMs;
    if (durationMs !== undefined) out.durationMs = durationMs;
    if (idleMs !== undefined) out.idleMs = idleMs;
    if (storageState !== undefined) out.storageState = ctx.resolve(storageState);
    if (userAgent !== undefined) out.userAgent = userAgent;
    if (login.length > 0) out.login = login;
    if (probeLogin) out.probeLogin = true;
    if (Object.keys(recorder).length > 0) out.recorder = recorder;
    return out;
  }

  static #userAgent(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (CaptureOptionGroup.HEADER_FORBIDDEN.test(value)) throw new UsageError(`${OptionReader.flag('user-agent')} must not contain NUL, CR or LF characters`);
    const trimmed = value.replace(CaptureOptionGroup.HTTP_WHITESPACE, '');
    if (trimmed === '') throw new UsageError(`${OptionReader.flag('user-agent')} needs a non-empty value`);
    return trimmed;
  }
}
