import { expect } from "chai";
import { ethers } from "hardhat";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  bytesToBigint, createNoteForAddress, createSwirlWallet, createTransferProof,
  encryptNote, noteCommitment, recoverWalletNotes,
} from "@swirl/wallet";
import { PPOICore, SwirlListProvider, VaultPPOISync, createEventSigner, publicKeyFromSecret } from "@swirl/poi";

const MNEMONIC = "test test test test test test test test test test test junk";
const LIST_SECRET = "11".repeat(32);
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const WASM = path.resolve("build/circuits/swirl_transfer_js/swirl_transfer.wasm");
const ZKEY = path.resolve("build/circuits/swirl_transfer_final.zkey");
const POI_VKEY = path.resolve("build/circuits/swirl_poi_verification_key.json");
const ciphertextHash = (ciphertexts: [string, string, string, string]) => BigInt(ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(["bytes[4]"], [ciphertexts]),
)) % FIELD;

describe("Shared-vault PPOI chain synchronization", function () {
  this.timeout(120_000);

  it("indexes new Shield events and preserves the token on each multi-asset transaction", async () => {
    const [depositor, treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("SwirlTestToken");
    const tokenA = await Token.deploy();
    const tokenB = await Token.deploy();
    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidonT3 = await PoseidonT3.deploy();
    const PoseidonT5 = await ethers.getContractFactory("PoseidonT5");
    const poseidonT5 = await PoseidonT5.deploy();
    const Vault = await ethers.getContractFactory("SwirlVault", {
      libraries: { PoseidonT3: poseidonT3.target, PoseidonT5: poseidonT5.target },
    });
    const vault = await Vault.deploy([tokenA.target, tokenB.target], treasury.address, 25, verifier.target);
    const { chainId } = await ethers.provider.getNetwork();
    const alice = await createSwirlWallet(Number(chainId), MNEMONIC);
    const bob = await createSwirlWallet(Number(chainId));

    for (const [token, gross, randomness] of [[tokenA, 10_000n, 777n], [tokenB, 2_000n, 778n]] as const) {
      const amount = gross * 9_975n / 10_000n;
      const note = await createNoteForAddress({
        address: alice.address, token: BigInt(token.target as string), amount,
        chainId: Number(chainId), randomness,
      });
      await token.approve(vault.target, gross);
      await vault.shield(token.target, gross, ethers.toBeHex(await noteCommitment(note), 32),
        ethers.hexlify(encryptNote(note, alice.address)), ethers.toBeHex(note.owner, 32), ethers.toBeHex(note.randomness, 32));
    }

    const core = await PPOICore.create({
      chainId, vault: vault.target as string, listKey: publicKeyFromSecret(LIST_SECRET),
      signMessage: createEventSigner(LIST_SECRET), verificationKey: JSON.parse(await readFile(POI_VKEY, "utf8")),
      listProvider: new SwirlListProvider({ mode: "local-test", blockedAddresses: [] }), shieldPendingSeconds: 0,
    });
    const sync = new VaultPPOISync(ethers.provider, vault.target as string, core, 0, 500, 0);
    await sync.sync();
    // Hardhat's deterministic test clock may be ahead of the host clock.
    await core.processShields(Number.MAX_SAFE_INTEGER);
    expect(core.stats.shields).to.equal(2);
    expect(core.stats.poiEvents).to.equal(2);
    expect(core.stats.pendingShields).to.equal(0);

    async function transfer(token: typeof tokenA) {
      const state = await recoverWalletNotes({ provider: ethers.provider, wallet: alice, vaultAddress: vault.target as string });
      const recovered = state.notes.find((item) => !item.spent && item.note.token === BigInt(token.target as string));
      expect(recovered).not.to.equal(undefined);
      const output = await createNoteForAddress({
        address: bob.address, token: BigInt(token.target as string), amount: recovered!.note.amount,
        chainId: Number(chainId), randomness: 999n,
      });
      const ciphertexts: [string, string, string, string] = [ethers.hexlify(encryptNote(output, bob.address)), "0x", "0x", "0x"];
      const proof = await createTransferProof({
        inputs: [{ note: recovered!.note, merklePath: state.tree.path(recovered!.note.leafIndex), ownerSecret: bytesToBigint(alice.noteSecretKey) }],
        outputs: [output], zeroInputPath: state.tree.path(0), ciphertextHash: ciphertextHash(ciphertexts), chainId,
        assets: { wasm: WASM, zkey: ZKEY },
      });
      await vault.connect(depositor).transact(proof.solidity, ethers.toBeHex(proof.root, 32),
        proof.nullifiers.map((value) => ethers.toBeHex(value, 32)),
        proof.outputCommitments.map((value) => ethers.toBeHex(value, 32)), ciphertexts, 0, ethers.ZeroAddress, token.target);
      await sync.sync();
    }

    await transfer(tokenA);
    await transfer(tokenB);
    expect(core.stats.transactions).to.equal(2);
    expect(core.state.transactions.map((item) => ethers.getAddress(ethers.toBeHex(BigInt(item.token), 20)))).to.deep.equal([
      ethers.getAddress(tokenA.target as string), ethers.getAddress(tokenB.target as string),
    ]);
  });
});
