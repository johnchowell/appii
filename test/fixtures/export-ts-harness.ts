import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ModelBuilder } from '../../src/build/index.js';
import { TypeScriptExporter } from '../../src/export/index.js';
import type { ApiModel } from '../../src/model/index.js';
import type { CaptureFactory } from '../helpers/capture-factory.js';

export type Module = Record<string, unknown>;

export interface FieldErrorShape {
  field: string;
  code: string;
  message: string;
}

export interface ResponseShape {
  status: number;
  ok: boolean;
  url: string;
  redirected: boolean;
  headers: Headers;
  data: any;
}

export interface ClientShape {
  cookies: { get(name: string, url?: string): string | undefined; header(url: string): string; clear(): void };
  clearTokens(): void;
  [method: string]: unknown;
}

export interface SentRequest {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

export type Handler = (request: SentRequest) => Response | Promise<Response>;

export interface CompileResult {
  code: number;
  output: string;
}

export class TsClientHarness {
  static readonly TSC = resolve('node_modules/.bin/tsc');
  static readonly TYPE_ROOTS = resolve('node_modules/@types');
  static readonly STRICT = [
    '--strict',
    '--target',
    'ES2022',
    '--module',
    'ESNext',
    '--moduleResolution',
    'Bundler',
    '--noEmit',
    '--noUnusedLocals',
    '--noUncheckedIndexedAccess',
    '--exactOptionalPropertyTypes',
    '--noImplicitOverride',
    '--noImplicitReturns',
    '--skipLibCheck',
  ];
  static readonly WITH_DOM = ['--lib', 'ES2022,DOM', '--types', ''];
  static readonly WITHOUT_DOM = ['--lib', 'ES2022', '--types', 'node', '--typeRoots', TsClientHarness.TYPE_ROOTS];

  readonly dir: string;
  #count = 0;

  private constructor(dir: string) {
    this.dir = dir;
  }

  static async open(prefix = 'appii-ts-client-'): Promise<TsClientHarness> {
    return new TsClientHarness(await mkdtemp(join(tmpdir(), prefix)));
  }

  static build(factory: CaptureFactory): ApiModel {
    return ModelBuilder.create({ now: new Date(0) }).build(factory.capture());
  }

  static source(model: ApiModel): string {
    return TypeScriptExporter.create().export(model).content;
  }

  async close(): Promise<void> {
    await rm(this.dir, { recursive: true, force: true });
  }

  async load(model: ApiModel, name?: string): Promise<{ mod: Module; source: string; file: string }> {
    const file = name ?? `client${++this.#count}.ts`;
    const source = TsClientHarness.source(model);
    await writeFile(join(this.dir, file), source);
    const mod = (await import(pathToFileURL(join(this.dir, file)).href)) as Module;
    return { mod, source, file };
  }

  compile(files: string[], dom: boolean): Promise<CompileResult> {
    const args = [...TsClientHarness.STRICT, ...(dom ? TsClientHarness.WITH_DOM : TsClientHarness.WITHOUT_DOM), ...files];
    return new Promise((done) => {
      execFile(TsClientHarness.TSC, args, { cwd: this.dir, timeout: 120_000 }, (err, stdout, stderr) => {
        done({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, output: stdout + stderr });
      });
    });
  }

  static client(mod: Module, model: ApiModel, options: Record<string, unknown> = {}): ClientShape {
    const Client = mod[TypeScriptExporter.clientName(model)] as new (options?: Record<string, unknown>) => ClientShape;
    assert.equal(typeof Client, 'function');
    return new Client(options);
  }

  static recorder(handler: Handler): { sent: SentRequest[]; fetch: (input: string, init: RequestInit) => Promise<Response> } {
    const sent: SentRequest[] = [];
    return {
      sent,
      fetch: async (input: string, init: RequestInit): Promise<Response> => {
        const request: SentRequest = { method: String(init.method ?? 'GET'), url: input, headers: new Headers(init.headers), body: init.body };
        sent.push(request);
        return handler(request);
      },
    };
  }

  static async call(client: ClientShape, method: string, request?: unknown): Promise<ResponseShape> {
    const fn = client[method];
    assert.equal(typeof fn, 'function', method);
    return (fn as (request?: unknown) => Promise<ResponseShape>).call(client, request);
  }

  static validator(mod: Module, name: string): (input?: unknown, options?: unknown) => FieldErrorShape[] {
    const fn = mod[name];
    assert.equal(typeof fn, 'function', name);
    return fn as (input?: unknown, options?: unknown) => FieldErrorShape[];
  }

  static async text(body: unknown): Promise<string> {
    if (body === undefined || body === null) return '';
    if (typeof body === 'string') return body;
    return Buffer.from(await new Response(body as BodyInit).arrayBuffer()).toString('latin1');
  }

  static json(value: unknown, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', ...headers } });
  }

  static html(body: string, status = 200, headers: Record<string, string> = {}): Response {
    return new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
  }
}
