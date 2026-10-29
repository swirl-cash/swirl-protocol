import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Contract, Wallet, ethers } from 'ethers';
import {
  bytesToBigint, createNoteForAddress, createSwirlWallet, createTransferProof,
  encryptNote, noteCommitment, recoverWalletNotes,
} from '@swirl/wallet';

const root = path.resolve(import.meta.dirname, '../../..');
const resultFile = path.join(root, 'apps/extension/artifacts/mainnet-relay-flow-result.json');
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Set DEPLOYER_PRIVATE_KEY in the command environment');
if (process.env.SWIRL_MAINNET_TEST_CONFIRM !== 'TEST_RELAY_ETH_0_001') throw new Error('Set SWIRL_MAINNET_TEST_CONFIRM=TEST_RELAY_ETH_0_001');

const deployment = JSON.parse(await readFile(path.join(root, 'packages/contracts/deployments/ethereum.json'), 'utf8'));
const asset = deployment.assets.find((item) => item.symbol === 'ETH');
if (deployment.chainId !== 1 || asset?.kind !== 'native' || !deployment.relayerUrl) throw new Error('Invalid Ethereum Relay configuration');
const provider = new ethers.JsonRpcProvider(deployment.rpcUrl, 1, { staticNetwork: true });
const signer = new Wallet(privateKey, provider);
if (signer.address.toLowerCase() !== deployment.deployer.toLowerCase()) throw new Error('Test signer does not match the deployment account');
const gross = ethers.parseEther('0.001');
const net = gross - gross * BigInt(deployment.feeBps) / 10_000n;
const transferAmount = ethers.parseEther('0.0005');
const overrides = { maxFeePerGas: 150_000_000n, maxPriorityFeePerGas: 1_000_000n };
const latest = await provider.getBlock('latest');
if (!latest || latest.baseFeePerGas + overrides.maxPriorityFeePerGas > overrides.maxFeePerGas) throw new Error('Mainnet Gas exceeds the approved cap');
const relayerAddress = '0x2E75FF91A27A3796123dD01c8d6C0f90b7A9bFFB';
const [balanceStart, relayerBalanceStart] = await Promise.all([
  provider.getBalance(signer.address), provider.getBalance(relayerAddress),
]);
if (balanceStart < gross + 500_000n * overrides.maxFeePerGas) throw new Error('Insufficient ETH for the small Relay test');

const gateway = new Contract(asset.gateway, [
  'function shieldNative(bytes32 commitment,bytes ciphertext,bytes32 owner,bytes32 randomness) payable',
], signer);
const vault = new Contract(asset.vault, ['function nullifiers(bytes32) view returns (bool)'], provider);
const provingAssets = {
  wasm: path.join(root, 'packages/contracts/build/circuits/swirl_transfer_js/swirl_transfer.wasm'),
  zkey: path.join(root, 'packages/contracts/build/circuits/swirl_transfer_final.zkey'),
};
const walletA = await createSwirlWallet(1, ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes(`${privateKey}:swirl-mainnet-relay:A`))).phrase);
const walletB = await createSwirlWallet(1, ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes(`${privateKey}:swirl-mainnet-relay:B`))).phrase);
const startBlock = 26288641;
const result = {
  ok: false, network: 'Ethereum', chainId: 1, asset: 'ETH', grossAmount: ethers.formatEther(gross),
  relayTransferAmount: ethers.formatEther(transferAmount), startBlock, transactions: [], stage: 'preflight',
};
async function save() { await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`); }
async function confirm(transaction, stage) {
  console.log(`${stage} transaction: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${stage} transaction failed: ${transaction.hash}`);
  result.transactions.push({
    stage, hash: receipt.hash, blockNumber: receipt.blockNumber, from: receipt.from,
    gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: (receipt.effectiveGasPrice ?? receipt.gasPrice).toString(),
  });
  result.stage = stage;
  await save();
  return receipt;
}
function ciphertextHash(ciphertexts) {
  return BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes[4]'], [ciphertexts])))
    % 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
}

try {
  await save();
  const quoteResponse = await fetch(`${deployment.relayerUrl.replace(/\/$/, '')}/quote?token=${asset.token}`, { signal: AbortSignal.timeout(15_000) });
  const quote = await quoteResponse.json();
  if (!quoteResponse.ok || quote.chainId !== '1' || quote.vault.toLowerCase() !== asset.vault.toLowerCase()) throw new Error('Invalid Relay quote');
  const relayFee = BigInt(quote.feeAmount);
  if (relayFee !== ethers.parseEther('0.0002') || net <= transferAmount + relayFee) throw new Error('Unexpected Relay fee or test amount');

  const shieldNote = await createNoteForAddress({ address: walletA.address, token: BigInt(asset.token), amount: net, chainId: 1 });
  const shieldTx = await gateway.shieldNative(
    ethers.toBeHex(await noteCommitment(shieldNote), 32), ethers.hexlify(encryptNote(shieldNote, walletA.address)),
    ethers.toBeHex(shieldNote.owner, 32), ethers.toBeHex(shieldNote.randomness, 32), { value: gross, ...overrides },
  );
  await confirm(shieldTx, 'Shield');

  const stateA = await recoverWalletNotes({ provider, wallet: walletA, vaultAddress: asset.vault, startBlock, batchSize: 100 });
  const input = stateA.notes.find((item) => !item.spent && item.note.token === BigInt(asset.token) && item.note.amount === net);
  if (!input) throw new Error('Shielded input was not recovered');
  const feeNote = await createNoteForAddress({ address: quote.feeAddress, token: BigInt(asset.token), amount: relayFee, chainId: 1 });
  const outputB = await createNoteForAddress({ address: walletB.address, token: BigInt(asset.token), amount: transferAmount, chainId: 1 });
  const change = net - transferAmount - relayFee;
  const changeNote = await createNoteForAddress({ address: walletA.address, token: BigInt(asset.token), amount: change, chainId: 1 });
  const ciphertexts = [
    ethers.hexlify(encryptNote(feeNote, quote.feeAddress)), ethers.hexlify(encryptNote(outputB, walletB.address)),
    ethers.hexlify(encryptNote(changeNote, walletA.address)), '0x',
  ];
  const proof = await createTransferProof({
    inputs: [{ note: input.note, merklePath: stateA.tree.path(input.note.leafIndex), ownerSecret: bytesToBigint(walletA.noteSecretKey) }],
    outputs: [feeNote, outputB, changeNote], zeroInputPath: stateA.tree.path(0), ciphertextHash: ciphertextHash(ciphertexts),
    chainId: 1n, assets: provingAssets,
  });
  const payload = {
    proof: proof.solidity, root: ethers.toBeHex(proof.root, 32),
    nullifiers: proof.nullifiers.map((value) => ethers.toBeHex(value, 32)),
    outputCommitments: proof.outputCommitments.map((value) => ethers.toBeHex(value, 32)),
    ciphertexts, publicAmount: '0', publicRecipient: ethers.ZeroAddress, quoteId: quote.id,
  };
  const relayResponse = await fetch(`${deployment.relayerUrl.replace(/\/$/, '')}/relay`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(30_000),
  });
  const relayResult = await relayResponse.json();
  if (!relayResponse.ok || !relayResult.transactionHash) throw new Error(relayResult.error || 'Relayer rejected the proof');
  const relayTx = await provider.getTransaction(relayResult.transactionHash);
  if (!relayTx || relayTx.from.toLowerCase() !== relayerAddress.toLowerCase()) throw new Error('Relay transaction was not sent by the configured Relayer');
  await confirm(relayTx, 'Relayer private transfer');

  const [stateB, stateAAfter, relayerBalanceEnd, indexerResponse] = await Promise.all([
    recoverWalletNotes({ provider, wallet: walletB, vaultAddress: asset.vault, startBlock, batchSize: 100 }),
    recoverWalletNotes({ provider, wallet: walletA, vaultAddress: asset.vault, startBlock, batchSize: 100 }),
    provider.getBalance(relayerAddress), fetch(`${deployment.indexerUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(15_000) }),
  ]);
  if (!stateB.notes.some((item) => !item.spent && item.note.amount === transferAmount)) throw new Error('Recipient did not recover the private output');
  if (!stateAAfter.notes.some((item) => !item.spent && item.note.amount === change)) throw new Error('Sender did not recover the change output');
  if (!stateAAfter.notes.find((item) => item.note.leafIndex === input.note.leafIndex)?.spent) throw new Error('Relay input was not spent');
  if (!indexerResponse.ok) throw new Error('Public Indexer health check failed');
  Object.assign(result, {
    ok: true, stage: 'verified', relayFee: ethers.formatEther(relayFee), changeAmount: ethers.formatEther(change),
    relayerBalanceStart: ethers.formatEther(relayerBalanceStart), relayerBalanceEnd: ethers.formatEther(relayerBalanceEnd),
    relayerPaidTransaction: true, recipientOutputRecovered: true, changeOutputRecovered: true,
    feeCommitmentVerified: BigInt(payload.outputCommitments[0]) === await noteCommitment(feeNote),
  });
  await save();
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  result.stage = `failed:${result.stage}`;
  result.error = error?.shortMessage ?? error?.message ?? String(error);
  await save();
  throw error;
} finally {
  provider.destroy();
}
process.exit(result.ok ? 0 : 1);
