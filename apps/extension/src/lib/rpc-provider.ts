import { ethers, JsonRpcProvider } from 'ethers';
import type { NetworkConfig } from './network';

const RPC_REQUEST_TIMEOUT_MS = 15_000;

function endpoints(config: Pick<NetworkConfig, 'rpcUrl' | 'rpcFallbackUrl' | 'rpcFallbackUrls'>): string[] {
  return [...new Set([config.rpcUrl, config.rpcFallbackUrl, ...(config.rpcFallbackUrls ?? [])]
    .filter((url): url is string => Boolean(url?.trim())))];
}

async function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('RPC request timed out')), RPC_REQUEST_TIMEOUT_MS); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* Every read can fail over independently. The last healthy endpoint is tried
   first on the next request, so a failed primary does not slow every refresh. */
export class FailoverProvider extends JsonRpcProvider {
  private readonly fallbacks: JsonRpcProvider[];
  private active = 0;

  constructor(config: Pick<NetworkConfig, 'rpcUrl' | 'rpcFallbackUrl' | 'rpcFallbackUrls' | 'chainId'>) {
    const urls = endpoints(config);
    if (!urls.length) throw new Error('This network has no RPC connection');
    super(urls[0], config.chainId, { staticNetwork: true });
    this.fallbacks = urls.slice(1).map((url) => new JsonRpcProvider(url, config.chainId, { staticNetwork: true }));
  }

  override async send(method: string, params: Array<unknown>): Promise<unknown> {
    const count = this.fallbacks.length + 1;
    let lastError: unknown = new Error('No RPC endpoint is available');
    for (let offset = 0; offset < count; offset += 1) {
      const index = (this.active + offset) % count;
      try {
        const request = index === 0 ? super.send(method, params) : this.fallbacks[index - 1].send(method, params);
        const result = await withTimeout(request);
        this.active = index;
        return result;
      } catch (error) {
        lastError = error;
        // A peer may already have accepted a transaction when another node's
        // response was lost. Treat an explicit duplicate response as accepted.
        if (method === 'eth_sendRawTransaction' && /already known|known transaction|already exists/i.test(String(error))) {
          this.active = index;
          return ethers.keccak256(String(params[0]));
        }
      }
    }
    throw lastError;
  }

  override destroy(): void {
    for (const provider of this.fallbacks) provider.destroy();
    super.destroy();
  }
}

const shared = new Map<string, FailoverProvider>();
export function createRpcProvider(config: NetworkConfig): FailoverProvider {
  const urls = endpoints(config);
  const key = `${config.chainId}:${urls.join('|')}`;
  let provider = shared.get(key);
  if (!provider) {
    provider = new FailoverProvider(config);
    shared.set(key, provider);
  }
  return provider;
}
