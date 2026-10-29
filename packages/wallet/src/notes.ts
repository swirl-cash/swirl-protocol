import { buildPoseidon } from 'circomlibjs';
import { decodeSwirlAddress } from './address.js';
import { assertAmount, assertField, BN254_FIELD, bytesToBigint, randomField } from './constants.js';

export type SwirlNote = {
  owner: bigint;
  token: bigint;
  amount: bigint;
  randomness: bigint;
  leafIndex?: number;
};

async function poseidon(values: bigint[]): Promise<bigint> {
  const instance = await buildPoseidon();
  return instance.F.toObject(instance(values)) as bigint;
}

export async function ownerFromSecret(ownerSecret: bigint): Promise<bigint> {
  assertField(ownerSecret, 'Owner secret');
  if (ownerSecret === 0n) throw new Error('Owner secret cannot be zero');
  return poseidon([ownerSecret]);
}

export async function noteCommitment(note: SwirlNote): Promise<bigint> {
  assertField(note.owner, 'Note owner');
  assertField(note.token, 'Token');
  assertAmount(note.amount);
  assertField(note.randomness, 'Note randomness');
  return poseidon([note.owner, note.token, note.amount, note.randomness]);
}

export async function noteNullifier(ownerSecret: bigint, leafIndex: number): Promise<bigint> {
  assertField(ownerSecret, 'Owner secret');
  if (ownerSecret === 0n) throw new Error('Owner secret cannot be zero');
  if (!Number.isInteger(leafIndex) || leafIndex < 0 || leafIndex >= 2 ** 16) throw new Error('Invalid leaf index');
  return poseidon([ownerSecret, BigInt(leafIndex)]);
}

export async function createNoteForAddress(input: {
  address: string;
  token: bigint;
  amount: bigint;
  chainId: number;
  randomness?: bigint;
}): Promise<SwirlNote> {
  const decoded = decodeSwirlAddress(input.address);
  if (decoded.chainId !== input.chainId) throw new Error('Recipient is on a different network');
  assertAmount(input.amount);
  const owner = bytesToBigint(decoded.spendingPublicKey);
  if (owner >= BN254_FIELD) throw new Error('Invalid recipient owner key');
  return {
    owner,
    token: input.token,
    amount: input.amount,
    randomness: input.randomness ?? randomField(),
  };
}

export function zeroNote(token: bigint): SwirlNote {
  return { owner: 0n, token, amount: 0n, randomness: 0n };
}
