import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { JsonRpcProvider, Wallet, ethers } from 'ethers';

const root = path.resolve(import.meta.dirname, '../../..');
const extensionRoot = path.join(root, 'apps/extension');
const password = 'native dApp test password';
const children = [];
const pageErrors = [];
let context;
let server;

function start(command, args, cwd) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child); return child;
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
async function approvalPage() {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const page = context.pages().find((item) => item.url().includes('/approval.html?id='));
    if (page) {
      await page.getByRole('heading', { name: 'Unlock to review' }).waitFor({ timeout: 10_000 });
      return page;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Native approval window did not open');
}
async function request(dapp, key, method, params = []) {
  await dapp.evaluate(({ key, method, params }) => {
    window[key] = { state: 'pending' };
    const provider = window.swirl ?? window.ethereum;
    void provider.request({ method, params }).then(
      (result) => { window[key] = { state: 'result', result }; },
      (error) => { window[key] = { state: 'error', error: { code: error.code, message: error.message } }; },
    );
  }, { key, method, params });
}
async function outcome(dapp, key) {
  await dapp.waitForFunction((key) => window[key]?.state !== 'pending', key, { timeout: 30_000 });
  return dapp.evaluate((key) => window[key], key);
}
async function unlockReview(button, screenshot) {
  const approval = await approvalPage();
  await approval.locator('#approval-password').fill(password);
  await approval.getByRole('button', { name: 'Unlock & review' }).click();
  await approval.getByRole('button', { name: button, exact: true }).waitFor({ timeout: 30_000 });
  if (screenshot) await approval.screenshot({ path: path.join(extensionRoot, 'artifacts', screenshot), fullPage: true });
  await approval.getByRole('button', { name: button, exact: true }).click();
}

try {
  const hardhat = start(process.execPath, [path.join(root, 'node_modules/hardhat/internal/cli/cli.js'), 'node', '--hostname', '127.0.0.1', '--port', '8545'], path.join(root, 'packages/contracts'));
  await ready(hardhat, 'Started HTTP and WebSocket JSON-RPC server');
  const deploy = start(process.execPath, [path.join(root, 'node_modules/hardhat/internal/cli/cli.js'), 'run', 'scripts/deploy-local.ts', '--network', 'localhost'], path.join(root, 'packages/contracts'));
  const [deployCode] = await once(deploy, 'exit');
  if (deployCode !== 0) throw new Error(`Deployment failed: ${deployCode}`);
  const deployment = JSON.parse(await readFile(path.join(root, 'packages/contracts/deployments/localhost.json'), 'utf8'));

  server = http.createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>SWIRL dApp E2E</title><h1>SWIRL native provider test</h1>');
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(7103, '127.0.0.1', resolve);
  });

  context = await chromium.launchPersistentContext(path.join(extensionRoot, 'artifacts', `dapp-profile-${Date.now()}`), {
    executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', headless: true,
    args: [`--disable-extensions-except=${path.join(extensionRoot, 'dist')}`, `--load-extension=${path.join(extensionRoot, 'dist')}`],
    viewport: { width: 440, height: 780 },
  });
  context.on('page', (page) => page.on('pageerror', (error) => pageErrors.push(error.message)));
  let worker = context.serviceWorkers().find((item) => item.url().startsWith('chrome-extension://'));
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
  const extensionId = new URL(worker.url()).host;
  worker.on('error', (error) => console.error(`Service worker error: ${error.message}`));
  await worker.evaluate(() => chrome.storage.local.set({ 'swirl.network.v1': { chainId: 31337 } }));
  const wallet = await context.newPage();
  wallet.on('pageerror', (error) => pageErrors.push(error.message));
  await wallet.goto(`chrome-extension://${extensionId}/index.html`, { waitUntil: 'networkidle' });
  await wallet.getByRole('button', { name: 'Create private wallet' }).click();
  await wallet.locator('#wallet-password').fill(password);
  await wallet.locator('#wallet-confirmation').fill(password);
  await wallet.getByRole('button', { name: 'Create encrypted wallet' }).click();
  await wallet.getByText('Wallet unlocked', { exact: true }).waitFor({ timeout: 60_000 }).catch(async () => {
    await wallet.screenshot({ path: path.join(extensionRoot, 'artifacts/swirl-native-create-failure.png'), fullPage: true });
    throw new Error(`Native wallet creation failed: ${await wallet.locator('body').innerText()} | ${pageErrors.join(' | ')}`);
  });

  await wallet.getByRole('button', { name: 'Select network' }).click();
  if (await wallet.getByRole('button', { name: 'Add custom network' }).count()) throw new Error('Custom network entry is still available');
  await wallet.getByRole('button', { name: 'Close network selector' }).click();
  await wallet.getByRole('button', { name: 'Receive', exact: true }).click();
  await wallet.getByRole('button', { name: 'EVM receive' }).click();
  const account = await wallet.locator('.address-box').getAttribute('title');
  if (!account || !ethers.isAddress(account)) throw new Error('No native EVM account was derived');
  const rpc = new JsonRpcProvider('http://127.0.0.1:8545');
  const funder = new Wallet('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80', rpc);
  await (await funder.sendTransaction({ to: account, value: ethers.parseEther('5') })).wait();

  const dapp = await context.newPage();
  dapp.on('pageerror', (error) => pageErrors.push(error.message));
  await dapp.goto('http://127.0.0.1:7103/', { waitUntil: 'networkidle' });
  const injected = await dapp.evaluate(() => ({ swirl: window.swirl?.isSWIRL === true, ethereum: window.ethereum?.isSWIRL === true }));
  if (!injected.swirl || !injected.ethereum) throw new Error(`Provider injection failed: ${JSON.stringify(injected)}`);
  await request(dapp, 'chain', 'eth_chainId');
  const chain = await outcome(dapp, 'chain');
  if (chain.result !== '0x7a69') throw new Error(`Unexpected initial chain: ${JSON.stringify(chain)}`);
  await request(dapp, 'beforeAccounts', 'eth_accounts');
  const beforeAccounts = await outcome(dapp, 'beforeAccounts');
  if (beforeAccounts.result?.length !== 0) throw new Error('dApp received an account before authorization');

  await request(dapp, 'rejectedConnect', 'eth_requestAccounts');
  await unlockReview('Reject');
  const rejectedConnect = await outcome(dapp, 'rejectedConnect');
  if (rejectedConnect.error?.code !== 4001) throw new Error(`Connection rejection failed: ${JSON.stringify(rejectedConnect)}`);

  await request(dapp, 'connect', 'eth_requestAccounts');
  await unlockReview('Approve', 'swirl-dapp-connect.png');
  const connected = await outcome(dapp, 'connect');
  if (connected.result?.[0]?.toLowerCase() !== account.toLowerCase()) throw new Error(`Connection returned the wrong account: ${JSON.stringify(connected)}`);
  await request(dapp, 'accounts', 'eth_accounts');
  const accounts = await outcome(dapp, 'accounts');
  if (accounts.result?.[0]?.toLowerCase() !== account.toLowerCase()) throw new Error('eth_accounts did not retain authorization');

  const message = 'SWIRL native dApp signature test';
  const messageHex = ethers.hexlify(ethers.toUtf8Bytes(message));
  await request(dapp, 'signature', 'personal_sign', [messageHex, account]);
  await unlockReview('Sign message');
  const signed = await outcome(dapp, 'signature');
  if (ethers.verifyMessage(message, signed.result).toLowerCase() !== account.toLowerCase()) throw new Error('Personal signature did not verify');

  await request(dapp, 'unsupportedSwitch', 'wallet_switchEthereumChain', [{ chainId: '0x7a6b' }]);
  const unsupportedSwitch = await outcome(dapp, 'unsupportedSwitch');
  if (unsupportedSwitch.error?.code !== 4902) throw new Error(`Unsupported chain was not rejected: ${JSON.stringify(unsupportedSwitch)}`);
  await dapp.evaluate(() => {
    window.chainEvents = [];
    window.swirl.on('chainChanged', (chainId) => window.chainEvents.push(chainId));
  });
  await request(dapp, 'switchEthereum', 'wallet_switchEthereumChain', [{ chainId: '0x1' }]);
  await unlockReview('Approve');
  const switchedEthereum = await outcome(dapp, 'switchEthereum');
  if (switchedEthereum.state !== 'result') throw new Error(`Supported Ethereum switch failed: ${JSON.stringify(switchedEthereum)}`);
  await request(dapp, 'ethereumChain', 'eth_chainId');
  if ((await outcome(dapp, 'ethereumChain')).result !== '0x1') throw new Error('eth_chainId did not change to Ethereum');
  await dapp.waitForFunction(() => window.chainEvents.includes('0x1'));
  await request(dapp, 'ethereumBlock', 'eth_blockNumber');
  const ethereumBlock = await outcome(dapp, 'ethereumBlock');
  if (typeof ethereumBlock.result !== 'string' || !ethereumBlock.result.startsWith('0x')) throw new Error(`Built-in Ethereum RPC failed: ${JSON.stringify(ethereumBlock)}`);

  await request(dapp, 'switchBack', 'wallet_switchEthereumChain', [{ chainId: '0x7a69' }]);
  await unlockReview('Approve');
  await outcome(dapp, 'switchBack');

  await request(dapp, 'block', 'eth_blockNumber');
  const block = await outcome(dapp, 'block');
  if (typeof block.result !== 'string' || !block.result.startsWith('0x')) throw new Error('Read-only RPC proxy failed');
  const recipient = Wallet.createRandom().address;
  await request(dapp, 'transaction', 'eth_sendTransaction', [{ from: account, to: recipient, value: ethers.toBeHex(ethers.parseEther('0.01')), data: '0x' }]);
  await unlockReview('Confirm & send', 'swirl-dapp-transaction.png');
  const transaction = await outcome(dapp, 'transaction');
  if (transaction.state !== 'result' || !/^0x[0-9a-f]{64}$/i.test(transaction.result)) throw new Error(`Transaction failed: ${JSON.stringify(transaction)}`);
  await rpc.waitForTransaction(transaction.result);
  const received = await rpc.getBalance(recipient);
  if (received !== ethers.parseEther('0.01')) throw new Error(`Unexpected recipient balance: ${received}`);

  await wallet.getByRole('button', { name: 'Lock wallet' }).click();
  await request(dapp, 'lockedAccounts', 'eth_accounts');
  const lockedAccounts = await outcome(dapp, 'lockedAccounts');
  if (lockedAccounts.result?.length !== 0) throw new Error('Locked wallet still exposed its account');
  await wallet.screenshot({ path: path.join(extensionRoot, 'artifacts/swirl-extension-native.png'), fullPage: true });
  if (pageErrors.length) throw new Error(`Native page errors: ${pageErrors.join(' | ')}`);

  console.log(JSON.stringify({
    ok: true, nativeExtension: true, providerInjected: true, fixedNetworksOnly: true,
    rejectionCode: rejectedConnect.error.code, connectedAccount: account,
    personalSignVerified: true, unconfiguredChainRejected: 4902,
    switchedChains: ['0x7a69', '0x1', '0x7a69'], chainChangedEvent: true,
    readRpcProxied: true, builtInEthereumRpcVerified: true,
    transactionHash: transaction.result, recipientReceived: ethers.formatEther(received),
    lockedAccountsHidden: true, pageErrors,
    screenshots: ['apps/extension/artifacts/swirl-dapp-connect.png', 'apps/extension/artifacts/swirl-dapp-transaction.png'],
  }, null, 2));
} finally {
  if (context) await context.close();
  if (server) await new Promise((resolve) => server.close(resolve));
  for (const child of children.reverse()) await stop(child);
}
