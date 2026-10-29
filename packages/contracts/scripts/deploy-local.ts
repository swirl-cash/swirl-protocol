import { ethers, network } from "hardhat";
import { copyFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_TREASURY = "0x51872254046BF76BF71DC941896943293D45624F";

async function main() {
  if (network.name !== "localhost" && network.name !== "hardhat") {
    throw new Error("This development deployment script only runs on Hardhat or localhost");
  }
  const [deployer] = await ethers.getSigners();
  const treasury = ethers.getAddress(process.env.SWIRL_TREASURY_ADDRESS ?? DEFAULT_TREASURY);
  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy();
  const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
  const poseidonT3 = await PoseidonT3.deploy();
  const PoseidonT5 = await ethers.getContractFactory("PoseidonT5");
  const poseidonT5 = await PoseidonT5.deploy();
  const Vault = await ethers.getContractFactory("SwirlVault", {
    libraries: { PoseidonT3: poseidonT3.target, PoseidonT5: poseidonT5.target },
  });
  const TestAsset = await ethers.getContractFactory("SwirlTestAsset");
  const Wrapped = await ethers.getContractFactory("SwirlTestWrappedNative");
  const Gateway = await ethers.getContractFactory("SwirlNativeGateway");

  const wrapped = await Wrapped.deploy();
  const usdc = await TestAsset.deploy("USD Coin (local)", "USDC", 6);
  const usdt = await TestAsset.deploy("Tether USD (local)", "USDT", 6);
  const tokens = [wrapped.target, usdc.target, usdt.target];
  const vault = await Vault.deploy(tokens, treasury, 25, verifier.target);
  await vault.waitForDeployment();
  const gateway = await Gateway.deploy(vault.target, wrapped.target);
  await gateway.waitForDeployment();
  const assets = [
    { symbol: "ETH", name: "ETH", kind: "native", decimals: 18, token: wrapped.target, vault: vault.target, gateway: gateway.target },
    { symbol: "USDC", name: "USDC", kind: "erc20", decimals: 6, token: usdc.target, vault: vault.target, gateway: "" },
    { symbol: "USDT", name: "USDT", kind: "erc20", decimals: 6, token: usdt.target, vault: vault.target, gateway: "" },
  ];

  const deployment = {
    network: "localhost",
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    treasury,
    verifier: verifier.target,
    feeBps: 25,
    treeDepth: 16,
    trustedSetup: "development-only",
    assets,
    relayerVault: assets[1].vault,
    // Legacy fields keep the earlier single-asset web preview functional.
    token: usdc.target,
    vault: assets[1].vault,
  };
  const root = path.resolve(process.cwd(), "../..");
  const serialized = `${JSON.stringify(deployment, null, 2)}\n`;
  for (const publicDir of ["apps/web/public", "apps/extension/public"]) {
    const target = path.join(root, publicDir);
    await mkdir(path.join(target, "proving"), { recursive: true });
    await writeFile(path.join(target, "deployment.local.json"), serialized);
    for (const file of ["swirl_transfer_js/swirl_transfer.wasm", "swirl_transfer_final.zkey", "verification_key.json"]) {
      const destination = file.includes("/") ? "swirl_transfer.wasm" : file;
      await copyFile(path.join(process.cwd(), "build/circuits", file), path.join(target, "proving", destination));
    }
  }
  await mkdir(path.join(process.cwd(), "deployments"), { recursive: true });
  await writeFile(path.join(process.cwd(), "deployments/localhost.json"), serialized);
  console.log(serialized);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
