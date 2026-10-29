import { expect } from "chai";
import { ethers } from "hardhat";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import path from "node:path";

const DEPTH = 16;
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SECRET = 111111111111111111n;
const WASM = path.resolve("build/circuits/swirl_transfer_js/swirl_transfer.wasm");
const ZKEY = path.resolve("build/circuits/swirl_transfer_final.zkey");

const ciphertextHash = (ciphertexts: string[]) => BigInt(ethers.keccak256(
  ethers.AbiCoder.defaultAbiCoder().encode(["bytes[4]"], [ciphertexts]),
)) % FIELD;

describe("SwirlNativeGateway real native-asset flow", function () {
  this.timeout(120_000);

  it("shields native value, binds the final recipient and rejects replay", async () => {
    const [depositor, treasury, recipient, relayer, attacker] = await ethers.getSigners();
    const poseidon = await buildPoseidon();
    const hash = (values: bigint[]) => poseidon.F.toObject(poseidon(values)) as bigint;
    const note = (owner: bigint, token: bigint, amount: bigint, randomness: bigint) => hash([owner, token, amount, randomness]);
    const owner = hash([SECRET]);
    const zeroes: bigint[] = [0n];
    for (let i = 1; i < DEPTH; i++) zeroes.push(hash([zeroes[i - 1], zeroes[i - 1]]));
    const pathFor = (leaves: bigint[], leafIndex: number) => {
      const elements: bigint[] = [];
      let level = leaves.slice();
      let index = leafIndex;
      for (let depth = 0; depth < DEPTH; depth++) {
        elements.push(level[index ^ 1] ?? zeroes[depth]);
        const next: bigint[] = [];
        for (let i = 0; i < level.length; i += 2) next.push(hash([level[i], level[i + 1] ?? zeroes[depth]]));
        level = next;
        index = Math.floor(index / 2);
      }
      return elements;
    };

    const Wrapped = await ethers.getContractFactory("SwirlTestWrappedNative");
    const wrapped = await Wrapped.deploy();
    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidonT3 = await PoseidonT3.deploy();
    const PoseidonT5 = await ethers.getContractFactory("PoseidonT5");
    const poseidonT5 = await PoseidonT5.deploy();
    const Vault = await ethers.getContractFactory("SwirlVault", {
      libraries: { PoseidonT3: poseidonT3.target, PoseidonT5: poseidonT5.target },
    });
    const vault = await Vault.deploy([wrapped.target], treasury.address, 25, verifier.target);
    const Gateway = await ethers.getContractFactory("SwirlNativeGateway");
    const gateway = await Gateway.deploy(vault.target, wrapped.target);
    expect(await wrapped.allowance(gateway.target, vault.target)).to.equal(ethers.MaxUint256);
    await expect(Gateway.deploy(vault.target, attacker.address)).to.be.revertedWithCustomError(gateway, "InvalidVault");

    const tokenField = BigInt(wrapped.target as string);
    const gross = ethers.parseEther("1");
    const shieldFee = gross * 25n / 10_000n;
    const net = gross - shieldFee;
    const commitment = note(owner, tokenField, net, 777n);
    const zeroNote = note(0n, 0n, 0n, 0n);
    const emptyNote = note(0n, tokenField, 0n, 0n);
    await gateway.connect(depositor).shieldNative(ethers.toBeHex(commitment, 32), "0x1234",
      ethers.toBeHex(owner, 32), ethers.toBeHex(777n, 32), { value: gross });
    expect(await wrapped.balanceOf(vault.target)).to.equal(net);
    expect(await wrapped.balanceOf(treasury.address)).to.equal(shieldFee);
    expect(await wrapped.balanceOf(gateway.target)).to.equal(0);
    expect(await ethers.provider.getBalance(gateway.target)).to.equal(0);

    const root = BigInt(await vault.merkleRoot());
    const nullifiers = [hash([SECRET, 1n]), 0n];
    const outputs = [emptyNote, emptyNote, emptyNote, emptyNote];
    const encodedRecipient = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [recipient.address]);
    const ciphertexts = [encodedRecipient, "0x", "0x", "0x"];
    const result = await snarkjs.groth16.fullProve({
      root, nullifiers, outputCommitments: outputs, ciphertextHash: ciphertextHash(ciphertexts),
      publicAmount: net, publicRecipient: BigInt(gateway.target as string), token: tokenField, chainId: 31337n,
      inputEnabled: [1, 0], inputOwner: [owner, 0n], inputOwnerSecret: [SECRET, 0n],
      inputAmount: [net, 0n], inputRandomness: [777n, 0n], inputLeafIndex: [1, 0],
      pathElements: [pathFor([zeroNote, commitment], 1), pathFor([zeroNote, commitment], 0)],
      outputOwner: [0n, 0n, 0n, 0n], outputAmount: [0n, 0n, 0n, 0n], outputRandomness: [0n, 0n, 0n, 0n],
    }, WASM, ZKEY);
    const call = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(result.proof, result.publicSignals)}]`);
    const proof = { a: call[0], b: call[1], c: call[2] };
    const args = [proof, ethers.toBeHex(root, 32), nullifiers.map((value) => ethers.toBeHex(value, 32)),
      outputs.map((value) => ethers.toBeHex(value, 32))] as const;

    const encodedAttacker = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [attacker.address]);
    await expect(gateway.connect(relayer).unshieldNative(...args, [encodedAttacker, "0x", "0x", "0x"], net))
      .to.be.revertedWithCustomError(vault, "InvalidProof");
    await expect(gateway.connect(relayer).unshieldNative(...args, [ethers.ZeroHash, "0x", "0x", "0x"], net))
      .to.be.revertedWithCustomError(gateway, "InvalidNativeRecipient");
    expect(await vault.nullifiers(ethers.toBeHex(nullifiers[0], 32))).to.equal(false);

    const withdrawFee = net * 25n / 10_000n;
    const nativeOut = net - withdrawFee;
    await expect(() => gateway.connect(relayer).unshieldNative(...args, ciphertexts, net))
      .to.changeEtherBalances([recipient], [nativeOut]);
    expect(await wrapped.balanceOf(treasury.address)).to.equal(shieldFee + withdrawFee);
    expect(await wrapped.balanceOf(vault.target)).to.equal(0);
    expect(await wrapped.balanceOf(gateway.target)).to.equal(0);
    expect(await ethers.provider.getBalance(gateway.target)).to.equal(0);
    expect(await wrapped.balanceOf(attacker.address)).to.equal(0);
    await expect(gateway.connect(relayer).unshieldNative(...args, ciphertexts, net))
      .to.be.revertedWithCustomError(vault, "DuplicateNullifier");
  });
});
