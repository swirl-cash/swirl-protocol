type RpcRequest = { method: string; params?: unknown[] | Record<string, unknown> };
type Listener = (...args: unknown[]) => void;
type Pending = { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: number };

const listeners = new Map<string, Set<Listener>>();
const pending = new Map<string, Pending>();
const randomId = () => crypto.randomUUID();

const provider = {
  isSWIRL: true,
  isMetaMask: false,
  request({ method, params = [] }: RpcRequest): Promise<unknown> {
    if (typeof method !== 'string' || !method) return Promise.reject(new Error('Invalid JSON-RPC method'));
    const id = randomId();
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id);
        const error = new Error('SWIRL request timed out') as Error & { code: number };
        error.code = -32001;
        reject(error);
      }, 5 * 60 * 1000);
      pending.set(id, { resolve, reject, timer });
      window.postMessage({ source: 'swirl-page', type: 'dapp:request', id, method, params }, window.location.origin);
    });
  },
  on(event: string, listener: Listener) {
    const items = listeners.get(event) ?? new Set<Listener>();
    items.add(listener); listeners.set(event, items);
    return provider;
  },
  removeListener(event: string, listener: Listener) {
    listeners.get(event)?.delete(listener);
    return provider;
  },
  removeAllListeners(event?: string) {
    if (event) listeners.delete(event); else listeners.clear();
    return provider;
  },
  isConnected() { return true; },
};

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data as {
    source?: string; type?: string; id?: string; result?: unknown;
    error?: { code?: number; message?: string; data?: unknown }; event?: { method: string; params: unknown };
  };
  if (message?.source !== 'swirl-content') return;
  if (message.type === 'dapp:response' && message.id) {
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); window.clearTimeout(request.timer);
    if (message.error) {
      const error = new Error(message.error.message ?? 'SWIRL request failed') as Error & { code: number; data?: unknown };
      error.code = message.error.code ?? -32000; error.data = message.error.data;
      request.reject(error);
    } else request.resolve(message.result);
    return;
  }
  if (message.type === 'dapp:event' && message.event) {
    for (const listener of listeners.get(message.event.method) ?? []) {
      try { listener(message.event.params); } catch { /* A dApp listener cannot break the provider bridge. */ }
    }
  }
});

const target = window as Window & { ethereum?: unknown; swirl?: unknown };
Object.defineProperty(target, 'swirl', { value: provider, configurable: false, enumerable: true, writable: false });
if (!target.ethereum) Object.defineProperty(target, 'ethereum', { value: provider, configurable: true, enumerable: true, writable: false });

const info = Object.freeze({
  uuid: randomId(), name: 'SWIRL Private Wallet', rdns: 'cash.swirl.wallet',
  icon: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAzMiAzMiI+PHJlY3Qgd2lkdGg9IjMyIiBoZWlnaHQ9IjMyIiByeD0iOCIgZmlsbD0iIzExMTMxYSIvPjxwYXRoIGQ9Ik0yMyA4SDE0Yy00IDAtNiAyLTYgNXMyIDQgNiA0aDRjMiAwIDMgMSAzIDNzLTEgMy0zIDNIOWw0IDVoNWM1IDAgOC0zIDgtNnMtMy01LTctNWgtNGMtMiAwLTMtMS0zLTNzMS0zIDMtM2g3bC00LTVaIiBmaWxsPSIjOWI3MmZmIi8+PC9zdmc+',
});
const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
window.addEventListener('eip6963:requestProvider', announce);
announce();
