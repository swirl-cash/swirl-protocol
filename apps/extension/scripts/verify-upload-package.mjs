import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';

const extensionRoot = path.resolve(import.meta.dirname, '..');
const { version } = JSON.parse(await readFile(path.join(extensionRoot, 'public', 'manifest.json'), 'utf8'));
const packageRoot = path.join(extensionRoot, 'artifacts', `package-check-${version}`);
const manifest = JSON.parse(await readFile(path.join(packageRoot, 'manifest.json'), 'utf8'));
if (manifest.version !== version) throw new Error('Unexpected upload package version');
const expectedHosts = ['https://swirl.cash/*', 'https://www.swirl.cash/*', 'https://relay.swirl.cash/*', 'http://127.0.0.1/*', 'http://localhost/*'];
if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedHosts)) throw new Error('Upload package host permissions changed');

let context;
try {
  context = await chromium.launchPersistentContext(path.join(extensionRoot, 'artifacts', `package-profile-${Date.now()}`), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: [`--disable-extensions-except=${packageRoot}`, `--load-extension=${packageRoot}`],
    viewport: { width: 440, height: 760 },
  });
  let worker = context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/index.html`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.locator('#wallet-password').fill('upload package verification');
  await page.locator('#wallet-confirmation').fill('upload package verification');
  await page.getByRole('button', { name: 'Create encrypted wallet' }).click();
  await page.locator('.backup-confirmation input').check();
  await page.getByRole('button', { name: 'Continue to wallet' }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  const address = await page.locator('.account-address').getAttribute('title');
  // Background note synchronization may keep RPC requests active; verify the
  // restored wallet UI instead of requiring the network to become idle.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  if (await page.locator('.account-address').getAttribute('title') !== address) throw new Error('Package restored a different wallet');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#preference-settings > summary').click();
  if (await page.locator('#default-submission').inputValue() !== 'main') throw new Error('Package fee payer default is incorrect');
  await page.getByRole('button', { name: 'Lock wallet' }).click();
  await page.getByRole('button', { name: 'Unlock wallet' }).waitFor();
  if (errors.length) throw new Error(errors.join(' | '));
  console.log(JSON.stringify({ ok: true, version: manifest.version, loadedFromExtractedZip: true, refreshRestored: true, defaultFeePayer: 'main', lockVerified: true, hostPermissions: manifest.host_permissions }, null, 2));
} finally {
  if (context) await context.close();
}
