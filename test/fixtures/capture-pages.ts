import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface PageRequest {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

export type PageHandler = (req: IncomingMessage, res: ServerResponse, body: Buffer) => void | Promise<void>;

export interface PageServer {
  origin: string;
  port: number;
  requests: PageRequest[];
  url(path: string): string;
  close(): Promise<void>;
}

export class PageServers {
  static html(title: string, body: string): string {
    return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;
  }

  static send(res: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string | string[]> = {}): void {
    res.writeHead(status, { 'content-type': type, ...headers });
    res.end(body);
  }

  static async start(routes: Record<string, PageHandler>, host = '127.0.0.1'): Promise<PageServer> {
    const requests: PageRequest[] = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      const path = req.url ?? '/';
      requests.push({ method: req.method ?? 'GET', path, headers: req.headers, body });
      const handler = routes[path] ?? routes[path.split('?')[0] ?? path];
      if (!handler) {
        PageServers.send(res, 404, 'text/plain', 'not found');
        return;
      }
      try {
        await handler(req, res, body);
      } catch (err) {
        if (!res.headersSent) PageServers.send(res, 500, 'text/plain', String(err));
        else res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, host, resolve));
    const port = (server.address() as AddressInfo).port;
    const origin = `http://${host}:${port}`;
    return {
      origin,
      port,
      requests,
      url: (path: string) => origin + path,
      close: () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    };
  }
}
