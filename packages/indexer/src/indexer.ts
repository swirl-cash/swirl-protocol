import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Contract, JsonRpcProvider, ethers } from 'ethers';

const VAULT_ABI = [
  'function zeroNoteCommitment() view returns (bytes32)',
  'event Shielded(uint32 indexed leafIndex, bytes32 indexed commitment, bytes ciphertext, uint256 amount, uint256 fee, bytes32 owner, address indexed token)',
  'event Transacted(bytes32[2] nullifiers, bytes32[4] commitments, bytes[4] ciphertexts, uint32 firstLeafIndex)',
];

export type IndexedEvent = {
  kind: 'shield' | 'transacted';
  blockNumber: number;
  transactionIndex: number;
  logIndex: number;
  transactionHash: string;
  leafIndex: number;
  commitment?: string;
  ciphertext?: string;
  commitments?: [string, string, string, string];
  ciphertexts?: [string, string, string, string];
};

export type BlockAnchor = { blockNumber: number; hash: string };

export type IndexerSnapshot = {
  version: 3;
  chainId: string;
  vault: string;
  zeroCommitment: string;
  lastScannedBlock: number;
  lastBlockHash: string | null;
  anchors: BlockAnchor[];
  events: IndexedEvent[];
};

const isIndex = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const isBytes32 = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const isHex = (value: unknown): value is string => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);

function isIndexedEvent(value: unknown): value is IndexedEvent {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (!isIndex(event.blockNumber) || !isIndex(event.transactionIndex) || !isIndex(event.logIndex)
    || !isIndex(event.leafIndex) || !isBytes32(event.transactionHash)) return false;
  if (event.kind === 'shield') return isBytes32(event.commitment) && isHex(event.ciphertext);
  if (event.kind !== 'transacted' || !Array.isArray(event.commitments) || event.commitments.length !== 4
    || !Array.isArray(event.ciphertexts) || event.ciphertexts.length !== 4) return false;
  return event.commitments.every(isBytes32) && event.ciphertexts.every(isHex);
}

function parseSnapshot(value: unknown): IndexerSnapshot | null {
  if (!value || typeof value !== 'object') return null;
  const saved = value as Record<string, unknown>;
  if (saved.version !== 3 || typeof saved.chainId !== 'string' || !/^\d+$/.test(saved.chainId)
    || typeof saved.vault !== 'string' || !ethers.isAddress(saved.vault) || !isBytes32(saved.zeroCommitment)
    || !isIndex(saved.lastScannedBlock) || !isBytes32(saved.lastBlockHash)
    || !Array.isArray(saved.anchors) || saved.anchors.length === 0 || saved.anchors.length > 10_000
    || !saved.anchors.every((anchor) => anchor && typeof anchor === 'object'
      && isIndex(anchor.blockNumber) && isBytes32(anchor.hash))
    || !Array.isArray(saved.events) || !saved.events.every(isIndexedEvent)) return null;
  const lastScannedBlock = saved.lastScannedBlock;
  const anchors = saved.anchors as BlockAnchor[];
  if (saved.events.some((event) => event.blockNumber > lastScannedBlock)
    || anchors.some((anchor, index) => anchor.blockNumber > lastScannedBlock
      || (index > 0 && anchor.blockNumber !== anchors[index - 1].blockNumber + 1))
    || anchors.at(-1)?.blockNumber !== lastScannedBlock || anchors.at(-1)?.hash !== saved.lastBlockHash) return null;
  return saved as IndexerSnapshot;
}

export class VaultIndexer {
  private snapshot: IndexerSnapshot;
  private syncing: Promise<IndexerSnapshot> | null = null;

  constructor(
    private readonly provider: JsonRpcProvider,
    private readonly vaultAddress: string,
    private readonly stateFile: string,
    private readonly fromBlock = 0,
    private readonly batchSize = 500,
    private readonly confirmations = 0,
    private readonly historyDepth = 64,
  ) {
    if (!ethers.isAddress(vaultAddress)) throw new Error('Invalid vault address');
    if (!Number.isSafeInteger(fromBlock) || fromBlock < 0 || !Number.isSafeInteger(batchSize) || batchSize < 1
      || !Number.isSafeInteger(confirmations) || confirmations < 0
      || !Number.isSafeInteger(historyDepth) || historyDepth < 1) throw new Error('Invalid indexer configuration');
    this.snapshot = {
      version: 3, chainId: '0', vault: vaultAddress, zeroCommitment: '',
      lastScannedBlock: fromBlock - 1, lastBlockHash: null, anchors: [], events: [],
    };
  }

  async init(): Promise<void> {
    const [{ chainId }, vault] = await Promise.all([
      this.provider.getNetwork(), new Contract(this.vaultAddress, VAULT_ABI, this.provider),
    ]);
    this.snapshot.chainId = chainId.toString();
    this.snapshot.zeroCommitment = await vault.zeroNoteCommitment();
    try {
      const saved = parseSnapshot(JSON.parse(await readFile(this.stateFile, 'utf8')));
      if (saved && saved.chainId === this.snapshot.chainId
        && saved.vault.toLowerCase() === this.vaultAddress.toLowerCase()
        && saved.zeroCommitment === this.snapshot.zeroCommitment
        && saved.lastScannedBlock >= this.fromBlock - 1
        && saved.events.every((event) => event.blockNumber >= this.fromBlock)) {
        this.snapshot = saved;
      }
    } catch { /* A missing or incompatible snapshot is rebuilt from chain events. */ }
    await this.sync();
  }

  get current(): IndexerSnapshot {
    return this.snapshot;
  }

  async sync(): Promise<IndexerSnapshot> {
    if (this.syncing) return this.syncing;
    this.syncing = this.performSync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async performSync(): Promise<IndexerSnapshot> {
    // Bypass Ethers' block-number cache: recovery may request events immediately after a confirmed transaction.
    const latest = Number(await this.provider.send('eth_blockNumber', []));
    const target = Math.max(this.fromBlock - 1, latest - this.confirmations);
    const vault = new Contract(this.vaultAddress, VAULT_ABI, this.provider);
    let changed = await this.rollbackToCanonicalAncestor();
    const previouslyScanned = this.snapshot.lastScannedBlock;
    for (let start = this.snapshot.lastScannedBlock + 1; start <= target; start += this.batchSize) {
      const end = Math.min(start + this.batchSize - 1, target);
      // Keep requests sequential: public RPC burst budgets are smaller than a parallel pair of log scans.
      const shields = await vault.queryFilter('Shielded', start, end);
      const transfers = await vault.queryFilter('Transacted', start, end);
      const events: IndexedEvent[] = [];
      for (const event of [...shields, ...transfers]) {
        if (!('args' in event) || !('fragment' in event) || event.removed) continue;
        const args = event.args as ethers.Result;
        const fragment = event.fragment as ethers.EventFragment;
        const base = {
          blockNumber: event.blockNumber, transactionIndex: event.transactionIndex,
          logIndex: event.index, transactionHash: event.transactionHash,
        };
        if (fragment.name === 'Shielded') {
          events.push({ ...base, kind: 'shield', leafIndex: Number(args[0]), commitment: args[1], ciphertext: args[2] });
        } else {
          events.push({
            ...base, kind: 'transacted', leafIndex: Number(args[3]),
            commitments: [...args[1]] as [string, string, string, string],
            ciphertexts: [...args[2]] as [string, string, string, string],
          });
        }
      }
      events.sort((a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex);
      if (events.length) this.snapshot.events.push(...events);
      this.snapshot.lastScannedBlock = end;
      changed = true;
    }
    if (this.snapshot.lastScannedBlock > previouslyScanned) {
      // Only recent hashes are needed for reorg recovery; fetching every historical block overloads public RPCs.
      const oldestRetained = Math.max(this.fromBlock, target - this.historyDepth);
      const blocks = [];
      for (let blockNumber = oldestRetained; blockNumber <= target; blockNumber++) {
        blocks.push(await this.provider.getBlock(blockNumber));
      }
      if (blocks.some((block) => !block?.hash)) throw new Error(`Missing recent block hash near ${target}`);
      this.snapshot.anchors = blocks.map((block, offset) => ({ blockNumber: oldestRetained + offset, hash: block!.hash! }));
      this.snapshot.lastBlockHash = blocks.at(-1)!.hash!;
    }
    if (changed) await this.save();
    return this.snapshot;
  }

  private async rollbackToCanonicalAncestor(): Promise<boolean> {
    if (this.snapshot.lastScannedBlock < this.fromBlock) return false;
    for (const anchor of [...this.snapshot.anchors].reverse()) {
      const canonical = await this.provider.getBlock(anchor.blockNumber);
      if (canonical?.hash !== anchor.hash) continue;
      if (anchor.blockNumber === this.snapshot.lastScannedBlock) return false;
      this.snapshot.events = this.snapshot.events.filter((event) => event.blockNumber <= anchor.blockNumber);
      this.snapshot.anchors = this.snapshot.anchors.filter((item) => item.blockNumber <= anchor.blockNumber);
      this.snapshot.lastScannedBlock = anchor.blockNumber;
      this.snapshot.lastBlockHash = anchor.hash;
      return true;
    }
    // A reset or a fork deeper than retained history cannot be repaired locally.
    // Rebuild from the configured deployment block rather than mixing histories.
    this.snapshot.events = [];
    this.snapshot.anchors = [];
    this.snapshot.lastScannedBlock = this.fromBlock - 1;
    this.snapshot.lastBlockHash = null;
    return true;
  }

  private async save(): Promise<void> {
    await mkdir(path.dirname(this.stateFile), { recursive: true });
    const temporary = `${this.stateFile}.tmp`;
    await writeFile(temporary, JSON.stringify(this.snapshot, null, 2), { mode: 0o600 });
    await rename(temporary, this.stateFile);
  }
}
