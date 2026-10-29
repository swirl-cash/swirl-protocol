import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const extensionRoot = path.resolve(import.meta.dirname, '../..');
const dist = path.join(extensionRoot, 'dist');
let browser;
try {
  browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  const page = await browser.newPage({ viewport: { width: 440, height: 760 } });
  await page.goto('edge://extensions');
  const id = await page.evaluate(() => {
    const manager = document.querySelector('extensions-manager');
    const list = manager?.shadowRoot?.querySelector('extensions-item-list');
    const items = list?.shadowRoot?.querySelectorAll('extensions-item') ?? [];
    for (const item of items) {
      const name = item.shadowRoot?.querySelector('#name')?.textContent ?? '';
      if (name.includes('SWIRL Private Wallet')) return item.id;
    }
    return '';
  });
  if (!id) throw new Error('SWIRL extension was not found on chrome://extensions');
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`chrome-extension://${id}/index.html`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.locator('#wallet-password').fill('native extension test');
  await page.locator('#wallet-confirmation').fill('native extension test');
  await page.getByRole('button', { name: 'Create encrypted wallet' }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  const stored = await page.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
  if (!stored.includes('AES-256-GCM') || stored.includes('mnemonic')) throw new Error('Native extension storage boundary failed');
  await page.getByRole('button', { name: 'Lock wallet' }).click();
  await page.getByRole('button', { name: 'Unlock wallet' }).waitFor();
  if (errors.length) throw new Error(errors.join(' | '));
  await mkdir(path.join(extensionRoot, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(extensionRoot, 'artifacts/swirl-extension-native.png'), fullPage: true });
  console.log(JSON.stringify({ ok: true, extensionId: id, chromeStorageVerified: true, lockVerified: true, pageErrors: errors }, null, 2));
} finally {
  if (browser) await browser.close();
}
