import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({
  executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  headless: true,
});
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto('https://swirl.cash/wallet/', { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('heading', { name: 'Your assets. Your zero knowledge.' }).waitFor();

  const connectivity = await page.evaluate(async () => {
    const [configResponse, ppoiResponse] = await Promise.all([
      fetch('./deployment.ethereum.json'),
      fetch('https://relay.swirl.cash/ppoi/health'),
    ]);
    const config = await configResponse.json();
    const ppoi = await ppoiResponse.json();
    return { config, ppoi, ppoiStatus: ppoiResponse.status };
  });
  assert.equal(connectivity.config.chainId, 1);
  assert.equal(connectivity.config.poiNodeUrl, 'https://relay.swirl.cash/ppoi');
  assert.equal(connectivity.ppoiStatus, 200);
  assert.equal(connectivity.ppoi.ok, true);
  assert.equal(connectivity.ppoi.chainId, '1');
  assert.equal(connectivity.ppoi.listKey, connectivity.config.poiListKey);

  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.getByText('Keys active', { exact: true }).waitFor({ timeout: 30_000 });
  const address = await page.locator('.address-box code').textContent();
  assert.ok(address?.startsWith('swirl1'));
  await mkdir(path.resolve('apps/web/artifacts'), { recursive: true });
  await page.screenshot({ path: path.resolve('apps/web/artifacts/swirl-wallet-public.png'), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, address, mainnet: true, ppoiConnected: true, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
}
