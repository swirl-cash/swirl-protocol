import { ethers } from "hardhat";

const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const TREASURY = "0x51872254046bf76bf71dc941896943293d45624f";

async function gasUsed(factory: Awaited<ReturnType<typeof ethers.getContractFactory>>, args: unknown[] = []) {
  const contract = await factory.deploy(...args);
  await contract.waitForDeployment();
  const hash = contract.deploymentTransaction()?.hash;
  if (!hash) throw new Error("Missing deployment transaction");
  const receipt = await ethers.provider.getTransactionReceipt(hash);
  if (!receipt || receipt.status !== 1) throw new Error("Local deployment estimation failed");
  return { contract, gas: receipt.gasUsed };
}

async function main() {
  if ((await ethers.provider.getNetwork()).chainId !== 31337n) throw new Error("Gas estimation must use an ephemeral Hardhat chain");
  const Verifier = await ethers.getContractFactory("Groth16Verifier");
  const PoseidonT3 = await ethers.getContractFactory("PoseidonT3");
  const PoseidonT5 = await ethers.getContractFactory("PoseidonT5");
  const { gas: verifierGas } = await gasUsed(Verifier);
  const { gas: poseidonT3Gas } = await gasUsed(PoseidonT3);
  const { gas: poseidonT5Gas } = await gasUsed(PoseidonT5);
  const Wrapped = await ethers.getContractFactory("SwirlTestWrappedNative");
  const wrapped = await Wrapped.deploy();
  await wrapped.waitForDeployment();
  const Vault = await ethers.getContractFactory("SwirlVault", {
    libraries: { PoseidonT3: (await PoseidonT3.deploy()).target, PoseidonT5: (await PoseidonT5.deploy()).target },
  });
  const { contract: vault, gas: vaultGas } = await gasUsed(Vault, [[wrapped.target, USDC, USDT], TREASURY, 25, (await Verifier.deploy()).target]);
  const Gateway = await ethers.getContractFactory("SwirlNativeGateway");
  const { gas: gatewayGas } = await gasUsed(Gateway, [vault.target, wrapped.target]);
  const total = verifierGas + poseidonT3Gas + poseidonT5Gas + vaultGas + gatewayGas;
  console.log(JSON.stringify({
    verifier: verifierGas.toString(), poseidonT3: poseidonT3Gas.toString(), poseidonT5: poseidonT5Gas.toString(),
    vault: vaultGas.toString(), gateway: gatewayGas.toString(), totalGas: total.toString(),
  }, null, 2));
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
