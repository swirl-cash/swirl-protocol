// Content scripts are classic scripts: keep this entry self-contained, without ES module imports.
function sendRuntimeMessage<T = any>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

type RequestAck = { id: string; status: 'pending' | 'done'; result?: unknown; error?: { code: number; message: string } };
const BACKGROUND_SOURCE = 'swirl-background';
const CONTENT_SOURCE = 'swirl-content';
const PAGE_SOURCE = 'swirl-page';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForResult(id: string): Promise<RequestAck> {
  const deadline = Date.now() + 5 * 60 * 1000;
  while (Date.now() < deadline) {
    const response = await sendRuntimeMessage<RequestAck>({ source: CONTENT_SOURCE, type: 'dapp:result', id });
    if (response?.status === 'done') return response;
    await sleep(350);
  }
  return { id, status: 'done', error: { code: -32001, message: 'SWIRL approval timed out' } };
}

window.addEventListener('message', (event) => {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = event.data as { source?: string; type?: string; id?: string; method?: string; params?: unknown[] };
  if (message?.source !== PAGE_SOURCE || message.type !== 'dapp:request' || typeof message.id !== 'string') return;
  const id = message.id;
  void (async () => {
    let response: RequestAck;
    try {
      response = await sendRuntimeMessage<RequestAck>({
        source: CONTENT_SOURCE, type: 'dapp:request', id, method: message.method, params: message.params ?? [],
      });
      if (response?.status === 'pending') response = await waitForResult(id);
    } catch (error) {
      response = { id, status: 'done', error: { code: -32000, message: error instanceof Error ? error.message : String(error) } };
    }
    window.postMessage({ source: CONTENT_SOURCE, type: 'dapp:response', ...response }, window.location.origin);
  })();
});

chrome.runtime.onMessage.addListener((message: {
  source?: string; type?: string; origin?: string; event?: { method: string; params: unknown };
}) => {
  if (message?.source !== BACKGROUND_SOURCE || message.type !== 'dapp:event' || message.origin !== window.location.origin || !message.event) return;
  window.postMessage({ source: CONTENT_SOURCE, type: 'dapp:event', event: message.event }, window.location.origin);
});
