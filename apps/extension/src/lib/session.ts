import { createSwirlWallet, type SwirlWallet } from '@swirl/wallet';
import { UNLOCKED_SESSION_KEY as SESSION_KEY, WALLET_VIEW_SESSION_KEY as VIEW_KEY } from './session-constants';
const DB_NAME = 'swirl.session.crypto';
const STORE_NAME = 'keys';
const KEY_ID = 'tab-session-key';

type SessionRecord = { version: 1; iv: string; ciphertext: string };
type SessionPayload = { mnemonic: string; chainId: number };

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}
function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Session key storage failed'));
  });
}
async function openSessionDb(): Promise<IDBDatabase> {
  const request = indexedDB.open(DB_NAME, 1);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
  };
  return requestResult(request);
}
async function sessionKey(create: boolean): Promise<CryptoKey | null> {
  const db = await openSessionDb();
  try {
    const existing = await requestResult(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(KEY_ID));
    if (existing) return existing as CryptoKey;
    if (!create) return null;
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    await requestResult(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(key, KEY_ID));
    return key;
  } finally {
    db.close();
  }
}

/* The extension popup keeps its session across refresh/reopen in this browser tab.
   The mnemonic is AES-GCM encrypted with a non-extractable IndexedDB key. */
export async function saveUnlockedSession(wallet: SwirlWallet): Promise<void> {
  const key = await sessionKey(true);
  if (!key) throw new Error('Unable to create the wallet session key');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: SessionPayload = { mnemonic: wallet.mnemonic, chainId: wallet.chainId };
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)),
  );
  const record: SessionRecord = { version: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) };
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(record));
}

export async function restoreUnlockedSession(chainId?: number): Promise<SwirlWallet | null> {
  const raw = sessionStorage.getItem(SESSION_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as SessionRecord;
    if (record.version !== 1 || typeof record.iv !== 'string' || typeof record.ciphertext !== 'string') throw new Error('Invalid session');
    const key = await sessionKey(false);
    if (!key) throw new Error('Session key unavailable');
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(record.iv) as BufferSource }, key, fromBase64(record.ciphertext) as BufferSource,
    );
    const payload = JSON.parse(new TextDecoder().decode(decrypted)) as SessionPayload;
    if (typeof payload.mnemonic !== 'string' || !Number.isInteger(payload.chainId)) throw new Error('Invalid session payload');
    return await createSwirlWallet(chainId ?? payload.chainId, payload.mnemonic);
  } catch {
    sessionStorage.removeItem(SESSION_KEY);
    return null;
  }
}

type ViewSessionPayload = { chainId: number; account: string; view: unknown };

/* Only view data is cached. Notes, spending keys and the Merkle tree are never persisted. */
export async function saveWalletViewSnapshot(chainId: number, account: string, view: unknown): Promise<void> {
  const key = await sessionKey(false);
  if (!key) return;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const payload: ViewSessionPayload = { chainId, account, view };
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(payload)),
  );
  const record: SessionRecord = { version: 1, iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)) };
  sessionStorage.setItem(VIEW_KEY, JSON.stringify(record));
}

export async function restoreWalletViewSnapshot<T>(chainId: number, account: string): Promise<T | null> {
  const raw = sessionStorage.getItem(VIEW_KEY);
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as SessionRecord;
    if (record.version !== 1 || typeof record.iv !== 'string' || typeof record.ciphertext !== 'string') throw new Error('Invalid view session');
    const key = await sessionKey(false);
    if (!key) throw new Error('Session key unavailable');
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(record.iv) as BufferSource }, key, fromBase64(record.ciphertext) as BufferSource,
    );
    const payload = JSON.parse(new TextDecoder().decode(decrypted)) as ViewSessionPayload;
    if (payload.chainId !== chainId || payload.account.toLowerCase() !== account.toLowerCase()) return null;
    return payload.view as T;
  } catch {
    sessionStorage.removeItem(VIEW_KEY);
    return null;
  }
}

export async function clearUnlockedSession(): Promise<void> {
  sessionStorage.removeItem(SESSION_KEY);
  sessionStorage.removeItem(VIEW_KEY);
}
