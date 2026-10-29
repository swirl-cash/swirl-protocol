import { Contract, ethers, HDNodeWallet, JsonRpcProvider, NonceManager, type Signer, type TransactionReceipt } from 'ethers';
import {
  blindedCommitment, bytesToBigint, createNoteForAddress, createPreTransactionPOIProof,
  createTransferProof, decryptNote, encryptNote, hex32, noteCommitment, noteNullifier,
  POINodeClient, SwirlMerkleTree, zeroNote,
  type POIProofResult, type POIStatus, type ProofInput, type SolidityProof, type SwirlNote, type SwirlWallet,
} from '@swirl/wallet';
import { validateNetwork, type AssetConfig, type NetworkConfig } from './network';

export type OwnedNote = {
  note: SwirlNote & { leafIndex: number };
  commitment: bigint;
  nullifier: bigint;
  blindedCommitment: bigint;
  spent: boolean;
  poiStatus?: POIStatus | 'Unavailable';
};
export type SyncedNotes = { notes: OwnedNote[]; tree: SwirlMerkleTree; poiError?: string };
export type ProofPayload = {
  proof: SolidityProof;
  root: string;
  nullifiers: [string, string];
  outputCommitments: [string, string, string, string];
  ciphertexts: [string, string, string, string];
  publicAmount: string;
  publicRecipient: string;
  quoteId?: string;
  preTransactionPOI?: POIProofResult;
};
export type PendingPOITransaction = {
  version: 1;
  walletFingerprint: string;
  chainId: number;
  vault: string;
  token: string;
  transactionHash: string;
  firstLeafIndex: number;
  payload: ProofPayload;
  inputs: OwnedNote[];
  outputs: SwirlNote[];
  createdAt: number;
};
export type PrivateTransactionResult = {
  receipt: TransactionReceipt | null;
  poi: Omit<PendingPOITransaction, 'version' | 'walletFingerprint' | 'transactionHash' | 'firstLeafIndex' | 'createdAt'>;
};
export type RelayQuote = {
  id: string;
  chainId: string;
  vault: string;
  token: string;
  feeAddress: string;
  feeAmount: string;
  expiresAt: number;
  gasEstimate?: string;
  gasLimit?: string;
  gasPrice?: string;
  overallBatchMinGasPrice?: string;
};
type RelayFeeConfig = {
  chainId: string; vault: string; token: string; relayer: string; feeAddress: string; dynamicGasFee: boolean;
};

export async function getRelayFeeConfig(config: NetworkConfig, asset: AssetConfig): Promise<RelayFeeConfig> {
  if (!config.relayerUrl) throw new Error('Relayer is not configured');
  const response = await fetch(`${config.relayerUrl.replace(/\/$/, '')}/fee-config?token=${encodeURIComponent(asset.token)}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  const fee = await response.json() as RelayFeeConfig & { error?: string };
  if (!response.ok) throw new Error(fee.error || 'Relayer fee configuration unavailable');
  if (fee.chainId !== config.chainId.toString() || fee.vault?.toLowerCase() !== asset.vault.toLowerCase()
    || fee.token?.toLowerCase() !== asset.token.toLowerCase() || !ethers.isAddress(fee.relayer)
    || typeof fee.feeAddress !== 'string' || typeof fee.dynamicGasFee !== 'boolean') throw new Error('Relayer returned an invalid fee configuration');
  return fee;
}

export async function getRelayQuote(config: NetworkConfig, asset: AssetConfig, gasEstimate?: bigint): Promise<RelayQuote> {
  if (!config.relayerUrl) throw new Error('Relayer is not configured');
  const gasQuery = gasEstimate === undefined ? '' : `&gasEstimate=${encodeURIComponent(gasEstimate.toString())}`;
  const response = await fetch(`${config.relayerUrl.replace(/\/$/, '')}/quote?token=${encodeURIComponent(asset.token)}${gasQuery}`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  const quote = await response.json() as RelayQuote & { error?: string };
  if (!response.ok) throw new Error(quote.error || 'Relayer quote unavailable');
  if (!/^[0-9a-f-]{36}$/.test(quote.id) || quote.chainId !== config.chainId.toString()
    || quote.vault?.toLowerCase() !== asset.vault.toLowerCase() || quote.token?.toLowerCase() !== asset.token.toLowerCase()
    || typeof quote.feeAddress !== 'string' || !/^(0|[1-9][0-9]*)$/.test(quote.feeAmount) || BigInt(quote.feeAmount) <= 0n
    || !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= Date.now()) throw new Error('Relayer returned an invalid quote');
  if (gasEstimate !== undefined && (quote.gasEstimate !== gasEstimate.toString()
    || !/^[1-9][0-9]*$/.test(quote.gasLimit ?? '') || !/^[1-9][0-9]*$/.test(quote.gasPrice ?? '')
    || quote.overallBatchMinGasPrice !== quote.gasPrice)) throw new Error('Relayer returned invalid dynamic Gas details');
  return quote;
}

async function prepareRelayProof(
  signer: Signer, config: NetworkConfig, asset: AssetConfig,
  build: (feeAmount: bigint, feeAddress: string) => Promise<Omit<ProofPayload, 'quoteId'>>,
  onQuote?: (quote: RelayQuote) => void,
): Promise<ProofPayload> {
  const feeConfig = await getRelayFeeConfig(config, asset);
  if (!feeConfig.dynamicGasFee) {
    const quote = await getRelayQuote(config, asset);
    onQuote?.(quote);
    return { ...await build(BigInt(quote.feeAmount), quote.feeAddress), quoteId: quote.id };
  }
  // Match upstream: estimate with a Dummy Proof, add its 9,000 Gas variance, and
  // re-estimate when the quoted fee changes the transaction's input/output shape.
  if (!signer.provider) throw new Error('Provider unavailable for Relay Gas estimation');
  const vault = new Contract(asset.vault, VAULT_ABI, signer.provider);
  let feeAmount = 1n;
  let previousShape = '';
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const candidate = await build(feeAmount, feeConfig.feeAddress);
    const shape = [
      candidate.nullifiers.filter((value) => BigInt(value) !== 0n).length,
      candidate.ciphertexts.filter((value) => value !== '0x').length,
      candidate.publicAmount === '0' ? 0 : 1,
    ].join(':');
    const estimated = await vault.transact.estimateGas(
      candidate.proof, candidate.root, candidate.nullifiers, candidate.outputCommitments,
      candidate.ciphertexts, candidate.publicAmount, candidate.publicRecipient, asset.token, { from: feeConfig.relayer },
    ) as bigint;
    const quote = await getRelayQuote(config, asset, estimated + 9_000n);
    onQuote?.(quote);
    // Like upstream, compare circuit/transaction sizes rather than the changing
    // fee or calldata-dependent Gas estimate. The 9,000 variance and 20% limit
    // buffer cover the remaining dummy-to-final calldata difference.
    if (shape === previousShape) {
      const final = BigInt(quote.feeAmount) === feeAmount
        ? candidate : await build(BigInt(quote.feeAmount), feeConfig.feeAddress);
      return { ...final, quoteId: quote.id };
    }
    previousShape = shape;
    feeAmount = BigInt(quote.feeAmount);
  }
  throw new Error('Dynamic Relay transaction shape did not stabilize after five attempts');
}

const VAULT_ABI = [
  'error InvalidFee()',
  'error InvalidCommitment()',
  'error InvalidRoot()',
  'error InvalidProof()',
  'error DuplicateNullifier()',
  'error TreeFull()',
  'error InvalidWithdrawal()',
  'error UnsupportedToken()',
  'function shield(address token, uint256 grossAmount, bytes32 commitment, bytes ciphertext, bytes32 owner, bytes32 randomness)',
  'function transact((uint256[2] a, uint256[2][2] b, uint256[2] c) proof, bytes32 root, bytes32[2] nullifiers, bytes32[4] outputCommitments, bytes[4] ciphertexts, uint256 publicAmount, address publicRecipient, address token)',
  'function nullifiers(bytes32) view returns (bool)',
  'function merkleRoot() view returns (bytes32)',
  'function zeroNoteCommitment() view returns (bytes32)',
  'function nextLeafIndex() view returns (uint32)',
  'event Shielded(uint32 indexed leafIndex, bytes32 indexed commitment, bytes ciphertext, uint256 amount, uint256 fee, bytes32 owner, address indexed token)',
  'event Transacted(bytes32[2] nullifiers, bytes32[4] commitments, bytes[4] ciphertexts, uint32 firstLeafIndex)',
];
const TOKEN_ABI = [
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address recipient, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function mint(address to, uint256 amount)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];
const GATEWAY_ABI = [
  'function shieldNative(bytes32 commitment, bytes ciphertext, bytes32 owner, bytes32 randomness) payable',
  'function unshieldNative((uint256[2] a, uint256[2][2] b, uint256[2] c) proof, bytes32 root, bytes32[2] nullifiers, bytes32[4] outputCommitments, bytes[4] ciphertexts, uint256 publicAmount)',
];

export function contracts(signer: Signer, config: NetworkConfig, asset: AssetConfig) {
  return {
    vault: new Contract(asset.vault, VAULT_ABI, signer),
    token: new Contract(asset.token, TOKEN_ABI, signer),
    gateway: asset.gateway ? new Contract(asset.gateway, GATEWAY_ABI, signer) : null,
  };
}

export async function connectNetwork(config: NetworkConfig, wallet: SwirlWallet, asset: AssetConfig) {
  validateNetwork(config);
  const provider = new JsonRpcProvider(config.rpcUrl, config.chainId, { staticNetwork: true });
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(config.chainId)) throw new Error(`RPC returned chain ${network.chainId}, expected ${config.chainId}`);
  const signer = new NonceManager(HDNodeWallet.fromPhrase(wallet.mnemonic).connect(provider));
  return { provider, signer, account: await signer.getAddress(), ...contracts(signer, config, asset) };
}

type ShieldRecord = { index: number; commitment: string; ciphertext: string };
type TransferRecord = { first: number; commitments: string[]; ciphertexts: string[] };
type EventRecords = { shields: ShieldRecord[]; transfers: TransferRecord[] };
const isBytes32 = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const isHex = (value: unknown): value is string => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
const isIndex = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

async function recordsFromIndexer(vault: Contract, zeroCommitment: string, indexerUrl: string): Promise<EventRecords> {
  if (!indexerUrl) throw new Error('Indexer is not configured');
  const provider = vault.runner?.provider;
  if (!provider) throw new Error('Vault provider is unavailable');
  const baseUrl = indexerUrl.replace(/\/$/, '');
  const [{ chainId }, response] = await Promise.all([
    provider.getNetwork(), fetch(`${baseUrl}/events`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!response.ok) throw new Error(`Indexer returned HTTP ${response.status}`);
  const snapshot = await response.json() as Record<string, unknown>;
  if (snapshot.version !== 3 || snapshot.chainId !== chainId.toString()
    || typeof snapshot.vault !== 'string' || snapshot.vault.toLowerCase() !== (await vault.getAddress()).toLowerCase()
    || snapshot.zeroCommitment !== zeroCommitment || !isBytes32(snapshot.lastBlockHash)
    || !isIndex(snapshot.lastScannedBlock) || !Array.isArray(snapshot.anchors)
    || !snapshot.anchors.every((anchor) => anchor && typeof anchor === 'object'
      && isIndex(anchor.blockNumber) && isBytes32(anchor.hash)) || !Array.isArray(snapshot.events)) {
    throw new Error('Indexer snapshot does not match this vault');
  }
  const shields: ShieldRecord[] = [];
  const transfers: TransferRecord[] = [];
  for (const raw of snapshot.events) {
    if (!raw || typeof raw !== 'object') throw new Error('Indexer returned a malformed event');
    const event = raw as Record<string, unknown>;
    if (!isIndex(event.blockNumber) || !isIndex(event.transactionIndex) || !isIndex(event.logIndex)
      || typeof event.transactionHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(event.transactionHash)
      || !isIndex(event.leafIndex)) throw new Error('Indexer returned invalid event metadata');
    if (event.kind === 'shield' && isBytes32(event.commitment) && isHex(event.ciphertext)) {
      shields.push({ index: event.leafIndex, commitment: event.commitment, ciphertext: event.ciphertext });
    } else if (event.kind === 'transacted' && Array.isArray(event.commitments) && event.commitments.length === 4
      && event.commitments.every(isBytes32) && Array.isArray(event.ciphertexts) && event.ciphertexts.length === 4
      && event.ciphertexts.every(isHex)) {
      transfers.push({ first: event.leafIndex, commitments: event.commitments, ciphertexts: event.ciphertexts });
    } else throw new Error('Indexer returned an invalid event payload');
  }
  return { shields, transfers };
}

async function recordsFromRpc(vault: Contract): Promise<EventRecords> {
  const [shieldEvents, transferEvents] = await Promise.all([
    vault.queryFilter('Shielded', 0), vault.queryFilter('Transacted', 0),
  ]);
  const shields: ShieldRecord[] = [];
  const transfers: TransferRecord[] = [];
  for (const event of shieldEvents) {
    if (!('args' in event)) continue;
    shields.push({ index: Number(event.args[0]), commitment: event.args[1], ciphertext: event.args[2] });
  }
  for (const event of transferEvents) {
    if (!('args' in event)) continue;
    transfers.push({ first: Number(event.args[3]), commitments: [...event.args[1]], ciphertexts: [...event.args[2]] });
  }
  return { shields, transfers };
}

async function reconstructValidatedTree(vault: Contract, records: EventRecords, zeroCommitment: string) {
  const commitments: bigint[] = [BigInt(zeroCommitment)];
  const encrypted: { index: number; ciphertext: string }[] = [];
  for (const event of records.shields) {
    commitments[event.index] = BigInt(event.commitment);
    encrypted.push({ index: event.index, ciphertext: event.ciphertext });
  }
  for (const event of records.transfers) {
    for (let offset = 0; offset < 4; offset++) {
      commitments[event.first + offset] = BigInt(event.commitments[offset]);
      encrypted.push({ index: event.first + offset, ciphertext: event.ciphertexts[offset] });
    }
  }
  if (Array.from({ length: commitments.length }, (_, index) => commitments[index]).some((value) => value === undefined)) {
    throw new Error('Event history has a missing leaf');
  }
  const tree = await SwirlMerkleTree.create(16, commitments);
  if (tree.root !== BigInt(await vault.merkleRoot())) throw new Error('Reconstructed tree does not match the vault root');
  return { commitments, encrypted, tree };
}

export async function syncNotes(vault: Contract, wallet: SwirlWallet, indexerUrl: string, poiClient?: POINodeClient): Promise<SyncedNotes> {
  const zeroCommitment = await vault.zeroNoteCommitment();
  let reconstructed: Awaited<ReturnType<typeof reconstructValidatedTree>>;
  try {
    reconstructed = await reconstructValidatedTree(vault, await recordsFromIndexer(vault, zeroCommitment, indexerUrl), zeroCommitment);
  } catch (error) {
    if (indexerUrl) console.warn('Indexed history rejected; falling back to RPC event queries', error);
    reconstructed = await reconstructValidatedTree(vault, await recordsFromRpc(vault), zeroCommitment);
  }
  const { encrypted, tree } = reconstructed;
  const ownerSecret = bytesToBigint(wallet.noteSecretKey);
  const notes: OwnedNote[] = [];
  for (const item of encrypted) {
    if (item.ciphertext === '0x') continue;
    const note = await decryptNote(ethers.getBytes(item.ciphertext), wallet.viewingSecretKey, ownerSecret);
    if (!note) continue;
    const commitment = await noteCommitment(note);
    if (commitment !== reconstructed.commitments[item.index]) throw new Error('Decrypted note does not match its on-chain commitment');
    const [nullifier, blinded] = await Promise.all([
      noteNullifier(ownerSecret, item.index), blindedCommitment(commitment, note.owner, item.index),
    ]);
    notes.push({
      note: { ...note, leafIndex: item.index }, commitment, nullifier, blindedCommitment: blinded,
      spent: await vault.nullifiers(ethers.toBeHex(nullifier, 32)),
    });
  }
  notes.sort((a, b) => a.note.leafIndex - b.note.leafIndex);
  let poiError = '';
  if (poiClient && notes.length) {
    try {
      const statuses = await poiClient.getStatuses(notes.map((item) => hex32(item.blindedCommitment)));
      for (const note of notes) note.poiStatus = statuses[hex32(note.blindedCommitment)];
    } catch (error) {
      poiError = error instanceof Error ? error.message : String(error);
      for (const note of notes) note.poiStatus = 'Unavailable';
    }
  }
  return { notes, tree, ...(poiError ? { poiError } : {}) };
}

function provingAssets() {
  return { wasm: './proving/swirl_transfer.wasm', zkey: './proving/swirl_transfer_final.zkey' };
}

async function submitProof(signer: Signer, config: NetworkConfig, asset: AssetConfig, payload: ProofPayload, directSubmission: boolean) {
  if (config.relayerUrl && !directSubmission) {
    const response = await fetch(`${config.relayerUrl.replace(/\/$/, '')}/relay`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const result = await response.json() as { transactionHash?: string; error?: string };
    if (!response.ok || !result.transactionHash) throw new Error(result.error || 'Relayer rejected the proof');
    if (!signer.provider) throw new Error('Provider unavailable');
    return signer.provider.waitForTransaction(result.transactionHash);
  }
  const { vault } = contracts(signer, config, asset);
  const args = [
    payload.proof, payload.root, payload.nullifiers, payload.outputCommitments,
    payload.ciphertexts, payload.publicAmount, payload.publicRecipient, asset.token,
  ] as const;
  try {
    await vault.transact.staticCall(...args);
  } catch (error) {
    const details = error as {
      shortMessage?: string; message?: string; data?: unknown;
      error?: { data?: unknown }; info?: { error?: { data?: unknown } };
    };
    const data = details.data ?? details.error?.data ?? details.info?.error?.data;
    throw new Error(`Vault preflight failed: ${details.shortMessage ?? details.message ?? String(error)}; revert data: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  }
  const transaction = await vault.transact(...args);
  return transaction.wait();
}

export async function shieldTokens(input: { signer: Signer; config: NetworkConfig; asset: AssetConfig; wallet: SwirlWallet; grossAmount: bigint }) {
  const { vault, token, gateway } = contracts(input.signer, input.config, input.asset);
  const fee = input.grossAmount * BigInt(input.config.feeBps) / 10_000n;
  const note = await createNoteForAddress({
    address: input.wallet.address, token: BigInt(input.asset.token), amount: input.grossAmount - fee, chainId: input.config.chainId,
  });
  const commitment = await noteCommitment(note);
  const ciphertext = ethers.hexlify(encryptNote(note, input.wallet.address));
  if (input.asset.kind === 'native') {
    if (!gateway) throw new Error('Native gateway is not configured');
    const transaction = await gateway.shieldNative(
      ethers.toBeHex(commitment, 32), ciphertext,
      ethers.toBeHex(note.owner, 32), ethers.toBeHex(note.randomness, 32),
      { value: input.grossAmount },
    );
    return transaction.wait();
  }
  const account = await input.signer.getAddress();
  const allowance = await token.allowance(account, input.asset.vault);
  if (allowance < input.grossAmount) await (await token.approve(input.asset.vault, input.grossAmount)).wait();
  const transaction = await vault.shield(
    input.asset.token, input.grossAmount, ethers.toBeHex(commitment, 32), ciphertext,
    ethers.toBeHex(note.owner, 32), ethers.toBeHex(note.randomness, 32),
  );
  return transaction.wait();
}

export function poiClientFor(config: NetworkConfig, asset: AssetConfig): POINodeClient | undefined {
  if (!config.poiNodeUrl) return undefined;
  return new POINodeClient({
    url: config.poiNodeUrl, chainId: config.chainId, vault: asset.vault, listKey: config.poiListKey,
  });
}

export function isNoteSpendable(note: OwnedNote, poiRequired: boolean): boolean {
  return !note.spent && (!poiRequired || note.poiStatus === 'Valid');
}

export function spendableNotes(synced: SyncedNotes, token: bigint, poiRequired: boolean): OwnedNote[] {
  return synced.notes.filter((note) => note.note.token === token && isNoteSpendable(note, poiRequired));
}

function selectNotes(synced: SyncedNotes, amount: bigint, token: bigint, poiRequired: boolean): OwnedNote[] {
  const selected: OwnedNote[] = [];
  let total = 0n;
  const candidates = spendableNotes(synced, token, poiRequired).sort((a, b) => a.note.amount > b.note.amount ? -1 : 1);
  for (const note of candidates) {
    selected.push(note);
    total += note.note.amount;
    if (total >= amount || selected.length === 2) break;
  }
  if (total < amount) {
    throw new Error(poiRequired
      ? 'Up to two PPOI-valid notes cannot cover this amount. Pending, blocked or unavailable notes cannot be spent.'
      : 'Up to two unspent notes cannot cover this amount');
  }
  return selected;
}

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export function ciphertextHash(ciphertexts: [string, string, string, string]): bigint {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['bytes[4]'], [ciphertexts]);
  return BigInt(ethers.keccak256(encoded)) % FIELD_SIZE;
}

function poiProvingAssets() {
  return { wasm: './proving/swirl_poi.wasm', zkey: './proving/swirl_poi_final.zkey' };
}

type PrivateTransferInput = {
  signer: Signer; config: NetworkConfig; asset: AssetConfig; wallet: SwirlWallet; synced: SyncedNotes; recipient: string; amount: bigint; directSubmission: boolean;
};
type BuiltProof = { payload: Omit<ProofPayload, 'quoteId'>; inputs: OwnedNote[]; outputs: SwirlNote[] };

async function buildPrivateTransferPayload(
  input: PrivateTransferInput, relay: boolean, feeAmount: bigint, feeAddress: string,
): Promise<BuiltProof> {
  const token = BigInt(input.asset.token);
  const selected = selectNotes(input.synced, input.amount + feeAmount, token, Boolean(input.config.poiNodeUrl));
  const total = selected.reduce((sum, item) => sum + item.note.amount, 0n);
  const outputA = await createNoteForAddress({ address: input.recipient, token, amount: input.amount, chainId: input.config.chainId });
  const change = total - input.amount - feeAmount;
  const outputB = change > 0n ? await createNoteForAddress({ address: input.wallet.address, token, amount: change, chainId: input.config.chainId }) : null;
  const feeNote = relay ? await createNoteForAddress({ address: feeAddress, token, amount: feeAmount, chainId: input.config.chainId }) : null;
  const ownerSecret = bytesToBigint(input.wallet.noteSecretKey);
  const proofInputs = selected.map((item) => ({ note: item.note, merklePath: input.synced.tree.path(item.note.leafIndex), ownerSecret })) as [ProofInput] | [ProofInput, ProofInput];
  const outputs = [...(feeNote ? [feeNote] : []), outputA, ...(outputB ? [outputB] : [])];
  const ciphertexts = [
    ...(feeNote ? [ethers.hexlify(encryptNote(feeNote, feeAddress))] : []),
    ethers.hexlify(encryptNote(outputA, input.recipient)),
    ...(outputB ? [ethers.hexlify(encryptNote(outputB, input.wallet.address))] : []),
  ];
  while (ciphertexts.length < 4) ciphertexts.push('0x');
  const encrypted = ciphertexts as [string, string, string, string];
  const proof = await createTransferProof({
    inputs: proofInputs, outputs, zeroInputPath: input.synced.tree.path(0), ciphertextHash: ciphertextHash(encrypted),
    chainId: BigInt(input.config.chainId), assets: provingAssets(),
  });
  return {
    payload: {
      proof: proof.solidity, root: ethers.toBeHex(proof.root, 32),
      nullifiers: proof.nullifiers.map((value) => ethers.toBeHex(value, 32)) as [string, string],
      outputCommitments: proof.outputCommitments.map((value) => ethers.toBeHex(value, 32)) as [string, string, string, string],
      ciphertexts: encrypted, publicAmount: '0', publicRecipient: ethers.ZeroAddress,
    },
    inputs: selected,
    outputs,
  };
}

async function attachPreTransactionPOI(
  input: { config: NetworkConfig; asset: AssetConfig; wallet: SwirlWallet },
  payload: ProofPayload, inputs: OwnedNote[], outputs: SwirlNote[],
): Promise<ProofPayload> {
  const client = poiClientFor(input.config, input.asset);
  if (!client) throw new Error('A configured PPOI node is required for Relayer submission');
  const paths = await client.getPOIPaths(inputs.map((item) => hex32(item.blindedCommitment)));
  const ownerSecret = bytesToBigint(input.wallet.noteSecretKey);
  const proofInputs = inputs.map((item, index) => ({
    note: item.note, ownerSecret, poiMerklePath: paths[index],
  })) as [{ note: OwnedNote['note']; ownerSecret: bigint; poiMerklePath: typeof paths[number] }] | [
    { note: OwnedNote['note']; ownerSecret: bigint; poiMerklePath: typeof paths[number] },
    { note: OwnedNote['note']; ownerSecret: bigint; poiMerklePath: typeof paths[number] },
  ];
  const preTransactionPOI = await createPreTransactionPOIProof({
    inputs: proofInputs,
    outputs,
    transaction: {
      nullifiers: payload.nullifiers.map(BigInt) as [bigint, bigint],
      outputCommitments: payload.outputCommitments.map(BigInt) as [bigint, bigint, bigint, bigint],
      ciphertextHash: ciphertextHash(payload.ciphertexts), publicAmount: BigInt(payload.publicAmount),
      publicRecipient: BigInt(payload.publicRecipient), token: BigInt(input.asset.token), chainId: BigInt(input.config.chainId),
    },
    assets: poiProvingAssets(),
  });
  return { ...payload, preTransactionPOI };
}

export async function estimatePrivateTransferRelayFee(
  input: Omit<PrivateTransferInput, 'recipient' | 'amount' | 'directSubmission'>,
): Promise<bigint> {
  const spendable = spendableNotes(input.synced, BigInt(input.asset.token), Boolean(input.config.poiNodeUrl))
    .sort((a, b) => a.note.amount > b.note.amount ? -1 : 1).slice(0, 2)
    .reduce((sum, note) => sum + note.note.amount, 0n);
  if (spendable <= 1n) throw new Error('PPOI-valid private balance is too small to estimate the Relayer fee');
  let feeAmount = 0n;
  await prepareRelayProof(
    input.signer, input.config, input.asset,
    async (fee, feeAddress) => (await buildPrivateTransferPayload({
      // Keep enough headroom for the real dynamic fee during iterative estimation.
      ...input, recipient: input.wallet.address, amount: spendable / 2n, directSubmission: false,
    }, true, fee, feeAddress)).payload,
    (quote) => { feeAmount = BigInt(quote.feeAmount); },
  );
  return feeAmount;
}

export async function privateTransfer(input: PrivateTransferInput): Promise<PrivateTransactionResult> {
  const relay = Boolean(input.config.relayerUrl && !input.directSubmission);
  let context: { inputs: OwnedNote[]; outputs: SwirlNote[] } | undefined;
  const build = async (feeAmount: bigint, feeAddress: string) => {
    const built = await buildPrivateTransferPayload(input, relay, feeAmount, feeAddress);
    context = { inputs: built.inputs, outputs: built.outputs };
    return built.payload;
  };
  let payload = relay
    ? await prepareRelayProof(input.signer, input.config, input.asset, build)
    : await build(0n, '');
  if (!context) throw new Error('Private transaction context was not created');
  if (relay && input.config.poiNodeUrl) payload = await attachPreTransactionPOI(input, payload, context.inputs, context.outputs);
  const receipt = await submitProof(input.signer, input.config, input.asset, payload, input.directSubmission);
  return {
    receipt,
    poi: {
      chainId: input.config.chainId, vault: input.asset.vault, token: input.asset.token,
      payload, inputs: context.inputs, outputs: context.outputs,
    },
  };
}

export async function unshieldTokens(input: {
  signer: Signer; config: NetworkConfig; asset: AssetConfig; wallet: SwirlWallet; synced: SyncedNotes; note: OwnedNote; recipient: string; directSubmission: boolean;
}): Promise<PrivateTransactionResult> {
  if (!isNoteSpendable(input.note, Boolean(input.config.poiNodeUrl))) throw new Error('This note is spent or does not have valid PPOI');
  if (!ethers.isAddress(input.recipient)) throw new Error('Invalid public recipient address');
  const token = BigInt(input.asset.token);
  const empty = zeroNote(token);
  const native = input.asset.kind === 'native';
  const relay = Boolean(!native && input.config.relayerUrl && !input.directSubmission);
  if (native && input.config.relayerUrl && !input.directSubmission) throw new Error('Native Unshield currently requires direct wallet submission');
  const build = async (feeAmount: bigint, feeAddress: string): Promise<BuiltProof> => {
    if (feeAmount >= input.note.note.amount) throw new Error('This note is too small to cover the Relayer fee and Unshield amount');
    const feeNote = relay ? await createNoteForAddress({ address: feeAddress, token, amount: feeAmount, chainId: input.config.chainId }) : null;
    const publicAmount = input.note.note.amount - feeAmount;
    const ciphertexts: [string, string, string, string] = native
      ? [ethers.AbiCoder.defaultAbiCoder().encode(['address'], [input.recipient]), '0x', '0x', '0x']
      : feeNote ? [ethers.hexlify(encryptNote(feeNote, feeAddress)), '0x', '0x', '0x'] : ['0x', '0x', '0x', '0x'];
    const publicRecipient = native ? input.asset.gateway : input.recipient;
    const outputs = feeNote ? [feeNote, empty] : [empty];
    const proof = await createTransferProof({
      inputs: [{ note: input.note.note, merklePath: input.synced.tree.path(input.note.note.leafIndex), ownerSecret: bytesToBigint(input.wallet.noteSecretKey) }],
      outputs, zeroInputPath: input.synced.tree.path(0), publicAmount,
      ciphertextHash: ciphertextHash(ciphertexts), publicRecipient: BigInt(publicRecipient),
      chainId: BigInt(input.config.chainId), assets: provingAssets(),
    });
    return {
      payload: {
        proof: proof.solidity, root: ethers.toBeHex(proof.root, 32),
        nullifiers: proof.nullifiers.map((value) => ethers.toBeHex(value, 32)) as [string, string],
        outputCommitments: proof.outputCommitments.map((value) => ethers.toBeHex(value, 32)) as [string, string, string, string],
        ciphertexts, publicAmount: publicAmount.toString(), publicRecipient,
      },
      inputs: [input.note], outputs,
    };
  };
  let context: { inputs: OwnedNote[]; outputs: SwirlNote[] } | undefined;
  const buildWithContext = async (feeAmount: bigint, feeAddress: string) => {
    const built = await build(feeAmount, feeAddress);
    context = { inputs: built.inputs, outputs: built.outputs };
    return built.payload;
  };
  let payload = relay
    ? await prepareRelayProof(input.signer, input.config, input.asset, buildWithContext)
    : await buildWithContext(0n, '');
  if (!context) throw new Error('Unshield transaction context was not created');
  if (relay && input.config.poiNodeUrl) payload = await attachPreTransactionPOI(input, payload, context.inputs, context.outputs);
  let receipt: TransactionReceipt | null;
  if (native) {
    const { gateway } = contracts(input.signer, input.config, input.asset);
    if (!gateway) throw new Error('Native gateway is not configured');
    const transaction = await gateway.unshieldNative(payload.proof, payload.root, payload.nullifiers, payload.outputCommitments, payload.ciphertexts, payload.publicAmount);
    receipt = await transaction.wait();
  } else {
    receipt = await submitProof(input.signer, input.config, input.asset, payload, input.directSubmission);
  }
  return {
    receipt,
    poi: {
      chainId: input.config.chainId, vault: input.asset.vault, token: input.asset.token,
      payload, inputs: context.inputs, outputs: context.outputs,
    },
  };
}

export async function publicTransfer(input: { signer: Signer; config: NetworkConfig; asset: AssetConfig; recipient: string; amount: bigint }) {
  if (!ethers.isAddress(input.recipient)) throw new Error('Invalid public recipient address');
  if (input.amount <= 0n) throw new Error('Enter an amount greater than zero');
  const transaction = input.asset.kind === 'native'
    ? await input.signer.sendTransaction({ to: input.recipient, value: input.amount })
    : await contracts(input.signer, input.config, input.asset).token.transfer(input.recipient, input.amount);
  return transaction.wait();
}

export async function mintTestTokens(signer: Signer, config: NetworkConfig, asset: AssetConfig, amount: bigint) {
  if (asset.kind !== 'erc20') throw new Error('Native development assets are funded with ordinary test coins');
  const account = await signer.getAddress();
  const transaction = await contracts(signer, config, asset).token.mint(account, amount);
  return transaction.wait();
}
