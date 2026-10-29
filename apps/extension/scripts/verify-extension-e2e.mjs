import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { JsonRpcProvider, Wallet, ethers } from 'ethers';
import { bytesToBigint, createSwirlWallet, decryptNote, noteCommitment } from '@swirl/wallet';

const root = path.resolve(import.meta.dirname, '../../..');
const children = [];
let browser;
const errors = [];
let rpcGetLogs = 0;
let usdcRpcGetLogs = 0;
const rpcMethods = [];
const relayRequests = [];
function start(command, args, cwd, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); return child;
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
  for (const service of ['relay', 'indexer']) {
    const build = start(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, `packages/${service}/tsconfig.json`)], root);
    const [buildCode] = await once(build, 'exit');
    if (buildCode !== 0) throw new Error(`${service} build failed: ${buildCode}`);
  }
  const relayAssets = deployment.assets.map((asset) => ({
    token: asset.token, feeAmount: asset.symbol === 'ETH' ? '2500000000000000' : '250000',
  }));
  const relayer = start(process.execPath, [path.join(root, 'packages/relay/dist/index.js')], root, {
    ...process.env, RPC_URL: 'http://127.0.0.1:8545', RELAYER_PRIVATE_KEY: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    VAULT_ADDRESS: deployment.vault, CORS_ORIGIN: 'http://127.0.0.1:7102', PORT: '8787', RATE_LIMIT_PER_MINUTE: '10000',
    RELAYER_MNEMONIC: 'test test test test test test test test test test test junk', RELAYER_ASSETS: JSON.stringify(relayAssets),
  });
  await ready(relayer, 'SWIRL relayer listening');
  const relayHealth = await (await fetch('http://127.0.0.1:8787/health')).json();
  if (relayHealth.assets?.length !== 3) throw new Error('Relayer did not expose all three configured assets');
  for (const asset of relayAssets) {
    const quoteResponse = await fetch(`http://127.0.0.1:8787/quote?token=${encodeURIComponent(asset.token)}`);
    const quote = await quoteResponse.json();
    if (quoteResponse.status !== 200 || quote.token.toLowerCase() !== asset.token.toLowerCase() || quote.feeAmount !== asset.feeAmount) {
      throw new Error(`Incorrect multi-asset quote for ${asset.token}: ${JSON.stringify(quote)}`);
    }
  }
  if ((await fetch('http://127.0.0.1:8787/quote')).status !== 400) throw new Error('Multi-asset Relayer accepted a quote without a token');
  const indexer = start(process.execPath, [path.join(root, 'packages/indexer/dist/index.js')], root, {
    ...process.env, RPC_URL: 'http://127.0.0.1:8545', VAULT_ADDRESS: deployment.vault, RATE_LIMIT_PER_MINUTE: '10000',
    INDEXER_STATE_FILE: path.join(root, 'apps/extension/artifacts/indexer-e2e-state.json'), CORS_ORIGIN: 'http://127.0.0.1:7102', PORT: '8788',
  });
  await ready(indexer, 'SWIRL indexer listening');
  const vite = start(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '7102', '--strictPort'], path.join(root, 'apps/extension'));
  await ready(vite, 'Local:');

  const rpc = new JsonRpcProvider('http://127.0.0.1:8545');
  const funder = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', rpc);
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 440, height: 900 } });
  async function openAsset(bucket, symbol) {
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await page.locator(`.${bucket}-gateway`).click();
    await page.locator('.asset-list-row').filter({ hasText: symbol }).click();
  }
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.route('**/deployment.local.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(deployment) }));
  page.on('request', (request) => {
    if (request.url() === 'http://127.0.0.1:8787/relay') relayRequests.push(request.postDataJSON());
    if (!/^http:\/\/127\.0\.0\.1:8545\/?$/.test(request.url())) return;
    const body = request.postDataJSON();
    const entries = Array.isArray(body) ? body : [body];
    const methods = entries.map((item) => item.method);
    rpcMethods.push(...methods);
    rpcGetLogs += methods.filter((method) => method === 'eth_getLogs').length;
    usdcRpcGetLogs += entries.filter((item) => item.method === 'eth_getLogs' && JSON.stringify(item.params).toLowerCase().includes(deployment.vault.toLowerCase())).length;
  });
  await page.addInitScript(() => localStorage.setItem('swirl.network.v1', JSON.stringify({ chainId: 31337 })));
  await page.goto('http://127.0.0.1:7102/', { waitUntil: 'networkidle' });
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
  await (await funder.sendTransaction({ to: evmAddress, value: ethers.parseEther('10') })).wait();
  await openAsset('public', 'USDC');
  await page.getByRole('button', { name: 'Refresh public assets' }).click();
  await page.getByRole('button', { name: 'Mint test USDC' }).waitFor({ timeout: 30_000 }).catch(async (error) => {
    await page.screenshot({ path: path.join(root, 'apps/extension/artifacts/swirl-extension-e2e-mint-failure.png'), fullPage: true });
    throw new Error(`Mint button unavailable: ${error.message}\n${await page.locator('body').innerText()}\n${errors.join(' | ')}`);
  });
  await page.getByRole('button', { name: 'Mint test USDC' }).click({ timeout: 10_000 }).catch(async (error) => {
    throw new Error(`Mint unavailable: ${error.message}\n${await page.locator('body').innerText()}\n${errors.join(' | ')}`);
  });
  await page.locator('.public-row').filter({ hasText: '10000.0 USDC' }).waitFor({ timeout: 60_000 });
  rpcGetLogs = 0; usdcRpcGetLogs = 0; // Other asset pools may use RPC fallback; this assertion covers indexed USDC recovery.

  if (await page.locator('#action-amount').inputValue() !== '0') throw new Error('Transaction amount must default to 0');
  await page.locator('#action-amount').fill('100');
  await page.getByRole('button', { name: 'Shield assets' }).click();
  await openAsset('private', 'USDC');
  await page.locator('.private-balance').filter({ hasText: '99.75' }).waitFor({ timeout: 60_000 }).catch(async () => {
    throw new Error(`First Shield failed:\n${await page.locator('body').innerText()}\n${errors.join(' | ')}`);
  });
  await openAsset('public', 'USDC');
  await page.locator('#action-amount').fill('20');
  await page.getByRole('button', { name: 'Shield assets' }).click();
  await openAsset('private', 'USDC');
  await page.locator('.private-balance').filter({ hasText: '119.7' }).waitFor({ timeout: 60_000 });
  const shieldedBalance = await page.locator('.private-balance').textContent();

  await page.getByRole('tab', { name: 'Transfer', exact: true }).click();
  await page.locator('.relayer-fee-line').filter({ hasText: '0.25 USDC' }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Use maximum transfer amount' }).click();
  if (await page.locator('#action-amount').inputValue() !== '119.45') throw new Error('Private MAX did not subtract the Relayer fee');
  await page.locator('#action-amount').fill('110');
  await page.locator('#action-recipient').fill(swirlAddress);
  await page.getByRole('button', { name: 'Prove & transfer' }).click();
  await page.getByText('Private transfer confirmed. The input nullifiers are now spent.').waitFor({ timeout: 120_000 }).catch(async () => {
    throw new Error(`Private transfer failed:\n${await page.locator('body').innerText()}\n${errors.join(' | ')}`);
  });

  const relayerFeeWallet = await createSwirlWallet(31337, 'test test test test test test test test test test test junk');
  const feeIndexResponse = await fetch('http://127.0.0.1:8788/events');
  const feeSnapshot = await feeIndexResponse.json();
  const relayEvent = feeSnapshot.events.filter((event) => event.kind === 'transacted').at(-1);
  const relayFeeNote = await decryptNote(ethers.getBytes(relayEvent.ciphertexts[0]), relayerFeeWallet.viewingSecretKey, bytesToBigint(relayerFeeWallet.noteSecretKey));
  if (!relayFeeNote || relayFeeNote.amount !== 250000n || relayFeeNote.token !== BigInt(deployment.token)
    || await noteCommitment(relayFeeNote) !== BigInt(relayEvent.commitments[0])) throw new Error('Real Relayer fee output was not paid correctly');
  const replayResponse = await fetch('http://127.0.0.1:8787/relay', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(relayRequests.at(-1)),
  });
  if (replayResponse.status !== 409) throw new Error(`Used Relayer quote replay returned ${replayResponse.status}, expected 409`);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#preference-settings > summary').click();
  await page.locator('#default-submission').selectOption('gas');
  await page.getByText('Gas account selected. Top it up with ETH before private transactions.').waitFor();
  await page.locator('#gas-settings > summary').click();
  const dedicatedGasAddress = await page.locator('.gas-address').getAttribute('title');
  if (!dedicatedGasAddress || !ethers.isAddress(dedicatedGasAddress) || dedicatedGasAddress.toLowerCase() === evmAddress.toLowerCase()) throw new Error('Gas account was not derived independently');
  await openAsset('private', 'USDC');
  await page.getByRole('tab', { name: 'Unshield' }).click();
  await page.locator('.note-item').filter({ hasText: '110.0 USDC' }).click();
  await page.locator('#action-recipient').fill(evmAddress);
  await page.getByRole('button', { name: 'Prove & unshield' }).click();
  await page.getByText(/Gas account needs about .* Top up Gas in Settings/).waitFor({ timeout: 15_000 });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#gas-settings > summary').click();
  if (await page.locator('#gas-topup-amount').inputValue() !== '0') throw new Error('Gas top-up amount must default to 0');
  await page.locator('#gas-topup-amount').fill('1');
  await page.getByRole('button', { name: 'Top up', exact: true }).click();
  await page.locator('.gas-balance').filter({ hasText: '1.000000' }).waitFor({ timeout: 60_000 });
  await page.locator('#gas-estimate-operation').selectOption('unshield');
  await page.locator('#gas-estimate-count').selectOption('10');
  await page.locator('#gas-estimate-count').selectOption('5');
  await page.locator('#security-settings > summary').click();
  await page.getByRole('button', { name: 'Reveal key', exact: true }).click();
  await page.locator('.viewing-key').waitFor();
  await page.getByRole('button', { name: 'Hide key', exact: true }).click();
  await page.screenshot({ path: path.join(root, 'apps/extension/artifacts/swirl-extension-gas-settings.png'), fullPage: true });

  await openAsset('private', 'USDC');
  await page.getByRole('tab', { name: 'Unshield' }).click();
  if (await page.locator('#gas-payer').inputValue() !== 'gas') throw new Error('Gas account preference was not applied to Unshield');
  await page.locator('.note-item').filter({ hasText: '110.0 USDC' }).click();
  await page.locator('#action-recipient').fill(evmAddress);
  await page.getByRole('button', { name: 'Prove & unshield' }).click();
  await page.getByText('Unshield confirmed. Public assets were sent to the recipient.').waitFor({ timeout: 120_000 }).catch(async () => {
    throw new Error(`Gas-paid Unshield failed:\n${await page.locator('body').innerText()}\n${errors.join(' | ')}`);
  });
  let gasTransactionHash = '';
  let gasTransaction;
  for (let attempt = 0; attempt < 50; attempt++) {
    const gasIndexResponse = await fetch('http://127.0.0.1:8788/events');
    const gasSnapshot = await gasIndexResponse.json();
    gasTransactionHash = gasSnapshot.events.filter((event) => event.kind === 'transacted').at(-1).transactionHash;
    gasTransaction = await rpc.getTransaction(gasTransactionHash);
    if (gasTransaction?.from.toLowerCase() === dedicatedGasAddress.toLowerCase()) break;
    await page.waitForTimeout(200);
  }
  if (gasTransaction?.from.toLowerCase() !== dedicatedGasAddress.toLowerCase()) throw new Error(`Unshield was not submitted by the Gas account: ${gasTransaction?.from}`);
  await page.waitForFunction(() => document.querySelector('.private-balance')?.textContent?.trim().startsWith('9.45 '), null, { timeout: 30_000 });
  const finalBalance = await page.locator('.private-balance').textContent();
  if (!finalBalance?.startsWith('9.45 ')) throw new Error(`Unexpected final private balance: ${finalBalance}`);
  const indexResponse = await fetch('http://127.0.0.1:8788/events');
  const snapshot = await indexResponse.json();
  const indexedShields = snapshot.events.filter((event) => event.kind === 'shield').length;
  const indexedTransfers = snapshot.events.filter((event) => event.kind === 'transacted').length;
  if (indexedShields !== 2 || indexedTransfers !== 2) throw new Error('Unexpected indexed history');
  if (usdcRpcGetLogs !== 0) throw new Error(`Primary indexed USDC recovery unexpectedly used RPC ${usdcRpcGetLogs} times`);
  await page.route('http://127.0.0.1:8788/events', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, events: [] }) }));
  rpcGetLogs = 0; usdcRpcGetLogs = 0;
  await page.getByRole('button', { name: 'Refresh private assets' }).click();
  const deadline = Date.now() + 10_000;
  while (usdcRpcGetLogs < 2 && Date.now() < deadline) await page.waitForTimeout(100);
  if (usdcRpcGetLogs < 2) throw new Error(`RPC fallback did not query both USDC events. Count=${usdcRpcGetLogs}; recent RPC=${rpcMethods.slice(-20).join(',')}; errors=${errors.join(' | ')}; page=\n${await page.locator('body').innerText()}`);
  await page.locator('.private-balance').filter({ hasText: '9.45' }).waitFor({ timeout: 10_000 });
  await page.unroute('http://127.0.0.1:8788/events');

  await openAsset('private', 'ETH');
  await page.locator('.private-balance').filter({ hasText: '0.0 ETH' }).waitFor({ timeout: 30_000 });
  await openAsset('public', 'ETH');
  await page.locator('#action-amount').fill('1');
  await page.getByRole('button', { name: 'Shield assets' }).click();
  await openAsset('private', 'ETH');
  await page.locator('.private-balance').filter({ hasText: '0.9975 ETH' }).waitFor({ timeout: 60_000 }).catch(async () => {
    throw new Error(`Native Shield failed:\n${await page.locator('body').innerText()}\n${errors.join(' | ')}`);
  });
  await page.getByRole('tab', { name: 'Transfer', exact: true }).click();
  await page.locator('#action-amount').fill('0.5');
  await page.locator('#action-recipient').fill(swirlAddress);
  await page.getByRole('button', { name: 'Prove & transfer' }).click();
  await page.getByText('Private transfer confirmed. The input nullifiers are now spent.').waitFor({ timeout: 120_000 });
  await page.getByRole('tab', { name: 'Unshield' }).click();
  await page.locator('.note-item').filter({ hasText: '0.5 ETH' }).click();
  await page.locator('#action-recipient').fill(evmAddress);
  await page.getByRole('button', { name: 'Prove & unshield' }).click();
  await page.getByText('Unshield confirmed. Public assets were sent to the recipient.').waitFor({ timeout: 120_000 });
  await page.locator('.private-balance').filter({ hasText: '0.4975 ETH' }).waitFor({ timeout: 30_000 });
  const nativeFinalBalance = await page.locator('.private-balance').textContent();
  await openAsset('public', 'ETH');
  await page.getByRole('tab', { name: 'Transfer', exact: true }).click();
  await page.getByRole('button', { name: 'Use maximum transfer amount' }).click();
  const nativeMaximum = Number(await page.locator('#action-amount').inputValue());
  if (!(nativeMaximum > 0 && nativeMaximum < 8.48507103)) throw new Error(`Native MAX did not reserve Gas: ${nativeMaximum}`);
  await page.locator('#action-amount').fill('0.01');
  if (await page.locator('#action-amount').inputValue() !== '0.01') throw new Error('Native MAX overwrote the manually entered transfer amount');
  await page.locator('#action-recipient').fill(funder.address);
  await page.getByRole('button', { name: 'Send publicly' }).click();
  await page.getByText('Public transfer confirmed.').waitFor({ timeout: 60_000 });
  const nativeTransferBlock = await rpc.getBlock('latest', true);
  const nativeTransferHash = nativeTransferBlock?.transactions.at(-1);
  const nativeTransfer = nativeTransferHash ? await rpc.getTransaction(nativeTransferHash) : null;
  if (nativeTransfer?.to?.toLowerCase() !== funder.address.toLowerCase() || nativeTransfer.value !== ethers.parseEther('0.01')) {
    throw new Error(`Native public transfer used the wrong amount: to=${nativeTransfer?.to}, value=${nativeTransfer?.value}`);
  }
  const remainingNativeBalance = await rpc.getBalance(evmAddress);
  if (remainingNativeBalance < ethers.parseEther('8')) throw new Error(`Native transfer consumed the MAX amount instead of 0.01 ETH: ${ethers.formatEther(remainingNativeBalance)}`);

  await openAsset('private', 'USDT');
  await page.locator('.private-balance').filter({ hasText: '0.0 USDT' }).waitFor({ timeout: 30_000 });
  await openAsset('public', 'USDT');
  await page.getByRole('button', { name: 'Mint test USDT' }).click();
  await page.locator('.public-row').filter({ hasText: '10000.0 USDT' }).waitFor({ timeout: 60_000 }).catch(async () => {
    throw new Error(`USDT mint or portfolio refresh failed:\n${await page.locator('body').innerText()}\n${errors.join(' | ')}`);
  });
  await page.locator('#action-amount').fill('100');
  await page.getByRole('button', { name: 'Shield assets' }).click();
  await openAsset('private', 'USDT');
  await page.locator('.private-balance').filter({ hasText: '99.75 USDT' }).waitFor({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Transfer', exact: true }).click();
  await page.locator('#action-amount').fill('20');
  await page.locator('#action-recipient').fill(swirlAddress);
  await page.getByRole('button', { name: 'Prove & transfer' }).click();
  await page.getByText('Private transfer confirmed. The input nullifiers are now spent.').waitFor({ timeout: 120_000 });
  await page.getByRole('tab', { name: 'Unshield' }).click();
  await page.locator('.note-item').filter({ hasText: '20.0 USDT' }).click();
  await page.locator('#action-recipient').fill(evmAddress);
  await page.getByRole('button', { name: 'Prove & unshield' }).click();
  await page.getByText('Unshield confirmed. Public assets were sent to the recipient.').waitFor({ timeout: 120_000 });
  await page.locator('.private-balance').filter({ hasText: '79.75 USDT' }).waitFor({ timeout: 30_000 });
  const usdtFinalBalance = await page.locator('.private-balance').textContent();
  await openAsset('private', 'USDC');
  await page.locator('.private-balance').filter({ hasText: '9.45 USDC' }).waitFor({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Select network' }).click();
  await page.locator('.network-option').filter({ hasText: 'Ethereum' }).click();
  await page.getByText('Switched to Ethereum.', { exact: true }).waitFor();
  const clearedBalance = await page.locator('.private-balance').count();
  if (clearedBalance !== 0) throw new Error(`Network switch retained the previous signer or balance: ${clearedBalance}`);
  const clearedUsd = await page.locator('.portfolio-value').textContent();
  if (clearedUsd !== '$0.00') throw new Error(`Zero-value display is incorrect: ${clearedUsd}`);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#gas-settings > summary').waitFor();
  await page.locator('#network-settings > summary').click();
  await page.getByRole('switch', { name: 'Show BNB Smart Chain' }).click();
  await page.getByRole('button', { name: 'Select network' }).click();
  if (await page.locator('.network-option').filter({ hasText: 'BNB Smart Chain' }).count()) throw new Error('Hidden network remains in the selector');
  await page.getByRole('button', { name: 'Close network selector' }).click();
  await page.getByRole('switch', { name: 'Show BNB Smart Chain' }).click();
  for (const selector of ['#network-rpc', '#network-token', '#network-vault']) {
    if (await page.locator(selector).count()) throw new Error(`Manual network field remains visible: ${selector}`);
  }
  await page.screenshot({ path: path.join(root, 'apps/extension/artifacts/swirl-extension-networks.png'), fullPage: true });
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Select network' }).click();
  if (await page.getByRole('button', { name: 'Add custom network' }).count()) throw new Error('Custom network entry is still available');
  if (await page.locator('.network-option').filter({ hasText: 'Local Hardhat' }).count()) throw new Error('Local Hardhat remains in the user network selector');
  for (const chainId of [1, 11155111]) {
    const option = page.locator('.network-option').filter({ has: page.getByText(`Chain ID · ${chainId}`, { exact: true }) });
    if (await option.count() !== 1 || await option.isDisabled()) throw new Error(`Chain ${chainId} must be selectable`);
  }
  for (const name of ['BNB Smart Chain', 'Polygon', 'Arbitrum One', 'Polygon Amoy']) {
    const option = page.locator('.network-option').filter({ has: page.getByText(name, { exact: true }) });
    if (await option.count() !== 1 || !(await option.isDisabled()) || !(await option.innerText()).includes('SOON')) {
      throw new Error(`${name} must be disabled with SOON status`);
    }
  }
  await page.screenshot({ path: path.join(root, 'apps/extension/artifacts/swirl-extension-networks.png'), fullPage: true });
  await page.getByRole('button', { name: 'Close network selector' }).click();
  await page.evaluate(() => localStorage.setItem('swirl.network.v1', JSON.stringify({ chainId: 31337 })));
  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#unlock-password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  await openAsset('private', 'USDC');
  await page.waitForFunction(() => document.querySelector('.private-balance')?.textContent?.trim().startsWith('9.45 '), null, { timeout: 30_000 });
  const restoredBalance = await page.locator('.private-balance').textContent();

  await openAsset('public', 'USDC');
  await page.getByRole('tab', { name: 'Transfer', exact: true }).click();
  await page.locator('#action-amount').fill('1');
  await page.locator('#action-recipient').fill(funder.address);
  await page.getByRole('button', { name: 'Send publicly' }).click();
  await page.getByText('Public transfer confirmed.').waitFor({ timeout: 60_000 });
  await page.locator('.public-row').filter({ hasText: '9988.725 USDC' }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(root, 'apps/extension/artifacts/swirl-extension-transfer-choice.png'), fullPage: true });

  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const activityCount = await page.locator('.activity-item').count();
  if (activityCount !== 6) throw new Error(`Expected 6 confirmed local activities, got ${activityCount}`);
  await page.getByText('Public transfer', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(root, 'apps/extension/artifacts/swirl-extension-activity.png'), fullPage: true });
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await mkdir(path.join(root, 'apps/extension/artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'apps/extension/artifacts/swirl-extension-e2e.png'), fullPage: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#preference-settings > summary').click();
  await page.locator('#auto-lock-minutes').selectOption('1');
  await page.locator('#unlock-password').waitFor({ timeout: 70_000 });
  await page.locator('#unlock-password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  const autoLockVerified = true;

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  if (!(await page.locator('#preference-settings').evaluate((element) => element.open))) await page.locator('#preference-settings > summary').click();
  await page.locator('#default-submission').selectOption('relayer');
  await openAsset('private', 'USDC');
  await page.getByRole('tab', { name: 'Unshield', exact: true }).click();
  await page.locator('.note-item').filter({ hasText: '9.45 USDC' }).click();
  await page.locator('#action-recipient').fill(evmAddress);
  await page.locator('.relayer-fee-line').filter({ hasText: '0.25 USDC' }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Prove & unshield' }).click();
  await page.getByText('Unshield confirmed. Public assets were sent to the recipient.').waitFor({ timeout: 120_000 });
  await page.locator('.private-balance').filter({ hasText: '0 USDC' }).waitFor({ timeout: 30_000 });
  const unshieldFeeResponse = await fetch('http://127.0.0.1:8788/events');
  const unshieldFeeSnapshot = await unshieldFeeResponse.json();
  const unshieldRelayEvent = unshieldFeeSnapshot.events.filter((event) => event.kind === 'transacted').at(-1);
  const unshieldFeeNote = await decryptNote(ethers.getBytes(unshieldRelayEvent.ciphertexts[0]), relayerFeeWallet.viewingSecretKey, bytesToBigint(relayerFeeWallet.noteSecretKey));
  if (!unshieldFeeNote || unshieldFeeNote.amount !== 250000n || await noteCommitment(unshieldFeeNote) !== BigInt(unshieldRelayEvent.commitments[0])) {
    throw new Error('Relayer Unshield fee output was not paid correctly');
  }
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log(JSON.stringify({ ok: true, builtInEvmFunded: true, dedicatedGasAddress, gasPaidTransaction: gasTransactionHash, gasPaidUnshield: true, autoLockVerified, shieldedBalance, twoInputTransfer: '110 USDC', relayerFee: '0.25 USDC', relayerFeeCommitmentVerified: true, relayerUnshieldFeeVerified: true, finalBalance, nativeFinalBalance, usdtFinalBalance, networkSwitchClearedBalance: clearedBalance, networkSwitchRestoredBalance: restoredBalance?.trim(), activityCount, indexedShields, indexedTransfers, rpcFallbackGetLogs: rpcGetLogs, pageErrors: errors, screenshot: 'apps/extension/artifacts/swirl-extension-e2e.png' }, null, 2));
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) await stop(child);
}
