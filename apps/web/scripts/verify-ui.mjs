import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '../../..');
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '7100', '--strictPort'], {
  cwd: path.join(root, 'apps/web'),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let browser;
const errors = [];
try {
  await Promise.race([
    new Promise((resolve, reject) => {
      server.stdout.on('data', (chunk) => {
        if (chunk.toString().includes('Local:')) resolve();
      });
      server.stderr.on('data', (chunk) => console.error(chunk.toString()));
      server.once('error', reject);
      server.once('exit', (code) => reject(new Error(`Vite exited early: ${code}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Vite startup timed out')), 15_000)),
  ]);
  browser = await chromium.launch({
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('http://127.0.0.1:7100/', { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Your assets. Your zero knowledge.' }).waitFor();
  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.getByText('Keys active', { exact: true }).waitFor({ timeout: 30_000 });
  const address = await page.locator('.address-box code').textContent();
  const fullAddress = await page.locator('.address-box').getAttribute('title');
  const mnemonic = await page.locator('.recovery-phrase').textContent();
  if (!address?.startsWith('swirl1')) throw new Error(`Invalid rendered address: ${address}`);

  await page.getByRole('button', { name: 'Save encrypted wallet' }).click();
  await page.getByLabel('Encryption password').fill('correct horse battery');
  await page.getByRole('dialog', { name: 'Save encrypted wallet' }).getByRole('button', { name: 'Save encrypted wallet' }).click();
  await page.getByText('Encrypted wallet saved in this browser. Your password is never stored.').waitFor({ timeout: 30_000 });
  const stored = await page.evaluate(() => localStorage.getItem('swirl.encrypted-wallet.v1'));
  if (!stored || stored.includes(mnemonic)) throw new Error('Recovery phrase was stored without encryption');

  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Unlock saved wallet' }).click();
  await page.getByLabel('Encryption password').fill('wrong password');
  await page.getByRole('button', { name: 'Unlock wallet' }).click();
  await page.getByText('Incorrect password or damaged encrypted wallet').waitFor({ timeout: 30_000 });
  await page.getByLabel('Encryption password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Unlock wallet' }).click();
  await page.getByText('Keys active', { exact: true }).waitFor({ timeout: 30_000 });
  if (await page.locator('.address-box').getAttribute('title') !== fullAddress) throw new Error('Unlocked wallet address differs');

  await page.getByRole('tab', { name: 'Private transfer' }).click();
  await page.getByText('Send a private note', { exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Unshield' }).click();
  await page.getByText('No spendable notes found for this identity.').waitFor();
  await mkdir(path.join(root, 'apps/web/artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'apps/web/artifacts/swirl-wallet.png'), fullPage: true });
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  console.log(JSON.stringify({ ok: true, address, pageErrors: errors, screenshot: 'apps/web/artifacts/swirl-wallet.png' }, null, 2));
} finally {
  if (browser) await browser.close();
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([once(server, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
  }
}
