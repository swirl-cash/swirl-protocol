import { ethers } from 'ethers';
import type { AssetConfig } from './network';

const cache = new Map<number, { price: number; timestamp: number }>();
const storageKey = (chainId: number) => `swirl.native-usd-price.${chainId}.v1`;

function lastKnownPrice(chainId: number): number {
  try {
    const raw = localStorage.getItem(storageKey(chainId));
    if (!raw) return 0;
    const saved = JSON.parse(raw) as { price?: unknown; timestamp?: unknown };
    if (typeof saved.price !== 'number' || !Number.isFinite(saved.price) || saved.price <= 0
      || typeof saved.timestamp !== 'number' || Date.now() - saved.timestamp > 86_400_000) return 0;
    return saved.price;
  } catch { return 0; }
}

export async function assetUsdPrice(asset: AssetConfig | undefined, chainId: number): Promise<number> {
  if (!asset || chainId === 31337) return 0;
  if (asset.symbol === 'USDC' || asset.symbol === 'USDT') return 1;
  if (asset.kind !== 'native') return 0;
  const cached = cache.get(chainId);
  if (cached && Date.now() - cached.timestamp < 300_000) return cached.price;
  try {
    // Use the same multi-source price service as the web app instead of a
    // browser-only third-party request that is intermittently blocked by CORS.
    const response = await fetch(`https://swirl.cash/api/prices/native?chainId=${chainId}`, {
      signal: AbortSignal.timeout(10_000), cache: 'no-store',
    });
    if (!response.ok) return cached?.price ?? lastKnownPrice(chainId);
    const data = await response.json() as { price?: unknown };
    if (typeof data.price !== 'number' || !Number.isFinite(data.price) || data.price <= 0) {
      return cached?.price ?? lastKnownPrice(chainId);
    }
    const timestamp = Date.now();
    cache.set(chainId, { price: data.price, timestamp });
    try { localStorage.setItem(storageKey(chainId), JSON.stringify({ price: data.price, timestamp })); } catch { /* Storage is optional. */ }
    return data.price;
  } catch { return cached?.price ?? lastKnownPrice(chainId); }
}

export function usdValue(amount: bigint, decimals: number, price: number): number {
  const value = Number(ethers.formatUnits(amount, decimals)) * price;
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

export function formatUsd(value: number): string {
  return `$${(Number.isFinite(value) && value > 0 ? value : 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
