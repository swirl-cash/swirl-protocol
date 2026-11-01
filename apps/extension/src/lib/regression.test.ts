import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { formatPoiCountdown, nextPendingPoiReviewAt } from './poi-timing';
import { loadSettings } from './settings';
import { waitForTransactionReceipt } from './protocol';
import { addActivity, listActivity } from './activity';

const servers: Server[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

function mockLocalStorage() {
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  });
  return values;
}

async function receiptServer() {
  const hash = `0x${'11'.repeat(32)}`;
  const receipt = {
    hash,
    blockHash: `0x${'22'.repeat(32)}`,
    blockNumber: '0x1',
    transactionIndex: '0x0',
    from: `0x${'33'.repeat(20)}`,
    to: `0x${'44'.repeat(20)}`,
    gasUsed: '0x5208',
    cumulativeGasUsed: '0x5208',
    effectiveGasPrice: '0x1',
    contractAddress: null,
    logs: [],
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    type: '0x2',
  };
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const rpc = JSON.parse(body) as { id: number };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: request.url === '/fallback' ? receipt : null }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { hash, base: `http://127.0.0.1:${port}` };
}

describe('extension update regressions', () => {
  it('formats PPOI countdowns and chooses the earliest review', () => {
    const now = Date.UTC(2026, 9, 31, 12, 0, 0);
    expect(formatPoiCountdown(now + 3_661_000, now)).toBe('PPOI wait · 1h 1m 1s');
    expect(formatPoiCountdown(now + 59_000, now)).toBe('PPOI wait · 0m 59s');
    expect(formatPoiCountdown(now - 1, now)).toBe('Reviewing PPOI…');
    expect(nextPendingPoiReviewAt([
      { spent: false, poiStatus: 'ShieldPending', poiReviewAt: now + 60_000 },
      { spent: false, poiStatus: 'Valid', poiReviewAt: now + 1_000 },
      { spent: false, poiStatus: 'ShieldPending', poiReviewAt: now + 30_000 },
      { spent: true, poiStatus: 'ShieldPending', poiReviewAt: now + 2_000 },
    ])).toBe(now + 30_000);
  });

  it('migrates v1 Relayer settings once and preserves later v2 choices', async () => {
    const values = mockLocalStorage();
    values.set('swirl.wallet-settings.v1', JSON.stringify({ autoLockMinutes: 30, submission: 'relayer', hiddenChainIds: [56] }));
    expect(await loadSettings()).toEqual({ autoLockMinutes: 30, submission: 'main', hiddenChainIds: [56] });
    values.set('swirl.wallet-settings.v2', JSON.stringify({ autoLockMinutes: 5, submission: 'gas', hiddenChainIds: [137] }));
    expect(await loadSettings()).toEqual({ autoLockMinutes: 5, submission: 'gas', hiddenChainIds: [137] });
  });

  it('confirms from a fallback RPC when the primary has no receipt', async () => {
    const { hash, base } = await receiptServer();
    const receipt = await waitForTransactionReceipt({
      hash,
      config: { rpcUrl: `${base}/primary`, rpcFallbackUrls: [`${base}/fallback`], chainId: 1 } as never,
      timeoutMs: 1_000,
    });
    expect(receipt.hash).toBe(hash);
    expect(receipt.status).toBe(1);
  });

  it('returns an explicit pending error instead of suggesting a retry', async () => {
    const { hash, base } = await receiptServer();
    const pending = waitForTransactionReceipt({
      hash,
      config: { rpcUrl: `${base}/primary`, chainId: 1 } as never,
      timeoutMs: 0,
    });
    await expect(pending).rejects.toMatchObject({ code: 'CONFIRMATION_PENDING' });
    await expect(pending).rejects.toThrow(/Do not retry/);
  });

  it('records a broadcast as pending and confirms it in place', async () => {
    mockLocalStorage();
    const base = {
      kind: 'shield' as const, transactionHash: `0x${'ab'.repeat(32)}`, amount: '1.0',
      chainId: 1, account: `0x${'33'.repeat(20)}`,
    };
    await addActivity({ ...base, status: 'pending' });
    const [pending] = await listActivity(1, base.account);
    expect(pending.status).toBe('pending');
    // A repeated broadcast callback for the same hash is a duplicate, not a new row.
    await addActivity({ ...base, status: 'pending' });
    await addActivity({ ...base, status: 'confirmed' });
    const all = await listActivity(1, base.account);
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(pending.id);
    expect(all[0].status).toBe('confirmed');
  });
});
