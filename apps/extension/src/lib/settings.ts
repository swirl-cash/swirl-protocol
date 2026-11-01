export type SubmissionPreference = 'relayer' | 'main' | 'gas';
export type WalletSettings = {
  autoLockMinutes: number;
  submission: SubmissionPreference;
  hiddenChainIds: number[];
};

const SETTINGS_KEY = 'swirl.wallet-settings.v2';
const LEGACY_SETTINGS_KEY = 'swirl.wallet-settings.v1';
export const DEFAULT_SETTINGS: WalletSettings = { autoLockMinutes: 15, submission: 'main', hiddenChainIds: [] };

async function readSettings(key: string): Promise<unknown> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) return (await chrome.storage.local.get(key))[key];
  const value = localStorage.getItem(key);
  return value ? JSON.parse(value) : undefined;
}

export async function loadSettings(): Promise<WalletSettings> {
  let raw = await readSettings(SETTINGS_KEY);
  const migrating = raw === undefined || raw === null;
  if (migrating) raw = await readSettings(LEGACY_SETTINGS_KEY);
  const value = raw && typeof raw === 'object' ? raw as Partial<WalletSettings> : {};
  const settings: WalletSettings = {
    autoLockMinutes: [0, 1, 5, 15, 30].includes(value.autoLockMinutes ?? -1) ? value.autoLockMinutes! : 15,
    // One-time v2 migration: existing Relayer users also start with their own EVM wallet.
    submission: !migrating && ['relayer', 'main', 'gas'].includes(value.submission ?? '') ? value.submission! : 'main',
    hiddenChainIds: Array.isArray(value.hiddenChainIds) ? value.hiddenChainIds.filter((item): item is number => Number.isSafeInteger(item) && item > 0) : [],
  };
  if (migrating) await saveSettings(settings);
  return settings;
}

export async function saveSettings(settings: WalletSettings): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [SETTINGS_KEY]: settings });
    return;
  }
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}
