import http from 'node:http';
import type { VaultIndexer } from './indexer.js';

export type IndexerServerOptions = {
  rateLimitPerMinute?: number;
  trustProxy?: boolean;
  maxTrackedClients?: number;
};

function clientAddress(request: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers['x-forwarded-for'];
    const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(',')[0].trim();
    if (first) return first;
  }
  return request.socket.remoteAddress ?? 'unknown';
}

function withinRateLimit(
  requests: Map<string, { reset: number; count: number }>, key: string,
  limit: number, maxTrackedClients: number,
): boolean {
  const now = Date.now();
  if (requests.size >= maxTrackedClients) {
    for (const [ip, quota] of requests) if (quota.reset <= now) requests.delete(ip);
  }
  const quota = requests.get(key);
  if (!quota || quota.reset <= now) {
    if (!quota && requests.size >= maxTrackedClients) return false;
    requests.set(key, { reset: now + 60_000, count: 1 });
    return true;
  }
  quota.count += 1;
  return quota.count <= limit;
}

export function createIndexerServer(indexer: VaultIndexer, corsOrigin = '*', options: IndexerServerOptions = {}): http.Server {
  const rateLimit = options.rateLimitPerMinute ?? 60;
  const maxTrackedClients = options.maxTrackedClients ?? 10_000;
  const trustProxy = options.trustProxy ?? false;
  if (![rateLimit, maxTrackedClients].every((value) => Number.isInteger(value) && value > 0)) {
    throw new Error('Indexer rate and client limits must be positive integers');
  }
  const requests = new Map<string, { reset: number; count: number }>();
  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [ip, quota] of requests) if (quota.reset <= now) requests.delete(ip);
  }, 60_000);
  cleanup.unref();

  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('access-control-allow-origin', corsOrigin);
    response.setHeader('access-control-allow-methods', 'GET, OPTIONS');
    const send = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    };
    if (request.method === 'OPTIONS') return send(204, {});
    const ip = clientAddress(request, trustProxy);
    if (!withinRateLimit(requests, ip, rateLimit, maxTrackedClients)) return send(429, { error: 'Rate limit exceeded' });
    try {
      if (request.method === 'GET' && request.url === '/health') {
        const snapshot = await indexer.sync();
        return send(200, { ok: true, chainId: snapshot.chainId, vault: snapshot.vault, lastScannedBlock: snapshot.lastScannedBlock, events: snapshot.events.length });
      }
      if (request.method === 'GET' && request.url === '/events') return send(200, await indexer.sync());
      return send(404, { error: 'Not found' });
    } catch (error) {
      return send(503, { error: error instanceof Error ? error.message : 'Indexer unavailable' });
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.on('close', () => clearInterval(cleanup));
  return server;
}
