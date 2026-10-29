import { AbiCoder, Contract, Interface, ethers, type EventLog, type Provider } from 'ethers';
import { hex32 } from '@swirl/wallet';
import type { PPOICore } from './core.js';

const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const VAULT_ABI = [
  'function token() view returns (address)',
  'function wrappedNative() view returns (address)',
  'event Shielded(uint32 indexed leafIndex, bytes32 indexed commitment, bytes ciphertext, uint256 amount, uint256 fee, bytes32 owner, address indexed token)',
  'event Transacted(bytes32[2] nullifiers, bytes32[4] commitments, bytes[4] ciphertexts, uint32 firstLeafIndex)',
  'function transact((uint256[2] a, uint256[2][2] b, uint256[2] c) proof, bytes32 root, bytes32[2] nullifiers, bytes32[4] outputCommitments, bytes[4] ciphertexts, uint256 publicAmount, address publicRecipient)',
  'function transact((uint256[2] a, uint256[2][2] b, uint256[2] c) proof, bytes32 root, bytes32[2] nullifiers, bytes32[4] outputCommitments, bytes[4] ciphertexts, uint256 publicAmount, address publicRecipient, address token)',
  'function unshieldNative((uint256[2] a, uint256[2][2] b, uint256[2] c) proof, bytes32 root, bytes32[2] nullifiers, bytes32[4] outputCommitments, bytes[4] ciphertexts, uint256 publicAmount)',
];

export class VaultPPOISync {
  private readonly vault: Contract;
  private readonly abi = new Interface(VAULT_ABI);
  private syncing: Promise<void> | null = null;
  private token = '';

  constructor(
    private readonly provider: Provider,
    private readonly vaultAddress: string,
    private readonly core: PPOICore,
    private readonly startBlock: number,
    private readonly batchSize = 500,
    private readonly confirmations = 1,
  ) {
    if (!ethers.isAddress(vaultAddress) || !Number.isSafeInteger(startBlock) || startBlock < 0
      || !Number.isSafeInteger(batchSize) || batchSize < 1 || !Number.isSafeInteger(confirmations) || confirmations < 0) {
      throw new Error('Invalid PPOI chain synchronization configuration');
    }
    this.vault = new Contract(vaultAddress, VAULT_ABI, provider);
  }

  sync(): Promise<void> {
    this.syncing ??= this.performSync().finally(() => { this.syncing = null; });
    return this.syncing;
  }

  private async performSync(): Promise<void> {
    const latest = await this.provider.getBlockNumber();
    const target = Math.max(this.startBlock - 1, latest - this.confirmations);
    for (let start = Math.max(this.startBlock, this.core.state.lastScannedBlock + 1); start <= target; start += this.batchSize) {
      const end = Math.min(start + this.batchSize - 1, target);
      const logs = await Promise.all([
        this.vault.queryFilter('Shielded', start, end),
        this.vault.queryFilter('Transacted', start, end),
      ]).catch((error: unknown) => {
        // Load-balanced RPC backends can briefly disagree about the head. Keep the
        // checkpoint and let the next scheduled sync retry this exact range.
        if (error instanceof Error && error.message.includes('beyond current head block')) return null;
        throw error;
      });
      if (!logs) return;
      const [shieldEvents, transactionEvents] = logs;
      const events = [...shieldEvents, ...transactionEvents].sort((a, b) => a.blockNumber - b.blockNumber
        || a.transactionIndex - b.transactionIndex || a.index - b.index);
      for (const candidate of events) {
        if (!('args' in candidate) || !('fragment' in candidate) || candidate.removed) continue;
        const event = candidate as EventLog;
        if (event.fragment.name === 'Shielded') {
          const [receipt, block] = await Promise.all([
            this.provider.getTransactionReceipt(event.transactionHash),
            this.provider.getBlock(event.blockNumber),
          ]);
          if (!receipt || !block) throw new Error(`Missing Shield receipt or block ${event.transactionHash}`);
          await this.core.queueShield({
            transactionHash: event.transactionHash,
            blockNumber: event.blockNumber,
            logIndex: event.index,
            leafIndex: Number(event.args[0]),
            commitment: event.args[1],
            owner: event.args[5],
            from: receipt.from,
            timestamp: block.timestamp,
          });
        } else {
          const transaction = await this.provider.getTransaction(event.transactionHash);
          if (!transaction) throw new Error(`Missing transaction ${event.transactionHash}`);
          const parsed = this.abi.parseTransaction({ data: transaction.data, value: transaction.value });
          if (!parsed || (parsed.name !== 'transact' && parsed.name !== 'unshieldNative') || !transaction.to) {
            throw new Error('Transacted event does not match a supported vault or native-gateway call');
          }
          const publicRecipient = parsed.name === 'transact' ? parsed.args[6] : transaction.to;
          let token: string;
          if (parsed.name === 'transact' && parsed.args.length === 8) token = parsed.args[7];
          else if (parsed.name === 'transact') {
            this.token ||= await this.vault.token();
            token = this.token;
          } else {
            token = await new Contract(transaction.to, ['function wrappedNative() view returns (address)'], this.provider).wrappedNative();
          }
          const ciphertexts = [...event.args[2]] as [string, string, string, string];
          const encoded = AbiCoder.defaultAbiCoder().encode(['bytes[4]'], [ciphertexts]);
          const ciphertextHash = BigInt(ethers.keccak256(encoded)) % FIELD;
          await this.core.appendTransaction({
            transactionHash: event.transactionHash,
            blockNumber: event.blockNumber,
            logIndex: event.index,
            nullifiers: [...event.args[0]] as [string, string],
            outputCommitments: [...event.args[1]] as [string, string, string, string],
            ciphertextHash: hex32(ciphertextHash),
            publicAmount: parsed.args[5].toString(),
            publicRecipient: ethers.zeroPadValue(publicRecipient, 32),
            token: ethers.zeroPadValue(token, 32),
            chainId: this.core.state.chainId,
            firstLeafIndex: Number(event.args[3]),
          });
        }
      }
      await this.core.processShields();
      await this.core.setLastScannedBlock(end);
    }
    await this.core.processShields();
  }
}
