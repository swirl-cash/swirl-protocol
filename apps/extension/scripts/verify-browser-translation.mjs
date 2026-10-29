import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';

const browser = await chromium.launch({ executablePath: process.env.BROWSER_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
const page = await browser.newPage({ viewport: { width: 440, height: 760 } });
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
try {
  await page.goto('https://swirl.cash/wallet/', { waitUntil: 'networkidle', timeout: 60_000 });
  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.locator('#wallet-password').fill('correct horse battery');
  await page.locator('#wallet-confirmation').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create encrypted wallet' }).click();
  await page.locator('.backup-view').waitFor({ timeout: 30_000 });
  await page.evaluate(() => {
    const walker = document.createTreeWalker(document.getElementById('root'), NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (node.nodeValue?.trim() && !['SCRIPT', 'STYLE'].includes(node.parentElement?.tagName)) nodes.push(node);
    }
    for (const node of nodes) {
      const translated = document.createElement('span');
      translated.className = 'simulated-browser-translation';
      translated.textContent = `译:${node.nodeValue}`;
      node.parentNode.replaceChild(translated, node);
    }
  });
  await page.getByRole('button', { name: 'Copy EVM private key' }).click();
  await page.locator('.backup-confirmation input').check();
  await page.locator('.backup-view .primary-button').click();
  await page.locator('.account-card').waitFor({ timeout: 30_000 });
  assert.equal(await page.locator('.loading-screen').count(), 0);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, translatedCopy: true, translatedContinue: true, pageErrors: errors }, null, 2));
} finally {
  await browser.close();
}
