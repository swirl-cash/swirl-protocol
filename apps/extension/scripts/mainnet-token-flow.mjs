import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Contract, Wallet, ethers } from 'ethers';
import {
  bytesToBigint, createNoteForAddress, createSwirlWallet, createTransferProof,
  encryptNote, noteCommitment, recoverWalletNotes, zeroNote,
} from '@swirl/wallet';

const root = path.resolve(import.meta.dirname, '../../..');
const symbol = process.env.SWIRL_ASSET_SYMBOL;
if (!['USDC', 'USDT'].includes(symbol ?? '')) throw new Error('Set SWIRL_ASSET_SYMBOL to USDC or USDT');
if (process.env.SWIRL_MAINNET_TEST_CONFIRM !== 'TEST_STABLECOINS_0_1') throw new Error('Set SWIRL_MAINNET_TEST_CONFIRM=TEST_STABLECOINS_0_1 after reviewing the approved transactions');
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Set DEPLOYER_PRIVATE_KEY in the command environment');
const deployment = JSON.parse(await readFile(path.join(root, 'packages/contracts/deployments/ethereum.json'), 'utf8'));
const asset = deployment.assets.find((item) => item.symbol === symbol);
if (deployment.chainId !== 1 || !asset || asset.kind !== 'erc20' || asset.decimals !== 6) throw new Error('Invalid packaged stablecoin deployment');
const provider = new ethers.JsonRpcProvider(deployment.rpcUrl, 1, { staticNetwork: true });
const signer = new Wallet(privateKey, provider);
if (signer.address.toLowerCase() !== deployment.deployer.toLowerCase()) throw new Error('Test signer does not match the reviewed account');
const resultFile = path.join(root, `apps/extension/artifacts/mainnet-${symbol.toLowerCase()}-flow-result.json`);
const gross = ethers.parseUnits('0.1', 6);
const feeBps = BigInt(deployment.feeBps);
const net = gross - gross * feeBps / 10_000n;
const expectedReturn = net - net * feeBps / 10_000n;
const overrides = { maxFeePerGas: 50_000_000n, maxPriorityFeePerGas: 1_000_000n };
const latest = await provider.getBlock('latest');
if (!latest || latest.baseFeePerGas + overrides.maxPriorityFeePerGas > overrides.maxFeePerGas) throw new Error('Current mainnet fee exceeds the approved 0.05 gwei cap');
const [ethBalance, tokenBalance] = await Promise.all([
  provider.getBalance(signer.address),
  new Contract(asset.token, ['function balanceOf(address) view returns (uint256)'], provider).balanceOf(signer.address),
]);
if (ethBalance < 6_300_000n * overrides.maxFeePerGas) throw new Error('Insufficient ETH for this asset\'s maximum Gas budget');
if (tokenBalance < gross) throw new Error(`Insufficient ${symbol} for the reviewed test amount`);

const token = new Contract(asset.token, [
  'function allowance(address owner,address spender) view returns (uint256)',
  'function approve(address spender,uint256 amount) returns (bool)',
], signer);
const vault = new Contract(asset.vault, [
  'function shield(address token,uint256 grossAmount,bytes32 commitment,bytes ciphertext,bytes32 owner,bytes32 randomness)',
  'function transact((uint256[2] a,uint256[2][2] b,uint256[2] c) proof,bytes32 root,bytes32[2] nullifiers,bytes32[4] outputCommitments,bytes[4] ciphertexts,uint256 publicAmount,address publicRecipient,address token)',
], signer);
const walletA = await createSwirlWallet(1, ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes(`${privateKey}:swirl-mainnet-${symbol}:A`))).phrase);
const walletB = await createSwirlWallet(1, ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes(`${privateKey}:swirl-mainnet-${symbol}:B`))).phrase);
const provingAssets = {
  wasm: path.join(root, 'packages/contracts/build/circuits/swirl_transfer_js/swirl_transfer.wasm'),
  zkey: path.join(root, 'packages/contracts/build/circuits/swirl_transfer_final.zkey'),
};
const startBlock = 26288500;
const result = {
  ok: false, network: 'Ethereum', chainId: 1, asset: symbol,
  grossAmount: ethers.formatUnits(gross, 6), expectedReturn: ethers.formatUnits(expectedReturn, 6),
  startBlock, transactions: [], stage: 'preflight',
};
async function save() { await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`); }
async function confirm(transaction, stage) {
  console.log(`${symbol} ${stage} transaction: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${symbol} ${stage} failed: ${transaction.hash}`);
  const effectiveGasPrice = receipt.effectiveGasPrice ?? receipt.gasPrice;
  if (effectiveGasPrice === undefined) throw new Error(`${stage} receipt has no Gas price`);
  result.transactions.push({ stage, hash: receipt.hash, blockNumber: receipt.blockNumber, gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: effectiveGasPrice.toString() });
  result.stage = stage;
  await save();
  console.log(`${symbol} ${stage} confirmed in block ${receipt.blockNumber}; Gas ${receipt.gasUsed}`);
}
function ciphertextHash(ciphertexts) {
  return BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(['bytes[4]'], [ciphertexts]))) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
}
async function recover(wallet) {
  return recoverWalletNotes({ provider, wallet, vaultAddress: asset.vault, startBlock, batchSize: 100 });
}

try {
  await save();
  const allowance = await token.allowance(signer.address, asset.vault);
  if (allowance < gross) {
    if (allowance !== 0n && symbol === 'USDT') throw new Error('USDT has a non-zero insufficient allowance; reset it explicitly before continuing');
    const approveTx = await token.approve(asset.vault, gross, overrides);
    await confirm(approveTx, 'Approve');
  }

  const shieldNote = await createNoteForAddress({ address: walletA.address, token: BigInt(asset.token), amount: net, chainId: 1 });
  const commitment = await noteCommitment(shieldNote);
  const ciphertext = ethers.hexlify(encryptNote(shieldNote, walletA.address));
  const shieldArgs = [asset.token, gross, ethers.toBeHex(commitment, 32), ciphertext, ethers.toBeHex(shieldNote.owner, 32), ethers.toBeHex(shieldNote.randomness, 32)];
  await vault.shield.staticCall(...shieldArgs);
  const shieldTx = await vault.shield(...shieldArgs, overrides);
  await confirm(shieldTx, 'Shield');

  const stateA = await recover(walletA);
  const inputA = stateA.notes.find((item) => !item.spent && item.note.token === BigInt(asset.token) && item.note.amount === net);
  if (!inputA) throw new Error(`${symbol} Shielded note was not recovered`);
  const outputB = await createNoteForAddress({ address: walletB.address, token: BigInt(asset.token), amount: net, chainId: 1 });
  const transferCiphertexts = [ethers.hexlify(encryptNote(outputB, walletB.address)), '0x', '0x', '0x'];
  const transferProof = await createTransferProof({
    inputs: [{ note: inputA.note, merklePath: stateA.tree.path(inputA.note.leafIndex), ownerSecret: bytesToBigint(walletA.noteSecretKey) }],
    outputs: [outputB], zeroInputPath: stateA.tree.path(0), ciphertextHash: ciphertextHash(transferCiphertexts), chainId: 1n, assets: provingAssets,
  });
  const transferArgs = [
    transferProof.solidity, ethers.toBeHex(transferProof.root, 32),
    transferProof.nullifiers.map((value) => ethers.toBeHex(value, 32)),
    transferProof.outputCommitments.map((value) => ethers.toBeHex(value, 32)),
    transferCiphertexts, 0n, ethers.ZeroAddress, asset.token,
  ];
  await vault.transact.staticCall(...transferArgs);
  const transferTx = await vault.transact(...transferArgs, overrides);
  await confirm(transferTx, 'Private transfer');

  const stateB = await recover(walletB);
  const inputB = stateB.notes.find((item) => !item.spent && item.note.token === BigInt(asset.token) && item.note.amount === net);
  if (!inputB) throw new Error(`${symbol} private recipient note was not recovered`);
  const unshieldCiphertexts = ['0x', '0x', '0x', '0x'];
  const unshieldProof = await createTransferProof({
    inputs: [{ note: inputB.note, merklePath: stateB.tree.path(inputB.note.leafIndex), ownerSecret: bytesToBigint(walletB.noteSecretKey) }],
    outputs: [zeroNote(BigInt(asset.token))], zeroInputPath: stateB.tree.path(0), publicAmount: net,
    ciphertextHash: ciphertextHash(unshieldCiphertexts), publicRecipient: BigInt(signer.address), chainId: 1n, assets: provingAssets,
  });
  const unshieldArgs = [
    unshieldProof.solidity, ethers.toBeHex(unshieldProof.root, 32),
    unshieldProof.nullifiers.map((value) => ethers.toBeHex(value, 32)),
    unshieldProof.outputCommitments.map((value) => ethers.toBeHex(value, 32)),
    unshieldCiphertexts, net, signer.address, asset.token,
  ];
  await vault.transact.staticCall(...unshieldArgs);
  const unshieldTx = await vault.transact(...unshieldArgs, overrides);
  await confirm(unshieldTx, 'Unshield');
  result.stage = 'submitted';
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
process.exit(0);
