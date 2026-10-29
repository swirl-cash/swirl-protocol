import { ethers } from 'ethers';
import type { AssetConfig } from './network';

const NATIVE_IDS: Record<number, string> = {
  1: 'ethereum',
  56: 'binancecoin',
  137: 'polygon-ecosystem-token',
  42161: 'ethereum',
  11155111: 'ethereum',
  80002: 'polygon-ecosystem-token',
};
const cache = new Map<number, { price: number; timestamp: number }>();

export async function assetUsdPrice(asset: AssetConfig | undefined, chainId: number): Promise<number> {
  if (!asset || chainId === 31337) return 0;
  if (asset.symbol === 'USDC' || asset.symbol === 'USDT') return 1;
  if (asset.kind !== 'native') return 0;
  const cached = cache.get(chainId);
  if (cached && Date.now() - cached.timestamp < 300_000) return cached.price;
  const id = NATIVE_IDS[chainId];
  if (!id) return 0;
  try {
    const response = await fetch(`https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`, {
      signal: AbortSignal.timeout(8_000), cache: 'no-store',
    });
    if (!response.ok) return cached?.price ?? 0;
    const data = await response.json() as Record<string, { usd?: unknown }>;
    const price = data[id]?.usd;
    if (typeof price !== 'number' || !Number.isFinite(price) || price < 0) return cached?.price ?? 0;
    cache.set(chainId, { price, timestamp: Date.now() });
    return price;
  } catch { return cached?.price ?? 0; }
}

export function usdValue(amount: bigint, decimals: number, price: number): number {
  const value = Number(ethers.formatUnits(amount, decimals)) * price;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function formatUsd(value: number): string {
  return `$${(Number.isFinite(value) && value > 0 ? value : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
