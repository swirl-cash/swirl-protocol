#!/usr/bin/env node
import path from 'node:path';
import { HDNodeWallet, JsonRpcProvider, ethers } from 'ethers';
import { recoverWalletNotes } from './recovery.js';
import { createSwirlWallet } from './wallet.js';

function option(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.slice(2).find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

function required(name: string, envName: string): string {
  const value = option(name) ?? process.env[envName];
  if (!value) throw new Error(`Missing --${name} (or ${envName})`);
  return value;
}

async function main(): Promise<void> {
  if (process.argv.includes('--help')) {
    console.log(`SWIRL emergency recovery\n\nScan only (default):\n  node dist/recovery-cli.js --rpc=RPC_URL --vault=0x... --token=0x... [--start-block=N] [--batch-size=N]\n\nWithdraw every unspent note for one asset:\n  node dist/recovery-cli.js --rpc=RPC_URL --vault=0x... --token=0x... --to=0x... --withdraw --confirm=WITHDRAW [--gateway=0x...]\n\nThe recovery phrase is read only from SWIRL_RECOVERY_PHRASE.\nProving files default to packages/contracts/build/circuits; override with --wasm and --zkey.\nNo website, indexer, Relayer or SWIRL server is contacted.`);
    return;
  }
  const phrase = process.env.SWIRL_RECOVERY_PHRASE;
  if (!phrase) throw new Error('Set SWIRL_RECOVERY_PHRASE in this local process only');
  const rpc = required('rpc', 'RPC_URL');
  const vaultAddress = required('vault', 'VAULT_ADDRESS');
  const token = ethers.getAddress(required('token', 'TOKEN_ADDRESS'));
  const provider = new JsonRpcProvider(rpc, undefined, { staticNetwork: true });
  const { chainId } = await provider.getNetwork();
  const wallet = await createSwirlWallet(Number(chainId), phrase);
  const state = await recoverWalletNotes({
    provider, wallet, vaultAddress,
    startBlock: Number(option('start-block') ?? 0), batchSize: Number(option('batch-size') ?? 500),
  });
  const notes = state.notes.filter((item) => item.note.token === BigInt(token));
  const unspent = notes.filter((item) => !item.spent);
  console.log(JSON.stringify({
    chainId: state.chainId, vault: state.vaultAddress, token, lastScannedBlock: state.lastScannedBlock,
    recoveredNotes: notes.length, unspentNotes: unspent.length,
    unspentAmount: unspent.reduce((sum, item) => sum + item.note.amount, 0n).toString(),
  }, null, 2));
  if (!process.argv.includes('--withdraw')) return;
  if (option('confirm') !== 'WITHDRAW') throw new Error('Add --confirm=WITHDRAW after reviewing the scan and recipient');
  const recipient = ethers.getAddress(required('to', 'RECOVERY_RECIPIENT'));
  const gatewayAddress = option('gateway');
  if (gatewayAddress && !ethers.isAddress(gatewayAddress)) throw new Error('Invalid gateway address');
  const wasm = path.resolve(option('wasm') ?? 'packages/contracts/build/circuits/swirl_transfer_js/swirl_transfer.wasm');
  const zkey = path.resolve(option('zkey') ?? 'packages/contracts/build/circuits/swirl_transfer_final.zkey');
  const signer = HDNodeWallet.fromPhrase(phrase).connect(provider);
  console.log(`Local Gas signer: ${signer.address}; recipient: ${recipient}; notes: ${unspent.length}`);
  const { withdrawRecoveredNote } = await import('./recovery.js');
  for (const recovered of unspent) {
    const receipt = await withdrawRecoveredNote({
      signer, wallet, state, recovered, recipient, gatewayAddress, assets: { wasm, zkey },
    });
    console.log(`Withdrawn leaf ${recovered.note.leafIndex}: ${receipt.hash}`);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Recovery failed');
  process.exitCode = 1;
});
