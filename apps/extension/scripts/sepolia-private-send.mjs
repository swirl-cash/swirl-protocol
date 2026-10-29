import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { JsonRpcProvider, Wallet, ethers } from 'ethers';

const root = path.resolve(import.meta.dirname, '../../..');
const recipient = process.env.SEPOLIA_RECIPIENT;
if (!recipient || !ethers.isAddress(recipient)) throw new Error('Set SEPOLIA_RECIPIENT to a valid address');
if (!process.env.DEPLOYER_PRIVATE_KEY) throw new Error('Set DEPLOYER_PRIVATE_KEY for the Sepolia test funder');
const expectedAmount = ethers.parseEther('0.10025062656641604');
const children = [];
let browser;
const errors = [];
function start(command, args, cwd) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
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
  const vite = start(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--mode', 'sepolia', '--host', '127.0.0.1', '--port', '7102', '--strictPort'], path.join(root, 'apps/extension'));
  await ready(vite, 'Local:');
  const rpc = new JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com', 11155111);
  const funder = new Wallet(process.env.DEPLOYER_PRIVATE_KEY, rpc);
  const recipientBefore = await rpc.getBalance(recipient);
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  async function openAsset(bucket) {
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await page.locator(`.${bucket}-gateway`).click();
    await page.locator('.asset-list-row').filter({ hasText: 'ETH' }).click();
  }
  async function waitPrivateBalance(text) {
    for (let attempt = 0; attempt < 18; attempt++) {
      const balance = page.locator('.private-balance');
      if ((await balance.count()) && (await balance.textContent())?.includes(text)) return;
      const refresh = page.getByRole('button', { name: 'Refresh private assets' });
      if (await refresh.count()) await refresh.click();
      await page.waitForTimeout(5000);
    }
    throw new Error(`Private balance did not reach ${text}:\n${await page.locator('body').innerText()}`);
  }
  async function waitForNote(text) {
    for (let attempt = 0; attempt < 18; attempt++) {
      const note = page.locator('.note-item').filter({ hasText: text });
      if (await note.count()) return note;
      const refresh = page.getByRole('button', { name: 'Refresh private assets' });
      if (await refresh.count()) await refresh.click();
      await page.waitForTimeout(5000);
    }
    throw new Error(`Private note did not appear ${text}:\n${await page.locator('body').innerText()}`);
  }
  await page.goto('http://127.0.0.1:7102/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.locator('#wallet-password').fill('correct horse battery');
  await page.locator('#wallet-confirmation').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create encrypted wallet' }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  if (await page.locator('.network-button').textContent() !== 'Sepolia Public Beta') throw new Error('Wallet did not default to the Sepolia public beta');
  if (await page.locator('.asset-list-row').count() !== 0) throw new Error('Unexpected asset list on portfolio home');
  const swirlAddress = await page.locator('.account-address').getAttribute('title');
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await page.getByRole('button', { name: 'EVM receive' }).click();
  const evmAddress = await page.locator('.address-box').getAttribute('title');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#gas-settings > summary').click();
  const gasAddress = await page.locator('.gas-address').getAttribute('title');
  if (!evmAddress || !gasAddress) throw new Error('Wallet accounts were not derived');
  for (const [to, value] of [[evmAddress, ethers.parseEther('0.12')], [gasAddress, ethers.parseEther('0.01')]]) {
    const transaction = await funder.sendTransaction({ to, value });
    console.log(`Funding ${to}: ${transaction.hash}`);
    await transaction.wait();
  }

  await openAsset('public');
  await page.getByRole('button', { name: 'Refresh public assets' }).click();
  await page.locator('.public-row').filter({ hasText: '0.12 ETH' }).waitFor({ timeout: 60_000 });
  if (await page.locator('.asset-list-row').count() !== 1) throw new Error('Sepolia beta is not ETH-only');
  await page.locator('#action-amount').fill('0.101');
  await page.getByRole('button', { name: 'Shield assets' }).click();
  await page.getByText('Shield confirmed. Your encrypted note is now in the vault.').waitFor({ timeout: 120_000 });
  await page.waitForTimeout(15_000);
  await openAsset('private');
  await waitPrivateBalance('0.1007475');

  await page.getByRole('tab', { name: 'Transfer', exact: true }).click();
  await page.locator('.relayer-fee-line').filter({ hasText: '0.0001 ETH' }).waitFor({ timeout: 30_000 });
  await page.locator('#action-amount').fill('0.10025062656641604');
  await page.locator('#action-recipient').fill(swirlAddress);
  await page.getByRole('button', { name: 'Prove & transfer' }).click();
  await page.getByText('Private transfer confirmed. The input nullifiers are now spent.').waitFor({ timeout: 180_000 });
  await page.waitForTimeout(15_000);

  await page.getByRole('tab', { name: 'Unshield', exact: true }).click();
  await page.locator('#gas-payer').selectOption('gas');
  await (await waitForNote('0.10025062656641604 ETH')).click();
  await page.locator('#action-recipient').fill(recipient);
  await page.getByRole('button', { name: 'Prove & unshield' }).click();
  await page.getByText('Unshield confirmed. Public assets were sent to the recipient.').waitFor({ timeout: 180_000 });
  const recipientAfter = await rpc.getBalance(recipient);
  if (recipientAfter - recipientBefore !== ethers.parseEther('0.1')) throw new Error(`Recipient received ${ethers.formatEther(recipientAfter - recipientBefore)} instead of 0.1 ETH`);

  await page.getByRole('button', { name: 'Activity', exact: true }).click();
  const activities = await page.locator('.activity-item').evaluateAll((items) => items.map((item) => ({ title: item.getAttribute('title'), text: item.textContent })));
  const shieldHash = activities.find((item) => item.text?.includes('Shield'))?.title?.replace('Copy transaction ', '');
  const transferHash = activities.find((item) => item.text?.includes('Private transfer'))?.title?.replace('Copy transaction ', '');
  const unshieldHash = activities.find((item) => item.text?.includes('Unshield'))?.title?.replace('Copy transaction ', '');
  const [shieldTransaction, transferTransaction, unshieldTransaction] = await Promise.all([rpc.getTransaction(shieldHash), rpc.getTransaction(transferHash), rpc.getTransaction(unshieldHash)]);
  if (shieldTransaction?.from.toLowerCase() !== evmAddress.toLowerCase()) throw new Error('Shield signer mismatch');
  if (transferTransaction?.from.toLowerCase() !== '0xc7221bbcb68f78bbbf fa64f938341687ad3ba565'.replace(' ', '')) throw new Error('Private transfer was not submitted by the public Relayer');
  if (unshieldTransaction?.from.toLowerCase() !== gasAddress.toLowerCase()) throw new Error('Unshield was not submitted by the independent Gas account');
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log(JSON.stringify({ ok: true, network: 'Sepolia', shieldTransaction: shieldHash, privateTransferTransaction: transferHash, relayer: transferTransaction.from, unshieldTransaction: unshieldHash, unshieldSigner: gasAddress, recipient, recipientReceived: '0.1', recipientBalance: ethers.formatEther(recipientAfter), pageErrors: errors }, null, 2));
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) await stop(child);
}
