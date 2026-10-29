import { ethers, type TransactionReceipt } from 'ethers';
import {
  createPOIProof, swirlBoundParamsHash, swirlTransactionID, walletFingerprint,
  type POIProofResult, type SwirlWallet,
} from '@swirl/wallet';
import type { AssetConfig, NetworkConfig } from './network';
import {
  ciphertextHash, poiClientFor,
  type PendingPOITransaction, type PrivateTransactionResult,
} from './protocol';

const STORAGE_KEY = 'swirl.poi.pending.v1';
const TRANSACTED = new ethers.Interface([
  'event Transacted(bytes32[2] nullifiers, bytes32[4] commitments, bytes[4] ciphertexts, uint32 firstLeafIndex)',
]);

type EncryptedPending = { walletFingerprint: string; iv: string; ciphertext: string };
type PendingStore = Record<string, EncryptedPending>;

function jsonStringify(value: unknown): string {
  return JSON.stringify(value, (_, item) => typeof item === 'bigint' ? `${item.toString()}n` : item);
}
function jsonParse(text: string): unknown {
  return JSON.parse(text, (_, value) => typeof value === 'string' && /^-?[0-9]+n$/.test(value) ? BigInt(value.slice(0, -1)) : value);
}
function base64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
async function encryptionKey(wallet: SwirlWallet): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', wallet.noteSecretKey as BufferSource, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}
async function readStore(): Promise<PendingStore> {
  const raw = typeof chrome !== 'undefined' && chrome.storage?.local
    ? (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY]
    : localStorage.getItem(STORAGE_KEY);
  if (!raw) return {};
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('Invalid pending PPOI store');
  return parsed as PendingStore;
}
async function writeStore(store: PendingStore): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY]: store });
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
}
async function encryptPending(pending: PendingPOITransaction, wallet: SwirlWallet): Promise<EncryptedPending> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(jsonStringify(pending));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await encryptionKey(wallet), plaintext);
  return { walletFingerprint: pending.walletFingerprint, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) };
}
async function decryptPending(record: EncryptedPending, wallet: SwirlWallet): Promise<PendingPOITransaction> {
  if (record.walletFingerprint !== walletFingerprint(wallet)) throw new Error('Pending PPOI record belongs to another wallet');
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromBase64(record.iv) as BufferSource },
    await encryptionKey(wallet), fromBase64(record.ciphertext) as BufferSource,
  );
  const pending = jsonParse(new TextDecoder().decode(plaintext)) as PendingPOITransaction;
  if (pending.version !== 1 || pending.walletFingerprint !== record.walletFingerprint) throw new Error('Invalid pending PPOI record');
  return pending;
}

function firstLeafIndex(receipt: TransactionReceipt, result: PrivateTransactionResult): number {
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== result.poi.vault.toLowerCase()) continue;
    try {
      const parsed = TRANSACTED.parseLog({ topics: [...log.topics], data: log.data });
      if (!parsed) continue;
      const nullifiers = [...parsed.args[0]] as string[];
      const commitments = [...parsed.args[1]] as string[];
      if (nullifiers.every((value, index) => BigInt(value) === BigInt(result.poi.payload.nullifiers[index]))
        && commitments.every((value, index) => BigInt(value) === BigInt(result.poi.payload.outputCommitments[index]))) {
        const first = Number(parsed.args[3]);
        if (Number.isSafeInteger(first) && first > 0) return first;
      }
    } catch { /* Not the vault Transacted event. */ }
  }
  throw new Error('The confirmed transaction does not contain the expected SWIRL Transacted event');
}

export async function savePendingPOI(result: PrivateTransactionResult, wallet: SwirlWallet): Promise<PendingPOITransaction> {
  if (!result.receipt || result.receipt.status !== 1) throw new Error('PPOI can only follow a successful confirmed transaction');
  const pending: PendingPOITransaction = {
    version: 1,
    walletFingerprint: walletFingerprint(wallet),
    ...result.poi,
    transactionHash: result.receipt.hash,
    firstLeafIndex: firstLeafIndex(result.receipt, result),
    createdAt: Date.now(),
  };
  const store = await readStore();
  store[`${pending.chainId}:${pending.transactionHash.toLowerCase()}`] = await encryptPending(pending, wallet);
  await writeStore(store);
  return pending;
}

async function transactionID(pending: PendingPOITransaction): Promise<bigint> {
  const payload = pending.payload;
  return swirlTransactionID({
    nullifiers: payload.nullifiers.map(BigInt) as [bigint, bigint],
    outputCommitments: payload.outputCommitments.map(BigInt) as [bigint, bigint, bigint, bigint],
    boundParamsHash: await awaitBoundParams(pending),
  });
}
function awaitBoundParams(pending: PendingPOITransaction): Promise<bigint> {
  return swirlBoundParamsHash({
    ciphertextHash: ciphertextHash(pending.payload.ciphertexts),
    publicAmount: BigInt(pending.payload.publicAmount),
    publicRecipient: BigInt(pending.payload.publicRecipient),
    token: BigInt(pending.token),
    chainId: BigInt(pending.chainId),
  });
}
function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
function assertTransactionRecord(pending: PendingPOITransaction, record: {
  nullifiers: string[]; outputCommitments: string[]; ciphertextHash: string;
  publicAmount: string; publicRecipient: string; token: string; firstLeafIndex: number;
}): void {
  const matches = record.nullifiers.every((value, index) => BigInt(value) === BigInt(pending.payload.nullifiers[index]))
    && record.outputCommitments.every((value, index) => BigInt(value) === BigInt(pending.payload.outputCommitments[index]))
    && BigInt(record.ciphertextHash) === ciphertextHash(pending.payload.ciphertexts)
    && BigInt(record.publicAmount) === BigInt(pending.payload.publicAmount)
    && BigInt(record.publicRecipient) === BigInt(pending.payload.publicRecipient)
    && BigInt(record.token) === BigInt(pending.token)
    && record.firstLeafIndex === pending.firstLeafIndex;
  if (!matches) throw new Error('PPOI node transaction data does not match the confirmed wallet transaction');
}

export async function submitPendingPOI(
  pending: PendingPOITransaction, wallet: SwirlWallet, config: NetworkConfig, asset: AssetConfig,
): Promise<POIProofResult> {
  if (pending.chainId !== config.chainId || pending.vault.toLowerCase() !== asset.vault.toLowerCase()
    || pending.token.toLowerCase() !== asset.token.toLowerCase()) throw new Error('Pending PPOI transaction is on another network or asset');
  const client = poiClientFor(config, asset);
  if (!client) throw new Error('PPOI node is not configured');
  const txid = `0x${(await transactionID(pending)).toString(16).padStart(64, '0')}`;
  let confirmed: Awaited<ReturnType<typeof client.getTransaction>> | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 45; attempt++) {
    try {
      confirmed = await client.getTransaction(txid);
      break;
    } catch (error) {
      lastError = error;
      if (attempt < 44) await delay(2000);
    }
  }
  if (!confirmed) throw new Error(`PPOI node has not indexed the confirmed transaction: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
  assertTransactionRecord(pending, confirmed.transaction);
  const paths = await client.getPOIPaths(pending.inputs.map((item) => `0x${item.blindedCommitment.toString(16).padStart(64, '0')}`));
  const ownerSecret = BigInt(`0x${Buffer.from(wallet.noteSecretKey).toString('hex')}`);
  const inputs = pending.inputs.map((item, index) => ({
    note: item.note, ownerSecret, poiMerklePath: paths[index],
  }));
  if (inputs.length < 1 || inputs.length > 2) throw new Error('Invalid pending PPOI input count');
  const proof = await createPOIProof({
    inputs: inputs as [{ note: PendingPOITransaction['inputs'][number]['note']; ownerSecret: bigint; poiMerklePath: typeof paths[number] }] | [
      { note: PendingPOITransaction['inputs'][number]['note']; ownerSecret: bigint; poiMerklePath: typeof paths[number] },
      { note: PendingPOITransaction['inputs'][number]['note']; ownerSecret: bigint; poiMerklePath: typeof paths[number] },
    ],
    outputs: pending.outputs,
    transaction: {
      nullifiers: pending.payload.nullifiers.map(BigInt) as [bigint, bigint],
      outputCommitments: pending.payload.outputCommitments.map(BigInt) as [bigint, bigint, bigint, bigint],
      ciphertextHash: ciphertextHash(pending.payload.ciphertexts), publicAmount: BigInt(pending.payload.publicAmount),
      publicRecipient: BigInt(pending.payload.publicRecipient), token: BigInt(pending.token), chainId: BigInt(pending.chainId),
      firstLeafIndex: pending.firstLeafIndex, txidMerklePath: confirmed.path,
    },
    assets: { wasm: './proving/swirl_poi.wasm', zkey: './proving/swirl_poi_final.zkey' },
  });
  await client.submitProof(proof);
  const store = await readStore();
  delete store[`${pending.chainId}:${pending.transactionHash.toLowerCase()}`];
  await writeStore(store);
  return proof;
}

export async function retryPendingPOI(
  wallet: SwirlWallet, config: NetworkConfig, asset: AssetConfig,
): Promise<{ completed: number; failed: number; errors: string[] }> {
  const store = await readStore();
  const fingerprint = walletFingerprint(wallet);
  const pending: PendingPOITransaction[] = [];
  for (const record of Object.values(store)) {
    if (record.walletFingerprint !== fingerprint) continue;
    try {
      const item = await decryptPending(record, wallet);
      if (item.chainId === config.chainId && item.vault.toLowerCase() === asset.vault.toLowerCase()
        && item.token.toLowerCase() === asset.token.toLowerCase()) pending.push(item);
    } catch { /* Another key or a damaged record cannot be used for proving. */ }
  }
  let completed = 0;
  const errors: string[] = [];
  for (const item of pending.sort((a, b) => a.createdAt - b.createdAt)) {
    try { await submitPendingPOI(item, wallet, config, asset); completed++; }
    catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  }
  return { completed, failed: errors.length, errors };
}
