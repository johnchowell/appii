import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import type { Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

export interface WebSocketSite {
  url: string;
  origin: string;
  received: { opcode: number; payload: Buffer }[];
  close(): Promise<void>;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const PAGE = `<!doctype html><html><head><title>Socket</title></head><body><div id="log">open</div><script>
const ws = new WebSocket('ws://' + location.host + '/ws');
ws.binaryType = 'arraybuffer';
let count = 0;
ws.onopen = () => { ws.send('hello'); ws.send(new Uint8Array([1, 2, 3])); };
ws.onmessage = () => { count++; if (count === 3) ws.close(1000, 'done'); };
ws.onclose = () => { document.getElementById('log').textContent = 'closed'; };
</script></body></html>`;

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) header = Buffer.from([0x80 | opcode, length]);
  else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrame(buffer: Buffer): { opcode: number; payload: Buffer; length: number } | undefined {
  if (buffer.length < 2) return undefined;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  const maskLength = masked ? 4 : 0;
  if (buffer.length < offset + maskLength + length) return undefined;
  const mask = buffer.subarray(offset, offset + maskLength);
  const payload = Buffer.from(buffer.subarray(offset + maskLength, offset + maskLength + length));
  if (masked) for (let i = 0; i < payload.length; i++) payload[i] = payload[i]! ^ mask[i % 4]!;
  return { opcode, payload, length: offset + maskLength + length };
}

export async function startWebSocketSite(): Promise<WebSocketSite> {
  const received: { opcode: number; payload: Buffer }[] = [];
  const sockets = new Set<Socket>();
  const server = createServer((req, res) => {
    if (req.url === '/') {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(PAGE);
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (req, socket: Socket) => {
    const key = req.headers['sec-websocket-key'];
    if (req.url !== '/ws' || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade', `Sec-WebSocket-Accept: ${accept}`, '', ''].join('\r\n'));
    socket.write(encodeFrame(1, Buffer.from('welcome')));
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        const frame = decodeFrame(buffer);
        if (!frame) break;
        buffer = buffer.subarray(frame.length);
        received.push({ opcode: frame.opcode, payload: frame.payload });
        if (frame.opcode === 1) socket.write(encodeFrame(1, Buffer.from('echo:' + frame.payload.toString('utf8'))));
        else if (frame.opcode === 2) socket.write(encodeFrame(2, Buffer.from([...frame.payload].reverse())));
        else if (frame.opcode === 9) socket.write(encodeFrame(10, frame.payload));
        else if (frame.opcode === 8) {
          socket.end(encodeFrame(8, frame.payload));
          return;
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    url: origin + '/',
    origin,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
