import * as snarkjs from 'snarkjs';
import type { ProvingAssets } from './prover.js';

const PROOF_TIMEOUT_MS = 120_000;

export async function fullProve(witness: Record<string, unknown>, assets: ProvingAssets): Promise<{ proof: snarkjs.Groth16Proof; publicSignals: string[] }> {
  if (typeof window === 'undefined' || typeof Worker === 'undefined') {
    return snarkjs.groth16.fullProve(witness, assets.wasm, assets.zkey) as Promise<{ proof: snarkjs.Groth16Proof; publicSignals: string[] }>;
  }
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./full-prove.worker.js', import.meta.url), { type: 'module' });
    const finish = (callback: (value: never) => void, value: unknown) => {
      clearTimeout(timer);
      worker.terminate();
      callback(value as never);
    };
    const timer = setTimeout(() => {
      worker.terminate();
      reject(new Error('Groth16 proof generation timed out after 120 seconds. Please try again.'));
    }, PROOF_TIMEOUT_MS);
    worker.onmessage = (event) => {
      if (event.data?.ok) finish(resolve, { proof: event.data.proof, publicSignals: event.data.publicSignals });
      else finish(reject, new Error(event.data?.error || 'Groth16 worker failed'));
    };
    worker.onerror = (event) => finish(reject, new Error(event.message || 'Groth16 worker failed to start'));
    worker.postMessage({ witness, assets });
  });
}
