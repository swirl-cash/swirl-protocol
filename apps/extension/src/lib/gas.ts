import { ethers, HDNodeWallet, JsonRpcProvider, NonceManager, type Signer } from 'ethers';
import type { NetworkConfig } from './network';

export const GAS_DERIVATION_PATH = "m/44'/60'/0'/1/0";
export type GasOperation = 'transfer' | 'unshield';
export type GasEstimate = { operation: GasOperation; units: bigint; cost: bigint; bufferedCost: bigint };

const PLANNED_GAS_UNITS: Record<GasOperation, bigint> = {
  transfer: 750_000n,
  unshield: 800_000n,
};

export function nativeSymbol(chainId: number): string {
  if (chainId === 56) return 'BNB';
  if (chainId === 137 || chainId === 80002) return 'POL';
  return 'ETH';
}

export function gasWallet(mnemonic: string, provider: JsonRpcProvider): NonceManager {
  return new NonceManager(HDNodeWallet.fromPhrase(mnemonic, undefined, GAS_DERIVATION_PATH).connect(provider));
}

export function mainWallet(mnemonic: string, provider: JsonRpcProvider): NonceManager {
  return new NonceManager(HDNodeWallet.fromPhrase(mnemonic).connect(provider));
}

export function gasAddress(mnemonic: string): string {
  return HDNodeWallet.fromPhrase(mnemonic, undefined, GAS_DERIVATION_PATH).address;
}

export function createProvider(config: NetworkConfig): JsonRpcProvider {
  if (!config.rpcUrl) throw new Error('This network has no RPC connection');
  return new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
}

export async function gasSnapshot(config: NetworkConfig, mnemonic: string): Promise<{
  address: string; balance: bigint; estimates: GasEstimate[];
}> {
  const provider = createProvider(config);
  const address = gasAddress(mnemonic);
  const [balance, feeData] = await Promise.all([provider.getBalance(address), provider.getFeeData()]);
  const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!feePerGas || feePerGas <= 0n) throw new Error('The RPC did not return a usable network fee');
  const estimates = (Object.keys(PLANNED_GAS_UNITS) as GasOperation[]).map((operation) => {
    const units = PLANNED_GAS_UNITS[operation];
    const cost = units * feePerGas;
    return { operation, units, cost, bufferedCost: cost * 120n / 100n };
  });
  return { address, balance, estimates };
}

export async function topUpGasAccount(input: {
  config: NetworkConfig; mnemonic: string; amount: bigint;
}): Promise<{ hash: string }> {
  if (input.amount <= 0n) throw new Error('Enter a Gas amount greater than zero');
  const provider = createProvider(input.config);
  const signer = mainWallet(input.mnemonic, provider);
  const recipient = gasAddress(input.mnemonic);
  const transaction = await signer.sendTransaction({ to: recipient, value: input.amount });
  const receipt = await transaction.wait();
  if (!receipt) throw new Error('Gas top-up receipt was not returned');
  return receipt;
}

export async function assertGasAvailable(input: {
  config: NetworkConfig; signer: Signer; operation: GasOperation;
}): Promise<void> {
  const provider = input.signer.provider ?? createProvider(input.config);
  const [address, feeData] = await Promise.all([input.signer.getAddress(), provider.getFeeData()]);
  const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!feePerGas) throw new Error('Unable to estimate the network fee');
  const required = PLANNED_GAS_UNITS[input.operation] * feePerGas;
  const balance = await provider.getBalance(address);
  if (balance < required) {
    throw new Error(`Gas account needs about ${ethers.formatEther(required)} ${nativeSymbol(input.config.chainId)} for this transaction. Top up Gas in Settings.`);
  }
}
