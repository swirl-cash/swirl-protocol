export type ActivityKind = 'shield' | 'transfer' | 'public' | 'unshield' | 'mint';
export type ActivityStatus = 'pending' | 'confirmed';
export type ActivityRecord = {
  id: string;
  kind: ActivityKind;
  transactionHash: string;
  amount: string;
  counterparty?: string;
  timestamp: number;
  chainId: number;
  account: string;
  assetToken?: string;
  assetSymbol?: string;
  /* Undefined means confirmed: records written before the pending state existed. */
  status?: ActivityStatus;
};

const STORAGE_KEY = 'swirl.activity.v1';

async function readAll(): Promise<ActivityRecord[]> {
  let value: unknown;
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    value = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY];
  } else {
    value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  }
  return Array.isArray(value) ? value as ActivityRecord[] : [];
}

async function writeAll(records: ActivityRecord[]): Promise<void> {
  const trimmed = records.sort((a, b) => b.timestamp - a.timestamp).slice(0, 500);
  if (typeof chrome !== 'undefined' && chrome.storage?.local) {
    await chrome.storage.local.set({ [STORAGE_KEY]: trimmed });
    return;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
}

export async function listActivity(chainId: number, account: string, assetToken?: string): Promise<ActivityRecord[]> {
  return (await readAll())
    .filter((item) => item.chainId === chainId && item.account.toLowerCase() === account.toLowerCase()
      && (!assetToken || item.assetToken?.toLowerCase() === assetToken.toLowerCase()))
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, 100);
}

export async function addActivity(record: Omit<ActivityRecord, 'id' | 'timestamp'>): Promise<void> {
  const all = await readAll();
  const existing = all.find((item) => item.chainId === record.chainId && item.account.toLowerCase() === record.account.toLowerCase()
    && item.kind === record.kind && item.transactionHash.toLowerCase() === record.transactionHash.toLowerCase());
  if (existing) {
    // A broadcast already recorded as pending becomes confirmed in place,
    // keeping the original broadcast timestamp. Anything else is a duplicate.
    if (existing.status === 'pending' && record.status === 'confirmed') {
      Object.assign(existing, { ...record, id: existing.id, timestamp: existing.timestamp });
      await writeAll(all);
    }
    return;
  }
  all.push({ ...record, id: crypto.randomUUID(), timestamp: Date.now() });
  await writeAll(all);
}
