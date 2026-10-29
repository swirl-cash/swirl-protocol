import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import { createSwirlWallet } from './wallet.js';
import { decodeSwirlAddress, isSwirlAddress } from './address.js';
import { bytesToBigint } from './constants.js';
import { createNoteForAddress, noteCommitment, zeroNote } from './notes.js';
import { SwirlMerkleTree } from './merkle.js';
import { createTransferProof } from './prover.js';
import { decryptNote, encryptNote } from './encryption.js';

const WASM = fileURLToPath(new URL('../../contracts/build/circuits/swirl_transfer_js/swirl_transfer.wasm', import.meta.url));
const ZKEY = fileURLToPath(new URL('../../contracts/build/circuits/swirl_transfer_final.zkey', import.meta.url));
const VERIFICATION_KEY = fileURLToPath(new URL('../../contracts/build/circuits/verification_key.json', import.meta.url));
const TOKEN = 0x1234567890123456789012345678901234567890n;

describe('SWIRL independent wallet', () => {
  it('creates and restores a swirl1 address', async () => {
    const first = await createSwirlWallet(11155111);
    const restored = await createSwirlWallet(11155111, first.mnemonic);
    expect(first.address.startsWith('swirl1')).toBe(true);
    expect(restored.address).toBe(first.address);
    expect(first.mnemonic.split(' ')).toHaveLength(24);
  });

  it('round-trips chain and public keys', async () => {
    const wallet = await createSwirlWallet(31337);
    const decoded = decodeSwirlAddress(wallet.address);
    expect(decoded.chainId).toBe(31337);
    expect(decoded.spendingPublicKey).toEqual(wallet.spendingPublicKey);
    expect(decoded.viewingPublicKey).toEqual(wallet.viewingPublicKey);
  });

  it('rejects checksum damage, other prefixes and wrong networks', async () => {
    const wallet = await createSwirlWallet(1);
    expect(isSwirlAddress(wallet.address, 1)).toBe(true);
    expect(isSwirlAddress(wallet.address, 137)).toBe(false);
    expect(isSwirlAddress(`0zk${wallet.address.slice(5)}`)).toBe(false);
    const damaged = `${wallet.address.slice(0, -1)}${wallet.address.endsWith('a') ? 'b' : 'a'}`;
    expect(isSwirlAddress(damaged)).toBe(false);
  });

  it('encrypts notes only for the recipient viewing key', async () => {
    const recipient = await createSwirlWallet(31337);
    const stranger = await createSwirlWallet(31337);
    const note = await createNoteForAddress({ address: recipient.address, token: TOKEN, amount: 9_975n, chainId: 31337 });
    const encrypted = encryptNote(note, recipient.address);
    expect(await decryptNote(encrypted, recipient.viewingSecretKey, bytesToBigint(recipient.noteSecretKey))).toEqual(note);
    expect(await decryptNote(encrypted, stranger.viewingSecretKey, bytesToBigint(stranger.noteSecretKey))).toBeNull();
    encrypted[encrypted.length - 1] ^= 1;
    expect(await decryptNote(encrypted, recipient.viewingSecretKey, bytesToBigint(recipient.noteSecretKey))).toBeNull();
  });

  it('builds real one/two-input Groth16 proofs and rejects invalid ownership or amounts', async () => {
    const alice = await createSwirlWallet(31337);
    const bob = await createSwirlWallet(31337);
    const aliceSecret = bytesToBigint(alice.noteSecretKey);
    const input = await createNoteForAddress({
      address: alice.address, token: TOKEN, amount: 9_975n, chainId: 31337, randomness: 777n,
    });
    const empty = zeroNote(0n);
    const tree = await SwirlMerkleTree.create(16, [await noteCommitment(empty), await noteCommitment(input)]);
    const outputA = await createNoteForAddress({
      address: bob.address, token: TOKEN, amount: 4_000n, chainId: 31337, randomness: 888n,
    });
    const outputB = await createNoteForAddress({
      address: alice.address, token: TOKEN, amount: 5_975n, chainId: 31337, randomness: 999n,
    });
    const proofInput = { note: { ...input, leafIndex: 1 }, merklePath: tree.path(1), ownerSecret: aliceSecret };
    const result = await createTransferProof({
      inputs: [proofInput], outputs: [outputA, outputB], zeroInputPath: tree.path(0),
      ciphertextHash: 12345n, chainId: 31337n, assets: { wasm: WASM, zkey: ZKEY },
    });
    expect(result.publicSignals).toHaveLength(12);
    expect(result.publicSignals[7]).toBe('12345');
    expect(result.outputCommitments).toHaveLength(4);
    const verificationKey = JSON.parse(await (await import('node:fs/promises')).readFile(VERIFICATION_KEY, 'utf8'));
    expect(await snarkjs.groth16.verify(verificationKey, result.publicSignals, result.proof)).toBe(true);
    const tamperedSignals = [...result.publicSignals];
    tamperedSignals[3] = (BigInt(tamperedSignals[3]) + 1n).toString();
    expect(await snarkjs.groth16.verify(verificationKey, tamperedSignals, result.proof)).toBe(false);
    const tamperedCiphertextHash = [...result.publicSignals];
    tamperedCiphertextHash[7] = (BigInt(tamperedCiphertextHash[7]) + 1n).toString();
    expect(await snarkjs.groth16.verify(verificationKey, tamperedCiphertextHash, result.proof)).toBe(false);

    const inputB = await createNoteForAddress({
      address: alice.address, token: TOKEN, amount: 1_995n, chainId: 31337, randomness: 778n,
    });
    const twoInputTree = await SwirlMerkleTree.create(16, [await noteCommitment(empty), await noteCommitment(input), await noteCommitment(inputB)]);
    const twoInputResult = await createTransferProof({
      inputs: [
        { note: { ...input, leafIndex: 1 }, merklePath: twoInputTree.path(1), ownerSecret: aliceSecret },
        { note: { ...inputB, leafIndex: 2 }, merklePath: twoInputTree.path(2), ownerSecret: aliceSecret },
      ],
      outputs: [outputA, { ...outputB, amount: 7_970n }], ciphertextHash: 12345n, chainId: 31337n, assets: { wasm: WASM, zkey: ZKEY },
    });
    expect(twoInputResult.nullifiers.every((value) => value > 0n)).toBe(true);
    expect(await snarkjs.groth16.verify(verificationKey, twoInputResult.publicSignals, twoInputResult.proof)).toBe(true);

    const forgedPath = { ...tree.path(1), pathElements: [...tree.path(1).pathElements] };
    forgedPath.pathElements[0] += 1n;
    await expect(createTransferProof({
      inputs: [{ ...proofInput, merklePath: forgedPath }], outputs: [outputA, outputB],
      zeroInputPath: tree.path(0), ciphertextHash: 12345n, chainId: 31337n, assets: { wasm: WASM, zkey: ZKEY },
    })).rejects.toThrow('Invalid Merkle path');
    await expect(createTransferProof({
      inputs: [{ ...proofInput, ownerSecret: bytesToBigint(bob.noteSecretKey) }], outputs: [outputA, outputB],
      zeroInputPath: tree.path(0), ciphertextHash: 12345n, chainId: 31337n, assets: { wasm: WASM, zkey: ZKEY },
    })).rejects.toThrow('Owner secret');
    await expect(createTransferProof({
      inputs: [proofInput], outputs: [outputA, { ...outputB, amount: 5_974n }],
      zeroInputPath: tree.path(0), ciphertextHash: 12345n, chainId: 31337n, assets: { wasm: WASM, zkey: ZKEY },
    })).rejects.toThrow('not conserved');
    await expect(createTransferProof({
      inputs: [proofInput], outputs: [outputA], publicAmount: 5_975n,
      zeroInputPath: tree.path(0), ciphertextHash: 12345n, chainId: 31337n, assets: { wasm: WASM, zkey: ZKEY },
    })).rejects.toThrow('recipient');
  }, 30_000);
});
