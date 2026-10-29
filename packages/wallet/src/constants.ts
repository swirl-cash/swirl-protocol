export const BN254_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const TREE_DEPTH = 16;
export const MAX_NOTE_AMOUNT = (1n << 128n) - 1n;

export function assertField(value: bigint, name: string): void {
  if (value < 0n || value >= BN254_FIELD) throw new Error(`${name} is outside the BN254 field`);
}

export function assertAmount(value: bigint, name = 'Amount'): void {
  if (value < 0n || value > MAX_NOTE_AMOUNT) throw new Error(`${name} must fit in 128 bits`);
}

export function bigintToBytes(value: bigint, length: number): Uint8Array {
  if (value < 0n || value >= (1n << BigInt(length * 8))) throw new Error('Integer does not fit target byte length');
  const result = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    result[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }
  return result;
}

export function bytesToBigint(value: Uint8Array): bigint {
  let result = 0n;
  for (const byte of value) result = (result << 8n) | BigInt(byte);
  return result;
}

export function randomField(): bigint {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const value = bytesToBigint(bytes) % BN254_FIELD;
  return value === 0n ? 1n : value;
}
