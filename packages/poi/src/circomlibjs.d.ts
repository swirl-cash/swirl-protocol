declare module 'circomlibjs' {
  export type Poseidon = ((inputs: bigint[]) => Uint8Array) & {
    F: { toObject(value: Uint8Array): bigint };
  };
  export function buildPoseidon(): Promise<Poseidon>;
}
