import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as snarkjs from 'snarkjs';
import {
  blindedCommitment,
  bytesToBigint,
  createNoteForAddress,
  createPOIProof,
  createSwirlWallet,
  hex32,
  noteCommitment,
  zeroNote,
} from '@swirl/wallet';
import { PPOICore } from './core.js';
import { SwirlListProvider } from './list-provider.js';
import { createEventSigner, publicKeyFromSecret, verifySignedPOIEvent } from './signer.js';

const WASM = fileURLToPath(new URL('../../contracts/build/circuits/swirl_poi_js/swirl_poi.wasm', import.meta.url));
const ZKEY = fileURLToPath(new URL('../../contracts/build/circuits/swirl_poi_final.zkey', import.meta.url));
const VKEY = fileURLToPath(new URL('../../contracts/build/circuits/swirl_poi_verification_key.json', import.meta.url));
const TOKEN = 0x1234567890123456789012345678901234567890n;
const VAULT = '0x9999999999999999999999999999999999999999';

describe('SWIRL PPOI end-to-end proof flow', () => {
  it('screens shields, proves a confirmed transaction and inherits POI to outputs', async () => {
    const alice = await createSwirlWallet(31337);
    const bob = await createSwirlWallet(31337);
    const privateKey = randomBytes(32).toString('hex');
    const listKey = publicKeyFromSecret(privateKey);
    const blockedAddress = '0x00000000000000000000000000000000000000aa';
    const core = await PPOICore.create({
      chainId: 31337n,
      vault: VAULT,
      listKey,
      signMessage: createEventSigner(privateKey),
      verificationKey: JSON.parse(await readFile(VKEY, 'utf8')),
      listProvider: new SwirlListProvider({ mode: 'local-test', blockedAddresses: [blockedAddress] }),
      shieldPendingSeconds: 60,
    });
    const input = await createNoteForAddress({ address: alice.address, token: TOKEN, amount: 9_975n, chainId: 31337, randomness: 777n });
    const shield = await core.queueShield({
      transactionHash: hex32(1n), blockNumber: 1, logIndex: 0, leafIndex: 1,
      commitment: hex32(await noteCommitment(input)), owner: hex32(input.owner),
      from: '0x0000000000000000000000000000000000000011', timestamp: 100,
    });
    await core.processShields(159);
    expect(core.status(shield.blindedCommitment)).toBe('ShieldPending');
    await core.processShields(160);
    expect(core.status(shield.blindedCommitment)).toBe('Valid');
    expect(await verifySignedPOIEvent(core.state.events[0], listKey)).toBe(true);

    const outputA = await createNoteForAddress({ address: bob.address, token: TOKEN, amount: 4_000n, chainId: 31337, randomness: 888n });
    const outputB = await createNoteForAddress({ address: alice.address, token: TOKEN, amount: 5_975n, chainId: 31337, randomness: 999n });
    const empty = zeroNote(TOKEN);
    const outputs = [outputA, outputB, empty, empty];
    const outputCommitments = await Promise.all(outputs.map(noteCommitment)) as [bigint, bigint, bigint, bigint];
    const transaction = await core.appendTransaction({
      transactionHash: hex32(2n), blockNumber: 2, logIndex: 0,
      nullifiers: [hex32(123n), hex32(0n)],
      outputCommitments: outputCommitments.map(hex32) as [string, string, string, string],
      ciphertextHash: hex32(12_345n), publicAmount: '0', publicRecipient: hex32(0n),
      token: hex32(TOKEN), chainId: '31337', firstLeafIndex: 2,
    });
    // Use the actual owner-secret nullifier rather than the placeholder above.
    const { noteNullifier } = await import('@swirl/wallet');
    const realNullifier = await noteNullifier(bytesToBigint(alice.noteSecretKey), 1);
    expect(realNullifier).not.toBe(123n);

    // Rebuild the isolated fixture with the correct confirmed nullifier.
    const clean = await PPOICore.create({
      chainId: 31337n, vault: VAULT, listKey, signMessage: createEventSigner(privateKey),
      verificationKey: JSON.parse(await readFile(VKEY, 'utf8')),
      listProvider: new SwirlListProvider({ mode: 'local-test', blockedAddresses: [blockedAddress] }),
      shieldPendingSeconds: 60,
    });
    const cleanShield = await clean.queueShield({
      transactionHash: hex32(1n), blockNumber: 1, logIndex: 0, leafIndex: 1,
      commitment: hex32(await noteCommitment(input)), owner: hex32(input.owner),
      from: '0x0000000000000000000000000000000000000011', timestamp: 100,
    });
    await clean.processShields(160);
    const confirmed = await clean.appendTransaction({
      transactionHash: hex32(2n), blockNumber: 2, logIndex: 0,
      nullifiers: [hex32(realNullifier), hex32(0n)],
      outputCommitments: outputCommitments.map(hex32) as [string, string, string, string],
      ciphertextHash: hex32(12_345n), publicAmount: '0', publicRecipient: hex32(0n),
      token: hex32(TOKEN), chainId: '31337', firstLeafIndex: 2,
    });
    const poiPath = clean.getPOIMerkleProof(cleanShield.blindedCommitment);
    const result = await createPOIProof({
      inputs: [{ note: { ...input, leafIndex: 1 }, ownerSecret: bytesToBigint(alice.noteSecretKey), poiMerklePath: poiPath }],
      outputs: [outputA, outputB],
      transaction: {
        nullifiers: [realNullifier, 0n], outputCommitments, ciphertextHash: 12_345n,
        publicAmount: 0n, publicRecipient: 0n, token: TOKEN, chainId: 31337n,
        firstLeafIndex: 2, txidMerklePath: clean.getTxidMerkleProof(confirmed.txid),
      },
      assets: { wasm: WASM, zkey: ZKEY },
    });
    expect(result.txid).toBe(confirmed.txid);
    expect(await snarkjs.groth16.verify(JSON.parse(await readFile(VKEY, 'utf8')), result.publicSignals, result.proof)).toBe(true);
    const added = await clean.submitProof(result);
    expect(added).toHaveLength(2);
    expect(added.every((event) => event.type === 'Transact')).toBe(true);
    for (const blinded of result.blindedCommitmentsOut.filter((value) => BigInt(value) !== 0n)) {
      expect(clean.status(blinded)).toBe('Valid');
      expect(clean.getPOIMerkleProof(blinded).pathElements).toHaveLength(16);
    }
    const outputBlinded = await blindedCommitment(outputCommitments[0], outputA.owner, 2);
    expect(result.blindedCommitmentsOut[0]).toBe(hex32(outputBlinded));

    const blocked = await clean.queueShield({
      transactionHash: hex32(3n), blockNumber: 3, logIndex: 0, leafIndex: 6,
      commitment: hex32(await noteCommitment({ ...input, randomness: 1001n })), owner: hex32(input.owner),
      from: blockedAddress, timestamp: 200,
    });
    await clean.processShields(260);
    expect(clean.status(blocked.blindedCommitment)).toBe('ShieldBlocked');
    expect(() => clean.getPOIMerkleProof(blocked.blindedCommitment)).toThrow('No valid POI');

    const restored = await PPOICore.create({
      chainId: 31337n, vault: VAULT, listKey, signMessage: createEventSigner(privateKey),
      verificationKey: JSON.parse(await readFile(VKEY, 'utf8')),
      listProvider: new SwirlListProvider({ mode: 'local-test' }), persisted: clean.state,
    });
    expect(restored.state.events.map((event) => event.merkleRoot)).toEqual(clean.state.events.map((event) => event.merkleRoot));
    expect(restored.getTxidMerkleProof(confirmed.txid).root).toBe(clean.getTxidMerkleProof(confirmed.txid).root);

    await expect(clean.submitProof({ ...result, publicSignals: [...result.publicSignals] })).rejects.toThrow('already exists');
    const tamperedSignals = [...result.publicSignals];
    tamperedSignals[0] = (BigInt(tamperedSignals[0]) + 1n).toString();
    expect(await snarkjs.groth16.verify(JSON.parse(await readFile(VKEY, 'utf8')), tamperedSignals, result.proof)).toBe(false);
  }, 120_000);

  it('proves two inputs and an unshield, and rejects unknown roots and tampered proofs', async () => {
    const alice = await createSwirlWallet(31337);
    const bob = await createSwirlWallet(31337);
    const privateKey = randomBytes(32).toString('hex');
    const listKey = publicKeyFromSecret(privateKey);
    const verificationKey = JSON.parse(await readFile(VKEY, 'utf8'));
    const core = await PPOICore.create({
      chainId: 31337n, vault: VAULT, listKey, signMessage: createEventSigner(privateKey), verificationKey,
      listProvider: new SwirlListProvider({ mode: 'local-test' }), shieldPendingSeconds: 60,
    });
    const { noteNullifier } = await import('@swirl/wallet');
    const inputA = await createNoteForAddress({ address: alice.address, token: TOKEN, amount: 5_000n, chainId: 31337, randomness: 111n });
    const inputB = await createNoteForAddress({ address: bob.address, token: TOKEN, amount: 7_000n, chainId: 31337, randomness: 222n });
    const inputs = [inputA, inputB];
    for (let index = 0; index < inputs.length; index++) {
      await core.queueShield({
        transactionHash: hex32(BigInt(index + 10)), blockNumber: 1, logIndex: index, leafIndex: index + 1,
        commitment: hex32(await noteCommitment(inputs[index])), owner: hex32(inputs[index].owner),
        from: `0x00000000000000000000000000000000000000${index + 11}`, timestamp: 100,
      });
    }
    await core.processShields(160);

    const outputA = await createNoteForAddress({ address: bob.address, token: TOKEN, amount: 9_000n, chainId: 31337, randomness: 333n });
    const outputB = await createNoteForAddress({ address: alice.address, token: TOKEN, amount: 3_000n, chainId: 31337, randomness: 444n });
    const empty = zeroNote(TOKEN);
    const outputs = [outputA, outputB, empty, empty];
    const outputCommitments = await Promise.all(outputs.map(noteCommitment)) as [bigint, bigint, bigint, bigint];
    const nullifiers = await Promise.all([
      noteNullifier(bytesToBigint(alice.noteSecretKey), 1),
      noteNullifier(bytesToBigint(bob.noteSecretKey), 2),
    ]) as [bigint, bigint];
    const transaction = await core.appendTransaction({
      transactionHash: hex32(20n), blockNumber: 2, logIndex: 0, nullifiers: nullifiers.map(hex32) as [string, string],
      outputCommitments: outputCommitments.map(hex32) as [string, string, string, string],
      ciphertextHash: hex32(55n), publicAmount: '0', publicRecipient: hex32(0n),
      token: hex32(TOKEN), chainId: '31337', firstLeafIndex: 3,
    });
    const result = await createPOIProof({
      inputs: [
        { note: { ...inputA, leafIndex: 1 }, ownerSecret: bytesToBigint(alice.noteSecretKey), poiMerklePath: core.getPOIMerkleProof(hex32(await blindedCommitment(await noteCommitment(inputA), inputA.owner, 1))) },
        { note: { ...inputB, leafIndex: 2 }, ownerSecret: bytesToBigint(bob.noteSecretKey), poiMerklePath: core.getPOIMerkleProof(hex32(await blindedCommitment(await noteCommitment(inputB), inputB.owner, 2))) },
      ],
      outputs: [outputA, outputB],
      transaction: {
        nullifiers, outputCommitments, ciphertextHash: 55n, publicAmount: 0n, publicRecipient: 0n,
        token: TOKEN, chainId: 31337n, firstLeafIndex: 3, txidMerklePath: core.getTxidMerkleProof(transaction.txid),
      },
      assets: { wasm: WASM, zkey: ZKEY },
    });
    expect(await core.submitProof(result)).toHaveLength(2);

    const unshieldNullifier = await noteNullifier(bytesToBigint(bob.noteSecretKey), 3);
    const zeroCommitments = [empty, empty, empty, empty].map(() => empty) as typeof outputs;
    const zeroOutputCommitments = await Promise.all(zeroCommitments.map(noteCommitment)) as [bigint, bigint, bigint, bigint];
    const unshieldTransaction = await core.appendTransaction({
      transactionHash: hex32(21n), blockNumber: 3, logIndex: 0,
      nullifiers: [hex32(unshieldNullifier), hex32(0n)], outputCommitments: zeroOutputCommitments.map(hex32) as [string, string, string, string],
      ciphertextHash: hex32(56n), publicAmount: '9000', publicRecipient: hex32(0x4444n),
      token: hex32(TOKEN), chainId: '31337', firstLeafIndex: 7,
    });
    // Advance the TXID tree after the transaction being proven. The prover must
    // be able to use a later historical root, not only the root at insertion.
    await core.appendTransaction({
      transactionHash: hex32(22n), blockNumber: 4, logIndex: 0,
      nullifiers: [hex32(0n), hex32(0n)], outputCommitments: zeroOutputCommitments.map(hex32) as [string, string, string, string],
      ciphertextHash: hex32(57n), publicAmount: '0', publicRecipient: hex32(0n),
      token: hex32(TOKEN), chainId: '31337', firstLeafIndex: 11,
    });
    const unshield = await createPOIProof({
      inputs: [{
        note: { ...outputA, leafIndex: 3 }, ownerSecret: bytesToBigint(bob.noteSecretKey),
        poiMerklePath: core.getPOIMerkleProof(result.blindedCommitmentsOut[0]),
      }],
      outputs: [empty],
      transaction: {
        nullifiers: [unshieldNullifier, 0n], outputCommitments: zeroOutputCommitments, ciphertextHash: 56n,
        publicAmount: 9_000n, publicRecipient: 0x4444n, token: TOKEN, chainId: 31337n,
        firstLeafIndex: 7, txidMerklePath: core.getTxidMerkleProof(unshieldTransaction.txid),
      },
      assets: { wasm: WASM, zkey: ZKEY },
    });
    const unshieldEvents = await core.submitProof(unshield);
    expect(unshieldEvents).toHaveLength(1);
    expect(unshieldEvents[0].type).toBe('Unshield');
    expect(core.status(unshield.txidIfHasUnshield)).toBe('Valid');

    const unknownRootSignals = [...unshield.publicSignals];
    unknownRootSignals[6] = '1';
    await expect(core.submitProof({ ...unshield, publicSignals: unknownRootSignals, poiMerkleRoots: [hex32(1n), hex32(0n)] }))
      .rejects.toThrow('Unknown historical POI Merkle root');
    const tamperedProof = structuredClone(unshield.proof);
    tamperedProof.pi_a[0] = (BigInt(tamperedProof.pi_a[0]) + 1n).toString();
    await expect(core.submitProof({ ...unshield, proof: tamperedProof })).rejects.toThrow('Invalid PPOI Groth16 proof');
  }, 120_000);
});
