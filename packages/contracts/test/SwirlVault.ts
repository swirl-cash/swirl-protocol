import { expect } from "chai";
import { ethers } from "hardhat";
import { buildPoseidon } from "circomlibjs";
import * as snarkjs from "snarkjs";
import path from "node:path";

const DEPTH = 16;
const FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
const SECRET_A = 111111111111111111n;
const SECRET_B = 222222222222222222n;
const WASM = path.resolve("build/circuits/swirl_transfer_js/swirl_transfer.wasm");
const ZKEY = path.resolve("build/circuits/swirl_transfer_final.zkey");

describe("SwirlVault real Groth16 2x4 flow", function () {
  this.timeout(120_000);

  async function fixture() {
    const [depositor, treasury, recipient, relayer] = await ethers.getSigners();
    const poseidon = await buildPoseidon();
    const hash = (values: bigint[]) => poseidon.F.toObject(poseidon(values)) as bigint;
    const pair = (a: bigint, b: bigint) => hash([a, b]);
    const note = (owner: bigint, token: bigint, amount: bigint, randomness: bigint) => hash([owner, token, amount, randomness]);
    const ownerA = hash([SECRET_A]);
    const ownerB = hash([SECRET_B]);
    const zeroes: bigint[] = [0n];
    for (let i = 1; i < DEPTH; i++) zeroes.push(pair(zeroes[i - 1], zeroes[i - 1]));
    const pathFor = (leaves: bigint[], leafIndex: number) => {
      const pathElements: bigint[] = [];
      let level = leaves.slice();
      let index = leafIndex;
      for (let depth = 0; depth < DEPTH; depth++) {
        pathElements.push(level[index ^ 1] ?? zeroes[depth]);
        const next: bigint[] = [];
        for (let i = 0; i < level.length; i += 2) next.push(pair(level[i], level[i + 1] ?? zeroes[depth]));
        level = next;
        index = Math.floor(index / 2);
      }
      return pathElements;
    };
    const Token = await ethers.getContractFactory("SwirlTestToken");
    const token = await Token.deploy();
    const otherToken = await Token.deploy();
    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidonT3 = await PoseidonT3.deploy();
    const PoseidonT5 = await ethers.getContractFactory("PoseidonT5");
    const poseidonT5 = await PoseidonT5.deploy();
    const Vault = await ethers.getContractFactory("SwirlVault", {
      libraries: { PoseidonT3: poseidonT3.target, PoseidonT5: poseidonT5.target },
    });
    const vault = await Vault.deploy([token.target, otherToken.target], treasury.address, 25, verifier.target);
    const tokenField = BigInt(token.target as string);
    const otherTokenField = BigInt(otherToken.target as string);
    const zeroNote = note(0n, 0n, 0n, 0n);
    const emptyNote = note(0n, tokenField, 0n, 0n);
    expect(await vault.zeroNoteCommitment()).to.equal(ethers.toBeHex(zeroNote, 32));
    expect(await vault.nextLeafIndex()).to.equal(1);
    return { depositor, treasury, recipient, relayer, hash, note, ownerA, ownerB, pathFor, token, tokenField, otherToken, otherTokenField, vault, zeroNote, emptyNote };
  }

  async function prove(witness: Record<string, unknown>) {
    const result = await snarkjs.groth16.fullProve(witness, WASM, ZKEY);
    const call = JSON.parse(`[${await snarkjs.groth16.exportSolidityCallData(result.proof, result.publicSignals)}]`);
    return { proof: { a: call[0], b: call[1], c: call[2] }, publicSignals: result.publicSignals };
  }

  const ciphertextHash = (ciphertexts: string[]) => BigInt(ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(["bytes[4]"], [ciphertexts]),
  )) % FIELD;

  it("supports one real input, four outputs, unshield and double-spend rejection", async () => {
    const f = await fixture();
    const inputCommitment = f.note(f.ownerA, f.tokenField, 9_975n, 777n);
    await f.token.approve(f.vault.target, 10_000n);
    await expect(f.vault.shield(f.token.target, 10_000n, ethers.toBeHex(inputCommitment, 32), "0x1234",
      ethers.toBeHex(f.ownerA, 32), ethers.toBeHex(778n, 32))).to.be.revertedWithCustomError(f.vault, "InvalidCommitment");
    await expect(f.vault.shield(f.token.target, 10_000n, ethers.toBeHex(inputCommitment, 32), "0x1234",
      ethers.toBeHex(f.ownerA, 32), ethers.toBeHex(777n, 32)))
      .to.emit(f.vault, "Shielded").withArgs(1, ethers.toBeHex(inputCommitment, 32), "0x1234", 9_975n, 25n, ethers.toBeHex(f.ownerA, 32), f.token.target);
    const outputA = f.note(f.ownerB, f.tokenField, 4_000n, 888n);
    const outputB = f.note(f.ownerA, f.tokenField, 5_975n, 999n);
    const leaves = [f.zeroNote, inputCommitment];
    const root = BigInt(await f.vault.merkleRoot());
    const nullifiers = [f.hash([SECRET_A, 1n]), 0n];
    const outputs = [outputA, outputB, f.emptyNote, f.emptyNote];
    const transferCiphertexts = ["0xaaaa", "0xbbbb", "0x", "0x"];
    const witness = {
      root, nullifiers, outputCommitments: outputs, ciphertextHash: ciphertextHash(transferCiphertexts),
      publicAmount: 0n, publicRecipient: 0n, token: f.tokenField, chainId: 31337n,
      inputEnabled: [1, 0], inputOwner: [f.ownerA, 0n], inputOwnerSecret: [SECRET_A, 0n],
      inputAmount: [9_975n, 0n], inputRandomness: [777n, 0n], inputLeafIndex: [1, 0],
      pathElements: [f.pathFor(leaves, 1), f.pathFor(leaves, 0)],
      outputOwner: [f.ownerB, f.ownerA, 0n, 0n], outputAmount: [4_000n, 5_975n, 0n, 0n],
      outputRandomness: [888n, 999n, 0n, 0n],
    };
    const transfer = await prove(witness);
    await expect(f.vault.transact(transfer.proof, ethers.toBeHex(root, 32), nullifiers.map((v) => ethers.toBeHex(v, 32)),
      [ethers.toBeHex(outputA + 1n, 32), ...outputs.slice(1).map((v) => ethers.toBeHex(v, 32))],
      transferCiphertexts, 0, ethers.ZeroAddress, f.token.target)).to.be.revertedWithCustomError(f.vault, "InvalidProof");
    await expect(f.vault.connect(f.relayer).transact(transfer.proof, ethers.toBeHex(root, 32), nullifiers.map((v) => ethers.toBeHex(v, 32)),
      outputs.map((v) => ethers.toBeHex(v, 32)), ["0xaaab", "0xbbbb", "0x", "0x"], 0, ethers.ZeroAddress, f.token.target))
      .to.be.revertedWithCustomError(f.vault, "InvalidProof");
    await f.vault.transact(transfer.proof, ethers.toBeHex(root, 32), nullifiers.map((v) => ethers.toBeHex(v, 32)),
      outputs.map((v) => ethers.toBeHex(v, 32)), transferCiphertexts, 0, ethers.ZeroAddress, f.token.target);
    await expect(f.vault.transact(transfer.proof, ethers.toBeHex(root, 32), nullifiers.map((v) => ethers.toBeHex(v, 32)),
      outputs.map((v) => ethers.toBeHex(v, 32)), transferCiphertexts, 0, ethers.ZeroAddress, f.token.target))
      .to.be.revertedWithCustomError(f.vault, "DuplicateNullifier");

    const withdrawLeaves = [...leaves, ...outputs];
    const withdrawRoot = BigInt(await f.vault.merkleRoot());
    const withdrawNullifiers = [f.hash([SECRET_B, 2n]), 0n];
    const zeroOutputs = [f.emptyNote, f.emptyNote, f.emptyNote, f.emptyNote];
    const withdrawal = await prove({
      root: withdrawRoot, nullifiers: withdrawNullifiers, outputCommitments: zeroOutputs,
      ciphertextHash: ciphertextHash(["0x", "0x", "0x", "0x"]),
      publicAmount: 4_000n, publicRecipient: BigInt(f.recipient.address), token: f.tokenField, chainId: 31337n,
      inputEnabled: [1, 0], inputOwner: [f.ownerB, 0n], inputOwnerSecret: [SECRET_B, 0n],
      inputAmount: [4_000n, 0n], inputRandomness: [888n, 0n], inputLeafIndex: [2, 0],
      pathElements: [f.pathFor(withdrawLeaves, 2), f.pathFor(withdrawLeaves, 0)],
      outputOwner: [0n, 0n, 0n, 0n], outputAmount: [0n, 0n, 0n, 0n], outputRandomness: [0n, 0n, 0n, 0n],
    });
    const withdrawalArgs = [
      withdrawal.proof, ethers.toBeHex(withdrawRoot, 32), withdrawNullifiers.map((v) => ethers.toBeHex(v, 32)),
      zeroOutputs.map((v) => ethers.toBeHex(v, 32)), ["0x", "0x", "0x", "0x"],
    ] as const;
    // A relayer can submit, but cannot redirect or enlarge the withdrawal.
    await expect(f.vault.connect(f.relayer).transact(...withdrawalArgs, 4_000n, f.relayer.address, f.token.target))
      .to.be.revertedWithCustomError(f.vault, "InvalidProof");
    await expect(f.vault.connect(f.relayer).transact(...withdrawalArgs, 4_001n, f.recipient.address, f.token.target))
      .to.be.revertedWithCustomError(f.vault, "InvalidProof");
    expect(await f.vault.nullifiers(ethers.toBeHex(withdrawNullifiers[0], 32))).to.equal(false);
    expect(await f.vault.merkleRoot()).to.equal(ethers.toBeHex(withdrawRoot, 32));
    expect(await f.vault.nextLeafIndex()).to.equal(6);
    expect(await f.token.balanceOf(f.relayer.address)).to.equal(0);

    await f.vault.connect(f.relayer).transact(...withdrawalArgs, 4_000n, f.recipient.address, f.token.target);
    expect(await f.token.balanceOf(f.recipient.address)).to.equal(3_990n);
    expect(await f.token.balanceOf(f.treasury.address)).to.equal(35n);
    expect(await f.token.balanceOf(f.vault.target)).to.equal(5_975n);
    expect(await f.vault.nextLeafIndex()).to.equal(10);
    await expect(f.vault.connect(f.relayer).transact(...withdrawalArgs, 4_000n, f.recipient.address, f.token.target))
      .to.be.revertedWithCustomError(f.vault, "DuplicateNullifier");
  });

  it("spends two inputs in one proof and accepts a third-party relayer", async () => {
    const f = await fixture();
    const inputA = f.note(f.ownerA, f.tokenField, 9_975n, 777n);
    const inputB = f.note(f.ownerA, f.tokenField, 1_995n, 778n);
    await f.token.approve(f.vault.target, 12_000n);
    await f.vault.shield(f.token.target, 10_000n, ethers.toBeHex(inputA, 32), "0x1234",
      ethers.toBeHex(f.ownerA, 32), ethers.toBeHex(777n, 32));
    await f.vault.shield(f.token.target, 2_000n, ethers.toBeHex(inputB, 32), "0x5678",
      ethers.toBeHex(f.ownerA, 32), ethers.toBeHex(778n, 32));
    const outputA = f.note(f.ownerB, f.tokenField, 4_000n, 888n);
    const outputB = f.note(f.ownerA, f.tokenField, 7_970n, 999n);
    const outputs = [outputA, outputB, f.emptyNote, f.emptyNote];
    const leaves = [f.zeroNote, inputA, inputB];
    const root = BigInt(await f.vault.merkleRoot());
    const nullifiers = [f.hash([SECRET_A, 1n]), f.hash([SECRET_A, 2n])];
    const transfer = await prove({
      root, nullifiers, outputCommitments: outputs,
      ciphertextHash: ciphertextHash(["0xaaaa", "0xbbbb", "0x", "0x"]),
      publicAmount: 0n, publicRecipient: 0n, token: f.tokenField, chainId: 31337n,
      inputEnabled: [1, 1], inputOwner: [f.ownerA, f.ownerA], inputOwnerSecret: [SECRET_A, SECRET_A],
      inputAmount: [9_975n, 1_995n], inputRandomness: [777n, 778n], inputLeafIndex: [1, 2],
      pathElements: [f.pathFor(leaves, 1), f.pathFor(leaves, 2)],
      outputOwner: [f.ownerB, f.ownerA, 0n, 0n], outputAmount: [4_000n, 7_970n, 0n, 0n],
      outputRandomness: [888n, 999n, 0n, 0n],
    });
    await f.vault.connect(f.relayer).transact(transfer.proof, ethers.toBeHex(root, 32), nullifiers.map((v) => ethers.toBeHex(v, 32)),
      outputs.map((v) => ethers.toBeHex(v, 32)), ["0xaaaa", "0xbbbb", "0x", "0x"], 0, ethers.ZeroAddress, f.token.target);
    expect(await f.vault.nullifiers(ethers.toBeHex(nullifiers[0], 32))).to.equal(true);
    expect(await f.vault.nullifiers(ethers.toBeHex(nullifiers[1], 32))).to.equal(true);
    expect(await f.vault.nextLeafIndex()).to.equal(7);
    expect(await f.token.balanceOf(f.vault.target)).to.equal(11_970n);
  });

  it("shares one UTXO tree across assets while binding every proof to its token", async () => {
    const f = await fixture();
    const inputA = f.note(f.ownerA, f.tokenField, 9_975n, 111n);
    const inputB = f.note(f.ownerA, f.otherTokenField, 1_995n, 222n);
    await f.token.approve(f.vault.target, 10_000n);
    await f.otherToken.approve(f.vault.target, 2_000n);
    await f.vault.shield(f.token.target, 10_000n, ethers.toBeHex(inputA, 32), "0x11",
      ethers.toBeHex(f.ownerA, 32), ethers.toBeHex(111n, 32));
    await f.vault.shield(f.otherToken.target, 2_000n, ethers.toBeHex(inputB, 32), "0x22",
      ethers.toBeHex(f.ownerA, 32), ethers.toBeHex(222n, 32));

    const Unsupported = await ethers.getContractFactory("SwirlTestToken");
    const unsupported = await Unsupported.deploy();
    await expect(f.vault.shield(unsupported.target, 10_000n, ethers.toBeHex(inputA, 32), "0x11",
      ethers.toBeHex(f.ownerA, 32), ethers.toBeHex(111n, 32))).to.be.revertedWithCustomError(f.vault, "UnsupportedToken");

    const outputA = f.note(f.ownerB, f.tokenField, 9_975n, 333n);
    const outputsA = [outputA, f.emptyNote, f.emptyNote, f.emptyNote];
    const rootA = BigInt(await f.vault.merkleRoot());
    const nullifierA = [f.hash([SECRET_A, 1n]), 0n];
    const proofA = await prove({
      root: rootA, nullifiers: nullifierA, outputCommitments: outputsA,
      ciphertextHash: ciphertextHash(["0xaa", "0x", "0x", "0x"]), publicAmount: 0n, publicRecipient: 0n,
      token: f.tokenField, chainId: 31337n, inputEnabled: [1, 0], inputOwner: [f.ownerA, 0n],
      inputOwnerSecret: [SECRET_A, 0n], inputAmount: [9_975n, 0n], inputRandomness: [111n, 0n],
      inputLeafIndex: [1, 0], pathElements: [f.pathFor([f.zeroNote, inputA, inputB], 1), f.pathFor([f.zeroNote, inputA, inputB], 0)],
      outputOwner: [f.ownerB, 0n, 0n, 0n], outputAmount: [9_975n, 0n, 0n, 0n], outputRandomness: [333n, 0n, 0n, 0n],
    });
    const argsA = [proofA.proof, ethers.toBeHex(rootA, 32), nullifierA.map((value) => ethers.toBeHex(value, 32)),
      outputsA.map((value) => ethers.toBeHex(value, 32)), ["0xaa", "0x", "0x", "0x"], 0, ethers.ZeroAddress] as const;
    await expect(f.vault.transact(...argsA, f.otherToken.target)).to.be.revertedWithCustomError(f.vault, "InvalidProof");
    await f.vault.transact(...argsA, f.token.target);

    const emptyB = f.note(0n, f.otherTokenField, 0n, 0n);
    const outputB = f.note(f.ownerB, f.otherTokenField, 1_995n, 444n);
    const outputsB = [outputB, emptyB, emptyB, emptyB];
    const leavesB = [f.zeroNote, inputA, inputB, ...outputsA];
    const rootB = BigInt(await f.vault.merkleRoot());
    const nullifierB = [f.hash([SECRET_A, 2n]), 0n];
    const proofB = await prove({
      root: rootB, nullifiers: nullifierB, outputCommitments: outputsB,
      ciphertextHash: ciphertextHash(["0xbb", "0x", "0x", "0x"]), publicAmount: 0n, publicRecipient: 0n,
      token: f.otherTokenField, chainId: 31337n, inputEnabled: [1, 0], inputOwner: [f.ownerA, 0n],
      inputOwnerSecret: [SECRET_A, 0n], inputAmount: [1_995n, 0n], inputRandomness: [222n, 0n],
      inputLeafIndex: [2, 0], pathElements: [f.pathFor(leavesB, 2), f.pathFor(leavesB, 0)],
      outputOwner: [f.ownerB, 0n, 0n, 0n], outputAmount: [1_995n, 0n, 0n, 0n], outputRandomness: [444n, 0n, 0n, 0n],
    });
    await f.vault.transact(proofB.proof, ethers.toBeHex(rootB, 32), nullifierB.map((value) => ethers.toBeHex(value, 32)),
      outputsB.map((value) => ethers.toBeHex(value, 32)), ["0xbb", "0x", "0x", "0x"], 0, ethers.ZeroAddress, f.otherToken.target);
    expect(await f.vault.nextLeafIndex()).to.equal(11);
    expect(await f.token.balanceOf(f.vault.target)).to.equal(9_975n);
    expect(await f.otherToken.balanceOf(f.vault.target)).to.equal(1_995n);
  });
});
