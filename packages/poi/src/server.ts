import http from 'node:http';
import type { PPOICore } from './core.js';
import type { VaultPPOISync } from './chain-sync.js';
import type { POIProofSubmission } from './types.js';

function json(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item);
}

function readBody(request: http.IncomingMessage, maxBytes: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      request.removeListener('data', onData);
      request.removeListener('end', onEnd);
      request.removeListener('error', onError);
    };
    const onError = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const onData = (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > maxBytes) {
        settled = true;
        cleanup();
        request.resume();
        reject(new Error('Request body too large'));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text ? JSON.parse(text) : {});
      } catch { reject(new Error('Invalid JSON request')); }
    };
    request.on('data', onData);
    request.on('end', onEnd);
    request.on('error', onError);
  });
}

export function createPOIServer(core: PPOICore, sync?: VaultPPOISync, corsOrigin = '*'): http.Server {
  const requests = new Map<string, { reset: number; count: number }>();
  const server = http.createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.setHeader('x-content-type-options', 'nosniff');
    response.setHeader('access-control-allow-origin', corsOrigin);
    response.setHeader('access-control-allow-headers', 'content-type');
    response.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS');
    const send = (status: number, body: unknown) => {
      response.writeHead(status);
      response.end(json(body));
    };
    if (request.method === 'OPTIONS') return send(204, {});
    const ip = request.socket.remoteAddress ?? 'unknown';
    const now = Date.now();
    if (requests.size > 10_000) for (const [key, quota] of requests) if (quota.reset <= now) requests.delete(key);
    const quota = requests.get(ip);
    if (!quota || quota.reset <= now) {
      if (requests.size >= 10_000) return send(429, { error: 'Too many clients' });
      requests.set(ip, { reset: now + 60_000, count: 1 });
    } else if (++quota.count > 120) return send(429, { error: 'Rate limit exceeded' });
    try {
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET' && url.pathname === '/health') {
        try { await sync?.sync(); } catch (error) {
          return send(503, { ok: false, error: error instanceof Error ? error.message : 'PPOI synchronization failed' });
        }
        return send(200, { ok: true, ...core.stats });
      }
      if (request.method === 'GET' && url.pathname === '/events') {
        const start = Number(url.searchParams.get('startIndex') ?? 0);
        const end = Number(url.searchParams.get('endIndex') ?? core.state.events.length);
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end - start > 1000) {
          return send(400, { error: 'Invalid event range' });
        }
        return send(200, { events: core.state.events.slice(start, end) });
      }
      if (request.method === 'POST' && url.pathname === '/status') {
        await sync?.sync();
        const body = await readBody(request, 131_072) as { blindedCommitments?: string[] };
        if (!Array.isArray(body.blindedCommitments) || body.blindedCommitments.length > 1000
          || body.blindedCommitments.some((item) => typeof item !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(item))) {
          return send(400, { error: 'Invalid blinded commitment list' });
        }
        return send(200, { statuses: Object.fromEntries(body.blindedCommitments.map((item) => [item, core.status(item)])) });
      }
      if (request.method === 'POST' && url.pathname === '/poi-proofs') {
        await sync?.sync();
        const body = await readBody(request, 131_072) as { blindedCommitments?: string[] };
        if (!Array.isArray(body.blindedCommitments) || body.blindedCommitments.length < 1 || body.blindedCommitments.length > 2
          || body.blindedCommitments.some((item) => typeof item !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(item))) {
          return send(400, { error: 'One or two blinded commitments are required' });
        }
        return send(200, {
          proofs: body.blindedCommitments.map((blindedCommitment) => ({
            blindedCommitment,
            event: core.getPOIEvent(blindedCommitment),
            proof: core.getPOIMerkleProof(blindedCommitment),
          })),
        });
      }
      if (request.method === 'POST' && url.pathname === '/validate-roots') {
        const body = await readBody(request, 4096) as { roots?: string[] };
        if (!Array.isArray(body.roots) || body.roots.length < 1 || body.roots.length > 2
          || body.roots.some((root) => typeof root !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(root))) {
          return send(400, { error: 'One or two POI roots are required' });
        }
        return send(200, { valid: body.roots.every((root) => core.hasPOIRoot(root)) });
      }
      if (request.method === 'POST' && url.pathname === '/txid-proof') {
        await sync?.sync();
        const body = await readBody(request, 4096) as { txid?: string };
        if (typeof body.txid !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(body.txid)) return send(400, { error: 'A valid txid is required' });
        return send(200, { transaction: core.getTransaction(body.txid), proof: core.getTxidMerkleProof(body.txid) });
      }
      if (request.method === 'POST' && url.pathname === '/submit-proof') {
        await sync?.sync();
        const body = await readBody(request, 1_048_576) as POIProofSubmission;
        const events = await core.submitProof(body);
        return send(200, { ok: true, events });
      }
      return send(404, { error: 'Not found' });
    } catch (error) {
      return send(400, { error: error instanceof Error ? error.message : 'PPOI request failed' });
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
