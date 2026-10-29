import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
const errors = [];
const password = 'correct horse battery';
const restoredPassword = 'a different restored password';

async function confirmBackup(page) {
  await page.getByRole('heading', { name: 'Back up your wallet' }).waitFor({ timeout: 30_000 });
  const secrets = page.locator('.backup-secret .recovery-phrase');
  const phrase = (await secrets.nth(0).innerText()).trim();
  const privateKey = (await secrets.nth(1).innerText()).trim();
  assert.equal(phrase.split(/\s+/).length, 24);
  assert.match(privateKey, /^0x[0-9a-f]{64}$/i);
  await page.screenshot({ path: path.resolve('apps/extension/artifacts/swirl-public-backup.png'), fullPage: true });
  const continueButton = page.getByRole('button', { name: 'Continue to wallet' });
  assert.equal(await continueButton.isDisabled(), true);
  await page.locator('.backup-confirmation input').check();
  await continueButton.click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  return { phrase, privateKey };
}

try {
  const page = await browser.newPage({ viewport: { width: 440, height: 760 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem('swirl.network.v1', JSON.stringify({ chainId: 1 })));
  await page.goto('https://swirl.cash/wallet/', { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.locator('#wallet-password').fill(password);
  await page.locator('#wallet-confirmation').fill(password);
  await page.getByRole('button', { name: 'Create encrypted wallet' }).click();
  const created = await confirmBackup(page);
  const address = await page.locator('.account-address').getAttribute('title');
  assert.ok(address?.startsWith('swirl1'));
  await page.locator('.public-gateway').waitFor();
  await page.locator('.private-gateway').waitFor();
  const body = await page.locator('body').innerText();
  assert.ok(body.includes('Ethereum'));
  assert.ok(!body.includes('LOCAL DEVNET') && !body.includes('Development environment'));

  await page.getByRole('button', { name: 'Lock wallet' }).click();
  await page.getByRole('button', { name: 'Import recovery phrase' }).click();
  await page.locator('#wallet-mnemonic').fill(created.phrase);
  await page.locator('#wallet-password').fill(restoredPassword);
  await page.locator('#wallet-confirmation').fill(restoredPassword);
  await page.locator('.overwrite-warning input').check();
  await page.getByRole('button', { name: 'Import encrypted wallet' }).click();
  const restored = await confirmBackup(page);
  assert.equal(restored.phrase, created.phrase);
  assert.equal(restored.privateKey, created.privateKey);
  assert.equal(await page.locator('.account-address').getAttribute('title'), address);

  await page.reload({ waitUntil: 'networkidle' });
  await page.locator('#unlock-password').fill(restoredPassword);
  await page.getByRole('button', { name: 'Unlock wallet' }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('.account-address').getAttribute('title'), address);

  await page.getByRole('button', { name: 'Lock wallet' }).click();
  await page.getByRole('button', { name: 'Create new wallet' }).click();
  await page.locator('.overwrite-warning').waitFor();
  await page.locator('#wallet-password').fill(password);
  await page.locator('#wallet-confirmation').fill(password);
  await page.locator('.overwrite-warning input').check();
  await page.getByRole('button', { name: 'Create encrypted wallet' }).click();
  await confirmBackup(page);
  const newAddress = await page.locator('.account-address').getAttribute('title');
  assert.ok(newAddress?.startsWith('swirl1'));
  assert.notEqual(newAddress, address);

  const health = await page.evaluate(async () => {
    const response = await fetch('https://relay.swirl.cash/ppoi/health');
    return { status: response.status, body: await response.json() };
  });
  assert.equal(health.status, 200);
  assert.equal(health.body.ok, true);
  assert.equal(health.body.chainId, '1');
  await mkdir(path.resolve('apps/extension/artifacts'), { recursive: true });
  await page.screenshot({ path: path.resolve('apps/extension/artifacts/swirl-public-wallet.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, mainnet: true, backupShown: true, privateKeyShown: true, lockImportRestored: true, unlockRestored: true, ppoiConnected: true, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
}
