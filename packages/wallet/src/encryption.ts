import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { decodeSwirlAddress } from './address.js';
import { ownerFromSecret, type SwirlNote } from './notes.js';

const VERSION = 1;
const NONCE_BYTES = 24;
const EPHEMERAL_KEY_BYTES = 33;
const HEADER_BYTES = 1 + EPHEMERAL_KEY_BYTES + NONCE_BYTES;
const AAD = new TextEncoder().encode('SWIRL_NOTE_V1');

function encryptionKey(secret: Uint8Array, publicKey: Uint8Array): Uint8Array {
  return sha256(secp256k1.getSharedSecret(secret, publicKey, true));
}

export function encryptNote(note: SwirlNote, recipientAddress: string): Uint8Array {
  const recipient = decodeSwirlAddress(recipientAddress);
  const ephemeralSecret = secp256k1.utils.randomSecretKey();
  const ephemeralPublic = secp256k1.getPublicKey(ephemeralSecret, true);
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const plaintext = new TextEncoder().encode(JSON.stringify({
    owner: note.owner.toString(),
    token: note.token.toString(),
    amount: note.amount.toString(),
    randomness: note.randomness.toString(),
  }));
  const encrypted = xchacha20poly1305(encryptionKey(ephemeralSecret, recipient.viewingPublicKey), nonce, AAD).encrypt(plaintext);
  const result = new Uint8Array(HEADER_BYTES + encrypted.length);
  result[0] = VERSION;
  result.set(ephemeralPublic, 1);
  result.set(nonce, 1 + EPHEMERAL_KEY_BYTES);
  result.set(encrypted, HEADER_BYTES);
  return result;
}

export async function decryptNote(
  ciphertext: Uint8Array,
  viewingSecretKey: Uint8Array,
  ownerSecret: bigint,
): Promise<SwirlNote | null> {
  if (ciphertext.length <= HEADER_BYTES + 16 || ciphertext[0] !== VERSION) return null;
  try {
    const ephemeralPublic = ciphertext.slice(1, 1 + EPHEMERAL_KEY_BYTES);
    const nonce = ciphertext.slice(1 + EPHEMERAL_KEY_BYTES, HEADER_BYTES);
    const encrypted = ciphertext.slice(HEADER_BYTES);
    const plaintext = xchacha20poly1305(encryptionKey(viewingSecretKey, ephemeralPublic), nonce, AAD).decrypt(encrypted);
    const parsed = JSON.parse(new TextDecoder().decode(plaintext)) as Record<keyof SwirlNote, string>;
    const note: SwirlNote = {
      owner: BigInt(parsed.owner),
      token: BigInt(parsed.token),
      amount: BigInt(parsed.amount),
      randomness: BigInt(parsed.randomness),
    };
    if (note.owner !== (await ownerFromSecret(ownerSecret))) return null;
    return note;
  } catch {
    return null;
  }
}
