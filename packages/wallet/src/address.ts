import { bech32m } from '@scure/base';

export const SWIRL_ADDRESS_PREFIX = 'swirl';
export const SWIRL_ADDRESS_VERSION = 1;
const ADDRESS_BYTES = 70;
const ADDRESS_LIMIT = 140;

export type SwirlAddressData = {
  version: number;
  chainId: number;
  spendingPublicKey: Uint8Array;
  viewingPublicKey: Uint8Array;
};

export function encodeSwirlAddress(data: Omit<SwirlAddressData, 'version'>): string {
  if (!Number.isInteger(data.chainId) || data.chainId < 0 || data.chainId > 0xffffffff) {
    throw new Error('Invalid chain ID');
  }
  if (data.spendingPublicKey.length !== 32 || data.viewingPublicKey.length !== 33) {
    throw new Error('Invalid SWIRL public key length');
  }
  const payload = new Uint8Array(ADDRESS_BYTES);
  payload[0] = SWIRL_ADDRESS_VERSION;
  new DataView(payload.buffer).setUint32(1, data.chainId, false);
  payload.set(data.spendingPublicKey, 5);
  payload.set(data.viewingPublicKey, 37);
  return bech32m.encode(SWIRL_ADDRESS_PREFIX, bech32m.toWords(payload), ADDRESS_LIMIT);
}

export function decodeSwirlAddress(address: string): SwirlAddressData {
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    throw new Error('Mixed-case SWIRL address');
  }
  const decoded = bech32m.decode(address.toLowerCase(), ADDRESS_LIMIT);
  if (decoded.prefix !== SWIRL_ADDRESS_PREFIX) throw new Error('Not a SWIRL address');
  const payload = bech32m.fromWords(decoded.words);
  if (payload.length !== ADDRESS_BYTES) throw new Error('Invalid SWIRL address length');
  if (payload[0] !== SWIRL_ADDRESS_VERSION) throw new Error('Unsupported SWIRL address version');
  return {
    version: payload[0],
    chainId: new DataView(payload.buffer).getUint32(1, false),
    spendingPublicKey: payload.slice(5, 37),
    viewingPublicKey: payload.slice(37, 70),
  };
}

export function isSwirlAddress(address: string, chainId?: number): boolean {
  try {
    const decoded = decodeSwirlAddress(address);
    return chainId === undefined || decoded.chainId === chainId;
  } catch {
    return false;
  }
}
