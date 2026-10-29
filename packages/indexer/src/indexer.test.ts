import { mkdir, mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonRpcProvider } from 'ethers';
import { VaultIndexer, type IndexedEvent } from './indexer.js';

const mocks = vi.hoisted(() => ({
  vault: null as null | {
    zeroNoteCommitment: () => Promise<string>;
    queryFilter: (name: string, start: number, end: number) => Promise<unknown[]>;
  },
}));

vi.mock('ethers', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ethers')>();
  return {
    ...actual,
    Contract: vi.fn(() => {
      if (!mocks.vault) throw new Error('Mock vault is not configured');
      return mocks.vault;
    }),
  };
});

const VAULT = '0xDc64a140Aa3E981100a9becA4E685f962f0cF6C9';
const ZERO = `0x${'2d'.repeat(32)}`;
const word = (value: number) => `0x${value.toString(16).padStart(64, '0')}`;
const hash = (family: string, block: number) => `0x${block.toString(16).padStart(64, family)}`;

type TestEvent = IndexedEvent;
type QueryRange = { name: string; start: number; end: number };

function shield(blockNumber: number, leafIndex: number, marker: number): TestEvent {
  return {
    kind: 'shield', blockNumber, transactionIndex: 0, logIndex: leafIndex,
    transactionHash: word(marker + 1000), leafIndex, commitment: word(marker), ciphertext: '0x1234',
  };
}

function transacted(blockNumber: number, leafIndex: number, marker: number): TestEvent {
  return {
    kind: 'transacted', blockNumber, transactionIndex: 0, logIndex: leafIndex,
    transactionHash: word(marker + 2000), leafIndex,
    commitments: [word(marker), word(marker + 1), word(marker + 2), word(marker + 3)],
    ciphertexts: ['0x1234', '0x', '0x', '0x'],
  };
}

class MockChain {
  readonly queries: QueryRange[] = [];

  constructor(readonly blocks: string[], readonly events: TestEvent[]) {
    mocks.vault = {
      zeroNoteCommitment: async () => ZERO,
      queryFilter: async (name, start, end) => {
        this.queries.push({ name, start, end });
        const kind = name === 'Shielded' ? 'shield' : 'transacted';
        return this.events
          .filter((event) => event.kind === kind && event.blockNumber >= start && event.blockNumber <= end)
          .map((event) => ({
            args: event.kind === 'shield'
              ? [event.leafIndex, event.commitment, event.ciphertext]
              : [[word(9000), word(0)], event.commitments, event.ciphertexts, event.leafIndex],
            fragment: { name }, removed: false, blockNumber: event.blockNumber,
            transactionIndex: event.transactionIndex, index: event.logIndex,
            transactionHash: event.transactionHash,
          }));
      },
    };
  }

  get provider(): JsonRpcProvider {
    return {
      getNetwork: async () => ({ chainId: 31337n }),
      send: async (method: string) => {
        if (method !== 'eth_blockNumber') throw new Error(`Unexpected RPC method: ${method}`);
        return `0x${(this.blocks.length - 1).toString(16)}`;
      },
      getBlock: async (blockNumber: number) => {
        const blockHash = this.blocks[blockNumber];
        return blockHash ? { hash: blockHash } : null;
      },
    } as unknown as JsonRpcProvider;
  }
}

async function stateFile() {
  const artifacts = path.join(process.cwd(), 'artifacts');
  await mkdir(artifacts, { recursive: true });
  return path.join(await mkdtemp(path.join(artifacts, 'indexer-test-')), 'snapshot.json');
}

beforeEach(() => { mocks.vault = null; });

describe('VaultIndexer snapshots', () => {
  it('saves atomically, resumes at the persisted height and scans only new batches', async () => {
    const file = await stateFile();
    const chain = new MockChain(
      [hash('a', 0), hash('a', 1), hash('a', 2)],
      [shield(1, 1, 11), transacted(2, 2, 21)],
    );
    const indexer = new VaultIndexer(chain.provider, VAULT, file, 0, 1);
    await indexer.init();

    expect(indexer.current.events.map((event) => event.kind)).toEqual(['shield', 'transacted']);
    expect(indexer.current.lastScannedBlock).toBe(2);
    expect(indexer.current.lastBlockHash).toBe(hash('a', 2));
    expect(chain.queries).toHaveLength(6);
    expect(JSON.parse(await readFile(file, 'utf8')).events).toHaveLength(2);

    chain.blocks.push(hash('a', 3));
    chain.events.push(shield(3, 6, 31));
    await indexer.sync();
    expect(indexer.current.events).toHaveLength(3);
    expect(chain.queries.slice(-2)).toEqual([
      { name: 'Shielded', start: 3, end: 3 },
      { name: 'Transacted', start: 3, end: 3 },
    ]);

    const queryCount = chain.queries.length;
    const resumed = new VaultIndexer(chain.provider, VAULT, file, 0, 1);
    await resumed.init();
    expect(resumed.current.events.map((event) => event.commitment ?? event.commitments?.[0]))
      .toEqual([word(11), word(21), word(31)]);
    expect(chain.queries).toHaveLength(queryCount);
  });

  it('discards a same-chain-id and same-vault snapshot after a local chain reset', async () => {
    const file = await stateFile();
    const original = new MockChain(
      [hash('a', 0), hash('a', 1), hash('a', 2)],
      [shield(1, 1, 41)],
    );
    await new VaultIndexer(original.provider, VAULT, file).init();

    const reset = new MockChain(
      [hash('b', 0), hash('b', 1), hash('b', 2)],
      [shield(1, 1, 42)],
    );
    const rebuilt = new VaultIndexer(reset.provider, VAULT, file);
    await rebuilt.init();

    expect(rebuilt.current.events).toHaveLength(1);
    expect(rebuilt.current.events[0].commitment).toBe(word(42));
    expect(rebuilt.current.events.some((event) => event.commitment === word(41))).toBe(false);
    expect(rebuilt.current.lastBlockHash).toBe(hash('b', 2));
  });

  it('rolls back to the common ancestor and preserves canonical events', async () => {
    const file = await stateFile();
    const chain = new MockChain(
      [hash('a', 0), hash('a', 1), hash('a', 2), hash('a', 3)],
      [shield(1, 1, 51), shield(3, 2, 52)],
    );
    await new VaultIndexer(chain.provider, VAULT, file).init();

    chain.blocks[2] = hash('c', 2);
    chain.blocks[3] = hash('c', 3);
    chain.events.splice(1, 1, shield(3, 2, 53));
    chain.queries.length = 0;
    const reorganized = new VaultIndexer(chain.provider, VAULT, file);
    await reorganized.init();

    expect(reorganized.current.events.map((event) => event.commitment)).toEqual([word(51), word(53)]);
    expect(chain.queries).toHaveLength(2);
    expect(chain.queries.every((query) => query.start === 2 && query.end === 3)).toBe(true);
    expect(reorganized.current.lastBlockHash).toBe(hash('c', 3));
  });

  it('rebuilds safely when a fork is deeper than the retained lookback', async () => {
    const file = await stateFile();
    const chain = new MockChain(
      Array.from({ length: 9 }, (_, block) => hash('a', block)),
      [shield(8, 1, 61)],
    );
    await new VaultIndexer(chain.provider, VAULT, file, 0, 500, 0, 3).init();
    expect(chain.events).toHaveLength(1);

    for (let block = 3; block <= 8; block++) chain.blocks[block] = hash('b', block);
    chain.events.splice(0, 1, shield(8, 1, 62));
    chain.queries.length = 0;
    const deepFork = new VaultIndexer(chain.provider, VAULT, file, 0, 500, 0, 3);
    await deepFork.init();

    expect(deepFork.current.events.map((event) => event.commitment)).toEqual([word(62)]);
    expect(chain.queries[0]).toEqual({ name: 'Shielded', start: 0, end: 8 });
    expect(deepFork.current.anchors.map((anchor) => anchor.blockNumber)).toEqual([5, 6, 7, 8]);
    expect(deepFork.current.lastBlockHash).toBe(hash('b', 8));
  });
});
