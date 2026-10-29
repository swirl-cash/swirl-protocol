import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Contract, Wallet, ethers } from 'ethers';
import { createSwirlWallet, recoverWalletNotes } from '@swirl/wallet';

const root = path.resolve(import.meta.dirname, '../../..');
const symbol = process.env.SWIRL_ASSET_SYMBOL;
if (!['USDC', 'USDT'].includes(symbol ?? '')) throw new Error('Set SWIRL_ASSET_SYMBOL to USDC or USDT');
const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Set DEPLOYER_PRIVATE_KEY in the command environment');
const deployment = JSON.parse(await readFile(path.join(root, 'packages/contracts/deployments/ethereum.json'), 'utf8'));
const resultFile = path.join(root, `apps/extension/artifacts/mainnet-${symbol.toLowerCase()}-flow-result.json`);
const previous = JSON.parse(await readFile(resultFile, 'utf8'));
const asset = deployment.assets.find((item) => item.symbol === symbol);
const provider = new ethers.JsonRpcProvider(deployment.rpcUrl, 1, { staticNetwork: true });
const signer = new Wallet(privateKey, provider);
const gross = ethers.parseUnits('0.1', 6);
const feeBps = BigInt(deployment.feeBps);
const shieldFee = gross * feeBps / 10_000n;
const net = gross - shieldFee;
const unshieldFee = net * feeBps / 10_000n;
const expectedReturn = net - unshieldFee;
const tokenBalanceStart = ethers.parseUnits(symbol === 'USDC' ? '0.331669' : '0.408542', 6);
const vault = new Contract(asset.vault, [
  'function nullifiers(bytes32) view returns (bool)',
  'event Shielded(uint32 indexed leafIndex,bytes32 indexed commitment,bytes ciphertext,uint256 amount,uint256 fee,bytes32 owner,address indexed token)',
  'event Unshielded(address indexed recipient,uint256 amount,uint256 fee,address indexed token)',
], provider);
const token = new Contract(asset.token, [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)',
], provider);
const walletA = await createSwirlWallet(1, ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes(`${privateKey}:swirl-mainnet-${symbol}:A`))).phrase);
const walletB = await createSwirlWallet(1, ethers.Mnemonic.fromEntropy(ethers.sha256(ethers.toUtf8Bytes(`${privateKey}:swirl-mainnet-${symbol}:B`))).phrase);

try {
  if (previous.transactions.length !== 4) throw new Error(`${symbol} must have exactly four test transactions`);
  const receipts = await Promise.all(previous.transactions.map((item) => provider.getTransactionReceipt(item.hash)));
  if (receipts.some((receipt) => !receipt || receipt.status !== 1)) throw new Error(`${symbol} has a missing or failed receipt`);
  const gasCost = receipts.reduce((sum, receipt) => sum + receipt.gasUsed * (receipt.effectiveGasPrice ?? receipt.gasPrice), 0n);
  const gasUsed = receipts.reduce((sum, receipt) => sum + receipt.gasUsed, 0n);
  const shieldLog = receipts[1].logs.map((log) => { try { return vault.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'Shielded');
  const unshieldLog = receipts[3].logs.map((log) => { try { return vault.interface.parseLog(log); } catch { return null; } }).find((log) => log?.name === 'Unshielded');
  if (!shieldLog || shieldLog.args.amount !== net || shieldLog.args.fee !== shieldFee || shieldLog.args.token.toLowerCase() !== asset.token.toLowerCase()) throw new Error(`${symbol} Shield event mismatch`);
  if (!unshieldLog || unshieldLog.args.recipient.toLowerCase() !== signer.address.toLowerCase() || unshieldLog.args.amount !== expectedReturn || unshieldLog.args.fee !== unshieldFee || unshieldLog.args.token.toLowerCase() !== asset.token.toLowerCase()) throw new Error(`${symbol} Unshield event mismatch`);

  const [stateA, stateB, tokenBalanceEnd, vaultTokenEnd, allowanceEnd] = await Promise.all([
    recoverWalletNotes({ provider, wallet: walletA, vaultAddress: asset.vault, startBlock: previous.startBlock, batchSize: 100 }),
    recoverWalletNotes({ provider, wallet: walletB, vaultAddress: asset.vault, startBlock: previous.startBlock, batchSize: 100 }),
    token.balanceOf(signer.address), token.balanceOf(asset.vault), token.allowance(signer.address, asset.vault),
  ]);
  const noteA = stateA.notes.find((item) => item.note.token === BigInt(asset.token) && item.note.amount === net);
  const noteB = stateB.notes.find((item) => item.note.token === BigInt(asset.token) && item.note.amount === net);
  if (!noteA?.spent || !noteB?.spent) throw new Error(`${symbol} recovered input notes are not both spent`);
  const [nullifierASpent, nullifierBSpent] = await Promise.all([
    vault.nullifiers(ethers.toBeHex(noteA.nullifier, 32)), vault.nullifiers(ethers.toBeHex(noteB.nullifier, 32)),
  ]);
  if (!nullifierASpent || !nullifierBSpent) throw new Error(`${symbol} on-chain nullifier mismatch`);
  if (tokenBalanceEnd !== tokenBalanceStart) throw new Error(`${symbol} final wallet balance mismatch: expected ${tokenBalanceStart}, received ${tokenBalanceEnd}`);
  if (vaultTokenEnd !== 0n) throw new Error(`${symbol} Vault has an unexpected remaining balance: ${vaultTokenEnd}`);
  if (allowanceEnd !== 0n) throw new Error(`${symbol} test allowance was not fully consumed`);

  const result = {
    ...previous, ok: true, stage: 'verified', error: undefined,
    returnedAmount: ethers.formatUnits(expectedReturn, 6),
    totalGasUsed: gasUsed.toString(), totalGasCost: ethers.formatEther(gasCost),
    totalProtocolFees: ethers.formatUnits(shieldFee + unshieldFee, 6),
    tokenBalanceStart: ethers.formatUnits(tokenBalanceStart, 6), tokenBalanceEnd: ethers.formatUnits(tokenBalanceEnd, 6),
    shieldEventVerified: true, unshieldEventVerified: true,
    recoveredInputNotesSpent: true, onChainNullifiersSpent: true,
    allowanceFullyConsumed: true, vaultTokenEnd: ethers.formatUnits(vaultTokenEnd, 6),
  };
  await writeFile(resultFile, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  provider.destroy();
}
process.exit(0);
