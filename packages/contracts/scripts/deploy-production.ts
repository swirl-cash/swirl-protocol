import { ethers, network } from "hardhat";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const SUPPORTED: Record<string, number> = { ethereum: 1, bnb: 56, polygon: 137, arbitrum: 42161, sepolia: 11155111, polygonAmoy: 80002 };
const requiredAddress = (name: string) => {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value)) throw new Error(`${name} must be a verified contract address`);
  return ethers.getAddress(value);
};

async function main() {
  const expectedChain = SUPPORTED[network.name];
  if (!expectedChain) throw new Error(`Unsupported production network profile: ${network.name}`);
  const { chainId } = await ethers.provider.getNetwork();
  if (Number(chainId) !== expectedChain) throw new Error(`RPC chain ${chainId} does not match ${network.name}`);
  if (process.env.SWIRL_DEPLOY_CONFIRM !== `DEPLOY_${expectedChain}`) throw new Error(`Set SWIRL_DEPLOY_CONFIRM=DEPLOY_${expectedChain} after reviewing the deployment plan`);
  if (!process.env.SWIRL_TRUSTED_SETUP_ID?.trim()) throw new Error("Set SWIRL_TRUSTED_SETUP_ID to the reviewed public ceremony transcript identifier");

  const [deployer] = await ethers.getSigners();
  const maxFeePerGas = process.env.SWIRL_MAX_FEE_PER_GAS_WEI ? BigInt(process.env.SWIRL_MAX_FEE_PER_GAS_WEI) : undefined;
  const maxPriorityFeePerGas = process.env.SWIRL_MAX_PRIORITY_FEE_PER_GAS_WEI ? BigInt(process.env.SWIRL_MAX_PRIORITY_FEE_PER_GAS_WEI) : undefined;
  if (!maxFeePerGas || maxFeePerGas <= 0n || !maxPriorityFeePerGas || maxPriorityFeePerGas < 0n) {
    throw new Error("Set explicit positive SWIRL_MAX_FEE_PER_GAS_WEI and non-negative SWIRL_MAX_PRIORITY_FEE_PER_GAS_WEI values after checking current network fees");
  }
  const latest = await ethers.provider.getBlock("latest");
  const requiredFee = (latest?.baseFeePerGas ?? 0n) + maxPriorityFeePerGas;
  if (maxFeePerGas < requiredFee) throw new Error(`SWIRL_MAX_FEE_PER_GAS_WEI is below the current base fee plus priority fee (${requiredFee})`);
  const estimatedGas = 12_088_161n;
  const budgetGas = estimatedGas * 110n / 100n;
  const balance = await ethers.provider.getBalance(deployer.address);
  const requiredBalance = budgetGas * maxFeePerGas;
  if (balance < requiredBalance) throw new Error(`Insufficient deployment balance: have ${ethers.formatEther(balance)} ETH, need ${ethers.formatEther(requiredBalance)} ETH including 10% gas headroom`);
  const overrides = { maxFeePerGas, maxPriorityFeePerGas };
  console.log(`Deployment preflight: ${ethers.formatEther(balance)} ETH available, maximum budget ${ethers.formatEther(requiredBalance)} ETH`);

  const treasury = requiredAddress("SWIRL_TREASURY_ADDRESS");
  const wrappedNative = requiredAddress("WRAPPED_NATIVE_ADDRESS");
  const usdc = requiredAddress("USDC_ADDRESS");
  const usdt = requiredAddress("USDT_ADDRESS");
  if (new Set([wrappedNative, usdc, usdt].map((item) => item.toLowerCase())).size !== 3) throw new Error("Asset addresses must be distinct");
  const nativeSymbol = process.env.NATIVE_SYMBOL?.trim();
  if (!nativeSymbol) throw new Error("NATIVE_SYMBOL is required");
  const feeBps = Number(process.env.SWIRL_FEE_BPS ?? "25");
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 1000) throw new Error("Invalid SWIRL_FEE_BPS");
  const erc20 = await ethers.getContractAt(["function decimals() view returns (uint8)", "function symbol() view returns (string)"], usdc);
  for (const [label, address] of [["wrapped native", wrappedNative], ["USDC", usdc], ["USDT", usdt]] as const) {
    const code = await ethers.provider.getCode(address);
    if (code === "0x") throw new Error(`${label} has no contract code at ${address}`);
    await erc20.attach(address).decimals();
  }

  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const verifier = await Verifier.deploy(overrides);
  await verifier.waitForDeployment();
  const verifierReceipt = await verifier.deploymentTransaction()?.wait();
  if (verifierReceipt?.status !== 1) throw new Error("Verifier deployment transaction failed");
  console.log(`Verifier deployed: ${verifier.target}`);

  const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
  const poseidonT3 = await PoseidonT3.deploy(overrides);
  await poseidonT3.waitForDeployment();
  const poseidonT3Receipt = await poseidonT3.deploymentTransaction()?.wait();
  if (poseidonT3Receipt?.status !== 1) throw new Error("PoseidonT3 deployment transaction failed");
  console.log(`PoseidonT3 deployed: ${poseidonT3.target}`);

  const PoseidonT5 = await ethers.getContractFactory("PoseidonT5");
  const poseidonT5 = await PoseidonT5.deploy(overrides);
  await poseidonT5.waitForDeployment();
  const poseidonT5Receipt = await poseidonT5.deploymentTransaction()?.wait();
  if (poseidonT5Receipt?.status !== 1) throw new Error("PoseidonT5 deployment transaction failed");
  console.log(`PoseidonT5 deployed: ${poseidonT5.target}`);

  const Vault = await ethers.getContractFactory("SwirlVault", { libraries: { PoseidonT3: poseidonT3.target, PoseidonT5: poseidonT5.target } });
  const Gateway = await ethers.getContractFactory("SwirlNativeGateway");
  const vault = await Vault.deploy([wrappedNative, usdc, usdt], treasury, feeBps, verifier.target, overrides);
  await vault.waitForDeployment();
  const vaultReceipt = await vault.deploymentTransaction()?.wait();
  if (vaultReceipt?.status !== 1) throw new Error("Vault deployment transaction failed");
  console.log(`Vault deployed: ${vault.target}`);

  const gateway = await Gateway.deploy(vault.target, wrappedNative, overrides);
  await gateway.waitForDeployment();
  const gatewayReceipt = await gateway.deploymentTransaction()?.wait();
  if (gatewayReceipt?.status !== 1) throw new Error("Native Gateway deployment transaction failed");
  console.log(`Native Gateway deployed: ${gateway.target}`);

  const assets = [];
  for (const [symbol, kind, token] of [[nativeSymbol, "native", wrappedNative], ["USDC", "erc20", usdc], ["USDT", "erc20", usdt]] as const) {
    const decimals = Number(await erc20.attach(token).decimals());
    assets.push({ symbol, name: symbol, kind, decimals, token, vault: vault.target, gateway: kind === "native" ? gateway.target : "" });
  }
  const deployment = {
    network: network.name, name: process.env.SWIRL_NETWORK_NAME?.trim() || network.name,
    chainId: expectedChain, rpcUrl: process.env.SWIRL_PUBLIC_RPC_URL?.trim() || "",
    deployer: deployer.address, treasury,
    verifier: verifier.target, poseidonT3: poseidonT3.target, poseidonT5: poseidonT5.target,
    feeBps, treeDepth: 16, trustedSetup: process.env.SWIRL_TRUSTED_SETUP_ID, assets,
    relayerUrl: process.env.SWIRL_RELAYER_URL?.trim() || "", indexerUrl: process.env.SWIRL_INDEXER_URL?.trim() || "",
    relayerVault: process.env.SWIRL_RELAYER_URL?.trim() ? vault.target : "", vault: vault.target,
  };
  const serialized = `${JSON.stringify(deployment, null, 2)}\n`;
  const deploymentDirectory = path.join(process.cwd(), "deployments");
  const extensionDirectory = path.join(process.cwd(), "../../apps/extension/public");
  await Promise.all([mkdir(deploymentDirectory, { recursive: true }), mkdir(extensionDirectory, { recursive: true })]);
  const file = path.join(deploymentDirectory, `${network.name}.json`);
  const extensionFile = path.join(extensionDirectory, `deployment.${network.name}.json`);
  await Promise.all([writeFile(file, serialized), writeFile(extensionFile, serialized)]);
  console.log(`Deployment written to ${file} and ${extensionFile}`);
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
