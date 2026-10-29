export type SubmissionPreference = 'relayer' | 'main' | 'gas';
export type WalletSettings = {
  autoLockMinutes: number;
  submission: SubmissionPreference;
  hiddenChainIds: number[];
};

const SETTINGS_KEY = 'swirl.wallet-settings.v1';
export const DEFAULT_SETTINGS: WalletSettings = { autoLockMinutes: 15, submission: 'relayer', hiddenChainIds: [] };

export async function loadSettings(): Promise<WalletSettings> {
  let raw: unknown;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) raw = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  else {
    const value = localStorage.getItem(SETTINGS_KEY);
    raw = value ? JSON.parse(value) : undefined;
  }
  if (!raw || typeof raw !== 'object') return DEFAULT_SETTINGS;
  const value = raw as Partial<WalletSettings>;
  return {
    autoLockMinutes: [0, 1, 5, 15, 30].includes(value.autoLockMinutes ?? -1) ? value.autoLockMinutes! : 15,
    submission: ['relayer', 'main', 'gas'].includes(value.submission ?? '') ? value.submission! : 'relayer',
    hiddenChainIds: Array.isArray(value.hiddenChainIds) ? value.hiddenChainIds.filter((item): item is number => Number.isSafeInteger(item) && item > 0) : [],
  };
}

export async function saveSettings(settings: WalletSettings): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
