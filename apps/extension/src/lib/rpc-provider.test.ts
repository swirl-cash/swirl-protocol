import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { FailoverProvider } from './rpc-provider';

const servers: Server[] = [];
const providers: FailoverProvider[] = [];

afterEach(async () => {
  for (const provider of providers.splice(0)) provider.destroy();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe('RPC read failover', () => {
  it('uses a fallback for reads and remembers the healthy endpoint', async () => {
    const requests = { primary: 0, fallback: 0 };
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; });
      request.on('end', () => {
        const primary = request.url === '/primary';
        requests[primary ? 'primary' : 'fallback'] += 1;
        const rpc = JSON.parse(body) as { id: number };
        response.setHeader('content-type', 'application/json');
        if (primary) {
          response.statusCode = 503;
          response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, error: { code: -32000, message: 'unavailable' } }));
          return;
        }
        response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: '0x1' }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;
    const provider = new FailoverProvider({
      rpcUrl: `${base}/primary`,
      rpcFallbackUrls: [`${base}/fallback`],
      chainId: 1,
    });
    providers.push(provider);

    const firstAddress = '0x0000000000000000000000000000000000000001';
    const secondAddress = '0x0000000000000000000000000000000000000002';
    await expect(provider.getBalance(firstAddress)).resolves.toBe(1n);
    await expect(provider.getBalance(secondAddress)).resolves.toBe(1n);
    expect(requests).toEqual({ primary: 1, fallback: 2 });
  });
});
