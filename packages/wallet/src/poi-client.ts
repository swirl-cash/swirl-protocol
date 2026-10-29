import { ed25519 } from '@noble/curves/ed25519.js';
import { hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { Groth16Proof } from 'snarkjs';
import { verifyMerklePath, type MerklePath } from './merkle.js';

export type POIStatus = 'Valid' | 'ShieldBlocked' | 'ShieldPending' | 'ProofSubmitted' | 'Missing';
export type POIEventType = 'Shield' | 'Transact' | 'Unshield';
export type SignedPOIEvent = {
  index: number;
  blindedCommitment: string;
  signature: string;
  type: POIEventType;
  merkleRoot: string;
};
export type POITransactionRecord = {
  transactionHash: string;
  txidIndex: number;
  txid: string;
  txidLeaf: string;
  txidMerkleRoot: string;
  nullifiers: [string, string];
  outputCommitments: [string, string, string, string];
  ciphertextHash: string;
  publicAmount: string;
  publicRecipient: string;
  token: string;
  chainId: string;
  firstLeafIndex: number;
};
export type POIProofSubmission = {
  proof: Groth16Proof;
  publicSignals: string[];
  blindedCommitmentsOut: string[];
  txid: string;
  txidIfHasUnshield: string;
  txidMerkleRoot: string;
  txidMerkleRootIndex: number;
  poiMerkleRoots: string[];
};

const BYTES32 = /^0x[0-9a-fA-F]{64}$/;
const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const STATUSES = new Set<POIStatus>(['Valid', 'ShieldBlocked', 'ShieldPending', 'ProofSubmitted', 'Missing']);

function isBytes32(value: unknown): value is string {
  return typeof value === 'string' && BYTES32.test(value);
}

function wireField(value: unknown): bigint {
  if (typeof value !== 'string' || (!BYTES32.test(value) && !/^(0|[1-9][0-9]*)$/.test(value))) {
    throw new Error('PPOI node returned a malformed field element');
  }
  const parsed = BigInt(value);
  if (parsed >= FIELD_SIZE) throw new Error('PPOI node returned an out-of-field element');
  return parsed;
}

function wirePath(value: unknown): MerklePath {
  if (typeof value !== 'object' || value === null) throw new Error('PPOI node returned an invalid Merkle path');
  const path = value as { root?: unknown; pathElements?: unknown; leafIndex?: unknown };
  if (!Array.isArray(path.pathElements) || path.pathElements.length !== 16
    || !Number.isSafeInteger(path.leafIndex) || (path.leafIndex as number) < 0) {
    throw new Error('PPOI node returned a malformed Merkle path');
  }
  return {
    root: wireField(path.root),
    pathElements: path.pathElements.map(wireField),
    leafIndex: path.leafIndex as number,
  };
}

async function verifyEvent(event: SignedPOIEvent, listKey: string): Promise<boolean> {
  try {
    if (!Number.isSafeInteger(event.index) || event.index < 0 || !isBytes32(event.blindedCommitment)
      || !isBytes32(event.merkleRoot) || !/^[0-9a-fA-F]{128}$/.test(event.signature)
      || !['Shield', 'Transact', 'Unshield'].includes(event.type)) return false;
    const message = utf8ToBytes(JSON.stringify({ index: event.index, blindedCommitment: event.blindedCommitment, type: event.type }));
    return await ed25519.verify(hexToBytes(event.signature), message, hexToBytes(listKey));
  } catch { return false; }
}

export class POINodeClient {
  private readonly baseUrl: string;

  constructor(private readonly options: {
    url: string;
    chainId: number;
    vault: string;
    listKey: string;
    timeoutMs?: number;
  }) {
    this.baseUrl = options.url.replace(/\/$/, '');
    if (!this.baseUrl || !Number.isSafeInteger(options.chainId) || options.chainId <= 0
      || !/^0x[0-9a-fA-F]{40}$/.test(options.vault) || !/^[0-9a-fA-F]{64}$/.test(options.listKey)) {
      throw new Error('Invalid PPOI node configuration');
    }
  }

  private async request(path: string, init: RequestInit = {}, timeoutMs?: number): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs ?? this.options.timeoutMs ?? 15_000),
      });
    } catch (error) {
      throw new Error(`PPOI node unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    let body: unknown;
    try { body = await response.json(); } catch { throw new Error(`PPOI node returned non-JSON HTTP ${response.status}`); }
    if (!response.ok) {
      const message = typeof body === 'object' && body !== null && 'error' in body ? String(body.error) : `HTTP ${response.status}`;
      throw new Error(`PPOI node rejected the request: ${message}`);
    }
    return body;
  }

  async health(): Promise<void> {
    const body = await this.request('/health') as { ok?: boolean; chainId?: string; vault?: string; listKey?: string };
    if (body.ok !== true || body.chainId !== this.options.chainId.toString()
      || body.vault?.toLowerCase() !== this.options.vault.toLowerCase() || body.listKey !== this.options.listKey) {
      throw new Error('PPOI node identity does not match this network and list');
    }
  }

  async getStatuses(blindedCommitments: string[]): Promise<Record<string, POIStatus>> {
    if (!blindedCommitments.length) return {};
    if (blindedCommitments.length > 1000 || blindedCommitments.some((item) => !isBytes32(item))) throw new Error('Invalid blinded commitment query');
    await this.health();
    const body = await this.request('/status', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blindedCommitments }),
    }) as { statuses?: Record<string, POIStatus> };
    if (!body.statuses) throw new Error('PPOI node returned no statuses');
    for (const blinded of blindedCommitments) {
      if (!STATUSES.has(body.statuses[blinded])) throw new Error('PPOI node returned an invalid or missing status');
    }
    return body.statuses;
  }

  async getPOIPaths(blindedCommitments: string[]): Promise<MerklePath[]> {
    if (blindedCommitments.length < 1 || blindedCommitments.length > 2 || blindedCommitments.some((item) => !isBytes32(item))) {
      throw new Error('One or two valid blinded commitments are required');
    }
    await this.health();
    const body = await this.request('/poi-proofs', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ blindedCommitments }),
    }) as { proofs?: { blindedCommitment: string; event: SignedPOIEvent; proof: unknown }[] };
    if (!Array.isArray(body.proofs) || body.proofs.length !== blindedCommitments.length) throw new Error('PPOI node returned incomplete POI paths');
    const paths: MerklePath[] = [];
    for (let index = 0; index < blindedCommitments.length; index++) {
      const item = body.proofs[index];
      if (item.blindedCommitment !== blindedCommitments[index] || item.event?.blindedCommitment !== item.blindedCommitment
        || !(await verifyEvent(item.event, this.options.listKey))) throw new Error('PPOI event signature validation failed');
      const path = wirePath(item.proof);
      if (!(await verifyMerklePath(BigInt(item.blindedCommitment), path))) throw new Error('PPOI node returned an invalid Merkle proof');
      paths.push(path);
    }
    return paths;
  }

  async validatePOIRoots(roots: string[]): Promise<boolean> {
    if (roots.length < 1 || roots.length > 2 || roots.some((root) => !isBytes32(root))) throw new Error('Invalid POI root query');
    await this.health();
    const body = await this.request('/validate-roots', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roots }),
    }) as { valid?: boolean };
    if (typeof body.valid !== 'boolean') throw new Error('PPOI node returned an invalid root response');
    return body.valid;
  }

  async getTransaction(txid: string): Promise<{ transaction: POITransactionRecord; path: MerklePath }> {
    if (!isBytes32(txid)) throw new Error('Invalid SWIRL transaction ID');
    await this.health();
    const body = await this.request('/txid-proof', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ txid }),
    }) as { transaction?: POITransactionRecord; proof?: unknown };
    const transaction = body.transaction;
    if (!transaction || transaction.txid !== txid || !isBytes32(transaction.txidLeaf)
      || transaction.chainId !== this.options.chainId.toString()) throw new Error('PPOI node returned the wrong transaction');
    const path = wirePath(body.proof);
    if (transaction.txidIndex !== path.leafIndex || !(await verifyMerklePath(BigInt(transaction.txidLeaf), path))) {
      throw new Error('PPOI node returned an invalid TXID Merkle proof');
    }
    return { transaction, path };
  }

  async submitProof(submission: POIProofSubmission): Promise<void> {
    await this.health();
    const body = await this.request('/submit-proof', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(submission),
    }, 30_000) as { ok?: boolean };
    if (body.ok !== true) throw new Error('PPOI node did not accept the proof');
  }
}
