import * as snarkjs from 'snarkjs';

self.onmessage = async (event) => {
  try {
    const { witness, assets } = event.data;
    const { proof, publicSignals } = await snarkjs.groth16.fullProve(witness, assets.wasm, assets.zkey);
    self.postMessage({ ok: true, proof, publicSignals });
  } catch (error) {
    self.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
