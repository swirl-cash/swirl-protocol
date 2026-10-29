import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ethers } from 'ethers';
import { PPOICore } from './core.js';
import { VaultPPOISync } from './chain-sync.js';
import { SwirlListProvider } from './list-provider.js';
import { OfacAddressList } from './ofac-list.js';
import { PublicAmlScreener } from './publicaml.js';
import { createFallbackProvider } from './rpc.js';
import { createPOIServer } from './server.js';
import { createEventSigner, publicKeyFromSecret } from './signer.js';
import { loadPOIState, savePOIState } from './persistence.js';

function integer(name: string, fallback: number, minimum = 0): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
}

const {
  VAULT_ADDRESS, PPOI_LIST_PRIVATE_KEY, PPOI_MODE,
  START_BLOCK, PPOI_STATE_FILE, PPOI_VKEY, PORT, CORS_ORIGIN, HOST,
  CHAIN_ID, RPC_URLS, RPC_URL, NODE_ENV, OFAC_CACHE_FILE,
  PUBLICAML_ENABLED, PUBLICAML_BLOCK_SCORE,
} = process.env;
if (!VAULT_ADDRESS || !ethers.isAddress(VAULT_ADDRESS)) throw new Error('A valid VAULT_ADDRESS is required');
if (!PPOI_LIST_PRIVATE_KEY || !/^[0-9a-fA-F]{64}$/.test(PPOI_LIST_PRIVATE_KEY)) {
  throw new Error('PPOI_LIST_PRIVATE_KEY must contain exactly 32 bytes');
}
if (PPOI_MODE !== 'local-test' && PPOI_MODE !== 'ofac') throw new Error('PPOI_MODE must be local-test or ofac');
if (!CHAIN_ID || !/^[1-9][0-9]*$/.test(CHAIN_ID)) throw new Error('CHAIN_ID is required');
const chainId = Number(CHAIN_ID);
if (!Number.isSafeInteger(chainId)) throw new Error('Invalid CHAIN_ID');
if (NODE_ENV === 'production') {
  if (PPOI_MODE !== 'ofac') throw new Error('Production PPOI requires PPOI_MODE=ofac');
  if (!CORS_ORIGIN) throw new Error('CORS_ORIGIN is required in production');
  if (START_BLOCK === undefined) throw new Error('START_BLOCK is required in production');
}
const startBlock = integer('START_BLOCK', 0);
const stateFile = path.resolve(PPOI_STATE_FILE ?? `poi-state-${chainId}.json`);
const verificationKey = JSON.parse(await readFile(path.resolve(PPOI_VKEY ?? '../contracts/build/circuits/swirl_poi_verification_key.json'), 'utf8'));
const ofacList = PPOI_MODE === 'ofac' ? new OfacAddressList({
  cacheFile: path.resolve(OFAC_CACHE_FILE ?? `ofac-addresses-${chainId}.json`),
}) : undefined;
await ofacList?.start();
const publicAmlEnabled = PPOI_MODE === 'ofac' && PUBLICAML_ENABLED !== 'false';
const publicAmlChain = chainId === 1 || chainId === 11155111 ? 'ETH' : chainId === 56 ? 'BSC' : undefined;
if (publicAmlEnabled && !publicAmlChain) throw new Error(`PublicAML does not support configured chain ${chainId}`);
const blockScore = PUBLICAML_BLOCK_SCORE === undefined ? undefined : Number(PUBLICAML_BLOCK_SCORE);
const publicAml = publicAmlEnabled ? new PublicAmlScreener({
  chain: publicAmlChain!,
  blockScore,
  fetchTimeoutMs: integer('PUBLICAML_TIMEOUT_MS', 8_000, 1),
}) : undefined;
const core = await PPOICore.create({
  chainId: BigInt(chainId),
  vault: VAULT_ADDRESS,
  listKey: publicKeyFromSecret(PPOI_LIST_PRIVATE_KEY),
  signMessage: createEventSigner(PPOI_LIST_PRIVATE_KEY),
  verificationKey,
  listProvider: new SwirlListProvider({
    mode: PPOI_MODE,
    ofacList,
    publicAml,
    publicAmlRequired: publicAmlEnabled,
  }),
  shieldPendingSeconds: integer('SHIELD_PENDING_SECONDS', chainId === 1 ? 3600 : 60),
  persisted: await loadPOIState(stateFile),
  onStateChanged: async () => savePOIState(stateFile, core.state),
});
const { provider, health } = await createFallbackProvider(chainId, RPC_URLS ?? RPC_URL);
console.log(`Chain ${chainId} RPC health`, health);
const sync = new VaultPPOISync(
  provider, VAULT_ADDRESS, core, startBlock,
  integer('LOG_BATCH_SIZE', 500, 1), integer('CONFIRMATIONS', 1),
);
await sync.sync();
const port = integer('PORT', 8790, 1);
if (port > 65535) throw new Error('Invalid PORT');
const host = HOST ?? '127.0.0.1';
const server = createPOIServer(core, sync, CORS_ORIGIN ?? '*');
server.listen(port, host, () => console.log(`SWIRL PPOI node listening on ${host}:${port}; chain=${chainId}; mode=${PPOI_MODE}`));
const timer = setInterval(() => sync.sync().catch((error) => console.error('PPOI sync failed', error)), 15_000);
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    clearInterval(timer);
    ofacList?.close();
    server.close(() => {
      if ('destroy' in provider && typeof provider.destroy === 'function') provider.destroy();
      process.exit(0);
    });
  });
}
