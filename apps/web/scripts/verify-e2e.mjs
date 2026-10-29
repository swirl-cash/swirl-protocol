import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { JsonRpcProvider } from 'ethers';

const root = path.resolve(import.meta.dirname, '../../..');
const children = [];
let browser;
const errors = [];
let rpcGetLogs = 0;

function start(command, args, cwd, env = process.env) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  return child;
}
function ready(child, text) {
  return Promise.race([
    new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (chunk.toString().includes(text)) resolve(); });
      child.stderr.on('data', (chunk) => console.error(chunk.toString()));
      child.once('error', reject);
      child.once('exit', (code) => reject(new Error(`Process exited early: ${code}`)));
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${text}`)), 20_000)),
  ]);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}

try {
  const hardhat = start(process.execPath, [path.join(root, 'node_modules/hardhat/internal/cli/cli.js'), 'node', '--hostname', '127.0.0.1', '--port', '8545'], path.join(root, 'packages/contracts'));
  await ready(hardhat, 'Started HTTP and WebSocket JSON-RPC server');
  const deploy = start(process.execPath, [path.join(root, 'node_modules/hardhat/internal/cli/cli.js'), 'run', 'scripts/deploy-local.ts', '--network', 'localhost'], path.join(root, 'packages/contracts'));
  const [deployCode] = await once(deploy, 'exit');
  if (deployCode !== 0) throw new Error(`Deployment failed: ${deployCode}`);
  const deployment = JSON.parse(await readFile(path.join(root, 'packages/contracts/deployments/localhost.json'), 'utf8'));

  for (const service of ['relay', 'indexer']) {
    const build = start(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, `packages/${service}/tsconfig.json`)], root);
    const [buildCode] = await once(build, 'exit');
    if (buildCode !== 0) throw new Error(`${service} build failed: ${buildCode}`);
  }
  const relayer = start(process.execPath, [path.join(root, 'packages/relay/dist/index.js')], root, {
    ...process.env, RPC_URL: 'http://127.0.0.1:8545',
    RELAYER_PRIVATE_KEY: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    VAULT_ADDRESS: deployment.vault, TOKEN_ADDRESS: deployment.token, CORS_ORIGIN: 'http://127.0.0.1:7100', PORT: '8787',
    RELAYER_MNEMONIC: 'test test test test test test test test test test test junk', RELAYER_FEE_AMOUNT: '250000',
  });
  await ready(relayer, 'SWIRL relayer listening');
  const indexer = start(process.execPath, [path.join(root, 'packages/indexer/dist/index.js')], root, {
    ...process.env, RPC_URL: 'http://127.0.0.1:8545', VAULT_ADDRESS: deployment.vault,
    INDEXER_STATE_FILE: path.join(root, 'apps/web/artifacts/indexer-e2e-state.json'),
    CORS_ORIGIN: 'http://127.0.0.1:7100', PORT: '8788',
  });
  await ready(indexer, 'SWIRL indexer listening');
  const vite = start(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '7100', '--strictPort'], path.join(root, 'apps/web'), {
    ...process.env, VITE_RELAYER_URL: 'http://127.0.0.1:8787', VITE_INDEXER_URL: 'http://127.0.0.1:8788',
  });
  await ready(vite, 'Local:');

  const rpc = new JsonRpcProvider('http://127.0.0.1:8545');
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.exposeFunction('__swirlRpc', (args) => {
    if (args.method === 'eth_getLogs') rpcGetLogs++;
    return rpc.send(args.method === 'eth_requestAccounts' ? 'eth_accounts' : args.method, args.params ?? []);
  });
  await page.addInitScript(() => { window.ethereum = { request: (args) => window.__swirlRpc(args) }; });
  await page.goto('http://127.0.0.1:7100/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.getByText('Keys active', { exact: true }).waitFor({ timeout: 30_000 });
  const swirlAddress = await page.locator('.address-box').getAttribute('title');
  await page.getByRole('button', { name: 'Connect wallet' }).click();
  await page.locator('.connect-button').filter({ hasText: '0xf39Fd6…b92266' }).waitFor({ timeout: 20_000 });

  await page.getByRole('button', { name: 'Shield assets' }).click();
  await page.locator('.balance-value').filter({ hasText: '99.75' }).waitFor({ timeout: 60_000 }).catch(async () => {
    throw new Error(`First shield failed. Page state:\n${await page.locator('body').innerText()}\nBrowser errors: ${errors.join(' | ')}`);
  });
  await page.locator('.amount-input input').fill('20');
  await page.getByRole('button', { name: 'Shield assets' }).click();
  await page.locator('.balance-value').filter({ hasText: '119.7' }).waitFor({ timeout: 60_000 }).catch(async () => {
    throw new Error(`Second shield failed. Page state:\n${await page.locator('body').innerText()}\nBrowser errors: ${errors.join(' | ')}`);
  });
  const shieldedBalance = await page.locator('.balance-value').textContent();

  // 110 exceeds either input note, so this transaction must consume both.
  await page.getByRole('tab', { name: 'Private transfer' }).click();
  await page.locator('.amount-input input').fill('110');
  await page.locator('.text-input').fill(swirlAddress);
  await page.getByRole('button', { name: 'Prove & transfer' }).click();
  await page.getByText('Private transfer confirmed. The input nullifiers are now spent.').waitFor({ timeout: 120_000 }).catch(async () => {
    throw new Error(`Private transfer failed. Page state:\n${await page.locator('body').innerText()}\nBrowser errors: ${errors.join(' | ')}`);
  });

  await page.getByRole('tab', { name: 'Unshield' }).click();
  await page.getByRole('checkbox').check();
  await page.locator('.note-item').filter({ hasText: '110.0 USDC' }).click();
  await page.getByRole('button', { name: 'Prove & unshield' }).click();
  await page.getByText('Unshield confirmed. Public assets were sent to the recipient.').waitFor({ timeout: 120_000 }).catch(async () => {
    throw new Error(`Unshield failed. Page state:\n${await page.locator('body').innerText()}\nBrowser errors: ${errors.join(' | ')}`);
  });
  await page.waitForFunction(() =>
    document.querySelector('.balance-value')?.textContent?.trim().startsWith('9.45 ')
  , null, { timeout: 30_000 });
  const finalBalance = await page.locator('.balance-value').textContent();
  if (!finalBalance?.includes('9.45 USDC')) throw new Error(`Unexpected final balance: ${finalBalance}`);
  const indexResponse = await fetch('http://127.0.0.1:8788/events');
  if (!indexResponse.ok) throw new Error(`Indexer verification failed: HTTP ${indexResponse.status}`);
  const indexSnapshot = await indexResponse.json();
  const indexedShields = indexSnapshot.events.filter((event) => event.kind === 'shield').length;
  const indexedTransfers = indexSnapshot.events.filter((event) => event.kind === 'transacted').length;
  if (indexedShields !== 2 || indexedTransfers !== 2) {
    throw new Error(`Unexpected indexed events: ${indexedShields} Shielded, ${indexedTransfers} Transacted`);
  }
  if (rpcGetLogs !== 0) throw new Error(`Primary indexed recovery unexpectedly used RPC: ${rpcGetLogs} eth_getLogs calls`);
  rpcGetLogs = 0;
  await page.route('http://127.0.0.1:8788/events', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ version: 1, events: [] }),
  }));
  await page.getByRole('button', { name: 'Sync notes' }).click();
  const fallbackDeadline = Date.now() + 10_000;
  while (rpcGetLogs < 2 && Date.now() < fallbackDeadline) await page.waitForTimeout(100);
  if (rpcGetLogs < 2) throw new Error(`RPC fallback did not query both events: ${rpcGetLogs} eth_getLogs calls`);
  await page.locator('.balance-value').filter({ hasText: '9.45' }).waitFor({ timeout: 10_000 });
  if (errors.length) throw new Error(`Browser errors:\n${errors.join('\n')}`);
  await mkdir(path.join(root, 'apps/web/artifacts'), { recursive: true });
  await page.screenshot({ path: path.join(root, 'apps/web/artifacts/swirl-e2e.png'), fullPage: true });
  console.log(JSON.stringify({ ok: true, shieldedBalance, twoInputTransfer: '110 USDC', finalBalance, relay: 'http://127.0.0.1:8787', indexer: 'http://127.0.0.1:8788', indexedShields, indexedTransfers, rpcFallbackGetLogs: rpcGetLogs, pageErrors: errors, screenshot: 'apps/web/artifacts/swirl-e2e.png' }, null, 2));
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) await stop(child);
}
