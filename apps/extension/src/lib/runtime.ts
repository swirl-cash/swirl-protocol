/** Callback-based MV3 messaging also works in Chromium builds with incomplete Promise support. */
export function sendRuntimeMessage<T = any>(message: unknown): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response: T) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(response);
    });
  });
}

export function storageSessionGet(keys: string | string[]): Promise<Record<string, any>> {
  return new Promise((resolve, reject) => {
    chrome.storage.session.get(keys, (items) => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve(items);
    });
  });
}

export function storageSessionSet(items: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.session.set(items, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}

export function storageSessionRemove(keys: string | string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    chrome.storage.session.remove(keys, () => {
      const error = chrome.runtime.lastError;
      if (error) reject(new Error(error.message));
      else resolve();
    });
  });
}
