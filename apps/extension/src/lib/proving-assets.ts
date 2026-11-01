import brotliDecompress from 'brotli/decompress';

const ARTIFACT_COMMIT = 'fa4652a392bd4aa70e394f58ee0498feedfb7ce7';
const IPFS_ROOT = 'https://gateway.pinata.cloud/ipfs/QmVD4i6wenndzEhKWFogkB1sqAjvLCYDgkdmUCvyUFr25E';
const CACHE_ROOT = `https://fastly.jsdelivr.net/gh/swirl-cash/swirl-protocol@${ARTIFACT_COMMIT}/apps/web/public/proving`;
const CDN_ROOTS = [
  IPFS_ROOT,
  `https://gcore.jsdelivr.net/gh/swirl-cash/swirl-protocol@${ARTIFACT_COMMIT}/apps/web/public/proving`,
  CACHE_ROOT,
];
const CACHE_NAME = 'swirl-proving-artifacts-v2';
const DOWNLOAD_STALL_TIMEOUT_MS = 20_000;

const ARTIFACTS = {
  transfer: {
    wasm: { file: 'swirl_transfer.wasm.br', sha256: '8953d86b90fbfc32293b5ebafa16d130781d35de36af3cc0219bc7cacd969065' },
    zkey: { file: 'swirl_transfer_final.zkey.br', sha256: '829a3be016ff19fdaad6040dc5f04d06fad79400a01dea6d7fe0685bfa03b598' },
  },
  poi: {
    wasm: { file: 'swirl_poi.wasm.br', sha256: 'be470cbdf4faaec86b41c9ea2b88dc359b75fea0c81e784118d368698777954c' },
    zkey: { file: 'swirl_poi_final.zkey.br', sha256: 'cc61de5b3030a73127c7267f12bf9514797d2ddfce0f65e3113507657bcf698f' },
  },
} as const;

type ArtifactKind = keyof typeof ARTIFACTS;
type Artifact = { file: string; sha256: string };
type ProgressCallback = (progress: number) => void;
export type ProvingAssets = { wasm: Uint8Array; zkey: Uint8Array };

const memoryCache = new Map<ArtifactKind, Promise<ProvingAssets>>();
const progressListeners = new Map<ArtifactKind, Set<ProgressCallback>>();
const progressValues = new Map<ArtifactKind, number>();

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, '0')).join('');
}
function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}
async function validBytes(bytes: Uint8Array, expectedHash: string): Promise<Uint8Array> {
  const digest = await crypto.subtle.digest('SHA-256', exactBuffer(bytes));
  if (hex(digest) !== expectedHash) throw new Error('Proving resource integrity check failed');
  return bytes;
}
async function fetchCompressed(url: string, onProgress: ProgressCallback): Promise<Uint8Array> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const resetStallTimer = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), DOWNLOAD_STALL_TIMEOUT_MS);
  };
  resetStallTimer();
  try {
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`Proving resource returned HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    if (!response.body) return new Uint8Array(await response.arrayBuffer());
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      resetStallTimer();
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        resetStallTimer();
        chunks.push(value);
        received += value.length;
        onProgress(total > 0 ? Math.min(received / total, 1) * 0.8 : 0);
      }
    }
    const compressed = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) { compressed.set(chunk, offset); offset += chunk.length; }
    return compressed;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Proving resource download stalled for 20 seconds');
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
async function readCached(cacheKey: string, expectedHash: string): Promise<Uint8Array | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(CACHE_NAME);
    const response = await cache.match(cacheKey);
    if (!response) return null;
    return await validBytes(new Uint8Array(await response.arrayBuffer()), expectedHash);
  } catch {
    try { await (await caches.open(CACHE_NAME)).delete(cacheKey); } catch { /* Best effort. */ }
    return null;
  }
}
async function storeCached(cacheKey: string, bytes: Uint8Array): Promise<void> {
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(cacheKey, new Response(exactBuffer(bytes), { headers: { 'content-type': 'application/octet-stream' } }));
  } catch { /* Storage quotas must not block proving. */ }
}
async function loadArtifact(artifact: Artifact, onProgress: ProgressCallback): Promise<Uint8Array> {
  const cacheKey = `${CACHE_ROOT}/${artifact.file}`;
  const cached = await readCached(cacheKey, artifact.sha256);
  if (cached) { onProgress(1); return cached; }
  const sources = [...CDN_ROOTS.map((root) => `${root}/${artifact.file}`), `./proving/${artifact.file}`];
  const errors: string[] = [];
  for (const url of sources) {
    try {
      const compressed = await fetchCompressed(url, onProgress);
      onProgress(0.9);
      // Some static hosts serve .br with Content-Encoding: br, so fetch already
      // returns plain bytes. Accept either form, but only after the SHA-256 check.
      let decompressed: Uint8Array;
      try { decompressed = brotliDecompress(compressed) as Uint8Array; }
      catch { decompressed = compressed; }
      const bytes = await validBytes(decompressed, artifact.sha256);
      await storeCached(cacheKey, bytes);
      onProgress(1);
      return bytes;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(`Could not load ${artifact.file}. Check your connection and try again. ${errors.at(-1) ?? ''}`.trim());
}
function emitProgress(kind: ArtifactKind, progress: number) {
  progressValues.set(kind, progress);
  progressListeners.get(kind)?.forEach((listener) => listener(progress));
}
function attachProgress(kind: ArtifactKind, pending: Promise<ProvingAssets>, onProgress?: ProgressCallback) {
  if (!onProgress) return;
  const listeners = progressListeners.get(kind) ?? new Set<ProgressCallback>();
  progressListeners.set(kind, listeners);
  listeners.add(onProgress);
  onProgress(progressValues.get(kind) ?? 0);
  void pending.then(() => listeners.delete(onProgress), () => listeners.delete(onProgress));
}
function loadAssets(kind: ArtifactKind, onProgress?: ProgressCallback): Promise<ProvingAssets> {
  const existing = memoryCache.get(kind);
  if (existing) {
    attachProgress(kind, existing, onProgress);
    return existing;
  }
  const fractions = [0, 0];
  const report = (index: number, fraction: number) => {
    fractions[index] = fraction;
    emitProgress(kind, Math.round((fractions[0] + fractions[1]) * 50));
  };
  const pending = Promise.all([
    loadArtifact(ARTIFACTS[kind].wasm, (fraction) => report(0, fraction)),
    loadArtifact(ARTIFACTS[kind].zkey, (fraction) => report(1, fraction)),
  ]).then(([wasm, zkey]) => {
    emitProgress(kind, 100);
    return { wasm, zkey };
  }).catch((error) => {
    memoryCache.delete(kind);
    throw error;
  });
  memoryCache.set(kind, pending);
  attachProgress(kind, pending, onProgress);
  return pending;
}
export function getTransferProvingAssets(onProgress?: ProgressCallback): Promise<ProvingAssets> {
  return loadAssets('transfer', onProgress);
}
export function getPoiProvingAssets(onProgress?: ProgressCallback): Promise<ProvingAssets> {
  return loadAssets('poi', onProgress);
}
