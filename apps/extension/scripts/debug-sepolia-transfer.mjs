import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '../../..');
const extensionRoot = path.join(root, 'apps/extension');
const profile = process.env.SEPOLIA_PROFILE;
if (!profile) throw new Error('Set SEPOLIA_PROFILE');
const indexer = spawn(process.execPath, [path.join(root, 'packages/indexer/dist/index.js')], {
  cwd: root,
  env: {
    ...process.env,
    RPC_URL: 'https://ethereum-sepolia-rpc.publicnode.com',
    VAULT_ADDRESS: '0xA5a7071E80F89223E5B91651161274Fd5161E437',
    START_BLOCK: String(Math.max(0, 12009352 - 120)),
    INDEXER_STATE_FILE: path.join(extensionRoot, 'artifacts/indexer-sepolia-shared-state.json'),
    CORS_ORIGIN: '*', PORT: '8788', RATE_LIMIT_PER_MINUTE: '10000', BATCH_SIZE: '50',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let context;
const errors = [];
try {
  await Promise.race([
    new Promise((resolve, reject) => {
      indexer.stdout.on('data', (chunk) => { if (chunk.toString().includes('SWIRL indexer listening')) resolve(); });
      indexer.stderr.on('data', (chunk) => console.error(chunk.toString()));
      indexer.once('exit', (code) => reject(new Error(`Indexer exited: ${code}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Indexer start timed out')), 30_000)),
  ]);
  context = await chromium.launchPersistentContext(profile, {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: [`--disable-extensions-except=${path.join(extensionRoot, 'dist')}`, `--load-extension=${path.join(extensionRoot, 'dist')}`],
    viewport: { width: 440, height: 900 },
  });
  let worker = context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'networkidle' });
  await page.locator('#unlock-password').fill('sepolia shared vault browser test');
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 60_000 });
  const swirlAddress = await page.locator('.account-address').getAttribute('title');
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.locator('.private-gateway').click();
  await page.locator('.asset-list-row').filter({ hasText: 'ETH' }).click();
  for (let attempt = 0; attempt < 30; attempt++) {
    if ((await page.locator('.private-balance').textContent())?.includes('0.001995')) break;
    const refresh = page.getByRole('button', { name: 'Refresh private assets' });
    if (await refresh.count()) await refresh.click();
    await page.waitForTimeout(3000);
  }
  console.log('BEFORE TRANSFER\n', await page.locator('body').innerText());
  await page.getByRole('tab', { name: 'Transfer', exact: true }).click();
  await page.locator('#action-amount').fill('0.001');
  await page.locator('#action-recipient').fill(swirlAddress);
  await page.getByRole('button', { name: 'Prove & transfer' }).click();
  await page.getByText('Private transfer confirmed. The input nullifiers are now spent.').waitFor({ timeout: 90_000 }).catch(async (error) => {
    console.log('TRANSFER DID NOT CONFIRM\n', await page.locator('body').innerText(), '\nERRORS\n', errors.join('\n'));
    await page.screenshot({ path: path.join(extensionRoot, 'artifacts/swirl-sepolia-transfer-failure.png'), fullPage: true });
    throw error;
  });
  console.log('TRANSFER CONFIRMED\n', await page.locator('body').innerText());
} finally {
  if (context) await context.close();
  if (indexer.exitCode === null && indexer.signalCode === null) {
    indexer.kill('SIGTERM');
    await Promise.race([once(indexer, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}
