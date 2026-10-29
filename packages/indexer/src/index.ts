import path from 'node:path';
import { JsonRpcProvider } from 'ethers';
import { VaultIndexer } from './indexer.js';
import { createIndexerServer } from './server.js';

const { RPC_URL, VAULT_ADDRESS, INDEXER_STATE_FILE, CORS_ORIGIN, TRUST_PROXY, NODE_ENV } = process.env;
if (!RPC_URL || !VAULT_ADDRESS) throw new Error('RPC_URL and VAULT_ADDRESS are required');
if (NODE_ENV === 'production' && !CORS_ORIGIN) throw new Error('CORS_ORIGIN is required in production');
if (TRUST_PROXY !== undefined && TRUST_PROXY !== 'true' && TRUST_PROXY !== 'false') throw new Error('Invalid TRUST_PROXY');
const integer = (value: string | undefined, fallback: number) => value === undefined ? fallback : Number(value);
const port = integer(process.env.PORT, 8788);
const fromBlock = integer(process.env.START_BLOCK, 0);
const batchSize = integer(process.env.BATCH_SIZE, 500);
const confirmations = integer(process.env.CONFIRMATIONS, 0);
const reorgLookback = integer(process.env.REORG_LOOKBACK, 64);
const rateLimitPerMinute = integer(process.env.RATE_LIMIT_PER_MINUTE, 60);
const maxTrackedClients = integer(process.env.MAX_TRACKED_CLIENTS, 10_000);
if (![port, fromBlock, batchSize, confirmations, reorgLookback, rateLimitPerMinute, maxTrackedClients].every(Number.isInteger)
  || port < 1 || port > 65535 || fromBlock < 0 || batchSize < 1 || confirmations < 0 || reorgLookback < 1
  || rateLimitPerMinute < 1 || maxTrackedClients < 1) {
  throw new Error('Invalid indexer numeric configuration');
}
const provider = new JsonRpcProvider(RPC_URL);
const indexer = new VaultIndexer(
  provider, VAULT_ADDRESS, path.resolve(INDEXER_STATE_FILE ?? 'indexer-state.json'),
  fromBlock, batchSize, confirmations, reorgLookback,
);
await indexer.init();
const server = createIndexerServer(indexer, CORS_ORIGIN, {
  rateLimitPerMinute, maxTrackedClients, trustProxy: TRUST_PROXY === 'true',
});
server.listen(port, '127.0.0.1', () => console.log(`SWIRL indexer listening on 127.0.0.1:${port}`));
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
