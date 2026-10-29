import { ethers, network } from "hardhat";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const CHAIN_ID = 11155111;

async function main() {
  if (network.name !== "sepolia") throw new Error("This public-beta deployment only runs on Sepolia");
  const { chainId } = await ethers.provider.getNetwork();
  if (Number(chainId) !== CHAIN_ID) throw new Error(`RPC chain ${chainId} is not Sepolia`);
  if (process.env.SWIRL_DEPLOY_CONFIRM !== `DEPLOY_${CHAIN_ID}`) throw new Error(`Set SWIRL_DEPLOY_CONFIRM=DEPLOY_${CHAIN_ID} after reviewing the Sepolia plan`);
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("A Sepolia deployer is required");
  const treasury = ethers.getAddress(process.env.SWIRL_TREASURY_ADDRESS ?? "");
  const feeBps = Number(process.env.SWIRL_FEE_BPS ?? "25");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) throw new Error("Invalid SWIRL_FEE_BPS");
  const trustedSetup = process.env.SWIRL_TRUSTED_SETUP_ID;
  if (trustedSetup !== "development-only-sepolia-public-beta") throw new Error("Sepolia beta must explicitly identify its development trusted setup");

  console.log(`Deploying SWIRL shared-tree public beta from ${deployer.address}; treasury=${treasury}; feeBps=${feeBps}`);
  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const reusedVerifier = process.env.SEPOLIA_VERIFIER_ADDRESS;
  if (reusedVerifier && !ethers.isAddress(reusedVerifier)) throw new Error("Invalid SEPOLIA_VERIFIER_ADDRESS");
  const verifier = reusedVerifier
    ? await Verifier.attach(reusedVerifier)
    : await Verifier.deploy();
  if (reusedVerifier) {
    if (await ethers.provider.getCode(reusedVerifier) === "0x") throw new Error("Reused Verifier has no contract code");
  } else await verifier.waitForDeployment();
  console.log(`Verifier: ${verifier.target}`);
  const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
  const reusedPoseidonT3 = process.env.SEPOLIA_POSEIDON_T3_ADDRESS;
  if (reusedPoseidonT3 && !ethers.isAddress(reusedPoseidonT3)) throw new Error("Invalid SEPOLIA_POSEIDON_T3_ADDRESS");
  const poseidonT3 = reusedPoseidonT3 ? await PoseidonT3.attach(reusedPoseidonT3) : await PoseidonT3.deploy();
  if (reusedPoseidonT3) {
    if (await ethers.provider.getCode(reusedPoseidonT3) === "0x") throw new Error("Reused PoseidonT3 has no contract code");
  } else await poseidonT3.waitForDeployment();
  console.log(`PoseidonT3: ${poseidonT3.target}`);
  const PoseidonT5 = await ethers.getContractFactory("PoseidonT5");
  const reusedPoseidonT5 = process.env.SEPOLIA_POSEIDON_T5_ADDRESS;
  if (reusedPoseidonT5 && !ethers.isAddress(reusedPoseidonT5)) throw new Error("Invalid SEPOLIA_POSEIDON_T5_ADDRESS");
  const poseidonT5 = reusedPoseidonT5 ? await PoseidonT5.attach(reusedPoseidonT5) : await PoseidonT5.deploy();
  if (reusedPoseidonT5) {
    if (await ethers.provider.getCode(reusedPoseidonT5) === "0x") throw new Error("Reused PoseidonT5 has no contract code");
  } else await poseidonT5.waitForDeployment();
  console.log(`PoseidonT5: ${poseidonT5.target}`);

  const Vault = await ethers.getContractFactory("SwirlVault", {
    libraries: { PoseidonT3: poseidonT3.target, PoseidonT5: poseidonT5.target },
  });
  const Wrapped = await ethers.getContractFactory("SwirlTestWrappedNative");
  const Gateway = await ethers.getContractFactory("SwirlNativeGateway");
  const reusedWrapped = process.env.SEPOLIA_WRAPPED_NATIVE_ADDRESS;
  if (reusedWrapped && !ethers.isAddress(reusedWrapped)) throw new Error("Invalid SEPOLIA_WRAPPED_NATIVE_ADDRESS");
  const wrapped = reusedWrapped ? await Wrapped.attach(reusedWrapped) : await Wrapped.deploy();
  if (reusedWrapped) {
    if (await ethers.provider.getCode(reusedWrapped) === "0x") throw new Error("Reused wrapped native has no contract code");
  } else await wrapped.waitForDeployment();
  console.log(`Sepolia wrapped native test asset: WETH=${wrapped.target}`);
  const reusedVault = process.env.SEPOLIA_VAULT_ADDRESS;
  if (reusedVault && !ethers.isAddress(reusedVault)) throw new Error("Invalid SEPOLIA_VAULT_ADDRESS");
  const vault = reusedVault
    ? await Vault.attach(reusedVault)
    : await Vault.deploy([wrapped.target], treasury, feeBps, verifier.target);
  if (reusedVault) {
    if (await ethers.provider.getCode(reusedVault) === "0x") throw new Error("Reused Vault has no contract code");
    if ((await vault.verifier()).toLowerCase() !== verifier.target.toLowerCase()) throw new Error("Reused Vault has a different Verifier");
  } else await vault.waitForDeployment();
  const maxFeePerGas = process.env.SEPOLIA_MAX_FEE_PER_GAS_WEI;
  const maxPriorityFeePerGas = process.env.SEPOLIA_MAX_PRIORITY_FEE_PER_GAS_WEI;
  const overrides = maxFeePerGas && maxPriorityFeePerGas
    ? { maxFeePerGas: BigInt(maxFeePerGas), maxPriorityFeePerGas: BigInt(maxPriorityFeePerGas) }
    : {};
  const gateway = await Gateway.deploy(vault.target, wrapped.target, overrides);
  await gateway.waitForDeployment();
  console.log(`Shared vault=${vault.target}; native gateway=${gateway.target}`);
  const assets = [
    { symbol: "ETH", name: "Sepolia ETH", kind: "native", decimals: 18, token: wrapped.target, vault: vault.target, gateway: gateway.target },
  ];

  const deployment = {
    network: "sepolia",
    name: "Sepolia Public Beta",
    chainId: CHAIN_ID,
    rpcUrl: process.env.SEPOLIA_RPC_URL,
    deployer: deployer.address,
    treasury,
    verifier: verifier.target,
    poseidonT3: poseidonT3.target,
    poseidonT5: poseidonT5.target,
    feeBps,
    treeDepth: 16,
    trustedSetup,
    assetMode: "sepolia-eth-only-no-monetary-value",
    assets,
    relayerVault: vault.target,
    token: wrapped.target,
    vault: vault.target,
  };
  const root = path.resolve(process.cwd(), "../..");
  const serialized = `${JSON.stringify(deployment, null, 2)}\n`;
  for (const publicDir of ["apps/web/public", "apps/extension/public"]) {
    const target = path.join(root, publicDir);
    await mkdir(path.join(target, "proving"), { recursive: true });
    await writeFile(path.join(target, "deployment.sepolia.json"), serialized);
    for (const file of ["swirl_transfer_js/swirl_transfer.wasm", "swirl_transfer_final.zkey", "verification_key.json"]) {
      const destination = file.includes("/") ? "swirl_transfer.wasm" : file;
      await copyFile(path.join(process.cwd(), "build/circuits", file), path.join(target, "proving", destination));
    }
  }
  await mkdir(path.join(process.cwd(), "deployments"), { recursive: true });
  await writeFile(path.join(process.cwd(), "deployments/sepolia.json"), serialized);
  console.log(`Deployment written to deployments/sepolia.json`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
