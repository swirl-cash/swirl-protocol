import { FallbackProvider, JsonRpcProvider, Network } from 'ethers';

type RPCProviderConfig = {
  provider: JsonRpcProvider;
  priority: number;
  weight: number;
  stallTimeout?: number;
};

export const SEPOLIA_CHAIN_ID = 11155111;
export const SEPOLIA_RPC_CONFIG = [
  { provider: 'https://ethereum-sepolia-rpc.publicnode.com', priority: 2, weight: 2, maxLogsPerBatch: 10, stallTimeout: 2500 },
  { provider: 'https://sepolia.gateway.tenderly.co', priority: 3, weight: 2, maxLogsPerBatch: 10 },
  { provider: 'https://ethereum-sepolia-rpc.blockreq.com/v1/rpc/public', priority: 4, weight: 2, maxLogsPerBatch: 10 },
] as const;

const MAINNET_RPC_CONFIG = [
  { provider: 'https://ethereum-rpc.publicnode.com', priority: 2, weight: 2, maxLogsPerBatch: 5, stallTimeout: 2500 },
  { provider: 'https://eth.drpc.org', priority: 3, weight: 2, maxLogsPerBatch: 5 },
  { provider: 'https://rpc.mevblocker.io', priority: 4, weight: 2, maxLogsPerBatch: 5 },
] as const;

export type RPCHealth = { url: string; available: boolean; blockNumber?: number; error?: string };
export type RPCConfig = { provider: string; priority: number; weight: number; maxLogsPerBatch?: number; stallTimeout?: number };

function defaultRPCConfig(chainId: number): readonly RPCConfig[] {
  if (chainId === 1) return MAINNET_RPC_CONFIG;
  if (chainId === SEPOLIA_CHAIN_ID) return SEPOLIA_RPC_CONFIG;
  throw new Error(`RPC_URLS is required for chain ${chainId}`);
}

export function parseRPCConfig(chainId: number, rpcUrls?: string): RPCConfig[] {
  if (!rpcUrls?.trim()) return [...defaultRPCConfig(chainId)];
  const urls = rpcUrls.split(',').map((url) => url.trim()).filter(Boolean);
  if (!urls.length || urls.length > 10) throw new Error('RPC_URLS must contain between one and ten URLs');
  return urls.map((url, index) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error(`Invalid RPC URL at position ${index + 1}`); }
    const local = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) {
      throw new Error('RPC URLs must use HTTPS or a local development address');
    }
    return { provider: parsed.toString(), priority: index + 1, weight: 1, maxLogsPerBatch: 10, stallTimeout: 5000 };
  });
}

async function checkRPC(url: string, network: Network): Promise<RPCHealth> {
  const provider = new JsonRpcProvider(url, network, { staticNetwork: network });
  try {
    const block = await Promise.race([
      provider.getBlock('latest'),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('RPC health check timed out')), 5000)),
    ]);
    if (!block) throw new Error('RPC returned no latest block');
    return { url, available: true, blockNumber: block.number };
  } catch (error) {
    return { url, available: false, error: error instanceof Error ? error.message : 'RPC health check failed' };
  } finally {
    provider.destroy();
  }
}

export async function createFallbackProvider(chainId: number, rpcUrls?: string): Promise<{
  provider: FallbackProvider | JsonRpcProvider;
  health: RPCHealth[];
}> {
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw new Error('Invalid CHAIN_ID');
  const network = Network.from(chainId);
  const rpcConfig = parseRPCConfig(chainId, rpcUrls);
  const health = await Promise.all(rpcConfig.map((config) => checkRPC(config.provider, network)));
  const availableBlocks = health.flatMap((item) => item.available && item.blockNumber !== undefined ? [item.blockNumber] : []).sort((a, b) => a - b);
  if (!availableBlocks.length) throw new Error(`No RPC is available for chain ${chainId}: ${health.map((item) => item.error).join('; ')}`);
  const median = availableBlocks[Math.floor((availableBlocks.length - 1) / 2)];
  const configs: RPCProviderConfig[] = [];
  for (const config of rpcConfig) {
    const status = health.find((item) => item.url === config.provider);
    if (!status?.available || status.blockNumber === undefined || Math.abs(status.blockNumber - median) > 100) continue;
    configs.push({
      provider: new JsonRpcProvider(config.provider, network, {
        staticNetwork: network,
        batchMaxCount: config.maxLogsPerBatch,
      }),
      priority: config.priority,
      weight: config.weight,
      stallTimeout: config.stallTimeout,
    });
  }
  if (!configs.length) throw new Error('No RPC is close enough to the median chain head');
  if (configs.length === 1) return { provider: configs[0].provider, health };
  if (configs.reduce((sum, config) => sum + (config.weight ?? 0), 0) < 2) throw new Error('Insufficient healthy RPC weight for fallback quorum');
  return { provider: new FallbackProvider(configs, network), health };
}

export async function createSepoliaFallbackProvider(): Promise<{
  provider: FallbackProvider | JsonRpcProvider;
  health: RPCHealth[];
}> {
  return createFallbackProvider(SEPOLIA_CHAIN_ID);
}
