import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { PPOICore } from './core.js';
import { VaultPPOISync } from './chain-sync.js';
import { SwirlListProvider } from './list-provider.js';
import { createSepoliaFallbackProvider } from './rpc.js';
import { createEventSigner, publicKeyFromSecret } from './signer.js';
import { loadPOIState, savePOIState } from './persistence.js';

const vault = process.env.VAULT_ADDRESS;
if (!vault) throw new Error('VAULT_ADDRESS is required');
const privateKey = randomBytes(32).toString('hex');
const stateFile = path.resolve(process.env.PPOI_STATE_FILE ?? 'poi-sepolia-smoke-state.json');
const started = Date.now();
const memoryBefore = process.memoryUsage();
const { provider, health } = await createSepoliaFallbackProvider();
const core = await PPOICore.create({
  chainId: 11155111n,
  vault,
  listKey: publicKeyFromSecret(privateKey),
  signMessage: createEventSigner(privateKey),
  verificationKey: JSON.parse(await readFile(path.resolve('../contracts/build/circuits/swirl_poi_verification_key.json'), 'utf8')),
  listProvider: new SwirlListProvider({ mode: 'local-test' }),
  persisted: await loadPOIState(stateFile),
  onStateChanged: async () => savePOIState(stateFile, core.state),
});
const sync = new VaultPPOISync(provider, vault, core, Number(process.env.START_BLOCK ?? 0), 500, 1);
await sync.sync();
const stateSize = await stat(stateFile).then((info) => info.size).catch(() => 0);
console.log(JSON.stringify({
  ok: true,
  mode: 'local-test',
  notice: 'RPC and chain sync smoke only; local-test is not a production sanctions list.',
  rpc: health,
  stats: core.stats,
  durationMs: Date.now() - started,
  memory: {
    rssBefore: memoryBefore.rss,
    rssAfter: process.memoryUsage().rss,
    heapUsedBefore: memoryBefore.heapUsed,
    heapUsedAfter: process.memoryUsage().heapUsed,
  },
  stateBytes: stateSize,
}, null, 2));
provider.destroy();
