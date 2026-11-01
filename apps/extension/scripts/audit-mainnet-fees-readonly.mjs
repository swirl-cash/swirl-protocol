import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Contract, Interface, JsonRpcProvider, ethers } from 'ethers';

const root = path.resolve(import.meta.dirname, '../../..');
const deployment = JSON.parse(await readFile(path.join(root, 'apps/extension/public/deployment.ethereum.json'), 'utf8'));
const rpcUrls = [deployment.rpcUrl, ...(deployment.rpcFallbackUrls ?? [])];
let provider;
let activeRpc;
for (const rpcUrl of rpcUrls) {
  try {
    const candidate = new JsonRpcProvider(rpcUrl, 1, { staticNetwork: true });
    await candidate.getBlockNumber();
    provider = candidate;
    activeRpc = rpcUrl;
    break;
  } catch {}
}
if (!provider) throw new Error('No Ethereum RPC responded');

const vaultAddress = ethers.getAddress(deployment.vault);
const treasury = ethers.getAddress(deployment.treasury);
const vault = new Contract(vaultAddress, [
  'function treasury() view returns (address)',
  'function feeBps() view returns (uint16)',
  'event Shielded(uint32 indexed leafIndex,bytes32 indexed commitment,bytes ciphertext,uint256 amount,uint256 fee,bytes32 owner,address indexed token)',
  'event Unshielded(address indexed recipient,uint256 amount,uint256 fee,address indexed token)',
], provider);
const transferTopic = new Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']).getEvent('Transfer').topicHash;
const knownHashes = [
  '0x2691bd4458bf8ed57732bcac075e2bce720c5da379aa9c23d68e87353ddabbfe',
  '0x332f53a19ab844c100154756ca813ed5f312a1fa32eaa9a6f537ff8ecb6a7fe2',
];
const knownReceipts = await Promise.all(knownHashes.map((hash) => provider.getTransactionReceipt(hash)));
const firstKnownBlock = Math.min(...knownReceipts.filter(Boolean).map((receipt) => receipt.blockNumber));
const latest = await provider.getBlockNumber();
const startBlock = Math.max(0, firstKnownBlock - 1000);
const chunkSize = 2500;

async function logsFor(filter) {
  const logs = [];
  for (let from = startBlock; from <= latest; from += chunkSize) {
    const to = Math.min(latest, from + chunkSize - 1);
    logs.push(...await provider.getLogs({ ...filter, fromBlock: from, toBlock: to }));
  }
  return logs;
}

const shieldedTopic = vault.interface.getEvent('Shielded').topicHash;
const unshieldedTopic = vault.interface.getEvent('Unshielded').topicHash;
const [shieldLogs, unshieldLogs, onchainTreasury, onchainFeeBps] = await Promise.all([
  logsFor({ address: vaultAddress, topics: [shieldedTopic] }),
  logsFor({ address: vaultAddress, topics: [unshieldedTopic] }),
  vault.treasury(),
  vault.feeBps(),
]);

const tokenTransfers = {};
for (const asset of deployment.assets) {
  const logs = await logsFor({
    address: asset.token,
    topics: [transferTopic, ethers.zeroPadValue(vaultAddress, 32), ethers.zeroPadValue(treasury, 32)],
  });
  tokenTransfers[asset.symbol] = logs.map((log) => ({
    txHash: log.transactionHash,
    blockNumber: log.blockNumber,
    rawAmount: log.data,
    amount: ethers.formatUnits(log.data, asset.decimals),
  }));
}

function parseEvents(logs) {
  return logs.map((log) => {
    const parsed = vault.interface.parseLog(log);
    return {
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      leafIndex: parsed.name === 'Shielded' ? Number(parsed.args.leafIndex) : undefined,
      recipient: parsed.name === 'Unshielded' ? parsed.args.recipient : undefined,
      token: parsed.args.token,
      amount: parsed.args.amount.toString(),
      fee: parsed.args.fee.toString(),
    };
  });
}

const balances = {};
for (const asset of deployment.assets) {
  const token = new Contract(asset.token, ['function balanceOf(address) view returns (uint256)'], provider);
  balances[asset.symbol] = ethers.formatUnits(await token.balanceOf(treasury), asset.decimals);
}

console.log(JSON.stringify({
  activeRpc,
  startBlock,
  latest,
  scannedThrough: new Date((await provider.getBlock(latest)).timestamp * 1000).toISOString(),
  vaultAddress,
  treasury,
  onchainTreasury,
  onchainFeeBps: onchainFeeBps.toString(),
  treasuryNativeEth: ethers.formatEther(await provider.getBalance(treasury)),
  treasuryTokenBalances: balances,
  knownReceipts: knownReceipts.map((receipt, index) => ({
    hash: knownHashes[index], status: receipt?.status, blockNumber: receipt?.blockNumber,
    feeTransfers: receipt?.logs.filter((log) => log.address.toLowerCase() === deployment.assets[0].token.toLowerCase()
      && log.topics[0] === transferTopic
      && log.topics[1]?.toLowerCase() === ethers.zeroPadValue(vaultAddress, 32).toLowerCase()
      && log.topics[2]?.toLowerCase() === ethers.zeroPadValue(treasury, 32).toLowerCase())
      .map((log) => ({ rawAmount: log.data, amountWeth: ethers.formatEther(log.data) })) ?? [],
  })),
  shielded: parseEvents(shieldLogs),
  unshielded: parseEvents(unshieldLogs),
  treasuryTransfersFromVault: tokenTransfers,
}, null, 2));
provider.destroy();
