import { chromium } from 'playwright-core';

const executablePath = process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath, headless: process.env.HEADFUL !== '1' });
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (error) => { errors.push(`pageerror: ${error.stack || error.message}`); console.log(errors.at(-1)); });
page.on('console', (message) => { if (message.type() === 'error') { errors.push(`console: ${message.text()}`); console.log(errors.at(-1)); } });
page.on('requestfailed', (request) => console.log(`requestfailed: ${request.url()} ${request.failure()?.errorText}`));
page.on('response', (response) => { if (response.status() >= 400) console.log(`HTTP ${response.status()}: ${response.url()}`); });
try {
  await page.goto('https://swirl.cash/wallet/', { waitUntil: 'networkidle', timeout: 60_000 });
  console.log('Loaded:', (await page.locator('body').innerText()).slice(0, 500));
  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.locator('#wallet-password').fill('correct horse battery');
  await page.locator('#wallet-confirmation').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create encrypted wallet' }).click();
  await page.waitForTimeout(15_000);
  console.log('After create:', (await page.locator('body').innerText()).slice(0, 2000));
  console.log('Main count:', await page.locator('main').count());
  console.log('Errors:', JSON.stringify(errors, null, 2));
  await page.screenshot({ path: 'apps/extension/artifacts/public-create-chrome-desktop.png', fullPage: true });
} finally {
  await browser.close();
}
