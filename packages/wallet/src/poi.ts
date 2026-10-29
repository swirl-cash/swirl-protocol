import * as snarkjs from 'snarkjs';
import { buildPoseidon } from 'circomlibjs';
import { assertAmount, assertField, TREE_DEPTH } from './constants.js';
import { verifyMerklePath, type MerklePath } from './merkle.js';
import { noteCommitment, noteNullifier, ownerFromSecret, zeroNote, type SwirlNote } from './notes.js';
import type { ProvingAssets } from './prover.js';

export type BlindedCommitmentType = 'Shield' | 'Transact' | 'Unshield';

export async function poseidonHash(values: bigint[]): Promise<bigint> {
  const poseidon = await buildPoseidon();
  return poseidon.F.toObject(poseidon(values)) as bigint;
}

export function hex32(value: bigint): string {
  return `0x${value.toString(16).padStart(64, '0')}`;
}

export async function blindedCommitment(commitment: bigint, owner: bigint, globalLeafPosition: number): Promise<bigint> {
  assertField(commitment, 'Commitment');
  assertField(owner, 'Note owner');
  if (!Number.isSafeInteger(globalLeafPosition) || globalLeafPosition < 0) throw new Error('Invalid global leaf position');
  return poseidonHash([commitment, owner, BigInt(globalLeafPosition)]);
}

export function swirlBoundParamsHash(input: {
  ciphertextHash: bigint;
  publicAmount: bigint;
  publicRecipient: bigint;
  token: bigint;
  chainId: bigint;
}): Promise<bigint> {
  return poseidonHash([input.ciphertextHash, input.publicAmount, input.publicRecipient, input.token, input.chainId]);
}

export async function swirlTransactionID(input: {
  nullifiers: [bigint, bigint];
  outputCommitments: [bigint, bigint, bigint, bigint];
  boundParamsHash: bigint;
}): Promise<bigint> {
  const [nullifiersHash, commitmentsHash] = await Promise.all([
    poseidonHash(input.nullifiers), poseidonHash(input.outputCommitments),
  ]);
  return poseidonHash([nullifiersHash, commitmentsHash, input.boundParamsHash]);
}

export function swirlTxidLeaf(txid: bigint, firstLeafIndex: number): Promise<bigint> {
  if (!Number.isSafeInteger(firstLeafIndex) || firstLeafIndex < 0) throw new Error('Invalid first leaf index');
  return poseidonHash([txid, 0n, BigInt(firstLeafIndex)]);
}

export type POITransactionData = {
  nullifiers: [bigint, bigint];
  outputCommitments: [bigint, bigint, bigint, bigint];
  ciphertextHash: bigint;
  publicAmount: bigint;
  publicRecipient: bigint;
  token: bigint;
  chainId: bigint;
  firstLeafIndex: number;
  txidMerklePath: MerklePath;
};

export type POIProofInput = {
  note: SwirlNote & { leafIndex: number };
  ownerSecret: bigint;
  poiMerklePath: MerklePath;
};

export type POIProofResult = {
  proof: snarkjs.Groth16Proof;
  publicSignals: string[];
  blindedCommitmentsOut: string[];
  txid: string;
  txidLeaf: string;
  txidIfHasUnshield: string;
  txidMerkleRoot: string;
  txidMerkleRootIndex: number;
  poiMerkleRoots: string[];
};

export async function createPOIProof(input: {
  inputs: [POIProofInput] | [POIProofInput, POIProofInput];
  outputs: SwirlNote[];
  transaction: POITransactionData;
  assets: ProvingAssets;
}): Promise<POIProofResult> {
  if (input.inputs.length < 1 || input.inputs.length > 2) throw new Error('One or two POI inputs are required');
  if (input.outputs.length < 1 || input.outputs.length > 4) throw new Error('Between one and four outputs are required');
  const tx = input.transaction;
  if (tx.chainId <= 0n || !Number.isSafeInteger(tx.firstLeafIndex) || tx.firstLeafIndex < 1) throw new Error('Invalid transaction context');
  if ((tx.publicAmount === 0n) !== (tx.publicRecipient === 0n)) throw new Error('Withdrawal amount and recipient must be set together');
  assertAmount(tx.publicAmount, 'Public amount');
  assertField(tx.publicRecipient, 'Public recipient');
  assertField(tx.ciphertextHash, 'Ciphertext hash');

  const paddedOutputs = [...input.outputs];
  while (paddedOutputs.length < 4) paddedOutputs.push(zeroNote(tx.token));
  for (let index = 0; index < 4; index++) {
    if (paddedOutputs[index].token !== tx.token) throw new Error('Output token mismatch');
    if ((await noteCommitment(paddedOutputs[index])) !== tx.outputCommitments[index]) throw new Error(`Output ${index} does not match the confirmed transaction`);
  }

  const inputEnabled = [0, 0];
  const inputOwner = [0n, 0n];
  const inputOwnerSecret = [0n, 0n];
  const inputAmount = [0n, 0n];
  const inputRandomness = [0n, 0n];
  const inputLeafIndex = [0, 0];
  const poiPathIndices = [0, 0];
  const poiPathElements: bigint[][] = [new Array(TREE_DEPTH).fill(0n), new Array(TREE_DEPTH).fill(0n)];
  const poiMerkleRoots = [0n, 0n];
  const expectedNullifiers: [bigint, bigint] = [0n, 0n];
  for (let index = 0; index < input.inputs.length; index++) {
    const item = input.inputs[index];
    if (item.note.token !== tx.token || item.note.amount === 0n || item.note.leafIndex < 1) throw new Error('Invalid POI input note');
    if ((await ownerFromSecret(item.ownerSecret)) !== item.note.owner) throw new Error('Owner secret does not control POI input');
    const commitment = await noteCommitment(item.note);
    const blinded = await blindedCommitment(commitment, item.note.owner, item.note.leafIndex);
    if (!(await verifyMerklePath(blinded, item.poiMerklePath))) throw new Error(`Invalid POI Merkle path for input ${index}`);
    expectedNullifiers[index] = await noteNullifier(item.ownerSecret, item.note.leafIndex);
    if (expectedNullifiers[index] !== tx.nullifiers[index]) throw new Error(`Nullifier ${index} does not match the confirmed transaction`);
    inputEnabled[index] = 1;
    inputOwner[index] = item.note.owner;
    inputOwnerSecret[index] = item.ownerSecret;
    inputAmount[index] = item.note.amount;
    inputRandomness[index] = item.note.randomness;
    inputLeafIndex[index] = item.note.leafIndex;
    poiPathIndices[index] = item.poiMerklePath.leafIndex;
    poiPathElements[index] = item.poiMerklePath.pathElements;
    poiMerkleRoots[index] = item.poiMerklePath.root;
  }
  if (input.inputs.length === 1 && tx.nullifiers[1] !== 0n) throw new Error('Missing second transaction input');

  const boundParamsHash = await swirlBoundParamsHash(tx);
  const txid = await swirlTransactionID({ nullifiers: tx.nullifiers, outputCommitments: tx.outputCommitments, boundParamsHash });
  const txidLeaf = await swirlTxidLeaf(txid, tx.firstLeafIndex);
  if (!(await verifyMerklePath(txidLeaf, tx.txidMerklePath))) throw new Error('Invalid TXID Merkle path');
  const txidIfHasUnshield = tx.publicAmount > 0n ? txid : 0n;

  const witness = {
    anyTxidMerkleRootAfterTransaction: tx.txidMerklePath.root,
    txidIfHasUnshield,
    poiMerkleRoots,
    nullifiers: tx.nullifiers,
    outputCommitments: tx.outputCommitments,
    ciphertextHash: tx.ciphertextHash,
    publicAmount: tx.publicAmount,
    publicRecipient: tx.publicRecipient,
    token: tx.token,
    chainId: tx.chainId,
    firstLeafIndex: tx.firstLeafIndex,
    inputEnabled,
    inputOwner,
    inputOwnerSecret,
    inputAmount,
    inputRandomness,
    inputLeafIndex,
    poiPathIndices,
    poiPathElements,
    outputOwner: paddedOutputs.map((note) => note.owner),
    outputAmount: paddedOutputs.map((note) => note.amount),
    outputRandomness: paddedOutputs.map((note) => note.randomness),
    txidPathIndices: tx.txidMerklePath.leafIndex,
    txidPathElements: tx.txidMerklePath.pathElements,
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, input.assets.wasm, input.assets.zkey);
  return {
    proof,
    publicSignals,
    blindedCommitmentsOut: publicSignals.slice(0, 4).map((value) => hex32(BigInt(value))),
    txid: hex32(txid),
    txidLeaf: hex32(txidLeaf),
    txidIfHasUnshield: hex32(txidIfHasUnshield),
    txidMerkleRoot: hex32(tx.txidMerklePath.root),
    txidMerkleRootIndex: tx.txidMerklePath.leafIndex,
    poiMerkleRoots: poiMerkleRoots.map(hex32),
  };
}

// Matches the upstream Pre-Transaction POI construction: the TXID is bound to a
// dummy tree and reserved output positions. These blinded outputs are only for
// Broadcaster validation; confirmed outputs still require the normal POI proof.
export const PRE_TRANSACTION_LEAF_INDEX = 199_999;

export async function createPreTransactionTxidPath(txidLeaf: bigint): Promise<MerklePath> {
  assertField(txidLeaf, 'TXID leaf');
  const pathElements = new Array<bigint>(TREE_DEPTH).fill(0n);
  let root = txidLeaf;
  for (const element of pathElements) root = await poseidonHash([root, element]);
  return { root, pathElements, leafIndex: 0 };
}

export async function createPreTransactionPOIProof(input: {
  inputs: [POIProofInput] | [POIProofInput, POIProofInput];
  outputs: SwirlNote[];
  transaction: Omit<POITransactionData, 'firstLeafIndex' | 'txidMerklePath'>;
  assets: ProvingAssets;
}): Promise<POIProofResult> {
  const boundParamsHash = await swirlBoundParamsHash(input.transaction);
  const txid = await swirlTransactionID({
    nullifiers: input.transaction.nullifiers,
    outputCommitments: input.transaction.outputCommitments,
    boundParamsHash,
  });
  const txidLeaf = await swirlTxidLeaf(txid, PRE_TRANSACTION_LEAF_INDEX);
  const txidMerklePath = await createPreTransactionTxidPath(txidLeaf);
  return createPOIProof({
    ...input,
    transaction: {
      ...input.transaction,
      firstLeafIndex: PRE_TRANSACTION_LEAF_INDEX,
      txidMerklePath,
    },
  });
}
