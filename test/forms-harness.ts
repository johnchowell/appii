import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium } from 'playwright';
import type { Browser } from 'playwright';

export interface RecordedRequest {
  method: string;
  url: string;
  contentType: string;
  body: Buffer;
}

export type SubmittedValue = string | { filename: string; type: string; size: number };

interface Waiter {
  predicate: (request: RecordedRequest) => boolean;
  resolve: (request: RecordedRequest) => void;
}

export class PageServer {
  static readonly CHARSET = 'utf-8';

  readonly origin: string;
  readonly #server: Server;
  readonly #pages = new Map<string, string>();
  readonly #requests: RecordedRequest[] = [];
  readonly #waiters: Waiter[] = [];

  private constructor(server: Server, origin: string) {
    this.#server = server;
    this.origin = origin;
  }

  static async start(): Promise<PageServer> {
    let instance: PageServer | undefined;
    const server = createServer((req, res) => void instance?.handle(req, res));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    instance = new PageServer(server, `http://127.0.0.1:${port}`);
    return instance;
  }

  static async launchBrowser(): Promise<Browser> {
    return chromium.launch({ headless: true });
  }

  static async entries(request: RecordedRequest): Promise<[string, SubmittedValue][]> {
    if (request.method === 'GET') return [...new URL(request.url).searchParams.entries()];
    const essence = (request.contentType.split(';')[0] ?? '').trim().toLowerCase();
    if (essence === 'multipart/form-data') {
      const data = await new Response(new Uint8Array(request.body), { headers: { 'content-type': request.contentType } }).formData();
      return [...data.entries()].map(([name, value]) => [
        name,
        typeof value === 'string' ? value : { filename: value.name, type: value.type, size: value.size },
      ]);
    }
    if (essence === 'text/plain') {
      return request.body
        .toString('utf8')
        .split('\r\n')
        .filter((line) => line !== '')
        .map((line) => {
          const eq = line.indexOf('=');
          return [line.slice(0, eq), line.slice(eq + 1)];
        });
    }
    return [...new URLSearchParams(request.body.toString('utf8')).entries()];
  }

  page(path: string, html: string): string {
    this.#pages.set(path, html);
    return this.origin + path;
  }

  waitFor(predicate: (request: RecordedRequest) => boolean, timeoutMs = 10000): Promise<RecordedRequest> {
    const existing = this.#requests.find(predicate);
    if (existing) {
      this.#requests.splice(this.#requests.indexOf(existing), 1);
      return Promise.resolve(existing);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for a form submission')), timeoutMs);
      this.#waiters.push({
        predicate,
        resolve: (request) => {
          clearTimeout(timer);
          resolve(request);
        },
      });
    });
  }

  async close(): Promise<void> {
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const url = new URL(req.url ?? '/', this.origin);
    const html = req.method === 'GET' ? this.#pages.get(url.pathname) : undefined;
    if (html !== undefined) {
      res.writeHead(200, { 'content-type': `text/html; charset=${PageServer.CHARSET}` });
      res.end(html);
      return;
    }
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      url: url.href,
      contentType: req.headers['content-type'] ?? '',
      body: Buffer.concat(chunks),
    };
    res.writeHead(204);
    res.end();
    const waiter = this.#waiters.find((candidate) => candidate.predicate(recorded));
    if (waiter) {
      this.#waiters.splice(this.#waiters.indexOf(waiter), 1);
      waiter.resolve(recorded);
    } else this.#requests.push(recorded);
  }
}
