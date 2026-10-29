import { loadNetwork, loadNetworks, rpcReady } from './lib/network';
import {
  BACKGROUND_SOURCE, EXTENSION_SOURCE, type ApprovalDecision, type PendingApproval, type RequestAck, type RpcError,
} from './lib/dapp-types';
import { storageSessionGet, storageSessionRemove, storageSessionSet } from './lib/runtime';

const CONNECTIONS_KEY = 'swirl.dapp.connections.v1';
const PENDING_KEY = 'swirl.dapp.pending.v1';
const RESULTS_KEY = 'swirl.dapp.results.v1';
const WINDOW_KEY = 'swirl.dapp.window.v1';
const SESSION_KEY = 'swirl.dapp.session.v1';
const ACTIVE_NETWORK_KEY = 'swirl.network.v1';
const APPROVAL_TTL = 10 * 60 * 1000;

type Connection = { origin: string; tabId: number; account: string };
type ApprovalWindow = { windowId: number; tabId: number };
type WalletSession = { account: string; locked: boolean };
type StoredResult = { id: string; origin: string; tabId: number; result?: unknown; error?: RpcError; createdAt: number };
type PageRequest = { source: string; type: 'dapp:request' | 'dapp:result'; id: string; method?: string; params?: unknown[] };

const READ_METHODS = new Set([
  'eth_call', 'eth_estimateGas', 'eth_getBalance', 'eth_getCode', 'eth_getTransactionCount',
  'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_blockNumber', 'eth_gasPrice',
  'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getBlockByNumber', 'eth_getBlockByHash',
  'eth_getLogs', 'net_version', 'web3_clientVersion',
]);
const APPROVAL_METHODS = new Set(['eth_requestAccounts', 'wallet_switchEthereumChain', 'personal_sign', 'eth_sendTransaction']);

const rpcError = (code: number, message: string): RpcError => ({ code, message });
const done = (id: string, result?: unknown, error?: RpcError): RequestAck => ({ id, status: 'done', result, error });
const hexChain = (chainId: number) => `0x${chainId.toString(16)}`;
const isAddress = (value: string): boolean => /^0x[0-9a-f]{40}$/i.test(value);

async function connections(): Promise<Connection[]> {
  const stored = (await chrome.storage.local.get(CONNECTIONS_KEY))[CONNECTIONS_KEY];
  return Array.isArray(stored) ? stored as Connection[] : [];
}
async function pendingApproval(): Promise<PendingApproval | null> {
  const pending = (await storageSessionGet(PENDING_KEY))[PENDING_KEY] as PendingApproval | undefined;
  if (!pending) return null;
  if (Date.now() - pending.createdAt > APPROVAL_TTL) {
    await storageSessionRemove(PENDING_KEY);
    return null;
  }
  return pending;
}
async function walletSession(): Promise<WalletSession> {
  const session = (await storageSessionGet(SESSION_KEY))[SESSION_KEY] as WalletSession | undefined;
  return session ?? { account: '', locked: true };
}
function parseChainId(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw rpcError(32602, 'Expected a hexadecimal chain ID');
  const chainId = Number.parseInt(value, 16);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) throw rpcError(32602, 'Unsupported chain ID');
  return chainId;
}
function pageOrigin(sender: chrome.runtime.MessageSender): string {
  const value = sender.origin ?? (sender.url ? new URL(sender.url).origin : '');
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw rpcError(4100, 'Only HTTP(S) dApps can connect');
  return url.origin;
}

async function emitTo(connection: Connection, method: string, params: unknown): Promise<void> {
  try {
    await chrome.tabs.sendMessage(connection.tabId, {
      source: BACKGROUND_SOURCE, type: 'dapp:event', origin: connection.origin, event: { method, params },
    });
  } catch { /* The tab may have closed; authorization remains available for a future visit. */ }
}
async function broadcast(method: string, params: unknown): Promise<void> {
  const items = await connections();
  await Promise.all(items.map((item) => emitTo(item, method, params)));
}

async function openApproval(id: string): Promise<void> {
  const existing = (await storageSessionGet(WINDOW_KEY))[WINDOW_KEY] as ApprovalWindow | undefined;
  if (existing) {
    try {
      await chrome.windows.update(existing.windowId, { focused: true });
      await chrome.tabs.update(existing.tabId, { active: true, url: chrome.runtime.getURL(`approval.html?id=${encodeURIComponent(id)}`) });
      return;
    } catch { await storageSessionRemove(WINDOW_KEY); }
  }
  const created = await chrome.windows.create({
    url: chrome.runtime.getURL(`approval.html?id=${encodeURIComponent(id)}`),
    type: 'popup', focused: true, width: 440, height: 760,
  });
  const windowId = created?.id;
  const tabId = created?.tabs?.[0]?.id;
  if (!windowId || !tabId) throw rpcError(-32000, 'The approval window could not be opened');
  await storageSessionSet({ [WINDOW_KEY]: { windowId, tabId } });
}

async function queueApproval(request: PendingApproval): Promise<RequestAck> {
  const existing = await pendingApproval();
  if (existing) return done(request.id, undefined, rpcError(-32002, 'Another SWIRL approval is already pending'));
  await storageSessionSet({ [PENDING_KEY]: request });
  try { await openApproval(request.id); }
  catch (error) {
    await storageSessionRemove(PENDING_KEY);
    return done(request.id, undefined, rpcError(-32000, error instanceof Error ? error.message : String(error)));
  }
  return { id: request.id, status: 'pending' };
}

async function proxyRead(method: string, params: unknown[]): Promise<unknown> {
  const network = await loadNetwork();
  if (!network.rpcUrl) throw rpcError(4901, 'The active SWIRL network has no RPC configured');
  const response = await fetch(network.rpcUrl, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (!response.ok) throw rpcError(-32000, `RPC returned HTTP ${response.status}`);
  const payload = await response.json() as { result?: unknown; error?: RpcError };
  if (payload.error) throw payload.error;
  return payload.result;
}

async function handlePageRequest(message: PageRequest, sender: chrome.runtime.MessageSender): Promise<RequestAck> {
  if (typeof message.id !== 'string' || !message.id) throw rpcError(32600, 'Invalid request ID');
  const origin = pageOrigin(sender);
  const tabId = sender.tab?.id;
  if (tabId === undefined) throw rpcError(4100, 'The requesting tab could not be identified');
  if (message.type === 'dapp:result') {
    const stored = (await storageSessionGet(RESULTS_KEY))[RESULTS_KEY];
    const results = stored && typeof stored === 'object' ? stored as Record<string, StoredResult> : {};
    const result = results[message.id];
    if (result && result.origin === origin && result.tabId === tabId) {
      delete results[message.id];
      await storageSessionSet({ [RESULTS_KEY]: results });
      return done(message.id, result.result, result.error);
    }
    const pending = await pendingApproval();
    return pending?.id === message.id && pending.origin === origin && pending.tabId === tabId
      ? { id: message.id, status: 'pending' }
      : done(message.id, undefined, rpcError(-32001, 'The approval expired or was closed'));
  }

  const method = message.method ?? '';
  const params = Array.isArray(message.params) ? message.params : [];
  const network = await loadNetwork();
  if (method === 'eth_chainId') return done(message.id, hexChain(network.chainId));
  const session = await walletSession();
  const connection = (await connections()).find((item) => item.origin === origin);

  const connectedAccount = connection && !session.locked && session.account && connection.account.toLowerCase() === session.account.toLowerCase() ? session.account : '';
  if (method === 'eth_accounts') return done(message.id, connectedAccount ? [connectedAccount] : []);
  if (method === 'eth_requestAccounts' && connectedAccount) return done(message.id, [connectedAccount]);
  if (READ_METHODS.has(method)) {
    try { return done(message.id, await proxyRead(method, params)); }
    catch (error) {
      const cause = error as Partial<RpcError>;
      return done(message.id, undefined, rpcError(cause.code ?? -32000, cause.message ?? String(error)));
    }
  }
  if (!APPROVAL_METHODS.has(method)) return done(message.id, undefined, rpcError(4200, `SWIRL does not support ${method}`));
  if (method === 'wallet_switchEthereumChain') {
    try {
      const requested = parseChainId(params[0] && typeof params[0] === 'object' ? (params[0] as { chainId?: unknown }).chainId : undefined);
      if (requested === network.chainId) return done(message.id, null);
      if (![1, 11155111].includes(requested) && !((import.meta.env.DEV || import.meta.env.VITE_ENABLE_LOCAL_TEST === 'true') && requested === 31337)) {
        return done(message.id, undefined, rpcError(4902, 'This network is coming soon'));
      }
      const profile = (await loadNetworks()).find((item) => item.chainId === requested);
      if (!profile || !rpcReady(profile)) return done(message.id, undefined, rpcError(4902, 'This chain is not configured in SWIRL'));
      return await queueApproval({ id: message.id, origin, tabId, method, params, chainId: requested, createdAt: Date.now() });
    } catch (error) {
      const cause = error as Partial<RpcError>;
      return done(message.id, undefined, rpcError(cause.code ?? -32000, cause.message ?? String(error)));
    }
  }
  if (method !== 'eth_requestAccounts' && !connection) return done(message.id, undefined, rpcError(4100, 'Connect this dApp to SWIRL first'));
  return queueApproval({
    id: message.id, origin, tabId, method: method as PendingApproval['method'], params,
    chainId: network.chainId, createdAt: Date.now(),
  });
}

async function finishApproval(id: string, decision: ApprovalDecision): Promise<void> {
  const pending = await pendingApproval();
  if (!pending || pending.id !== id) throw new Error('This approval is no longer pending');
  let result: unknown = null;
  let error: RpcError | undefined;
  if (!decision.approved) error = rpcError(4001, decision.error || 'User rejected the request');
  else if (decision.error) error = rpcError(-32000, decision.error);
  else if (pending.method === 'eth_requestAccounts') {
    if (!decision.account || !isAddress(decision.account)) throw new Error('Invalid approved account');
    const account = decision.account;
    const items = await connections();
    const next = [...items.filter((item) => item.origin !== pending.origin), { origin: pending.origin, tabId: pending.tabId, account }];
    await chrome.storage.local.set({ [CONNECTIONS_KEY]: next });
    await storageSessionSet({ [SESSION_KEY]: { account, locked: false } });
    result = [account];
    await emitTo({ origin: pending.origin, tabId: pending.tabId, account }, 'connect', { chainId: hexChain(pending.chainId) });
    await emitTo({ origin: pending.origin, tabId: pending.tabId, account }, 'accountsChanged', [account]);
  } else if (pending.method === 'wallet_switchEthereumChain') {
    const active = await loadNetwork();
    if (active.chainId !== pending.chainId) throw new Error('The active network did not match the approved chain');
  } else if (pending.method === 'personal_sign') {
    if (!decision.signature) throw new Error('The signature was not returned');
    result = decision.signature;
  } else {
    if (!decision.transactionHash || !/^0x[0-9a-f]{64}$/i.test(decision.transactionHash)) throw new Error('The transaction hash was not returned');
    result = decision.transactionHash;
  }
  const stored = (await storageSessionGet(RESULTS_KEY))[RESULTS_KEY];
  const results = stored && typeof stored === 'object' ? stored as Record<string, StoredResult> : {};
  for (const [key, value] of Object.entries(results)) if (Date.now() - value.createdAt > APPROVAL_TTL) delete results[key];
  results[id] = { id, origin: pending.origin, tabId: pending.tabId, result, error, createdAt: Date.now() };
  await storageSessionSet({ [RESULTS_KEY]: results });
  await storageSessionRemove(PENDING_KEY);
}

async function handleExtensionMessage(message: { type?: string; id?: string; decision?: ApprovalDecision; account?: string }): Promise<unknown> {
  if (message.type === 'approval:get') return { pending: await pendingApproval() };
  if (message.type === 'approval:decision') {
    if (!message.id || !message.decision) throw new Error('Invalid approval decision');
    await finishApproval(message.id, message.decision);
    return { ok: true };
  }
  if (message.type === 'wallet:unlocked') {
    if (!message.account || !isAddress(message.account)) throw new Error('Invalid unlocked account');
    await storageSessionSet({ [SESSION_KEY]: { account: message.account, locked: false } });
    const items = await connections();
    await Promise.all(items.map((item) => emitTo(item, 'accountsChanged', item.account.toLowerCase() === message.account!.toLowerCase() ? [message.account] : [])));
    return { ok: true };
  }
  if (message.type === 'wallet:locked') {
    const session = await walletSession();
    await storageSessionSet({ [SESSION_KEY]: { ...session, locked: true } });
    await broadcast('accountsChanged', []);
    return { ok: true };
  }
  throw new Error('Unsupported extension message');
}

chrome.runtime.onMessage.addListener((message: PageRequest & { source?: string; type?: string }, sender, sendResponse) => {
  if (message?.source === 'swirl-content') {
    void handlePageRequest(message, sender).then(sendResponse).catch((error) => {
      const cause = error as Partial<RpcError>;
      sendResponse(done(message.id ?? '', undefined, rpcError(cause.code ?? -32000, cause.message ?? String(error))));
    });
    return true;
  }
  if (message?.source === EXTENSION_SOURCE) {
    void handleExtensionMessage(message).then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : String(error) }));
    return true;
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes[ACTIVE_NETWORK_KEY]) return;
  const network = changes[ACTIVE_NETWORK_KEY].newValue as { chainId?: number } | undefined;
  if (network?.chainId && Number.isSafeInteger(network.chainId)) void broadcast('chainChanged', hexChain(network.chainId));
});

chrome.windows.onRemoved.addListener((windowId) => {
  void (async () => {
    const existing = (await storageSessionGet(WINDOW_KEY))[WINDOW_KEY] as ApprovalWindow | undefined;
    if (!existing || existing.windowId !== windowId) return;
    await storageSessionRemove(WINDOW_KEY);
    const pending = await pendingApproval();
    if (pending) await finishApproval(pending.id, { approved: false, error: 'The approval window was closed' });
  })().catch(() => undefined);
});

chrome.runtime.onInstalled.addListener(() => {
  void storageSessionRemove([PENDING_KEY, RESULTS_KEY, WINDOW_KEY]);
});

