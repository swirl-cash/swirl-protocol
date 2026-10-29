import { createSwirlWallet, type SwirlWallet } from '@swirl/wallet';

const STORAGE_KEY = 'swirl.encrypted-wallet.v1';
const PBKDF2_ITERATIONS = 310_000;

type StoredWallet = {
  version: 1;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  cipher: 'AES-256-GCM';
  salt: string;
  iv: string;
  ciphertext: string;
};

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function parseRecord(raw: unknown): StoredWallet | null {
  if (!raw) return null;
  const record = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (record.version !== 1 || record.kdf !== 'PBKDF2-SHA256' || record.cipher !== 'AES-256-GCM'
    || !Number.isInteger(record.iterations) || record.iterations < 100_000
    || typeof record.salt !== 'string' || typeof record.iv !== 'string' || typeof record.ciphertext !== 'string') {
    throw new Error('Unsupported encrypted wallet record');
  }
  return record as StoredWallet;
}

async function readRaw(): Promise<unknown> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    return (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  }
  return localStorage.getItem(STORAGE_KEY);
}

async function writeRaw(record: StoredWallet): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY]: record });
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(record));
}

async function deriveKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, material,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function hasEncryptedWallet(): Promise<boolean> {
  try { return parseRecord(await readRaw()) !== null; } catch { return true; }
}

export async function createEncryptedWallet(password: string, mnemonic?: string, chainId = 1): Promise<SwirlWallet> {
  if (password.length < 12) throw new Error('Use at least 12 characters for your password');
  const wallet = await createSwirlWallet(chainId, mnemonic?.trim());
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const plaintext = new TextEncoder().encode(JSON.stringify({ mnemonic: wallet.mnemonic, chainId: wallet.chainId }));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  await writeRaw({
    version: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, cipher: 'AES-256-GCM',
    salt: toBase64(salt), iv: toBase64(iv), ciphertext: toBase64(new Uint8Array(encrypted)),
  });
  return wallet;
}

export async function unlockEncryptedWallet(password: string, chainId?: number): Promise<SwirlWallet> {
  const record = parseRecord(await readRaw());
  if (!record) throw new Error('No encrypted wallet is saved in this browser');
  try {
    const key = await deriveKey(password, fromBase64(record.salt), record.iterations);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: fromBase64(record.iv) as BufferSource }, key, fromBase64(record.ciphertext) as BufferSource,
    );
    const payload = JSON.parse(new TextDecoder().decode(decrypted)) as { mnemonic: string; chainId: number };
    if (!Number.isInteger(payload.chainId) || typeof payload.mnemonic !== 'string') throw new Error('Invalid wallet payload');
    return await createSwirlWallet(chainId ?? payload.chainId, payload.mnemonic);
  } catch {
    throw new Error('Incorrect password or damaged encrypted wallet');
  }
}
