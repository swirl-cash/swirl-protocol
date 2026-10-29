import { expect } from "chai";
import { ethers } from "hardhat";
import path from "node:path";
import {
  createNoteForAddress, createSwirlWallet, encryptNote, noteCommitment,
  recoverWalletNotes, withdrawRecoveredNote,
} from "@swirl/wallet";

const MNEMONIC = "test test test test test test test test test test test junk";
const OTHER_MNEMONIC = "legal winner thank year wave sausage worth useful legal winner thank yellow";
const WASM = path.resolve("build/circuits/swirl_transfer_js/swirl_transfer.wasm");
const ZKEY = path.resolve("build/circuits/swirl_transfer_final.zkey");

describe("Emergency recovery without website, indexer or Relayer", function () {
  this.timeout(120_000);

  it("recovers an encrypted note from chain logs and withdraws with only the mnemonic", async () => {
    const [depositor, treasury, recipient] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("SwirlTestToken");
    const token = await Token.deploy();
    const Verifier = await ethers.getContractFactory("Groth16Verifier");
    const verifier = await Verifier.deploy();
    const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
    const poseidonT3 = await PoseidonT3.deploy();
    const PoseidonT5 = await ethers.getContractFactory("PoseidonT5");
    const poseidonT5 = await PoseidonT5.deploy();
    const Vault = await ethers.getContractFactory("SwirlVault", {
      libraries: { PoseidonT3: poseidonT3.target, PoseidonT5: poseidonT5.target },
    });
    const vault = await Vault.deploy([token.target], treasury.address, 25, verifier.target);

    const { chainId } = await ethers.provider.getNetwork();
    const wallet = await createSwirlWallet(Number(chainId), MNEMONIC);
    const note = await createNoteForAddress({
      address: wallet.address, token: BigInt(token.target as string), amount: 9_975n,
      chainId: Number(chainId), randomness: 777n,
    });
    const commitment = await noteCommitment(note);
    const ciphertext = ethers.hexlify(encryptNote(note, wallet.address));
    await token.approve(vault.target, 10_000n);
    await vault.shield(token.target, 10_000n, ethers.toBeHex(commitment, 32), ciphertext,
      ethers.toBeHex(note.owner, 32), ethers.toBeHex(note.randomness, 32));

    // Recovery uses only an RPC provider, deployment data and the mnemonic.
    const state = await recoverWalletNotes({ provider: ethers.provider, wallet, vaultAddress: vault.target as string });
    expect(state.notes).to.have.length(1);
    expect(state.notes[0].spent).to.equal(false);
    expect(state.notes[0].note.amount).to.equal(9_975n);

    const otherWallet = await createSwirlWallet(Number(chainId), OTHER_MNEMONIC);
    const otherState = await recoverWalletNotes({ provider: ethers.provider, wallet: otherWallet, vaultAddress: vault.target as string });
    expect(otherState.notes).to.have.length(0);

    const receipt = await withdrawRecoveredNote({
      signer: depositor, wallet, state, recovered: state.notes[0], recipient: recipient.address,
      assets: { wasm: WASM, zkey: ZKEY },
    });
    expect(receipt.status).to.equal(1);
    expect(await token.balanceOf(recipient.address)).to.equal(9_951n);
    expect(await token.balanceOf(treasury.address)).to.equal(49n);
    expect(await vault.nullifiers(ethers.toBeHex(state.notes[0].nullifier, 32))).to.equal(true);
  });

  it("recovers native assets through the verified gateway without SWIRL services", async () => {
    const [depositor, treasury, recipient] = await ethers.getSigners();
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

    const { chainId } = await ethers.provider.getNetwork();
    const wallet = await createSwirlWallet(Number(chainId), MNEMONIC);
    const gross = ethers.parseEther("1");
    const amount = gross * 9_975n / 10_000n;
    const note = await createNoteForAddress({
      address: wallet.address, token: BigInt(wrapped.target as string), amount,
      chainId: Number(chainId), randomness: 888n,
    });
    const commitment = await noteCommitment(note);
    await gateway.shieldNative(ethers.toBeHex(commitment, 32), ethers.hexlify(encryptNote(note, wallet.address)),
      ethers.toBeHex(note.owner, 32), ethers.toBeHex(note.randomness, 32), { value: gross });

    const state = await recoverWalletNotes({ provider: ethers.provider, wallet, vaultAddress: vault.target as string });
    expect(state.notes).to.have.length(1);
    const expectedNative = amount - amount * 25n / 10_000n;
    const balanceBefore = await ethers.provider.getBalance(recipient.address);
    const receipt = await withdrawRecoveredNote({
      signer: depositor, wallet, state, recovered: state.notes[0], recipient: recipient.address,
      gatewayAddress: gateway.target as string, assets: { wasm: WASM, zkey: ZKEY },
    });
    expect(receipt.status).to.equal(1);
    expect(await ethers.provider.getBalance(recipient.address)).to.equal(balanceBefore + expectedNative);
    expect(await vault.nullifiers(ethers.toBeHex(state.notes[0].nullifier, 32))).to.equal(true);
    expect(await wrapped.balanceOf(vault.target)).to.equal(0n);
  });
});
