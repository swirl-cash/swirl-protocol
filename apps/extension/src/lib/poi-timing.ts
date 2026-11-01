import type { OwnedNote } from './protocol';

export function formatPoiCountdown(reviewAt: number | undefined, now: number): string {
  if (!reviewAt) return 'PPOI waiting period';
  const remaining = reviewAt - now;
  if (remaining <= 0) return 'Reviewing PPOI…';
  const totalSeconds = Math.ceil(remaining / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0 ? `PPOI wait · ${hours}h ${minutes}m ${seconds}s` : `PPOI wait · ${minutes}m ${seconds}s`;
}

export function notePoiLabel(note: Pick<OwnedNote, 'spent' | 'poiStatus' | 'poiReviewAt'>, now: number): string {
  if (note.spent) return 'Spent';
  if (note.poiStatus === 'ShieldPending') return formatPoiCountdown(note.poiReviewAt, now);
  if (note.poiStatus === 'Valid') return 'Available';
  if (note.poiStatus === 'ShieldBlocked') return 'Blocked by PPOI';
  if (note.poiStatus === 'Unavailable') return 'PPOI unavailable';
  if (note.poiStatus === 'Missing') return 'PPOI missing';
  if (note.poiStatus === 'ProofSubmitted') return 'PPOI proof submitted';
  return 'Available';
}

export function nextPendingPoiReviewAt(notes: Pick<OwnedNote, 'spent' | 'poiStatus' | 'poiReviewAt'>[]): number | undefined {
  const reviewTimes = notes
    .filter((note) => !note.spent && note.poiStatus === 'ShieldPending' && note.poiReviewAt)
    .map((note) => note.poiReviewAt!);
  return reviewTimes.length ? Math.min(...reviewTimes) : undefined;
}
