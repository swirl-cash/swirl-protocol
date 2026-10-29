import { Contract, ethers, type Provider, type Signer, type TransactionReceipt } from 'ethers';
import { bytesToBigint } from './constants.js';
import { decryptNote } from './encryption.js';
import { SwirlMerkleTree } from './merkle.js';
import { noteCommitment, noteNullifier, zeroNote, type SwirlNote } from './notes.js';
import { createTransferProof, type ProvingAssets } from './prover.js';
import type { SwirlWallet } from './wallet.js';

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const VAULT_ABI = [
  'function zeroNoteCommitment() view returns (bytes32)',
  'function merkleRoot() view returns (bytes32)',
  'function nextLeafIndex() view returns (uint32)',
  'function nullifiers(bytes32) view returns (bool)',
  'function supportedTokens(address) view returns (bool)',
  'function transact((uint256[2] a, uint256[2][2] b, uint256[2] c) proof, bytes32 root, bytes32[2] nullifiers, bytes32[4] outputCommitments, bytes[4] ciphertexts, uint256 publicAmount, address publicRecipient, address token)',
  'event Shielded(uint32 indexed leafIndex, bytes32 indexed commitment, bytes ciphertext, uint256 amount, uint256 fee, bytes32 owner, address indexed token)',
  'event Transacted(bytes32[2] nullifiers, bytes32[4] commitments, bytes[4] ciphertexts, uint32 firstLeafIndex)',
];
const GATEWAY_ABI = [
  'function wrappedNative() view returns (address)',
  'function vault() view returns (address)',
  'function unshieldNative((uint256[2] a, uint256[2][2] b, uint256[2] c) proof, bytes32 root, bytes32[2] nullifiers, bytes32[4] outputCommitments, bytes[4] ciphertexts, uint256 publicAmount)',
];

export type RecoveredNote = {
  note: SwirlNote & { leafIndex: number };
  commitment: bigint;
  nullifier: bigint;
  spent: boolean;
};

export type RecoveryState = {
  chainId: number;
  vaultAddress: string;
  notes: RecoveredNote[];
  tree: SwirlMerkleTree;
  lastScannedBlock: number;
};

function validateScanInput(vaultAddress: string, startBlock: number, batchSize: number): void {
  if (!ethers.isAddress(vaultAddress)) throw new Error('Invalid vault address');
  if (!Number.isSafeInteger(startBlock) || startBlock < 0) throw new Error('Invalid deployment block');
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 10_000) throw new Error('Invalid RPC batch size');
}

/** Rebuilds the note tree using only chain events and the user's recovery phrase. */
export async function recoverWalletNotes(input: {
  provider: Provider;
  wallet: SwirlWallet;
  vaultAddress: string;
  startBlock?: number;
  batchSize?: number;
}): Promise<RecoveryState> {
  const startBlock = input.startBlock ?? 0;
  const batchSize = input.batchSize ?? 500;
  validateScanInput(input.vaultAddress, startBlock, batchSize);
  const { chainId } = await input.provider.getNetwork();
  if (Number(chainId) !== input.wallet.chainId) throw new Error(`Recovery phrase is for chain ${input.wallet.chainId}, RPC returned ${chainId}`);
  const vaultAddress = ethers.getAddress(input.vaultAddress);
  const vault = new Contract(vaultAddress, VAULT_ABI, input.provider);
  const [zeroCommitment, latest] = await Promise.all([vault.zeroNoteCommitment(), input.provider.getBlockNumber()]);
  const commitments: bigint[] = [BigInt(zeroCommitment)];
  const encrypted: { index: number; ciphertext: string }[] = [];
  const insert = (index: number, commitment: string, ciphertext: string) => {
    if (!Number.isSafeInteger(index) || index < 1) throw new Error('Chain event contains an invalid leaf index');
    const value = BigInt(commitment);
    if (commitments[index] !== undefined && commitments[index] !== value) throw new Error('Conflicting commitments in chain history');
    commitments[index] = value;
    encrypted.push({ index, ciphertext });
  };

  for (let start = startBlock; start <= latest; start += batchSize) {
    const end = Math.min(start + batchSize - 1, latest);
    const [shields, transfers] = await Promise.all([
      vault.queryFilter('Shielded', start, end), vault.queryFilter('Transacted', start, end),
    ]);
    for (const event of shields) {
      if (!('args' in event) || event.removed) continue;
      insert(Number(event.args[0]), event.args[1], event.args[2]);
    }
    for (const event of transfers) {
      if (!('args' in event) || event.removed) continue;
      const first = Number(event.args[3]);
      for (let offset = 0; offset < 4; offset++) insert(first + offset, event.args[1][offset], event.args[2][offset]);
    }
  }
  if (Array.from({ length: commitments.length }, (_, index) => commitments[index]).some((value) => value === undefined)) {
    throw new Error('Chain event history has a missing leaf; check the deployment block and RPC archive coverage');
  }
  const [tree, onchainRoot, nextLeafIndex] = await Promise.all([
    SwirlMerkleTree.create(16, commitments), vault.merkleRoot(), vault.nextLeafIndex(),
  ]);
  if (Number(nextLeafIndex) !== commitments.length) throw new Error('Reconstructed leaf count does not match the vault');
  if (tree.root !== BigInt(onchainRoot)) throw new Error('Reconstructed tree does not match the vault root');

  const ownerSecret = bytesToBigint(input.wallet.noteSecretKey);
  const notes: RecoveredNote[] = [];
  for (const item of encrypted) {
    if (item.ciphertext === '0x') continue;
    const note = await decryptNote(ethers.getBytes(item.ciphertext), input.wallet.viewingSecretKey, ownerSecret);
    if (!note) continue;
    const commitment = await noteCommitment(note);
    if (commitment !== commitments[item.index]) throw new Error('Decrypted note does not match its on-chain commitment');
    const nullifier = await noteNullifier(ownerSecret, item.index);
    notes.push({
      note: { ...note, leafIndex: item.index }, commitment, nullifier,
      spent: await vault.nullifiers(ethers.toBeHex(nullifier, 32)),
    });
  }
  notes.sort((a, b) => a.note.leafIndex - b.note.leafIndex);
  return { chainId: Number(chainId), vaultAddress, notes, tree, lastScannedBlock: latest };
}

/** Builds and submits a direct Unshield. No SWIRL website, indexer or Relayer is used. */
export async function withdrawRecoveredNote(input: {
  signer: Signer;
  wallet: SwirlWallet;
  state: RecoveryState;
  recovered: RecoveredNote;
  recipient: string;
  gatewayAddress?: string;
  assets: ProvingAssets;
}): Promise<TransactionReceipt> {
  if (!input.signer.provider) throw new Error('A connected signer is required');
  if (!ethers.isAddress(input.recipient)) throw new Error('Invalid public recipient');
  if (input.recovered.spent) throw new Error('This recovered note was already spent');
  const { note } = input.recovered;
  const token = ethers.getAddress(ethers.toBeHex(note.token, 20));
  const vault = new Contract(input.state.vaultAddress, VAULT_ABI, input.signer);
  if (!await vault.supportedTokens(token)) throw new Error('The vault does not support this note asset');
  if (await vault.nullifiers(ethers.toBeHex(input.recovered.nullifier, 32))) throw new Error('This note was spent after recovery');
  const native = Boolean(input.gatewayAddress);
  const publicRecipient = native ? ethers.getAddress(input.gatewayAddress!) : ethers.getAddress(input.recipient);
  if (native) {
    const gateway = new Contract(publicRecipient, GATEWAY_ABI, input.signer);
    const [gatewayVault, wrappedNative] = await Promise.all([gateway.vault(), gateway.wrappedNative()]);
    if (ethers.getAddress(gatewayVault) !== input.state.vaultAddress || ethers.getAddress(wrappedNative) !== token) {
      throw new Error('Native gateway does not match the vault and note asset');
    }
  }
  const ciphertexts: [string, string, string, string] = native
    ? [ethers.AbiCoder.defaultAbiCoder().encode(['address'], [input.recipient]), '0x', '0x', '0x']
    : ['0x', '0x', '0x', '0x'];
  const ciphertextHash = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes[4]'], [ciphertexts]))) % FIELD_SIZE;
  const proof = await createTransferProof({
    inputs: [{
      note, merklePath: input.state.tree.path(note.leafIndex), ownerSecret: bytesToBigint(input.wallet.noteSecretKey),
    }],
    outputs: [zeroNote(note.token)], zeroInputPath: input.state.tree.path(0), publicAmount: note.amount,
    ciphertextHash, publicRecipient: BigInt(publicRecipient), chainId: BigInt(input.state.chainId), assets: input.assets,
  });
  const args = [proof.solidity, ethers.toBeHex(proof.root, 32),
    proof.nullifiers.map((value) => ethers.toBeHex(value, 32)),
    proof.outputCommitments.map((value) => ethers.toBeHex(value, 32)), ciphertexts, note.amount] as const;
  const transaction = native
    ? await new Contract(publicRecipient, GATEWAY_ABI, input.signer).unshieldNative(...args)
    : await vault.transact(...args, input.recipient, token);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error('Recovery withdrawal transaction failed');
  return receipt;
}
