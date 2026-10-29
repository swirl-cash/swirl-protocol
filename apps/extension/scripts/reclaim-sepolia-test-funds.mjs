import path from 'node:path';
import { chromium } from 'playwright-core';
import { HDNodeWallet, JsonRpcProvider } from 'ethers';

const root = path.resolve(import.meta.dirname, '../../..');
const profile = process.env.SEPOLIA_PROFILE;
const recipient = '0x51872254046bf76bf71dc941896943293d45624f';
if (!profile) throw new Error('Set SEPOLIA_PROFILE');
const provider = new JsonRpcProvider('https://ethereum-sepolia-rpc.publicnode.com', 11155111, { staticNetwork: true });
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: [`--disable-extensions-except=${path.join(root, 'apps/extension/dist')}`, `--load-extension=${path.join(root, 'apps/extension/dist')}`],
    viewport: { width: 440, height: 900 },
  });
  let worker = context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const page = await context.newPage();
  await page.goto(`chrome-extension://${new URL(worker.url()).host}/index.html`, { waitUntil: 'networkidle' });
  await page.locator('#unlock-password').fill('sepolia shared vault browser test');
  await page.getByRole('button', { name: 'Unlock wallet', exact: true }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#security-settings > summary').click();
  await page.getByRole('button', { name: 'Reveal phrase', exact: true }).click();
  const phrase = (await page.locator('.recovery-phrase').first().textContent())?.trim();
  if (!phrase) throw new Error('Could not recover the ephemeral test phrase from the encrypted profile');
  await context.close();
  context = undefined;

  const feeData = await provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!maxFeePerGas) throw new Error('No Sepolia fee estimate');
  const wallets = [
    HDNodeWallet.fromPhrase(phrase).connect(provider),
    HDNodeWallet.fromPhrase(phrase, undefined, "m/44'/60'/0'/1/0").connect(provider),
  ];
  const reclaimed = [];
  for (const wallet of wallets) {
    const balance = await provider.getBalance(wallet.address);
    const reserve = 21_000n * maxFeePerGas;
    if (balance <= reserve) continue;
    const value = balance - reserve;
    const transaction = await wallet.sendTransaction({
      to: recipient, value, gasLimit: 21_000n, maxFeePerGas,
      ...(feeData.maxPriorityFeePerGas ? { maxPriorityFeePerGas: feeData.maxPriorityFeePerGas } : {}),
    });
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) throw new Error('Test-fund reclaim transaction failed');
    reclaimed.push({ hash: receipt.hash, value: value.toString() });
  }
  console.log(JSON.stringify({ ok: true, reclaimed }, null, 2));
} finally {
  if (context) await context.close();
  provider.destroy();
}
