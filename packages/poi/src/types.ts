import type { Groth16Proof } from 'snarkjs';

export type POIEventType = 'Shield' | 'Transact' | 'Unshield';
export type POIStatus = 'Valid' | 'ShieldBlocked' | 'ShieldPending' | 'ProofSubmitted' | 'Missing';

export type SignedPOIEvent = {
  index: number;
  blindedCommitment: string;
  signature: string;
  type: POIEventType;
  merkleRoot: string;
};

export type ShieldRecord = {
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  leafIndex: number;
  commitment: string;
  owner: string;
  from: string;
  timestamp: number;
  blindedCommitment: string;
  status: 'Pending' | 'Allowed' | 'Blocked' | 'AddedPOI';
  blockReason?: string;
};

export type TransactionRecord = {
  transactionHash: string;
  blockNumber: number;
  logIndex: number;
  txidIndex: number;
  txid: string;
  txidLeaf: string;
  txidMerkleRoot: string;
  nullifiers: [string, string];
  outputCommitments: [string, string, string, string];
  ciphertextHash: string;
  publicAmount: string;
  publicRecipient: string;
  token: string;
  chainId: string;
  firstLeafIndex: number;
};

export type POIProofSubmission = {
  proof: Groth16Proof;
  publicSignals: string[];
  blindedCommitmentsOut: string[];
  txid: string;
  txidIfHasUnshield: string;
  txidMerkleRoot: string;
  txidMerkleRootIndex: number;
  poiMerkleRoots: string[];
};

export type PersistedPOIState = {
  version: 1;
  chainId: string;
  vault: string;
  lastScannedBlock: number;
  shields: ShieldRecord[];
  events: SignedPOIEvent[];
  transactions: TransactionRecord[];
};

export type ListDecision = { shouldAllow: boolean; blockReason?: string };
export type ListProvider = {
  shouldAllowShield(input: { transactionHash: string; fromAddressLowercase: string; timestamp: number }): Promise<ListDecision>;
  readonly stats?: unknown;
};

export type POICoreOptions = {
  chainId: bigint;
  vault: string;
  listKey: string;
  signMessage(message: Uint8Array): Promise<Uint8Array>;
  verificationKey: unknown;
  listProvider: ListProvider;
  shieldPendingSeconds?: number;
  persisted?: PersistedPOIState;
  onStateChanged?: () => Promise<void>;
};
