declare module 'snarkjs' {
  export type Groth16Proof = {
    pi_a: string[];
    pi_b: string[][];
    pi_c: string[];
    protocol: string;
    curve: string;
  };
  export const groth16: {
    fullProve(
      input: Record<string, unknown>,
      wasm: string | Uint8Array | ArrayBuffer,
      zkey: string | Uint8Array | ArrayBuffer,
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
    exportSolidityCallData(proof: Groth16Proof, publicSignals: string[]): Promise<string>;
    verify(
      verificationKey: unknown,
      publicSignals: string[],
      proof: Groth16Proof,
    ): Promise<boolean>;
  };
}
