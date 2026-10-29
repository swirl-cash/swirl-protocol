import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { HDNodeWallet, JsonRpcProvider, Wallet, ethers } from 'ethers';
import { createSwirlWallet, recoverWalletNotes, withdrawRecoveredNote } from '@swirl/wallet';

const root = path.resolve(import.meta.dirname, '../../..');
const extensionRoot = path.join(root, 'apps/extension');
const rpcUrl = process.env.SEPOLIA_RPC_URL ?? 'https://ethereum-sepolia-rpc.publicnode.com';
if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error('Set DEPLOYER_PRIVATE_KEY for the Sepolia test funder');
const phrase = Wallet.createRandom().mnemonic?.phrase;
if (!phrase) throw new Error('Could not generate an ephemeral test wallet');
const password = 'sepolia shared vault browser test';
const children = [];
const pageErrors = [];
const consoleErrors = [];
let context;

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
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${text}`)), 30_000)),
  ]);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
async function collect(child) {
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const [code] = await Promise.race([
    once(child, 'exit'),
    new Promise((_, reject) => setTimeout(() => { child.kill('SIGTERM'); reject(new Error('PPOI smoke timed out')); }, 120_000)),
  ]);
  if (code !== 0) throw new Error(`PPOI smoke exited with ${code}: ${stderr || stdout}`);
  return { stdout, stderr };
}
try {
  const deployment = JSON.parse(await readFile(path.join(root, 'packages/contracts/deployments/sepolia.json'), 'utf8'));
  if (deployment.chainId !== 11155111 || deployment.assetMode !== 'sepolia-eth-only-no-monetary-value'
    || deployment.assets.length !== 1 || deployment.assets[0].symbol !== 'ETH') {
    throw new Error('Sepolia public beta must expose ETH only');
  }
  const asset = deployment.assets[0];
  const rpc = new JsonRpcProvider(rpcUrl, 11155111, { staticNetwork: true });
  const funder = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, rpc);
  const startBlock = Math.max(0, (await rpc.getBlockNumber()) - 120);
  const recoveryStartBlock = startBlock;
  const indexer = start(process.execPath, [path.join(root, 'packages/indexer/dist/index.js')], root, {
    ...process.env, RPC_URL: rpcUrl, VAULT_ADDRESS: deployment.vault, START_BLOCK: String(startBlock),
    INDEXER_STATE_FILE: path.join(extensionRoot, 'artifacts/indexer-sepolia-shared-state.json'),
    CORS_ORIGIN: '*', PORT: '8788', RATE_LIMIT_PER_MINUTE: '10000', BATCH_SIZE: '50',
  });
  await ready(indexer, 'SWIRL indexer listening');
  const browserDeployment = { ...deployment, relayerUrl: '', indexerUrl: 'http://127.0.0.1:8788' };
  await writeFile(path.join(extensionRoot, 'dist/deployment.sepolia.json'), JSON.stringify(browserDeployment, null, 2));

  context = await chromium.launchPersistentContext(path.join(extensionRoot, 'artifacts', `sepolia-profile-${Date.now()}`), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: [`--disable-extensions-except=${path.join(extensionRoot, 'dist')}`, `--load-extension=${path.join(extensionRoot, 'dist')}`],
    viewport: { width: 440, height: 900 },
  });
  let worker = context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Import recovery phrase' }).click();
  await page.locator('#wallet-mnemonic').fill(phrase);
  await page.locator('#wallet-password').fill(password);
  await page.locator('#wallet-confirmation').fill(password);
  await page.getByRole('button', { name: 'Import encrypted wallet' }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 60_000 });
  if ((await page.locator('.network-button').textContent())?.trim() !== 'Sepolia Public Beta') {
    throw new Error('Native extension did not select the Sepolia deployment');
  }
  const swirlAddress = await page.locator('.account-address').getAttribute('title');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await page.getByRole('button', { name: 'EVM receive' }).click();
  const evmAddress = await page.locator('.address-box').getAttribute('title');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#gas-settings > summary').click();
  const gasAddress = await page.locator('.gas-address').getAttribute('title');
  if (!swirlAddress || !evmAddress || !gasAddress) throw new Error('Wallet accounts were not derived');
  for (const [to, target] of [[evmAddress, ethers.parseEther('0.005')], [gasAddress, ethers.parseEther('0.005')]]) {
    const balance = await rpc.getBalance(to);
    if (balance >= target) continue;
    const transaction = await funder.sendTransaction({ to, value: target - balance });
    await transaction.wait();
  }
  await page.locator('#preference-settings > summary').click();
  await page.locator('#default-submission').selectOption('gas');

  async function openAsset(bucket) {
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await page.locator(`.${bucket}-gateway`).click();
    await page.locator('.asset-list-row').filter({ hasText: 'ETH' }).click();
  }
  async function waitPrivate(expected) {
    for (let attempt = 0; attempt < 30; attempt++) {
      const balance = page.locator('.private-balance');
      if ((await balance.count()) && (await balance.textContent())?.includes(expected)) return (await balance.textContent()).trim();
      const refresh = page.getByRole('button', { name: 'Refresh private assets' });
      if (await refresh.count()) await refresh.click();
      await page.waitForTimeout(5000);
    }
    throw new Error(`Private balance did not reach ${expected}:\n${await page.locator('body').innerText()}\n${consoleErrors.join(' | ')}`);
  }

  await openAsset('public');
  if (await page.locator('.asset-list-row').count() !== 1) throw new Error('Sepolia must show exactly one asset: ETH');
  await page.getByRole('button', { name: 'Refresh public assets' }).click();
  await page.locator('#action-amount').fill('0.002');
  await page.getByRole('button', { name: 'Shield assets' }).click();
  await page.getByText('Shield confirmed. Your encrypted note is now in the vault.').waitFor({ timeout: 180_000 }).catch(async (error) => {
    await page.screenshot({ path: path.join(extensionRoot, 'artifacts/swirl-sepolia-shield-failure.png'), fullPage: true });
    throw new Error(`Sepolia Shield failed: ${error.message}\n${await page.locator('body').innerText()}\n${consoleErrors.join(' | ')}`);
  });
  await openAsset('private');
  const shieldedBalance = await waitPrivate('0.001995');

  await page.getByRole('tab', { name: 'Transfer', exact: true }).click();
  await page.locator('#action-amount').fill('0.001');
  await page.locator('#action-recipient').fill(swirlAddress);
  await page.getByRole('button', { name: 'Prove & transfer' }).click();
  await page.getByText('Private transfer confirmed. The input nullifiers are now spent.').waitFor({ timeout: 240_000 }).catch(async (error) => {
    await page.screenshot({ path: path.join(extensionRoot, 'artifacts/swirl-sepolia-transfer-failure.png'), fullPage: true });
    throw new Error(`Sepolia private transfer failed: ${error.message}\n${await page.locator('body').innerText()}\n${consoleErrors.join(' | ')}`);
  });
  const afterTransfer = await waitPrivate('0.001995');

  await page.getByRole('tab', { name: 'Unshield', exact: true }).click();
  await page.locator('.note-item').filter({ hasText: '0.001 ETH' }).click();
  await page.locator('#action-recipient').fill(evmAddress);
  await page.getByRole('button', { name: 'Prove & unshield' }).click();
  await page.getByText('Unshield confirmed. Public assets were sent to the recipient.').waitFor({ timeout: 240_000 }).catch(async (error) => {
    await page.screenshot({ path: path.join(extensionRoot, 'artifacts/swirl-sepolia-unshield-failure.png'), fullPage: true });
    throw new Error(`Sepolia Unshield failed: ${error.message}\n${await page.locator('body').innerText()}\n${consoleErrors.join(' | ')}`);
  });
  const finalBalance = await waitPrivate('0.000995');

  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const activities = await page.locator('.activity-item').evaluateAll((items) => items.map((item) => ({ title: item.getAttribute('title'), text: item.textContent })));
  const transactionHashes = activities.map((item) => item.title?.replace('Copy transaction ', '')).filter((item) => /^0x[0-9a-f]{64}$/i.test(item ?? ''));
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.screenshot({ path: path.join(extensionRoot, 'artifacts/swirl-sepolia-shared-extension.png'), fullPage: true });
  if (pageErrors.length) throw new Error(`Native extension page errors: ${pageErrors.join(' | ')}`);

  await context.close();
  context = undefined;
  await stop(indexer);
  const servicesClosedBeforeRecovery = indexer.exitCode !== null || indexer.signalCode !== null;
  if (!servicesClosedBeforeRecovery) throw new Error('Indexer did not stop before independent recovery');

  const poiStateFile = path.join(extensionRoot, 'artifacts', `poi-sepolia-shared-state-${Date.now()}.json`);
  const poi = start(process.execPath, [path.join(root, 'packages/poi/dist/sepolia-smoke.js')], path.join(root, 'packages/poi'), {
    ...process.env, VAULT_ADDRESS: deployment.vault, START_BLOCK: String(startBlock), PPOI_STATE_FILE: poiStateFile,
  });
  const poiOutput = await collect(poi);
  const poiResult = JSON.parse(poiOutput.stdout.slice(poiOutput.stdout.indexOf('{'), poiOutput.stdout.lastIndexOf('}') + 1));
  const poiState = JSON.parse(await readFile(poiStateFile, 'utf8'));
  const shieldSynced = poiState.shields.some((item) => transactionHashes.includes(item.transactionHash));
  const syncedTransactions = poiState.transactions.filter((item) => transactionHashes.includes(item.transactionHash)).length;
  if (!shieldSynced || syncedTransactions < 2) throw new Error('PPOI did not synchronize the Shield and two Transacted events');

  const wallet = await createSwirlWallet(11155111, phrase);
  const recoveryState = await recoverWalletNotes({
    provider: rpc, wallet, vaultAddress: deployment.vault, startBlock: recoveryStartBlock, batchSize: 50,
  });
  const recovered = recoveryState.notes.find((item) => !item.spent && item.note.token === BigInt(asset.token) && item.note.amount > 0n);
  if (!recovered) throw new Error('No unspent ETH note could be recovered from chain events');
  const recoveryRecipient = Wallet.createRandom().address;
  const balanceBefore = await rpc.getBalance(recoveryRecipient);
  const signer = HDNodeWallet.fromPhrase(phrase).connect(rpc);
  const recoveryReceipt = await withdrawRecoveredNote({
    signer, wallet, state: recoveryState, recovered, recipient: recoveryRecipient, gatewayAddress: asset.gateway,
    assets: {
      wasm: path.join(root, 'packages/contracts/build/circuits/swirl_transfer_js/swirl_transfer.wasm'),
      zkey: path.join(root, 'packages/contracts/build/circuits/swirl_transfer_final.zkey'),
    },
  });
  const expectedRecoveryAmount = recovered.note.amount - recovered.note.amount * BigInt(deployment.feeBps) / 10_000n;
  const balanceAfter = await rpc.getBalance(recoveryRecipient);
  if (balanceAfter - balanceBefore !== expectedRecoveryAmount) throw new Error('Independent recovery recipient received an unexpected amount');

  const result = {
    ok: true, network: 'Sepolia', chainId: 11155111, nativeExtension: true,
    vault: deployment.vault, assetMode: deployment.assetMode, exposedAssets: ['ETH'], startBlock, recoveryStartBlock,
    shieldedBalance, afterTransfer, finalBalance, gasAccountUsed: true,
    transactionHashes, pageErrors, consoleErrors,
    ppoi: { ...poiResult, shieldSynced, syncedTransactions, stateFile: path.relative(root, poiStateFile) },
    recovery: {
      hash: recoveryReceipt.hash, recoveredAmount: ethers.formatEther(expectedRecoveryAmount),
      recipientBalanceVerified: true, servicesClosedBeforeRecovery,
    },
    servicesClosedBeforeRecovery,
    screenshot: 'apps/extension/artifacts/swirl-sepolia-shared-extension.png',
  };
  await writeFile(path.join(extensionRoot, 'artifacts/sepolia-extension-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify(result, null, 2));
  rpc.destroy();
} finally {
  if (context) await context.close();
  for (const child of children.reverse()) await stop(child);
}
