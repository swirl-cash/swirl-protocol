import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Contract, Wallet, ethers } from 'ethers';
import {
  bytesToBigint, createNoteForAddress, createSwirlWallet, createTransferProof, encryptNote,
  noteCommitment, noteNullifier, recoverWalletNotes, zeroNote,
} from '@swirl/wallet';

const root = path.resolve(import.meta.dirname, '../../..');
const resultFile = path.join(root, 'apps/extension/artifacts/mainnet-small-flow-result.json');
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Set DEPLOYER_PRIVATE_KEY in the command environment');
if (process.env.SWIRL_MAINNET_TEST_CONFIRM !== 'TEST_ETH_0_0001') throw new Error('Set SWIRL_MAINNET_TEST_CONFIRM=TEST_ETH_0_0001 after reviewing the three mainnet transactions');

const deployment = JSON.parse(await readFile(path.join(root, 'packages/contracts/deployments/ethereum.json'), 'utf8'));
const asset = deployment.assets.find((item) => item.symbol === 'ETH');
if (deployment.chainId !== 1 || !asset || asset.kind !== 'native') throw new Error('The packaged Ethereum native deployment is invalid');
const rpcUrl = process.env.ETHEREUM_RPC_URL ?? deployment.rpcUrl;
const provider = new ethers.JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
const signer = new Wallet(privateKey, provider);
if (signer.address.toLowerCase() !== deployment.deployer.toLowerCase()) throw new Error('Test signer does not match the reviewed deployment account');
const gross = ethers.parseEther('0.0001');
const feeBps = BigInt(deployment.feeBps);
const net = gross - gross * feeBps / 10_000n;
const expectedReturn = net - net * feeBps / 10_000n;
const maxFeePerGas = 50_000_000n;
const maxPriorityFeePerGas = 1_000_000n;
const overrides = { maxFeePerGas, maxPriorityFeePerGas };
const latest = await provider.getBlock('latest');
if (!latest || latest.baseFeePerGas + maxPriorityFeePerGas > maxFeePerGas) throw new Error('Current mainnet fee exceeds the approved 0.05 gwei cap');
let balanceStart = await provider.getBalance(signer.address);
const maximumGas = 7_520_337n;
if (balanceStart < gross + maximumGas * maxFeePerGas) throw new Error('Insufficient ETH for the reviewed amount and maximum Gas budget');

const token = new Contract(asset.token, ['function balanceOf(address) view returns (uint256)'], provider);
const treasuryWethStart = await token.balanceOf(deployment.treasury);
const vault = new Contract(asset.vault, [
  'function transact((uint256[2] a,uint256[2][2] b,uint256[2] c) proof,bytes32 root,bytes32[2] nullifiers,bytes32[4] outputCommitments,bytes[4] ciphertexts,uint256 publicAmount,address publicRecipient,address token)',
  'function nullifiers(bytes32) view returns (bool)',
], signer);
const gateway = new Contract(asset.gateway, [
  'function shieldNative(bytes32 commitment,bytes ciphertext,bytes32 owner,bytes32 randomness) payable',
  'function unshieldNative((uint256[2] a,uint256[2][2] b,uint256[2] c) proof,bytes32 root,bytes32[2] nullifiers,bytes32[4] outputCommitments,bytes[4] ciphertexts,uint256 publicAmount)',
], signer);
const provingAssets = {
  wasm: path.join(root, 'packages/contracts/build/circuits/swirl_transfer_js/swirl_transfer.wasm'),
  zkey: path.join(root, 'packages/contracts/build/circuits/swirl_transfer_final.zkey'),
};
const walletA = await createSwirlWallet(1, ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes(`${privateKey}:swirl-mainnet-small:A`))).phrase);
const walletB = await createSwirlWallet(1, ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes(`${privateKey}:swirl-mainnet-small:B`))).phrase);
const startBlock = 26288500;
const result = {
  ok: false, network: 'Ethereum', chainId: 1, asset: 'ETH', grossAmount: ethers.formatEther(gross),
  expectedReturn: ethers.formatEther(expectedReturn), startBlock, transactions: [], stage: 'preflight',
};
async function save() { await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`); }
async function confirm(transaction, stage) {
  console.log(`${stage} transaction: ${transaction.hash}`);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error(`${stage} transaction failed: ${transaction.hash}`);
  const effectiveGasPrice = receipt.effectiveGasPrice ?? receipt.gasPrice;
  if (effectiveGasPrice === undefined) throw new Error(`${stage} receipt has no Gas price field`);
  result.transactions.push({
    stage, hash: receipt.hash, blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed.toString(), effectiveGasPrice: effectiveGasPrice.toString(),
  });
  if (stage === 'Shield' && process.env.SWIRL_TEST_SHIELD_TX) {
    balanceStart += gross + receipt.gasUsed * effectiveGasPrice;
  }
  result.stage = stage;
  await save();
  console.log(`${stage} confirmed in block ${receipt.blockNumber}; Gas ${receipt.gasUsed}`);
  return receipt;
}
function ciphertextHash(ciphertexts) {
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(['bytes[4]'], [ciphertexts]);
  return BigInt(ethers.keccak256(encoded)) % 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
}
async function recover(wallet) {
  return recoverWalletNotes({ provider, wallet, vaultAddress: asset.vault, startBlock, batchSize: 100 });
}

try {
  await save();
  let shieldTx;
  if (process.env.SWIRL_TEST_SHIELD_TX) {
    shieldTx = await provider.getTransaction(process.env.SWIRL_TEST_SHIELD_TX);
    if (!shieldTx) throw new Error('The confirmed Shield transaction could not be loaded');
  } else {
    const shieldNote = await createNoteForAddress({ address: walletA.address, token: BigInt(asset.token), amount: net, chainId: 1 });
    const shieldCommitment = await noteCommitment(shieldNote);
    const shieldCiphertext = ethers.hexlify(encryptNote(shieldNote, walletA.address));
    shieldTx = await gateway.shieldNative(
      ethers.toBeHex(shieldCommitment, 32), shieldCiphertext,
      ethers.toBeHex(shieldNote.owner, 32), ethers.toBeHex(shieldNote.randomness, 32),
      { value: gross, ...overrides },
    );
  }
  await confirm(shieldTx, 'Shield');

  const stateA = await recover(walletA);
  const inputA = stateA.notes.find((item) => !item.spent && item.note.token === BigInt(asset.token) && item.note.amount === net);
  if (!inputA) throw new Error('Shielded note was not recovered from Ethereum events');
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
  if (!inputB) throw new Error('Private recipient note was not recovered from Ethereum events');
  const unshieldCiphertexts = [ethers.AbiCoder.defaultAbiCoder().encode(['address'], [signer.address]), '0x', '0x', '0x'];
  const unshieldProof = await createTransferProof({
    inputs: [{ note: inputB.note, merklePath: stateB.tree.path(inputB.note.leafIndex), ownerSecret: bytesToBigint(walletB.noteSecretKey) }],
    outputs: [zeroNote(BigInt(asset.token))], zeroInputPath: stateB.tree.path(0), publicAmount: net,
    ciphertextHash: ciphertextHash(unshieldCiphertexts), publicRecipient: BigInt(asset.gateway), chainId: 1n, assets: provingAssets,
  });
  const unshieldArgs = [
    unshieldProof.solidity, ethers.toBeHex(unshieldProof.root, 32),
    unshieldProof.nullifiers.map((value) => ethers.toBeHex(value, 32)),
    unshieldProof.outputCommitments.map((value) => ethers.toBeHex(value, 32)),
    unshieldCiphertexts, net,
  ];
  await gateway.unshieldNative.staticCall(...unshieldArgs);
  const unshieldTx = await gateway.unshieldNative(...unshieldArgs, overrides);
  await confirm(unshieldTx, 'Unshield');

  const [balanceEnd, treasuryWethEnd, vaultWethEnd, nullifierASpent, nullifierBSpent] = await Promise.all([
    provider.getBalance(signer.address), token.balanceOf(deployment.treasury), token.balanceOf(asset.vault),
    vault.nullifiers(ethers.toBeHex(inputA.nullifier, 32)), vault.nullifiers(ethers.toBeHex(inputB.nullifier, 32)),
  ]);
  const gasCost = result.transactions.reduce((sum, item) => sum + BigInt(item.gasUsed) * BigInt(item.effectiveGasPrice), 0n);
  const expectedBalanceEnd = balanceStart - gross - gasCost + expectedReturn;
  const totalProtocolFees = gross - expectedReturn;
  if (balanceEnd !== expectedBalanceEnd) throw new Error(`Final ETH balance mismatch: expected ${expectedBalanceEnd}, received ${balanceEnd}`);
  if (treasuryWethEnd - treasuryWethStart !== totalProtocolFees) throw new Error('Treasury WETH fees do not match the two 0.25% charges');
  if (vaultWethEnd !== 0n) throw new Error(`Vault has an unexpected remaining WETH balance: ${vaultWethEnd}`);
  if (!nullifierASpent || !nullifierBSpent) throw new Error('An input nullifier was not marked spent');
  Object.assign(result, {
    ok: true, stage: 'verified', returnedAmount: ethers.formatEther(expectedReturn),
    totalGasCost: ethers.formatEther(gasCost), totalProtocolFees: ethers.formatEther(totalProtocolFees),
    balanceStart: ethers.formatEther(balanceStart), balanceEnd: ethers.formatEther(balanceEnd),
    treasuryWethFeeIncrease: ethers.formatEther(treasuryWethEnd - treasuryWethStart),
    vaultWethEnd: ethers.formatEther(vaultWethEnd), inputNullifiersSpent: true,
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
