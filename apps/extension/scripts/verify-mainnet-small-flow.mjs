import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Contract, Wallet, ethers } from 'ethers';
import { createSwirlWallet, recoverWalletNotes } from '@swirl/wallet';

const root = path.resolve(import.meta.dirname, '../../..');
const resultFile = path.join(root, 'apps/extension/artifacts/mainnet-small-flow-result.json');
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Set DEPLOYER_PRIVATE_KEY in the command environment');
const deployment = JSON.parse(await readFile(path.join(root, 'packages/contracts/deployments/ethereum.json'), 'utf8'));
const previous = JSON.parse(await readFile(resultFile, 'utf8'));
const asset = deployment.assets.find((item) => item.symbol === 'ETH');
const provider = new ethers.JsonRpcProvider(deployment.rpcUrl, 1, { staticNetwork: true });
const signer = new Wallet(privateKey, provider);
const gross = ethers.parseEther('0.0001');
const feeBps = BigInt(deployment.feeBps);
const shieldFee = gross * feeBps / 10_000n;
const net = gross - shieldFee;
const unshieldFee = net * feeBps / 10_000n;
const expectedReturn = net - unshieldFee;
const balanceStart = ethers.parseEther('0.001070591858467869');
const vault = new Contract(asset.vault, [
  'function nullifiers(bytes32) view returns (bool)',
  'event Shielded(uint32 indexed leafIndex,bytes32 indexed commitment,bytes ciphertext,uint256 amount,uint256 fee,bytes32 owner,address indexed token)',
  'event Unshielded(address indexed recipient,uint256 amount,uint256 fee,address indexed token)',
], provider);
const token = new Contract(asset.token, ['function balanceOf(address) view returns (uint256)'], provider);
const walletA = await createSwirlWallet(1, ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes(`${privateKey}:swirl-mainnet-small:A`))).phrase);
const walletB = await createSwirlWallet(1, ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes(`${privateKey}:swirl-mainnet-small:B`))).phrase);

try {
  const receipts = await Promise.all(previous.transactions.map((item) => provider.getTransactionReceipt(item.hash)));
  if (receipts.some((receipt) => !receipt || receipt.status !== 1)) throw new Error('A mainnet test receipt is missing or failed');
  const gasCost = receipts.reduce((sum, receipt) => sum + receipt.gasUsed * (receipt.effectiveGasPrice ?? receipt.gasPrice), 0n);
  const gasUsed = receipts.reduce((sum, receipt) => sum + receipt.gasUsed, 0n);
  const shieldLog = receipts[0].logs.map((log) => { try { return vault.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'Shielded');
  const unshieldLog = receipts[2].logs.map((log) => { try { return vault.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'Unshielded');
  if (!shieldLog || shieldLog.args.amount !== net || shieldLog.args.fee !== shieldFee || shieldLog.args.token.toLowerCase() !== asset.token.toLowerCase()) throw new Error('Shield event amount, fee or token mismatch');
  if (!unshieldLog || unshieldLog.args.recipient.toLowerCase() !== asset.gateway.toLowerCase() || unshieldLog.args.amount !== expectedReturn || unshieldLog.args.fee !== unshieldFee || unshieldLog.args.token.toLowerCase() !== asset.token.toLowerCase()) throw new Error('Unshield event recipient, amount, fee or token mismatch');

  const [stateA, stateB, balanceEnd, vaultWethEnd] = await Promise.all([
    recoverWalletNotes({ provider, wallet: walletA, vaultAddress: asset.vault, startBlock: previous.startBlock, batchSize: 100 }),
    recoverWalletNotes({ provider, wallet: walletB, vaultAddress: asset.vault, startBlock: previous.startBlock, batchSize: 100 }),
    provider.getBalance(signer.address), token.balanceOf(asset.vault),
  ]);
  const noteA = stateA.notes.find((item) => item.note.token === BigInt(asset.token) && item.note.amount === net);
  const noteB = stateB.notes.find((item) => item.note.token === BigInt(asset.token) && item.note.amount === net);
  if (!noteA?.spent || !noteB?.spent) throw new Error('Recovered input notes are not both marked spent');
  const [nullifierASpent, nullifierBSpent] = await Promise.all([
    vault.nullifiers(ethers.toBeHex(noteA.nullifier, 32)), vault.nullifiers(ethers.toBeHex(noteB.nullifier, 32)),
  ]);
  if (!nullifierASpent || !nullifierBSpent) throw new Error('On-chain nullifier status mismatch');
  const expectedBalanceEnd = balanceStart - gross - gasCost + expectedReturn;
  if (balanceEnd !== expectedBalanceEnd) throw new Error(`Final ETH balance mismatch: expected ${expectedBalanceEnd}, received ${balanceEnd}`);
  if (vaultWethEnd !== 0n) throw new Error(`Vault has an unexpected remaining WETH balance: ${vaultWethEnd}`);

  const result = {
    ...previous, ok: true, stage: 'verified', error: undefined,
    returnedAmount: ethers.formatEther(expectedReturn),
    totalGasUsed: gasUsed.toString(), totalGasCost: ethers.formatEther(gasCost),
    totalProtocolFees: ethers.formatEther(shieldFee + unshieldFee),
    balanceStart: ethers.formatEther(balanceStart), balanceEnd: ethers.formatEther(balanceEnd),
    shieldEventVerified: true, unshieldEventVerified: true,
    recoveredInputNotesSpent: true, onChainNullifiersSpent: true, vaultWethEnd: ethers.formatEther(vaultWethEnd),
  };
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  provider.destroy();
}
