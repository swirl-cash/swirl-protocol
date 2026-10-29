const isAddress = (value: string): boolean => /^0x[0-9a-f]{40}$/i.test(value);

export type AssetConfig = {
  symbol: string;
  name: string;
  kind: 'native' | 'erc20';
  decimals: number;
  token: string;
  vault: string;
  gateway: string;
};
export type NetworkConfig = {
  name: string;
  chainId: number;
  rpcUrl: string;
  assets: AssetConfig[];
  feeBps: number;
  relayerUrl: string;
  relayerVault: string;
  indexerUrl: string;
  poiNodeUrl: string;
  poiListKey: string;
};

export const EMPTY_NETWORK: NetworkConfig = {
  name: '', chainId: 1, rpcUrl: '', assets: [], feeBps: 25, relayerUrl: '', relayerVault: '', indexerUrl: '',
  poiNodeUrl: '', poiListKey: '',
};
export const DEFAULT_NETWORK: NetworkConfig = {
  ...EMPTY_NETWORK, name: 'Ethereum', chainId: 1, rpcUrl: 'https://ethereum.reth.rs/rpc',
};
const LOCAL_NETWORK: NetworkConfig = {
  ...EMPTY_NETWORK, name: 'Local Hardhat', chainId: 31337, rpcUrl: 'http://127.0.0.1:8545',
  relayerUrl: 'http://127.0.0.1:8787', indexerUrl: 'http://127.0.0.1:8788',
};

const ACTIVE_KEY = 'swirl.network.v1';
const SEPOLIA_BETA = import.meta.env.MODE === 'sepolia' || import.meta.env.VITE_SEPOLIA_BETA === 'true';
type PackagedNetwork = Partial<NetworkConfig> & { token?: string; vault?: string };

async function readValue<T>(key: string, fallback: T): Promise<T> {
  let value: unknown;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) value = (await chrome.storage.local.get(key))[key];
  else {
    const raw = localStorage.getItem(key);
    value = raw ? JSON.parse(raw) : undefined;
  }
  return value === undefined ? fallback : value as T;
}
async function writeValue(key: string, value: unknown): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) return chrome.storage.local.set({ [key]: value });
  localStorage.setItem(key, JSON.stringify(value));
}
async function packagedNetwork(file = './deployment.local.json'): Promise<Partial<NetworkConfig>> {
  try {
    const response = await fetch(file, { cache: 'no-store' });
    if (!response.ok) return {};
    const raw = await response.json() as PackagedNetwork;
    if (Array.isArray(raw.assets)) return raw;
    if (raw.token && raw.vault) return { ...raw, assets: [{ symbol: 'stUSD', name: 'SWIRL Test Dollar', kind: 'erc20', decimals: 18, token: raw.token, vault: raw.vault, gateway: '' }] };
    return raw;
  } catch { return {}; }
}
function presetNetworks(local: NetworkConfig): NetworkConfig[] {
  return [...((import.meta.env.DEV || import.meta.env.VITE_ENABLE_LOCAL_TEST === 'true') ? [local] : []), DEFAULT_NETWORK,
    { ...EMPTY_NETWORK, name: 'BNB Smart Chain', chainId: 56, rpcUrl: 'https://56.rpc.thirdweb.com' },
    { ...EMPTY_NETWORK, name: 'Polygon', chainId: 137, rpcUrl: 'https://polygon.drpc.org' },
    { ...EMPTY_NETWORK, name: 'Arbitrum One', chainId: 42161, rpcUrl: 'https://arb1.arbitrum.io/rpc' },
    { ...EMPTY_NETWORK, name: 'Sepolia Testnet', chainId: 11155111, rpcUrl: 'https://11155111.rpc.thirdweb.com' },
    { ...EMPTY_NETWORK, name: 'Polygon Amoy', chainId: 80002, rpcUrl: 'https://polygon-amoy.drpc.org' },
  ];
}

export async function loadNetworks(): Promise<NetworkConfig[]> {
  const [localDeployment, ethereumDeployment, sepoliaDeployment] = await Promise.all([
    packagedNetwork(), packagedNetwork('./deployment.ethereum.json'), packagedNetwork('./deployment.sepolia.json'),
  ]);
  const local = { ...LOCAL_NETWORK, ...localDeployment };
  return presetNetworks(local).map((item) => {
    if (item.chainId === 1) return { ...item, ...ethereumDeployment };
    if (item.chainId === 11155111) return { ...item, ...sepoliaDeployment };
    return item;
  });
}

export async function loadNetwork(): Promise<NetworkConfig> {
  const [networks, stored] = await Promise.all([loadNetworks(), readValue<Partial<NetworkConfig>>(ACTIVE_KEY, {})]);
  const betaDefault = networks.find((item) => item.chainId === 11155111 && protocolReady(item)) ?? DEFAULT_NETWORK;
  const productionDefault = networks.find((item) => item.chainId === 1 && protocolReady(item)) ?? networks[0] ?? DEFAULT_NETWORK;
  const defaultActive = SEPOLIA_BETA ? betaDefault : productionDefault;
  const active = { ...defaultActive, ...stored };
  return networks.find((item) => item.chainId === active.chainId) ?? defaultActive;
}

export async function activateNetwork(chainId: number): Promise<NetworkConfig> {
  if (![1, 11155111].includes(chainId) && !((import.meta.env.DEV || import.meta.env.VITE_ENABLE_LOCAL_TEST === 'true') && chainId === 31337)) {
    throw new Error('This network is coming soon');
  }
  const network = (await loadNetworks()).find((item) => item.chainId === chainId);
  if (!network) throw new Error('The selected network profile does not exist');
  await writeValue(ACTIVE_KEY, network);
  return network;
}

export function rpcReady(config: NetworkConfig): boolean {
  return Boolean(config.rpcUrl.trim());
}

function validAsset(asset: AssetConfig): boolean {
  return Boolean(asset.symbol && isAddress(asset.token) && isAddress(asset.vault)
    && Number.isInteger(asset.decimals) && asset.decimals >= 0 && asset.decimals <= 36
    && (asset.kind === 'native' ? isAddress(asset.gateway) : asset.kind === 'erc20' && !asset.gateway));
}
export function poiRequired(config: NetworkConfig): boolean {
  return config.chainId !== 31337 || Boolean(config.poiNodeUrl);
}
export function poiReady(config: NetworkConfig): boolean {
  return Boolean(config.poiNodeUrl && /^[0-9a-fA-F]{64}$/.test(config.poiListKey));
}
export function protocolReady(config: NetworkConfig): boolean {
  return rpcReady(config) && config.assets.length > 0 && config.assets.every(validAsset)
    && (!poiRequired(config) || poiReady(config));
}

export function validateNetwork(config: NetworkConfig): void {
  if (!config.name.trim()) throw new Error('Enter a network name');
  if (!Number.isSafeInteger(config.chainId) || config.chainId <= 0) throw new Error('Enter a valid chain ID');
  if (!Number.isInteger(config.feeBps) || config.feeBps < 0 || config.feeBps > 10_000) throw new Error('Invalid protocol fee');
  if (!protocolReady(config) && config.assets.length) throw new Error('The packaged asset or PPOI deployment is incomplete or invalid');
  const tokens = config.assets.map((asset) => asset.token.toLowerCase());
  if (new Set(tokens).size !== tokens.length) throw new Error('Each asset must use a distinct token; assets may share a vault');
  for (const [label, url, required] of [
    ['RPC', config.rpcUrl, true], ['Relayer', config.relayerUrl, false], ['Indexer', config.indexerUrl, false], ['PPOI', config.poiNodeUrl, false],
  ] as const) {
    if (!url && !required) continue;
    try {
      const parsed = new URL(url);
      const local = ['127.0.0.1', 'localhost'].includes(parsed.hostname);
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && local)) throw new Error('unsupported protocol');
    } catch { throw new Error(`${label} URL must use HTTPS or a local development address`); }
  }
}
