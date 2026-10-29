import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { JsonRpcProvider, Wallet, ethers } from 'ethers';
import { bytesToBigint, createSwirlWallet, decryptNote, noteCommitment } from '@swirl/wallet';

const root = path.resolve(import.meta.dirname, '../../..');
const children = [];
let browser;
const errors = [];
const relayRequests = [];
const relayQuotes = [];
function start(command, args, cwd, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}
function ready(child, text) {
  return Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (chunk.toString().includes(text)) resolve(); });
      child.stderr.on('data', (chunk) => console.error(chunk.toString()));
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Process exited early: ${code}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${text}`)), 20_000)),
  ]);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

try {
  const hardhat = start(process.execPath, [path.join(root, 'node_modules/hardhat/internal/cli/cli.js'), 'node', '--hostname', '127.0.0.1', '--port', '8545'], path.join(root, 'packages/contracts'));
  await ready(hardhat, 'Started HTTP and WebSocket JSON-RPC server');
  const deploy = start(process.execPath, [path.join(root, 'node_modules/hardhat/internal/cli/cli.js'), 'run', 'scripts/deploy-local.ts', '--network', 'localhost'], path.join(root, 'packages/contracts'));
  const [deployCode] = await once(deploy, 'exit');
  if (deployCode !== 0) throw new Error(`Deployment failed: ${deployCode}`);
  const deployment = JSON.parse(await readFile(path.join(root, 'packages/contracts/deployments/localhost.json'), 'utf8'));
  const nativeAsset = deployment.assets.find((asset) => asset.symbol === 'ETH');
  if (!nativeAsset) throw new Error('Local native asset is missing');
  for (const service of ['relay', 'indexer']) {
    const build = start(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, `packages/${service}/tsconfig.json`)], root);
    const [buildCode] = await once(build, 'exit');
    if (buildCode !== 0) throw new Error(`${service} build failed: ${buildCode}`);
  }
  const relayer = start(process.execPath, [path.join(root, 'packages/relay/dist/index.js')], root, {
    ...process.env,
    RPC_URL: 'http://127.0.0.1:8545',
    RELAYER_PRIVATE_KEY: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    VAULT_ADDRESS: deployment.vault,
    CORS_ORIGIN: 'http://127.0.0.1:7103',
    PORT: '8787',
    RATE_LIMIT_PER_MINUTE: '10000',
    RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
    RELAYER_DYNAMIC_GAS_FEE: 'true',
    RELAYER_GAS_MULTIPLIER_BPS: '10000',
    RELAYER_ASSETS: JSON.stringify([{ token: nativeAsset.token, feeAmount: '1', kind: 'native' }]),
  });
  await ready(relayer, 'SWIRL relayer listening');
  if ((await fetch(`http://127.0.0.1:8787/quote?token=${nativeAsset.token}`)).status !== 400) {
    throw new Error('Dynamic Relayer accepted a quote without a Dummy Proof Gas estimate');
  }
  const indexer = start(process.execPath, [path.join(root, 'packages/indexer/dist/index.js')], root, {
    ...process.env,
    RPC_URL: 'http://127.0.0.1:8545',
    VAULT_ADDRESS: deployment.vault,
    RATE_LIMIT_PER_MINUTE: '10000',
    INDEXER_STATE_FILE: path.join(root, 'apps/extension/artifacts/indexer-dynamic-e2e-state.json'),
    CORS_ORIGIN: 'http://127.0.0.1:7103',
    PORT: '8788',
  });
  await ready(indexer, 'SWIRL indexer listening');
  const vite = start(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '7103', '--strictPort'], path.join(root, 'apps/extension'));
  await ready(vite, 'Local:');

  const rpc = new JsonRpcProvider('http://127.0.0.1:8545');
  const funder = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', rpc);
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  page.on('request', (request) => {
    if (request.url() === 'http://127.0.0.1:8787/relay') relayRequests.push(request.postDataJSON());
  });
  page.on('response', (response) => {
    if (response.url().startsWith('http://127.0.0.1:8787/quote?') && response.status() === 200) {
      void response.json().then((quote) => relayQuotes.push(quote)).catch(() => undefined);
    }
  });
  async function openAsset(bucket, symbol) {
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await page.locator(`.${bucket}-gateway`).click();
    await page.locator('.asset-list-row').filter({ hasText: symbol }).click();
  }
  await page.route('**/deployment.local.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(deployment) }));
  await page.addInitScript(() => localStorage.setItem('swirl.network.v1', JSON.stringify({ chainId: 31337 })));
  await page.goto('http://127.0.0.1:7103/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.locator('#wallet-password').fill('correct horse battery');
  await page.locator('#wallet-confirmation').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create encrypted wallet' }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  const swirlAddress = await page.locator('.account-address').getAttribute('title');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await page.getByRole('button', { name: 'EVM receive' }).click();
  const evmAddress = await page.locator('.address-box').getAttribute('title');
  if (!evmAddress || !ethers.isAddress(evmAddress)) throw new Error('Built-in EVM account was not derived');
  await (await funder.sendTransaction({ to: evmAddress, value: ethers.parseEther('2') })).wait();

  await openAsset('public', 'ETH');
  await page.locator('#action-amount').fill('0.5');
  await page.getByRole('button', { name: 'Shield assets' }).click();
  await openAsset('private', 'ETH');
  await page.locator('.private-balance').filter({ hasText: '0.49875 ETH' }).waitFor({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Transfer', exact: true }).click();
  await page.getByRole('button', { name: 'Use maximum transfer amount' }).click();
  await page.waitForFunction(() => {
    const value = Number(document.querySelector('#action-amount')?.value ?? '0');
    return value > 0 && value < 0.49875;
  }, null, { timeout: 180_000 }).catch(async () => {
    throw new Error(`Dynamic MAX estimation failed:\n${await page.locator('body').innerText()}\n${errors.join(' | ')}`);
  });
  const dynamicMaximum = await page.locator('#action-amount').inputValue();
  await page.locator('#action-recipient').fill(swirlAddress);
  await page.getByRole('button', { name: 'Prove & transfer' }).click();
  await page.getByText('Private transfer confirmed. The input nullifiers are now spent.').waitFor({ timeout: 180_000 }).catch(async () => {
    throw new Error(`Dynamic private transfer failed:\n${await page.locator('body').innerText()}\n${errors.join(' | ')}`);
  });

  const quote = relayQuotes.at(-1);
  const request = relayRequests.at(-1);
  if (!quote || !request || request.quoteId !== quote.id) throw new Error('Dynamic quote was not bound to the submitted Relay request');
  const transaction = await rpc.getTransaction(request.transactionHash ?? (await rpc.getBlock('latest', true))?.transactions.at(-1));
  const latestBlock = await rpc.getBlock('latest', true);
  const relayedTransaction = transaction?.from.toLowerCase() === '0x0000000000000000000000000000000000000000'
    ? null : transaction;
  const submitted = relayedTransaction ?? await rpc.getTransaction(latestBlock?.transactions.at(-1));
  if (!submitted || submitted.type !== 1) throw new Error(`Relayed transaction is not Type 1: type=${submitted?.type}`);
  if (submitted.gasPrice !== BigInt(quote.overallBatchMinGasPrice) || submitted.gasLimit !== BigInt(quote.gasLimit)) {
    throw new Error('Submitted Type 1 Gas fields do not match the dynamic quote');
  }
  if (BigInt(quote.feeAmount) !== submitted.gasLimit * submitted.gasPrice) throw new Error('Native dynamic fee does not cover maximum Gas');

  const feeWallet = await createSwirlWallet(31337, 'test test test test test test test test test test test junk');
  const snapshot = await (await fetch('http://127.0.0.1:8788/events')).json();
  const event = snapshot.events.filter((item) => item.kind === 'transacted').at(-1);
  const feeNote = await decryptNote(ethers.getBytes(event.ciphertexts[0]), feeWallet.viewingSecretKey, bytesToBigint(feeWallet.noteSecretKey));
  if (!feeNote || feeNote.amount !== BigInt(quote.feeAmount) || await noteCommitment(feeNote) !== BigInt(event.commitments[0])) {
    throw new Error('Dynamic Relayer fee output was not paid correctly');
  }
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log(JSON.stringify({
    ok: true,
    dynamicTransfer: true,
    dynamicMaximum,
    transactionType: submitted.type,
    gasEstimate: quote.gasEstimate,
    gasLimit: quote.gasLimit,
    gasPrice: quote.gasPrice,
    feeAmount: quote.feeAmount,
    feeCommitmentVerified: true,
    pageErrors: errors,
  }, null, 2));
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) await stop(child);
}
