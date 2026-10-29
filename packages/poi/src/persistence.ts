import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PersistedPOIState } from './types.js';

export async function loadPOIState(file: string): Promise<PersistedPOIState | undefined> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as PersistedPOIState;
    return parsed.version === 1 ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function savePOIState(file: string, state: PersistedPOIState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  await rename(temporary, file);
}
