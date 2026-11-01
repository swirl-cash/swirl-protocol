import path from 'node:path';
import { chromium } from 'playwright-core';

const extensionRoot = path.resolve(import.meta.dirname, '..');
const dist = process.env.SWIRL_EXTENSION_DIST ? path.resolve(process.env.SWIRL_EXTENSION_DIST) : path.join(extensionRoot, 'dist');
const hex32 = (value) => `0x${BigInt(value).toString(16).padStart(64, '0')}`;
const hash = `0x${'11'.repeat(32)}`;
const block = {
  number: '0x1', hash, parentHash: `0x${'00'.repeat(32)}`, nonce: '0x0000000000000000',
  sha3Uncles: `0x${'00'.repeat(32)}`, logsBloom: `0x${'00'.repeat(256)}`,
  transactionsRoot: `0x${'00'.repeat(32)}`, stateRoot: `0x${'00'.repeat(32)}`, receiptsRoot: `0x${'00'.repeat(32)}`,
  miner: '0x0000000000000000000000000000000000000000', difficulty: '0x0', totalDifficulty: '0x0',
  extraData: '0x', size: '0x1', gasLimit: '0x1c9c380', gasUsed: '0x0', timestamp: '0x1',
  transactions: [], uncles: [], baseFeePerGas: '0x3b9aca00',
};

let context;
let releaseIndexer;
const indexerGate = new Promise((resolve) => { releaseIndexer = resolve; });
try {
  context = await chromium.launchPersistentContext(path.join(extensionRoot, 'artifacts', `refresh-balance-profile-${Date.now()}`), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
    args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
    viewport: { width: 440, height: 760 },
  });
  let worker = context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const id = new URL(worker.url()).host;
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('https://**/*', async (route) => {
    const request = route.request();
    const url = request.url();
    if (url.includes('swirl.cash/api/prices/native')) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ price: 2000 }) });
      return;
    }
    if (url.includes('indexer.swirl.cash/')) {
      await indexerGate;
      await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Intentional test outage' }) });
      return;
    }
    const body = request.postData();
    if (request.method() === 'POST' && body) {
      let payload;
      try { payload = JSON.parse(body); } catch { payload = null; }
      const requests = Array.isArray(payload) ? payload : [payload];
      if (requests.length && requests.every((rpc) => rpc?.jsonrpc === '2.0' && rpc.method)) {
        const responses = requests.map((rpc) => {
          let result = '0x0';
          if (rpc.method === 'eth_chainId') result = '0x1';
          else if (rpc.method === 'eth_getBalance') result = '0xde0b6b3a7640000';
          else if (rpc.method === 'eth_blockNumber') result = '0x1';
          else if (rpc.method === 'eth_gasPrice' || rpc.method === 'eth_maxPriorityFeePerGas') result = '0x3b9aca00';
          else if (rpc.method === 'eth_estimateGas') result = '0x186a0';
          else if (rpc.method === 'eth_getLogs') result = [];
          else if (rpc.method === 'eth_getBlockByNumber') result = block;
          else if (rpc.method === 'eth_feeHistory') result = { oldestBlock: '0x1', baseFeePerGas: ['0x3b9aca00', '0x3b9aca00'], gasUsedRatio: [0.5], reward: [['0x3b9aca00']] };
          else if (rpc.method === 'eth_call') {
            const to = rpc.params?.[0]?.to?.toLowerCase();
            const data = rpc.params?.[0]?.data ?? '';
            if (data.startsWith('0x313ce567')) result = hex32(to === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2' ? 18 : 6);
            else result = hex32(0);
          }
          return { jsonrpc: '2.0', id: rpc.id, result };
        });
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(Array.isArray(payload) ? responses : responses[0]) });
        return;
      }
    }
    await route.continue();
  });

  await page.goto(`chrome-extension://${id}/index.html`, { waitUntil: 'domcontentloaded' });
  const poi = await page.evaluate(async () => {
    const response = await fetch('https://relay.swirl.cash/ppoi/health', { cache: 'no-store' });
    return { status: response.status, body: await response.json() };
  });
  if (poi.status !== 200 || poi.body.ok !== true || poi.body.chainId !== '1') throw new Error(`PPOI extension fetch failed: ${JSON.stringify(poi)}`);

  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.locator('#wallet-password').fill('refresh balance verification');
  await page.locator('#wallet-confirmation').fill('refresh balance verification');
  await page.getByRole('button', { name: 'Create encrypted wallet' }).click();
  await page.locator('.backup-confirmation input').check();
  await page.getByRole('button', { name: 'Continue to wallet' }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  await page.locator('.public-gateway').click();
  const ethBalance = page.locator('.asset-list-row').filter({ hasText: 'ETH' }).first().locator('.asset-token-value strong');
  await ethBalance.waitFor({ timeout: 60_000 });
  // The indexer is deliberately still blocked: public chain data must render now.
  await page.waitForFunction(() => document.querySelector('.asset-list-row .asset-token-value strong')?.textContent?.includes('1.0 ETH'), null, { timeout: 60_000 });
  if ((await ethBalance.textContent())?.includes('Unavailable')) throw new Error('Public balance was hidden by the blocked indexer');
  releaseIndexer();

  await page.getByRole('button', { name: 'Use maximum Shield amount' }).click();
  await page.waitForFunction(() => {
    const value = Number(document.querySelector('#action-amount')?.value);
    return value > 0.99 && value < 1;
  }, null, { timeout: 30_000 });
  const maximum = await page.locator('#action-amount').inputValue();

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  await page.locator('.public-gateway').click();
  await page.waitForFunction(() => document.querySelector('.asset-list-row .asset-token-value strong')?.textContent?.includes('1.0 ETH'), null, { timeout: 60_000 });
  if (errors.length) throw new Error(errors.join(' | '));
  console.log(JSON.stringify({ ok: true, ppoiFetch: poi.status, publicBalanceBeforeIndexerResponse: '1.0 ETH', shieldMaximum: maximum, refreshRestoredBalance: true, pageErrors: errors }, null, 2));
} finally {
  releaseIndexer();
  if (context) await context.close();
}
