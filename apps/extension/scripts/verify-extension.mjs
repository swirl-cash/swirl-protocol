import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';

const root = path.resolve(import.meta.dirname, '../../..');
const extensionRoot = path.join(root, 'apps/extension');
let vite;
let browser;

function ready(child, text) {
  return Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (chunk.toString().includes(text)) resolve(); });
      child.stderr.on('data', (chunk) => console.error(chunk.toString()));
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Preview exited early: ${code}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Extension preview startup timed out')), 20_000)),
  ]);
}

async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

try {
  const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'dist/manifest.json'), 'utf8'));
  if (manifest.manifest_version !== 3 || manifest.action?.default_popup !== 'index.html') throw new Error('Invalid MV3 popup manifest');
  const expectedHosts = ['https://*/*', 'http://127.0.0.1/*', 'http://localhost/*'];
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(['storage'])
    || JSON.stringify(manifest.host_permissions) !== JSON.stringify(expectedHosts)
    || manifest.background?.service_worker !== 'background.js' || manifest.background?.type !== 'module'
    || manifest.content_scripts?.length !== 2
    || manifest.content_scripts[0].js?.[0] !== 'inpage.js' || manifest.content_scripts[0].world !== 'MAIN'
    || manifest.content_scripts[1].js?.[0] !== 'content.js' || manifest.content_scripts[1].world !== 'ISOLATED') {
    throw new Error('Extension exceeds its declared network, storage or dApp bridge boundary');
  }
  for (const size of [16, 32, 48, 128]) await stat(path.join(extensionRoot, `dist/icons/icon-${size}.png`));
  for (const file of ['background.js', 'content.js', 'inpage.js', 'approval.html', 'approval.js']) await stat(path.join(extensionRoot, `dist/${file}`));

  vite = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '7102', '--strictPort'], {
    cwd: extensionRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  await ready(vite, 'Local:');
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const context = await browser.newContext({ viewport: { width: 440, height: 760 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.addInitScript(() => localStorage.setItem('swirl.network.v1', JSON.stringify({ chainId: 1 })));
  await page.goto('http://127.0.0.1:7102/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.locator('#wallet-password').fill('correct horse battery');
  await page.locator('#wallet-confirmation').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create encrypted wallet' }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  const address = await page.locator('.account-address').getAttribute('title');
  if (!address?.startsWith('swirl1')) throw new Error('Wallet did not create a swirl1 address');
  const publicGateway = page.locator('.public-gateway');
  await publicGateway.waitFor();
  const borderBeforeHover = await publicGateway.evaluate((element) => getComputedStyle(element).borderTopColor);
  await publicGateway.hover(); await page.waitForTimeout(220);
  const borderAfterHover = await publicGateway.evaluate((element) => getComputedStyle(element).borderTopColor);
  if (borderBeforeHover === borderAfterHover) throw new Error('Interactive asset gateway has no visible hover state');
  await page.screenshot({ path: path.join(extensionRoot, 'artifacts/swirl-extension-overview.png'), fullPage: true });
  await page.locator('.private-gateway').click();
  await page.locator('.private-collection').waitFor();
  await page.getByRole('button', { name: 'Back to asset overview' }).click();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('#help-settings > summary').click();
  if (await page.getByRole('link', { name: 'Help & feedback' }).getAttribute('href') !== 'https://x.com/swirlbtc') throw new Error('Help link does not point to the official X account');
  await page.getByRole('button', { name: 'Terms of Service' }).click();
  await page.getByRole('heading', { name: 'Terms of Service', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to settings' }).first().click();
  await page.locator('#help-settings > summary').click();
  await page.getByRole('button', { name: 'Privacy Policy' }).click();
  await page.getByRole('heading', { name: 'Privacy Policy', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Back to settings' }).first().click();
  await page.getByRole('button', { name: 'Assets', exact: true }).click();
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  const qrLength = await page.locator('canvas').evaluate((canvas) => canvas.toDataURL().length);
  if (qrLength < 1000) throw new Error('Receiving QR code was not rendered');
  const stored = await page.evaluate(() => JSON.stringify(localStorage));
  if (!stored.includes('AES-256-GCM') || stored.includes('mnemonic')) throw new Error('Encrypted storage boundary failed');
  await mkdir(path.join(extensionRoot, 'artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(extensionRoot, 'artifacts/swirl-extension.png'), fullPage: true });

  await page.getByRole('button', { name: 'Lock wallet' }).click();
  await page.locator('#unlock-password').fill('definitely wrong');
  await page.getByRole('button', { name: 'Unlock wallet' }).click();
  await page.getByText('Incorrect password or damaged encrypted wallet').waitFor();
  await page.locator('#unlock-password').fill('correct horse battery');
  await page.getByRole('button', { name: 'Unlock wallet' }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  if (await page.locator('.account-address').getAttribute('title') !== address) throw new Error('Unlock restored a different wallet');
  await page.reload({ waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Unlock wallet' }).waitFor();
  if (errors.length) throw new Error(`Browser errors: ${errors.join(' | ')}`);

  const importContext = await browser.newContext({ viewport: { width: 440, height: 760 } });
  const importPage = await importContext.newPage();
  await importPage.goto('http://127.0.0.1:7102/', { waitUntil: 'networkidle' });
  await importPage.getByRole('button', { name: 'Import recovery phrase' }).click();
  const testPhrase = `abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about`;
  await importPage.locator('#wallet-mnemonic').fill(testPhrase);
  await importPage.locator('#wallet-password').fill('import test password');
  await importPage.locator('#wallet-confirmation').fill('import test password');
  await importPage.getByRole('button', { name: 'Import encrypted wallet' }).click();
  await importPage.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  const importedStorage = await importPage.evaluate(() => JSON.stringify(localStorage));
  if (importedStorage.includes(testPhrase)) throw new Error('Imported mnemonic was stored in plaintext');
  await importContext.close();

  let nativeExtension;
  let nativeContext;
  try {
    nativeContext = await chromium.launchPersistentContext(path.join(extensionRoot, 'artifacts', `verify-profile-${Date.now()}`), {
      executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
      args: [`--disable-extensions-except=${path.join(extensionRoot, 'dist')}`, `--load-extension=${path.join(extensionRoot, 'dist')}`],
      viewport: { width: 440, height: 760 },
    });
    let worker = nativeContext.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
    if (!worker) worker = await nativeContext.waitForEvent('serviceworker', { timeout: 20_000 });
    const id = new URL(worker.url()).host;
    const extensionPage = await nativeContext.newPage();
    await extensionPage.goto(`chrome-extension://${id}/index.html`, { waitUntil: 'networkidle' });
    await extensionPage.getByRole('button', { name: 'Create private wallet' }).click();
    await extensionPage.locator('#wallet-password').fill('native extension test');
    await extensionPage.locator('#wallet-confirmation').fill('native extension test');
    await extensionPage.getByRole('button', { name: 'Create encrypted wallet' }).click();
    await extensionPage.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
    const nativeStored = await extensionPage.evaluate(async () => JSON.stringify(await chrome.storage.local.get(null)));
    if (!nativeStored.includes('AES-256-GCM') || nativeStored.includes('mnemonic')) throw new Error('Native extension storage boundary failed');
    await extensionPage.getByRole('button', { name: 'Lock wallet' }).click();
    await extensionPage.getByRole('button', { name: 'Unlock wallet' }).waitFor();
    await extensionPage.screenshot({ path: path.join(extensionRoot, 'artifacts/swirl-extension-native.png'), fullPage: true });
    nativeExtension = { loaded: true, chromeStorageVerified: true, lockVerified: true };
  } catch (error) {
    nativeExtension = { loaded: false, error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (nativeContext) await nativeContext.close();
  }

  console.log(JSON.stringify({
    ok: true, address: `${address.slice(0, 18)}…${address.slice(-10)}`, qrRendered: true,
    wrongPasswordRejected: true, reloadLocked: true, plaintextMnemonicStored: false,
    manifestPermissions: manifest.permissions, pageErrors: errors, nativeExtension,
    screenshot: 'apps/extension/artifacts/swirl-extension.png',
  }, null, 2));
} finally {
  if (browser) await browser.close();
  await stop(vite);
}
