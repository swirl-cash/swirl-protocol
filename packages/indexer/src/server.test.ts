import type http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createIndexerServer } from './server.js';
import type { VaultIndexer } from './indexer.js';

const servers: http.Server[] = [];
const snapshot = {
  version: 3 as const, chainId: '31337', vault: `0x${'22'.repeat(20)}`, zeroCommitment: `0x${'00'.repeat(32)}`,
  lastScannedBlock: 0, lastBlockHash: null, anchors: [], events: [],
};

async function start(rateLimitPerMinute = 60) {
  const indexer = { sync: async () => snapshot } as unknown as VaultIndexer;
  const server = createIndexerServer(indexer, 'http://127.0.0.1:7102', { rateLimitPerMinute });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

afterEach(async () => {
  for (const server of servers.splice(0).reverse()) {
    await new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); });
  }
});

describe('Indexer HTTP boundary', () => {
  it('serves a snapshot and applies bounded per-client rate limits', async () => {
    const { url, server } = await start(1);
    const first = await fetch(`${url}/events`, { headers: { 'x-forwarded-for': '203.0.113.1' } });
    expect(first.status).toBe(200);
    expect((await first.json()).chainId).toBe('31337');
    const second = await fetch(`${url}/events`, { headers: { 'x-forwarded-for': '203.0.113.2' } });
    expect(second.status).toBe(429);
    expect(server.requestTimeout).toBe(15_000);
    expect(server.headersTimeout).toBe(10_000);
  });
});
