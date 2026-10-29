import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { JsonRpcProvider, Wallet, ethers } from 'ethers';
import { publicKeyFromSecret } from '@swirl/poi';
import { createSwirlWallet } from '@swirl/wallet';

const root = path.resolve(import.meta.dirname, '../../..');
const artifacts = path.join(root, 'apps/extension/artifacts');
const children = [];
const browserErrors = [];
const relayPayloads = [];
const rejections = {};
let browser;
let intercepted = false;

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
    new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${text}`)), 30_000)),
  ]);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 3000))]);
}
async function rejectedRelay(payload) {
  const response = await fetch('http://127.0.0.1:8787/relay', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload),
  });
  const body = await response.json();
  if (response.status !== 400) throw new Error(`Malformed Pre-Transaction POI returned HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body.error;
}

try {
  await mkdir(artifacts, { recursive: true });
  await Promise.all([
    rm(path.join(artifacts, 'poi-e2e-state.json'), { force: true }),
    rm(path.join(artifacts, 'indexer-poi-e2e-state.json'), { force: true }),
  ]);
  const hardhat = start(process.execPath, [path.join(root, 'node_modules/hardhat/internal/cli/cli.js'), 'node', '--hostname', '127.0.0.1', '--port', '8545'], path.join(root, 'packages/contracts'));
  await ready(hardhat, 'Started HTTP and WebSocket JSON-RPC server');
  const deploy = start(process.execPath, [path.join(root, 'node_modules/hardhat/internal/cli/cli.js'), 'run', 'scripts/deploy-local.ts', '--network', 'localhost'], path.join(root, 'packages/contracts'));
  const [deployCode] = await once(deploy, 'exit');
  if (deployCode !== 0) throw new Error(`Deployment failed: ${deployCode}`);
  const deployed = JSON.parse(await readFile(path.join(root, 'packages/contracts/deployments/localhost.json'), 'utf8'));
  for (const service of ['wallet', 'poi', 'relay', 'indexer']) {
    const build = start(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', path.join(root, `packages/${service}/tsconfig.json`)], root);
    const [buildCode] = await once(build, 'exit');
    if (buildCode !== 0) throw new Error(`${service} build failed: ${buildCode}`);
  }

  const listPrivateKey = '11'.repeat(32);
  const poiListKey = publicKeyFromSecret(listPrivateKey);
  const verificationKeyPath = path.join(root, 'packages/contracts/build/circuits/swirl_poi_verification_key.json');
  const ppoi = start(process.execPath, [path.join(root, 'packages/poi/dist/main.js')], root, {
    ...process.env,
    RPC_URL: 'http://127.0.0.1:8545', CHAIN_ID: '31337', VAULT_ADDRESS: deployed.vault,
    PPOI_LIST_PRIVATE_KEY: listPrivateKey, PPOI_MODE: 'local-test', PPOI_VKEY: verificationKeyPath,
    PPOI_STATE_FILE: path.join(artifacts, 'poi-e2e-state.json'), SHIELD_PENDING_SECONDS: '0',
    START_BLOCK: '0', CONFIRMATIONS: '0', CORS_ORIGIN: 'http://127.0.0.1:7104', PORT: '8790',
  });
  await ready(ppoi, 'SWIRL PPOI node listening');

  const usdc = deployed.assets.find((asset) => asset.symbol === 'USDC');
  if (!usdc) throw new Error('Local USDC asset is missing');
  const relayer = start(process.execPath, [path.join(root, 'packages/relay/dist/index.js')], root, {
    ...process.env,
    RPC_URL: 'http://127.0.0.1:8545', RELAYER_PRIVATE_KEY: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
    VAULT_ADDRESS: deployed.vault, CORS_ORIGIN: 'http://127.0.0.1:7104', PORT: '8787', RATE_LIMIT_PER_MINUTE: '10000',
    RELAYER_MNEMONIC: 'test test test test test test test test test test test junk',
    RELAYER_ASSETS: JSON.stringify(deployed.assets.map((asset) => ({
      token: asset.token, feeAmount: asset.symbol === 'ETH' ? '2500000000000000' : '250000',
    }))),
    PPOI_NODE_URL: 'http://127.0.0.1:8790', PPOI_LIST_KEY: poiListKey, PPOI_VKEY: verificationKeyPath,
  });
  await ready(relayer, 'SWIRL relayer listening');
  const indexer = start(process.execPath, [path.join(root, 'packages/indexer/dist/index.js')], root, {
    ...process.env,
    RPC_URL: 'http://127.0.0.1:8545', VAULT_ADDRESS: deployed.vault, RATE_LIMIT_PER_MINUTE: '10000',
    INDEXER_STATE_FILE: path.join(artifacts, 'indexer-poi-e2e-state.json'), CORS_ORIGIN: 'http://127.0.0.1:7104', PORT: '8788',
  });
  await ready(indexer, 'SWIRL indexer listening');
  const vite = start(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '7104', '--strictPort'], path.join(root, 'apps/extension'));
  await ready(vite, 'Local:');

  const rpc = new JsonRpcProvider('http://127.0.0.1:8545');
  const funder = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', rpc);
  browser = await chromium.launch({ executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true });
  const page = await browser.newPage({ viewport: { width: 440, height: 900 } });
  page.on('pageerror', (error) => browserErrors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  page.on('response', (response) => { if (response.status() >= 400) browserErrors.push(`HTTP ${response.status()} ${response.url()}`); });
  async function openAsset(bucket, symbol) {
    await page.getByRole('button', { name: 'Assets', exact: true }).click();
    await page.locator(`.${bucket}-gateway`).click();
    await page.locator('.asset-list-row').filter({ hasText: symbol }).click();
  }
  const deployment = { ...deployed, poiNodeUrl: 'http://127.0.0.1:8790', poiListKey };
  await page.route('**/deployment.local.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(deployment) }));
  const handleRelay = async (route) => {
    const payload = route.request().postDataJSON();
    relayPayloads.push(payload);
    if (!intercepted) {
      intercepted = true;
      await writeFile(path.join(artifacts, 'pre-transaction-debug.json'), JSON.stringify(payload, null, 2));
      const missing = structuredClone(payload);
      delete missing.preTransactionPOI;
      rejections.missing = await rejectedRelay(missing);
      const unknownRoot = structuredClone(payload);
      unknownRoot.preTransactionPOI.poiMerkleRoots[0] = `0x${'1'.padStart(64, '0')}`;
      unknownRoot.preTransactionPOI.publicSignals[6] = '1';
      rejections.unknownRoot = await rejectedRelay(unknownRoot);
      const tamperedProof = structuredClone(payload);
      tamperedProof.preTransactionPOI.proof.pi_a[0] = (BigInt(tamperedProof.preTransactionPOI.proof.pi_a[0]) + 1n).toString();
      rejections.tamperedProof = await rejectedRelay(tamperedProof);
      const changedPayload = structuredClone(payload);
      changedPayload.ciphertexts[1] = changedPayload.ciphertexts[1] === '0x' ? '0x00' : `${changedPayload.ciphertexts[1]}00`;
      rejections.changedPayload = await rejectedRelay(changedPayload);
    }
    await route.continue();
  };
  await page.route('http://127.0.0.1:8787/relay', handleRelay);
  await page.addInitScript(() => localStorage.setItem('swirl.network.v1', JSON.stringify({ chainId: 31337 })));
  await page.goto('http://127.0.0.1:7104/', { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Create private wallet' }).click();
  await page.locator('#wallet-password').fill('correct horse battery');
  await page.locator('#wallet-confirmation').fill('correct horse battery');
  await page.getByRole('button', { name: 'Create encrypted wallet' }).click();
  await page.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  const bobWallet = await createSwirlWallet(31337);
  await page.getByRole('button', { name: 'Receive', exact: true }).click();
  await page.getByRole('button', { name: 'EVM receive' }).click();
  const evmAddress = await page.locator('.address-box').getAttribute('title');
  if (!evmAddress || !ethers.isAddress(evmAddress)) throw new Error('Built-in EVM account was not derived');
  await (await funder.sendTransaction({ to: evmAddress, value: ethers.parseEther('2') })).wait();

  await openAsset('public', 'USDC');
  await page.getByRole('button', { name: 'Mint test USDC' }).click();
  await page.locator('.public-row').filter({ hasText: '10000.0 USDC' }).waitFor({ timeout: 60_000 });
  await page.locator('#action-amount').fill('100');
  await page.getByRole('button', { name: 'Shield assets' }).click();
  await openAsset('private', 'USDC');
  await page.locator('.private-balance').filter({ hasText: '99.75' }).waitFor({ timeout: 60_000 });
  await page.getByRole('tab', { name: 'Unshield', exact: true }).click();
  for (let attempt = 0; attempt < 30 && !(await page.locator('.note-item').filter({ hasText: 'PPOI Valid' }).count()); attempt++) {
    await page.waitForTimeout(500);
    await page.getByRole('button', { name: 'Refresh private assets' }).click();
  }
  await page.locator('.note-item').filter({ hasText: 'PPOI Valid' }).waitFor({ timeout: 5_000 }).catch(async () => {
    await page.screenshot({ path: path.join(artifacts, 'swirl-poi-shield-debug.png'), fullPage: true });
    throw new Error(`Shield PPOI status failed:\n${await page.locator('body').innerText()}\n${browserErrors.join(' | ')}`);
  });
  await page.getByRole('tab', { name: 'Transfer', exact: true }).click();
  await page.locator('#action-amount').fill('40');
  await page.locator('#action-recipient').fill(bobWallet.address);
  await page.getByRole('button', { name: 'Prove & transfer' }).click();
  await page.getByText('Private transfer confirmed. The input nullifiers are now spent.').waitFor({ timeout: 180_000 }).catch(async () => {
    throw new Error(`A-to-B PPOI transfer failed:\n${await page.locator('body').innerText()}\n${browserErrors.join(' | ')}`);
  });
  if (await page.getByText('PPOI is pending:', { exact: false }).count()) throw new Error('Confirmed transaction PPOI did not complete');

  if (!rejections.missing?.includes('required') || !rejections.unknownRoot?.includes('Unknown historical POI')
    || !rejections.tamperedProof?.includes('Invalid Pre-Transaction POI Groth16') || !rejections.changedPayload?.includes('not bound')) {
    throw new Error(`Relayer rejection checks failed: ${JSON.stringify(rejections)}`);
  }

  // Import a genuinely independent recipient wallet in an isolated browser
  // context. Bob has no Gas top-up: the Relayer must pay and deduct its token fee.
  const bobPage = await browser.newPage({ viewport: { width: 440, height: 900 } });
  bobPage.on('pageerror', (error) => browserErrors.push(error.message));
  bobPage.on('console', (message) => { if (message.type() === 'error') browserErrors.push(message.text()); });
  bobPage.on('response', (response) => { if (response.status() >= 400) browserErrors.push(`HTTP ${response.status()} ${response.url()}`); });
  await bobPage.route('**/deployment.local.json', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(deployment) }));
  await bobPage.route('http://127.0.0.1:8787/relay', handleRelay);
  await bobPage.addInitScript(() => localStorage.setItem('swirl.network.v1', JSON.stringify({ chainId: 31337 })));
  await bobPage.goto('http://127.0.0.1:7104/', { waitUntil: 'networkidle' });
  await bobPage.getByRole('button', { name: 'Import recovery phrase' }).click();
  await bobPage.locator('#wallet-mnemonic').fill(bobWallet.mnemonic);
  await bobPage.locator('#wallet-password').fill('correct horse battery');
  await bobPage.locator('#wallet-confirmation').fill('correct horse battery');
  await bobPage.getByRole('button', { name: 'Import encrypted wallet' }).click();
  await bobPage.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 30_000 });
  await bobPage.locator('.private-gateway').click();
  await bobPage.locator('.asset-list-row').filter({ hasText: 'USDC' }).click();
  await bobPage.locator('.private-balance').filter({ hasText: '40.0 USDC' }).waitFor({ timeout: 60_000 });
  await bobPage.getByRole('tab', { name: 'Unshield', exact: true }).click();
  for (let attempt = 0; attempt < 20 && !(await bobPage.locator('.note-item').filter({ hasText: 'PPOI Valid' }).count()); attempt++) {
    await bobPage.waitForTimeout(500);
    await bobPage.getByRole('button', { name: 'Refresh private assets' }).click();
  }
  const validOutputs = await bobPage.locator('.note-item').filter({ hasText: 'PPOI Valid' }).count();
  if (validOutputs !== 1) throw new Error(`Bob's confirmed output did not inherit PPOI: ${validOutputs}`);
  const bobEvmAddress = ethers.HDNodeWallet.fromPhrase(bobWallet.mnemonic).address;
  await bobPage.locator('.note-item').filter({ hasText: '40.0 USDC' }).click();
  await bobPage.locator('#action-recipient').fill(bobEvmAddress);
  await bobPage.getByRole('button', { name: 'Prove & unshield' }).click();
  await bobPage.getByText('Unshield confirmed. Public assets were sent to the recipient.').waitFor({ timeout: 180_000 }).catch(async () => {
    throw new Error(`Bob's Unshield failed:\n${await bobPage.locator('body').innerText()}\n${browserErrors.join(' | ')}`);
  });
  const token = new ethers.Contract(usdc.token, ['function balanceOf(address) view returns (uint256)'], rpc);
  const bobPublicBalance = await token.balanceOf(bobEvmAddress);
  const expectedPublicAmount = (40_000_000n - 250_000n) * 9_975n / 10_000n;
  if (bobPublicBalance !== expectedPublicAmount) throw new Error(`Bob received the wrong public Unshield amount: ${bobPublicBalance}; expected ${expectedPublicAmount}`);
  if (relayPayloads.length !== 2 || relayPayloads.some((payload) => !payload.preTransactionPOI)) {
    throw new Error('Not both Relayer transactions carried Pre-Transaction POI');
  }
  const health = await (await fetch('http://127.0.0.1:8790/health')).json();
  const events = await (await fetch('http://127.0.0.1:8790/events')).json();
  if (health.transactions !== 2 || health.poiEvents !== 6 || events.events.length !== 6) {
    throw new Error(`Unexpected final PPOI state: ${JSON.stringify(health)}`);
  }
  const signedBlinded = new Set(events.events.map((event) => event.blindedCommitment.toLowerCase()));
  for (const payload of relayPayloads) {
    for (const blinded of payload.preTransactionPOI.blindedCommitmentsOut) {
      if (signedBlinded.has(blinded.toLowerCase())) throw new Error('A reserved pre-transaction output leaked into the official POI tree');
    }
  }
  if (browserErrors.length) throw new Error(`Browser errors before offline test:\n${browserErrors.join('\n')}`);
  await page.screenshot({ path: path.join(artifacts, 'swirl-poi-valid.png'), fullPage: true });

  await stop(ppoi);
  await page.getByRole('button', { name: 'Refresh private assets' }).click();
  await page.getByRole('tab', { name: 'Unshield', exact: true }).click();
  await page.getByText('PPOI status unavailable:', { exact: false }).waitFor({ timeout: 30_000 });
  const disabled = await page.locator('.note-item:disabled').count();
  if (disabled < 1) throw new Error('PPOI node outage did not fail closed');

  const report = {
    ok: true,
    shieldAllowed: true,
    preTransactionProofAccepted: true,
    rejections,
    confirmedOutputsValid: validOutputs,
    independentRecipientUnshield: true,
    recipientPublicAmount: `${ethers.formatUnits(expectedPublicAmount, 6)} USDC`,
    officialPOIEvents: health.poiEvents,
    reservedOutputsExcluded: true,
    nodeOutageFailsClosed: true,
    browserErrorsBeforeOfflineTest: [],
  };
  await writeFile(path.join(artifacts, 'poi-e2e-result.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  if (browser) await browser.close();
  for (const child of children.reverse()) await stop(child);
}
