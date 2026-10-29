import * as snarkjs from 'snarkjs';
import {
  blindedCommitment,
  hex32,
  swirlBoundParamsHash,
  swirlTransactionID,
  swirlTxidLeaf,
  type MerklePath,
} from '@swirl/wallet';
import { PoseidonMerkleTree } from './tree.js';
import { poiEventMessage } from './signer.js';
import type {
  PersistedPOIState,
  POICoreOptions,
  POIProofSubmission,
  POIStatus,
  ShieldRecord,
  SignedPOIEvent,
  TransactionRecord,
} from './types.js';

export type NewShield = Omit<ShieldRecord, 'blindedCommitment' | 'status' | 'blockReason'>;
export type NewTransaction = Omit<TransactionRecord, 'txidIndex' | 'txid' | 'txidLeaf' | 'txidMerkleRoot'>;

function fromHex(value: string): bigint {
  if (!/^0x[0-9a-fA-F]{64}$/.test(value)) throw new Error('Expected a bytes32 field element');
  return BigInt(value);
}

function sameHex(a: string, b: string): boolean {
  return fromHex(a) === fromHex(b);
}

export class PPOICore {
  private poiTree!: PoseidonMerkleTree;
  private txidTree!: PoseidonMerkleTree;
  private readonly shieldRecords: ShieldRecord[];
  private readonly signedEvents: SignedPOIEvent[];
  private readonly transactionRecords: TransactionRecord[];
  private lastScannedBlock: number;

  private constructor(private readonly options: POICoreOptions) {
    const saved = options.persisted;
    if (saved && (saved.version !== 1 || saved.chainId !== options.chainId.toString()
      || saved.vault.toLowerCase() !== options.vault.toLowerCase())) {
      throw new Error('PPOI state does not match the configured chain and vault');
    }
    this.shieldRecords = saved?.shields ? [...saved.shields] : [];
    this.signedEvents = saved?.events ? [...saved.events] : [];
    this.transactionRecords = saved?.transactions ? [...saved.transactions] : [];
    this.lastScannedBlock = saved?.lastScannedBlock ?? -1;
  }

  static async create(options: POICoreOptions): Promise<PPOICore> {
    const core = new PPOICore(options);
    core.poiTree = await PoseidonMerkleTree.create();
    for (let index = 0; index < core.signedEvents.length; index++) {
      const event = core.signedEvents[index];
      core.poiTree.append(fromHex(event.blindedCommitment));
      if (event.index !== index || !sameHex(event.merkleRoot, hex32(core.poiTree.root))) {
        throw new Error('Invalid persisted PPOI event sequence');
      }
    }
    core.txidTree = await PoseidonMerkleTree.create();
    for (let index = 0; index < core.transactionRecords.length; index++) {
      const record = core.transactionRecords[index];
      core.txidTree.append(fromHex(record.txidLeaf));
      if (record.txidIndex !== index || !sameHex(record.txidMerkleRoot, hex32(core.txidTree.root))) {
        throw new Error('Invalid persisted TXID sequence');
      }
    }
    return core;
  }

  private async changed(): Promise<void> {
    await this.options.onStateChanged?.();
  }

  get state(): PersistedPOIState {
    return {
      version: 1,
      chainId: this.options.chainId.toString(),
      vault: this.options.vault,
      lastScannedBlock: this.lastScannedBlock,
      shields: this.shieldRecords,
      events: this.signedEvents,
      transactions: this.transactionRecords,
    };
  }

  get stats() {
    return {
      chainId: this.options.chainId.toString(),
      vault: this.options.vault,
      lastScannedBlock: this.lastScannedBlock,
      shields: this.shieldRecords.length,
      pendingShields: this.shieldRecords.filter((shield) => shield.status === 'Pending').length,
      blockedShields: this.shieldRecords.filter((shield) => shield.status === 'Blocked').length,
      poiEvents: this.signedEvents.length,
      transactions: this.transactionRecords.length,
      poiMerkleRoot: hex32(this.poiTree.root),
      txidMerkleRoot: hex32(this.txidTree.root),
      listKey: this.options.listKey,
      listProvider: this.options.listProvider.stats,
    };
  }

  async setLastScannedBlock(blockNumber: number): Promise<void> {
    if (!Number.isSafeInteger(blockNumber) || blockNumber < this.lastScannedBlock) throw new Error('Invalid PPOI scan checkpoint');
    this.lastScannedBlock = blockNumber;
    await this.changed();
  }

  async queueShield(input: NewShield): Promise<ShieldRecord> {
    const existing = this.shieldRecords.find((shield) => shield.transactionHash === input.transactionHash && shield.logIndex === input.logIndex);
    if (existing) return existing;
    if (this.shieldRecords.some((shield) => shield.leafIndex === input.leafIndex)) throw new Error('Duplicate shield leaf index');
    const blinded = await blindedCommitment(fromHex(input.commitment), fromHex(input.owner), input.leafIndex);
    const record: ShieldRecord = { ...input, from: input.from.toLowerCase(), blindedCommitment: hex32(blinded), status: 'Pending' };
    this.shieldRecords.push(record);
    this.shieldRecords.sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
    await this.changed();
    return record;
  }

  private async appendEvent(type: SignedPOIEvent['type'], blinded: string): Promise<SignedPOIEvent> {
    const existing = this.signedEvents.find((event) => sameHex(event.blindedCommitment, blinded));
    if (existing) return existing;
    const index = this.signedEvents.length;
    const signature = await this.options.signMessage(poiEventMessage(index, blinded, type));
    this.poiTree.append(fromHex(blinded));
    const event: SignedPOIEvent = {
      index,
      blindedCommitment: blinded,
      signature: Buffer.from(signature).toString('hex'),
      type,
      merkleRoot: hex32(this.poiTree.root),
    };
    this.signedEvents.push(event);
    return event;
  }

  async processShields(nowSeconds = Math.floor(Date.now() / 1000)): Promise<void> {
    const pendingSeconds = this.options.shieldPendingSeconds ?? 60;
    let changed = false;
    for (const shield of this.shieldRecords) {
      if (shield.status !== 'Pending' || shield.timestamp + pendingSeconds > nowSeconds) continue;
      try {
        const decision = await this.options.listProvider.shouldAllowShield({
          transactionHash: shield.transactionHash,
          fromAddressLowercase: shield.from,
          timestamp: shield.timestamp,
        });
        if (!decision.shouldAllow) {
          shield.status = 'Blocked';
          shield.blockReason = decision.blockReason ?? 'Blocked by list provider';
        } else {
          await this.appendEvent('Shield', shield.blindedCommitment);
          shield.status = 'AddedPOI';
        }
        changed = true;
      } catch {
        // A unavailable or ambiguous list response is never treated as approval.
        shield.status = 'Pending';
      }
    }
    if (changed) await this.changed();
  }

  async appendTransaction(input: NewTransaction): Promise<TransactionRecord> {
    const existing = this.transactionRecords.find((record) => record.transactionHash === input.transactionHash && record.logIndex === input.logIndex);
    if (existing) return existing;
    const nullifiers = input.nullifiers.map(fromHex) as [bigint, bigint];
    const outputCommitments = input.outputCommitments.map(fromHex) as [bigint, bigint, bigint, bigint];
    const boundParamsHash = await swirlBoundParamsHash({
      ciphertextHash: fromHex(input.ciphertextHash),
      publicAmount: BigInt(input.publicAmount),
      publicRecipient: fromHex(input.publicRecipient),
      token: fromHex(input.token),
      chainId: BigInt(input.chainId),
    });
    if (BigInt(input.chainId) !== this.options.chainId) throw new Error('Transaction chain ID mismatch');
    const txid = await swirlTransactionID({ nullifiers, outputCommitments, boundParamsHash });
    const txidLeaf = await swirlTxidLeaf(txid, input.firstLeafIndex);
    const txidIndex = this.txidTree.append(txidLeaf);
    const record: TransactionRecord = {
      ...input,
      txidIndex,
      txid: hex32(txid),
      txidLeaf: hex32(txidLeaf),
      txidMerkleRoot: hex32(this.txidTree.root),
    };
    this.transactionRecords.push(record);
    await this.changed();
    return record;
  }

  status(blinded: string): POIStatus {
    if (this.signedEvents.some((event) => sameHex(event.blindedCommitment, blinded))) return 'Valid';
    const shield = this.shieldRecords.find((record) => sameHex(record.blindedCommitment, blinded));
    if (shield?.status === 'Blocked') return 'ShieldBlocked';
    if (shield) return 'ShieldPending';
    return 'Missing';
  }

  hasPOIRoot(root: string): boolean {
    const value = fromHex(root);
    return value === 0n || this.poiTree.hasRoot(value);
  }

  getPOIMerkleProof(blinded: string): MerklePath {
    const event = this.signedEvents.find((item) => sameHex(item.blindedCommitment, blinded));
    if (!event) throw new Error('No valid POI event for blinded commitment');
    return this.poiTree.path(event.index);
  }

  getPOIEvent(blinded: string): SignedPOIEvent {
    const event = this.signedEvents.find((item) => sameHex(item.blindedCommitment, blinded));
    if (!event) throw new Error('No valid POI event for blinded commitment');
    return event;
  }

  getTxidMerkleProof(txid: string): MerklePath {
    const record = this.transactionRecords.find((item) => sameHex(item.txid, txid));
    if (!record) throw new Error('Unknown SWIRL transaction ID');
    return this.txidTree.path(record.txidIndex);
  }

  getTransaction(txid: string): TransactionRecord {
    const record = this.transactionRecords.find((item) => sameHex(item.txid, txid));
    if (!record) throw new Error('Unknown SWIRL transaction ID');
    return record;
  }

  async submitProof(submission: POIProofSubmission): Promise<SignedPOIEvent[]> {
    if (submission.blindedCommitmentsOut.length !== 4 || submission.poiMerkleRoots.length !== 2
      || submission.publicSignals.length !== 8) throw new Error('Invalid PPOI proof shape');
    const expectedSignals = [
      ...submission.blindedCommitmentsOut,
      submission.txidMerkleRoot,
      submission.txidIfHasUnshield,
      ...submission.poiMerkleRoots,
    ].map((value) => BigInt(value).toString());
    if (submission.publicSignals.map((value) => BigInt(value).toString()).some((value, index) => value !== expectedSignals[index])) {
      throw new Error('PPOI public signals do not match submission');
    }
    for (const root of submission.poiMerkleRoots) {
      if (fromHex(root) !== 0n && !this.poiTree.hasRoot(fromHex(root))) throw new Error('Unknown historical POI Merkle root');
    }
    const transaction = this.transactionRecords[submission.txidMerkleRootIndex];
    const rootRecord = this.transactionRecords.find((record) => sameHex(record.txidMerkleRoot, submission.txidMerkleRoot));
    if (!transaction || !sameHex(transaction.txid, submission.txid)
      || !rootRecord || rootRecord.txidIndex < transaction.txidIndex) throw new Error('Invalid historical TXID Merkle root');
    const expectedUnshield = BigInt(transaction.publicAmount) > 0n ? transaction.txid : hex32(0n);
    if (!sameHex(expectedUnshield, submission.txidIfHasUnshield)) throw new Error('Invalid unshield blinded commitment');

    const verified = await snarkjs.groth16.verify(this.options.verificationKey, submission.publicSignals, submission.proof);
    if (!verified) throw new Error('Invalid PPOI Groth16 proof');

    const outputs = submission.blindedCommitmentsOut.filter((value) => fromHex(value) !== 0n);
    if (new Set(outputs.map((value) => fromHex(value).toString())).size !== outputs.length) throw new Error('Duplicate blinded output');
    if (outputs.some((value) => this.signedEvents.some((event) => sameHex(event.blindedCommitment, value)))) {
      throw new Error('POI output already exists');
    }
    const added: SignedPOIEvent[] = [];
    for (const output of outputs) added.push(await this.appendEvent('Transact', output));
    if (fromHex(submission.txidIfHasUnshield) !== 0n) added.push(await this.appendEvent('Unshield', submission.txidIfHasUnshield));
    await this.changed();
    return added;
  }
}
