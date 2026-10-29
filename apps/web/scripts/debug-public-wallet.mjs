import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on('pageerror', (error) => console.log('PAGEERROR', error.message));
  page.on('console', (message) => console.log('CONSOLE', message.type(), message.text()));
  page.on('response', (response) => { if (response.status() >= 400) console.log('HTTP', response.status(), response.url()); });
  const response = await page.goto('https://swirl.cash/wallet/', { waitUntil: 'networkidle', timeout: 60_000 });
  console.log('STATUS', response?.status());
  await page.waitForTimeout(3000);
  console.log('BODY', (await page.locator('body').innerText()).slice(0, 3000));
  console.log('HTML', (await page.locator('body').innerHTML()).slice(0, 1500));
  await page.screenshot({ path: 'apps/web/artifacts/swirl-wallet-public-debug.png', fullPage: true });
} finally {
  await browser.close();
}
