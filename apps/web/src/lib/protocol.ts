import { BrowserProvider, Contract, JsonRpcSigner, ethers } from 'ethers';
import {
  bytesToBigint, createNoteForAddress, createTransferProof, decryptNote, encryptNote,
  noteCommitment, noteNullifier, SwirlMerkleTree, zeroNote,
  type ProofInput, type SolidityProof, type SwirlNote, type SwirlWallet,
} from '@swirl/wallet';

export type Deployment = {
  network: string;
  chainId: number;
  deployer: string;
  treasury: string;
  token: string;
  verifier: string;
  vault: string;
  feeBps: number;
  treeDepth: number;
  trustedSetup: string;
};

export type OwnedNote = {
  note: SwirlNote & { leafIndex: number };
  commitment: bigint;
  nullifier: bigint;
  spent: boolean;
};

export type SyncedNotes = { notes: OwnedNote[]; tree: SwirlMerkleTree };
export type ProofPayload = {
  proof: SolidityProof;
  root: string;
  nullifiers: [string, string];
  outputCommitments: [string, string, string, string];
  ciphertexts: [string, string, string, string];
  publicAmount: string;
  publicRecipient: string;
  quoteId?: string;
};
export type RelayQuote = {
  id: string;
  chainId: string;
  vault: string;
  token: string;
  feeAddress: string;
  feeAmount: string;
  expiresAt: number;
};

export async function getRelayQuote(deployment: Deployment): Promise<RelayQuote> {
  const relayerUrl = import.meta.env.VITE_RELAYER_URL as string | undefined;
  if (!relayerUrl) throw new Error('Relayer is not configured');
  const response = await fetch(`${relayerUrl.replace(/\/$/, '')}/quote`, { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  const quote = await response.json() as RelayQuote & { error?: string };
  if (!response.ok) throw new Error(quote.error || 'Relayer quote unavailable');
  if (!/^[0-9a-f-]{36}$/.test(quote.id) || quote.chainId !== deployment.chainId.toString()
    || quote.vault?.toLowerCase() !== deployment.vault.toLowerCase() || quote.token?.toLowerCase() !== deployment.token.toLowerCase()
    || typeof quote.feeAddress !== 'string' || !/^(0|[1-9][0-9]*)$/.test(quote.feeAmount) || BigInt(quote.feeAmount) <= 0n
    || !Number.isSafeInteger(quote.expiresAt) || quote.expiresAt <= Date.now()) throw new Error('Relayer returned an invalid quote');
  return quote;
}

const VAULT_ABI = [
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
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function mint(address to, uint256 amount)',
  'function decimals() view returns (uint8)',
];

export async function loadDeployment(): Promise<Deployment | null> {
  try {
    const response = await fetch(`${import.meta.env.BASE_URL}deployment.local.json`, { cache: 'no-store' });
    return response.ok ? await response.json() as Deployment : null;
  } catch { return null; }
}

export async function connectBrowserWallet(deployment: Deployment): Promise<JsonRpcSigner> {
  if (!window.ethereum) throw new Error('No EVM browser wallet found. Open this page with an EVM wallet on the local Hardhat network.');
  const provider = new BrowserProvider(window.ethereum);
  await provider.send('eth_requestAccounts', []);
  const network = await provider.getNetwork();
  if (network.chainId !== BigInt(deployment.chainId)) {
    try { await provider.send('wallet_switchEthereumChain', [{ chainId: ethers.toQuantity(deployment.chainId) }]); }
    catch { throw new Error(`Switch your EVM wallet to chain ${deployment.chainId}`); }
  }
  return provider.getSigner();
}

export function contracts(signer: JsonRpcSigner, deployment: Deployment) {
  return {
    vault: new Contract(deployment.vault, VAULT_ABI, signer),
    token: new Contract(deployment.token, TOKEN_ABI, signer),
  };
}

type ShieldRecord = { index: number; commitment: string; ciphertext: string };
type TransferRecord = { first: number; commitments: string[]; ciphertexts: string[] };
type EventRecords = { shields: ShieldRecord[]; transfers: TransferRecord[] };

const isBytes32 = (value: unknown): value is string => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
const isHex = (value: unknown): value is string => typeof value === 'string' && /^0x(?:[0-9a-fA-F]{2})*$/.test(value);
const isIndex = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;

async function recordsFromIndexer(vault: Contract, zeroCommitment: string): Promise<EventRecords> {
  const baseUrl = (import.meta.env.VITE_INDEXER_URL as string | undefined)?.replace(/\/$/, '');
  if (!baseUrl) throw new Error('Indexer is not configured');
  const provider = vault.runner?.provider;
  if (!provider) throw new Error('Vault provider is unavailable');
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

export async function syncNotes(vault: Contract, wallet: SwirlWallet): Promise<SyncedNotes> {
  const zeroCommitment = await vault.zeroNoteCommitment();
  let reconstructed: Awaited<ReturnType<typeof reconstructValidatedTree>>;
  try {
    // Like a QuickSync source, indexed data is only a candidate history. Any fetch,
    // schema, missing-leaf or root failure falls through to a direct chain scan.
    reconstructed = await reconstructValidatedTree(vault, await recordsFromIndexer(vault, zeroCommitment), zeroCommitment);
  } catch (error) {
    if (import.meta.env.VITE_INDEXER_URL) console.warn('Indexed history rejected; falling back to RPC event queries', error);
    reconstructed = await reconstructValidatedTree(vault, await recordsFromRpc(vault), zeroCommitment);
  }
  const { commitments, encrypted, tree } = reconstructed;
  const ownerSecret = bytesToBigint(wallet.noteSecretKey);
  const notes: OwnedNote[] = [];
  for (const item of encrypted) {
    if (item.ciphertext === '0x') continue;
    const note = await decryptNote(ethers.getBytes(item.ciphertext), wallet.viewingSecretKey, ownerSecret);
    if (!note) continue;
    const commitment = await noteCommitment(note);
    if (commitment !== commitments[item.index]) throw new Error('Decrypted note does not match its on-chain commitment');
    const nullifier = await noteNullifier(ownerSecret, item.index);
    notes.push({
      note: { ...note, leafIndex: item.index }, commitment, nullifier,
      spent: await vault.nullifiers(ethers.toBeHex(nullifier, 32)),
    });
  }
  notes.sort((a, b) => a.note.leafIndex - b.note.leafIndex);
  return { notes, tree };
}

function provingAssets() {
  return {
    wasm: `${import.meta.env.BASE_URL}proving/swirl_transfer.wasm`,
    zkey: `${import.meta.env.BASE_URL}proving/swirl_transfer_final.zkey`,
  };
}

async function submitProof(signer: JsonRpcSigner, deployment: Deployment, payload: ProofPayload, directSubmission = false) {
  const relayerUrl = import.meta.env.VITE_RELAYER_URL as string | undefined;
  if (relayerUrl && !directSubmission) {
    const response = await fetch(`${relayerUrl.replace(/\/$/, '')}/relay`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
    });
    const result = await response.json() as { transactionHash?: string; error?: string };
    if (!response.ok || !result.transactionHash) throw new Error(result.error || 'Relayer rejected the proof');
    return signer.provider.waitForTransaction(result.transactionHash);
  }
  const vault = contracts(signer, deployment).vault;
  const transaction = await vault.transact(
    payload.proof, payload.root, payload.nullifiers, payload.outputCommitments,
    payload.ciphertexts, payload.publicAmount, payload.publicRecipient, deployment.token,
  );
  return transaction.wait();
}

export async function shieldTokens(input: {
  signer: JsonRpcSigner; deployment: Deployment; wallet: SwirlWallet; grossAmount: bigint;
}) {
  const { vault, token } = contracts(input.signer, input.deployment);
  const fee = input.grossAmount * BigInt(input.deployment.feeBps) / 10_000n;
  const note = await createNoteForAddress({
    address: input.wallet.address, token: BigInt(input.deployment.token),
    amount: input.grossAmount - fee, chainId: input.deployment.chainId,
  });
  const commitment = await noteCommitment(note);
  const account = await input.signer.getAddress();
  const allowance = await token.allowance(account, input.deployment.vault);
  if (allowance < input.grossAmount) await (await token.approve(input.deployment.vault, input.grossAmount)).wait();
  const transaction = await vault.shield(
    input.deployment.token, input.grossAmount, ethers.toBeHex(commitment, 32), ethers.hexlify(encryptNote(note, input.wallet.address)),
    ethers.toBeHex(note.owner, 32), ethers.toBeHex(note.randomness, 32),
  );
  return transaction.wait();
}

function selectNotes(synced: SyncedNotes, amount: bigint): OwnedNote[] {
  const selected: OwnedNote[] = [];
  let total = 0n;
  const candidates = synced.notes.filter((item) => !item.spent).sort((a, b) => a.note.amount > b.note.amount ? -1 : 1);
  for (const note of candidates) {
    selected.push(note);
    total += note.note.amount;
    if (total >= amount) break;
    if (selected.length === 2) break;
  }
  if (total < amount) throw new Error('Up to two unspent notes cannot cover this amount');
  return selected;
}

const FIELD_SIZE = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
function ciphertextHash(ciphertexts: [string, string, string, string]): bigint {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['bytes[4]'], [ciphertexts]);
  return BigInt(ethers.keccak256(encoded)) % FIELD_SIZE;
}

export async function privateTransfer(input: {
  signer: JsonRpcSigner; deployment: Deployment; wallet: SwirlWallet; synced: SyncedNotes; recipient: string; amount: bigint;
  directSubmission?: boolean;
}) {
  const useRelayer = Boolean(import.meta.env.VITE_RELAYER_URL && !input.directSubmission);
  const quote = useRelayer ? await getRelayQuote(input.deployment) : null;
  const feeAmount = quote ? BigInt(quote.feeAmount) : 0n;
  const selected = selectNotes(input.synced, input.amount + feeAmount);
  const total = selected.reduce((sum, item) => sum + item.note.amount, 0n);
  const token = BigInt(input.deployment.token);
  const outputA = await createNoteForAddress({ address: input.recipient, token, amount: input.amount, chainId: input.deployment.chainId });
  const change = total - input.amount - feeAmount;
  const outputB = change > 0n ? await createNoteForAddress({ address: input.wallet.address, token, amount: change, chainId: input.deployment.chainId }) : null;
  const feeNote = quote ? await createNoteForAddress({ address: quote.feeAddress, token, amount: feeAmount, chainId: input.deployment.chainId }) : null;
  const ownerSecret = bytesToBigint(input.wallet.noteSecretKey);
  const proofInputs = selected.map((item) => ({
    note: item.note, merklePath: input.synced.tree.path(item.note.leafIndex), ownerSecret,
  })) as [ProofInput] | [ProofInput, ProofInput];
  const outputs = [...(feeNote ? [feeNote] : []), outputA, ...(outputB ? [outputB] : [])];
  const ciphertexts = [
    ...(feeNote ? [ethers.hexlify(encryptNote(feeNote, quote!.feeAddress))] : []),
    ethers.hexlify(encryptNote(outputA, input.recipient)),
    ...(outputB ? [ethers.hexlify(encryptNote(outputB, input.wallet.address))] : []),
  ];
  while (ciphertexts.length < 4) ciphertexts.push('0x');
  const encrypted = ciphertexts as [string, string, string, string];
  const proof = await createTransferProof({
    inputs: proofInputs, outputs, zeroInputPath: input.synced.tree.path(0), ciphertextHash: ciphertextHash(encrypted),
    chainId: BigInt(input.deployment.chainId), assets: provingAssets(),
  });
  return submitProof(input.signer, input.deployment, {
    proof: proof.solidity, root: ethers.toBeHex(proof.root, 32),
    nullifiers: proof.nullifiers.map((value) => ethers.toBeHex(value, 32)) as [string, string],
    outputCommitments: proof.outputCommitments.map((value) => ethers.toBeHex(value, 32)) as [string, string, string, string],
    ciphertexts: encrypted, publicAmount: '0', publicRecipient: ethers.ZeroAddress,
    ...(quote ? { quoteId: quote.id } : {}),
  }, input.directSubmission);
}

export async function unshieldTokens(input: {
  signer: JsonRpcSigner; deployment: Deployment; wallet: SwirlWallet; synced: SyncedNotes; note: OwnedNote; recipient: string;
  directSubmission?: boolean;
}) {
  if (input.note.spent) throw new Error('This note was already spent');
  if (!ethers.isAddress(input.recipient)) throw new Error('Invalid public recipient address');
  const token = BigInt(input.deployment.token);
  const empty = zeroNote(token);
  const useRelayer = Boolean(import.meta.env.VITE_RELAYER_URL && !input.directSubmission);
  const quote = useRelayer ? await getRelayQuote(input.deployment) : null;
  const feeAmount = quote ? BigInt(quote.feeAmount) : 0n;
  if (feeAmount >= input.note.note.amount) throw new Error('This note is too small to cover the Relayer fee and Unshield amount');
  const feeNote = quote ? await createNoteForAddress({ address: quote.feeAddress, token, amount: feeAmount, chainId: input.deployment.chainId }) : null;
  const publicAmount = input.note.note.amount - feeAmount;
  const ciphertexts: [string, string, string, string] = feeNote
    ? [ethers.hexlify(encryptNote(feeNote, quote!.feeAddress)), '0x', '0x', '0x'] : ['0x', '0x', '0x', '0x'];
  const proof = await createTransferProof({
    inputs: [{
      note: input.note.note, merklePath: input.synced.tree.path(input.note.note.leafIndex),
      ownerSecret: bytesToBigint(input.wallet.noteSecretKey),
    }],
    outputs: feeNote ? [feeNote, empty] : [empty], zeroInputPath: input.synced.tree.path(0), publicAmount,
    ciphertextHash: ciphertextHash(ciphertexts), publicRecipient: BigInt(input.recipient),
    chainId: BigInt(input.deployment.chainId), assets: provingAssets(),
  });
  return submitProof(input.signer, input.deployment, {
    proof: proof.solidity, root: ethers.toBeHex(proof.root, 32),
    nullifiers: proof.nullifiers.map((value) => ethers.toBeHex(value, 32)) as [string, string],
    outputCommitments: proof.outputCommitments.map((value) => ethers.toBeHex(value, 32)) as [string, string, string, string],
    ciphertexts, publicAmount: publicAmount.toString(), publicRecipient: input.recipient,
    ...(quote ? { quoteId: quote.id } : {}),
  }, input.directSubmission);
}

declare global {
  interface Window {
    ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
  }
}
