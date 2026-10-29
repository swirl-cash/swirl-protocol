import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils.js';
import type { POIEventType, SignedPOIEvent } from './types.js';

export function poiEventMessage(index: number, blindedCommitment: string, type: POIEventType): Uint8Array {
  return utf8ToBytes(JSON.stringify({ index, blindedCommitment, type }));
}

export function publicKeyFromSecret(privateKeyHex: string): string {
  return bytesToHex(ed25519.getPublicKey(hexToBytes(privateKeyHex)));
}

export function createEventSigner(privateKeyHex: string): (message: Uint8Array) => Promise<Uint8Array> {
  const privateKey = hexToBytes(privateKeyHex);
  if (privateKey.length !== 32) throw new Error('PPOI list private key must contain 32 bytes');
  return async (message: Uint8Array) => ed25519.sign(message, privateKey);
}

export async function verifySignedPOIEvent(event: SignedPOIEvent, listPublicKey: string): Promise<boolean> {
  try {
    return await ed25519.verify(
      hexToBytes(event.signature),
      poiEventMessage(event.index, event.blindedCommitment, event.type),
      hexToBytes(listPublicKey),
    );
  } catch {
    return false;
  }
}
