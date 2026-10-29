import * as snarkjs from 'snarkjs';
import { assertAmount, assertField, TREE_DEPTH } from './constants.js';
import { verifyMerklePath, type MerklePath } from './merkle.js';
import { noteCommitment, noteNullifier, ownerFromSecret, zeroNote, type SwirlNote } from './notes.js';

export type ProvingAssets = {
  wasm: string | Uint8Array | ArrayBuffer;
  zkey: string | Uint8Array | ArrayBuffer;
};

export type SolidityProof = {
  a: [string, string];
  b: [[string, string], [string, string]];
  c: [string, string];
};

export type ProofInput = {
  note: SwirlNote & { leafIndex: number };
  merklePath: MerklePath;
  ownerSecret: bigint;
};

export type SwirlProof = {
  proof: snarkjs.Groth16Proof;
  publicSignals: string[];
  solidity: SolidityProof;
  root: bigint;
  nullifiers: [bigint, bigint];
  outputCommitments: [bigint, bigint, bigint, bigint];
};

export async function createTransferProof(input: {
  inputs: [ProofInput] | [ProofInput, ProofInput];
  outputs: SwirlNote[];
  ciphertextHash: bigint;
  chainId: bigint;
  publicAmount?: bigint;
  publicRecipient?: bigint;
  zeroInputPath?: MerklePath;
  assets: ProvingAssets;
}): Promise<SwirlProof> {
  if (input.inputs.length < 1 || input.inputs.length > 2) throw new Error('One or two inputs are required');
  if (input.outputs.length < 1 || input.outputs.length > 4) throw new Error('Between one and four outputs are required');
  const publicAmount = input.publicAmount ?? 0n;
  const publicRecipient = input.publicRecipient ?? 0n;
  if ((publicAmount === 0n) !== (publicRecipient === 0n)) throw new Error('Withdrawal amount and recipient must be set together');
  if (input.chainId <= 0n) throw new Error('Invalid chain ID');
  assertField(publicRecipient, 'Public recipient');
  assertField(input.ciphertextHash, 'Ciphertext hash');
  assertAmount(publicAmount, 'Public amount');
  const token = input.inputs[0].note.token;
  const root = input.inputs[0].merklePath.root;
  assertField(root, 'Merkle root');

  const nullifiers: [bigint, bigint] = [0n, 0n];
  const inputOwner = [0n, 0n];
  const inputOwnerSecret = [0n, 0n];
  const inputAmount = [0n, 0n];
  const inputRandomness = [0n, 0n];
  const inputLeafIndex = [0, 0];
  const inputEnabled = [0, 0];
  const pathElements: bigint[][] = [];
  for (let index = 0; index < input.inputs.length; index++) {
    const item = input.inputs[index];
    if (item.note.leafIndex !== item.merklePath.leafIndex) throw new Error('Note and Merkle path indices differ');
    if (item.note.leafIndex === 0) throw new Error('The canonical zero note cannot be spent');
    if (item.note.token !== token || item.merklePath.root !== root) throw new Error('Input token or root mismatch');
    assertField(item.ownerSecret, 'Owner secret');
    assertAmount(item.note.amount, `Input ${index} amount`);
    if (item.note.amount === 0n) throw new Error('Real inputs must have a positive amount');
    if ((await ownerFromSecret(item.ownerSecret)) !== item.note.owner) throw new Error('Owner secret does not control input note');
    if (!(await verifyMerklePath(await noteCommitment(item.note), item.merklePath))) throw new Error('Invalid Merkle path');
    const nullifier = await noteNullifier(item.ownerSecret, item.merklePath.leafIndex);
    if (nullifiers.includes(nullifier)) throw new Error('Duplicate input nullifier');
    nullifiers[index] = nullifier;
    inputOwner[index] = item.note.owner;
    inputOwnerSecret[index] = item.ownerSecret;
    inputAmount[index] = item.note.amount;
    inputRandomness[index] = item.note.randomness;
    inputLeafIndex[index] = item.merklePath.leafIndex;
    inputEnabled[index] = 1;
    pathElements[index] = item.merklePath.pathElements;
  }
  if (input.inputs.length === 1) {
    const zeroPath = input.zeroInputPath;
    if (!zeroPath || zeroPath.leafIndex !== 0 || zeroPath.root !== root || zeroPath.pathElements.length !== TREE_DEPTH) {
      throw new Error('A valid canonical zero-input Merkle path is required');
    }
    if (!(await verifyMerklePath(await noteCommitment(zeroNote(0n)), zeroPath))) throw new Error('Invalid zero-input Merkle path');
    pathElements[1] = zeroPath.pathElements;
  }

  const paddedOutputs = [...input.outputs];
  while (paddedOutputs.length < 4) paddedOutputs.push(zeroNote(token));
  const outputCommitments: [bigint, bigint, bigint, bigint] = [0n, 0n, 0n, 0n];
  for (let index = 0; index < 4; index++) {
    if (paddedOutputs[index].token !== token) throw new Error('Output token mismatch');
    assertAmount(paddedOutputs[index].amount, `Output ${index} amount`);
    outputCommitments[index] = await noteCommitment(paddedOutputs[index]);
  }
  const inputTotal = inputAmount[0] + inputAmount[1];
  const outputTotal = paddedOutputs.reduce((sum, note) => sum + note.amount, 0n) + publicAmount;
  if (inputTotal !== outputTotal) throw new Error('Note amounts are not conserved');

  const witness = {
    root,
    nullifiers,
    outputCommitments,
    ciphertextHash: input.ciphertextHash,
    publicAmount,
    publicRecipient,
    token,
    chainId: input.chainId,
    inputEnabled,
    inputOwner,
    inputOwnerSecret,
    inputAmount,
    inputRandomness,
    inputLeafIndex,
    pathElements,
    outputOwner: paddedOutputs.map((note) => note.owner),
    outputAmount: paddedOutputs.map((note) => note.amount),
    outputRandomness: paddedOutputs.map((note) => note.randomness),
  };
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, input.assets.wasm, input.assets.zkey);
  const raw = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const [rawA, rawB, rawC] = JSON.parse(`[${raw}]`) as [SolidityProof['a'], SolidityProof['b'], SolidityProof['c']];
  const decimal = (value: string) => BigInt(value).toString(10);
  const solidity: SolidityProof = {
    a: rawA.map(decimal) as SolidityProof['a'],
    b: rawB.map((row) => row.map(decimal)) as SolidityProof['b'],
    c: rawC.map(decimal) as SolidityProof['c'],
  };
  return { proof, publicSignals, solidity, root, nullifiers, outputCommitments };
}
